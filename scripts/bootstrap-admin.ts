#!/usr/bin/env node
/**
 * bootstrap-admin.ts — разовое восстановление доступа к панели.
 *
 * Почему отдельный скрипт, а не scripts/seed-admin.mjs:
 *   * seed-admin СОЗНАТЕЛЬНО не перезаписывает существующего администратора
 *     (иначе ручная смена пароля затиралась бы каждым деплоем) и не умеет
 *     привязывать Discord ID. Для аварийного восстановления нужно и то, и другое;
 *   * запускается вручную с машины, где БД доступна по 127.0.0.1, поэтому
 *     алиасы Next.js («@/lib/...») здесь не используются — импорт идёт
 *     относительным путём с явным расширением .ts (как в tests/*.test.ts).
 *
 * Что делает:
 *   1. гарантирует запись в users с ролью admin (создаёт, если таблица пуста);
 *   2. задаёт пароль по политике проекта и отзывает прежние сессии
 *      (инкремент token_version — тот же приём, что в seed-admin);
 *   3. привязывает Discord ID к учётной записи: после этого вход через Discord
 *      сразу выдаёт сессию панели (см. api/auth/discord/callback);
 *   4. если в division_members найдётся боец Volkov/Данил — связывает его
 *      discord_id и задаёт тот же пароль.
 *
 * О пароле. Значение вида «Admin12345!» политика проекта ОТКЛОНЯЕТ
 * («построен на распространённом слове»): тот же список WEAK_BASES, что и в
 * src/lib/password-policy.ts, роняет на нём seed-admin.mjs. Поэтому по умолчанию
 * пароль генерируется случайным, а свой можно передать BOOTSTRAP_PASSWORD —
 * но он тоже обязан проходить политику, иначе скрипт падает (fail-fast).
 *
 * Запуск (нужен DATABASE_URL с доступом к БД, см. .env):
 *   node scripts/bootstrap-admin.ts
 *   BOOTSTRAP_PASSWORD='...' node scripts/bootstrap-admin.ts
 *
 * Повторный запуск безопасен: пароль админа будет выставлен заново, Discord
 * останется привязанным (та же привязка), боец не продублируется.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { checkPasswordPolicy } from "../src/lib/password-policy.ts";

/** Те же раунды, что в seed-admin.mjs и в роутах смены пароля */
const BCRYPT_ROUNDS = 10;

const USERNAME = (process.env.BOOTSTRAP_USERNAME || "admin").trim();
const DISCORD_ID = (process.env.BOOTSTRAP_DISCORD_ID || "580629680002969600").trim();
/** Позывные/имена бойца, которого просили связать с тем же Discord */
const MEMBER_LOOKUPS = ["volkov", "данил"];

/**
 * Проверка «снежинки» Discord.
 *
 * Копия правила из src/lib/validation.ts (isDiscordId) вынужденная: тот модуль
 * тянет алиас «@/lib/recruits», который вне сборки Next.js не резолвится.
 */
function isDiscordId(value: string): boolean {
  return /^\d{5,25}$/.test(value);
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const SYMBOLS = "!@#%*?-_+=.";

/**
 * Случайный пароль, заведомо проходящий политику (проверяем, а не надеемся:
 * буквы обоих регистров + цифра + знак дают четыре группы символов).
 */
function generatePassword(): string {
  for (;;) {
    const bytes = randomBytes(24);
    let out = "";
    for (let i = 0; i < 20; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    out += SYMBOLS[bytes[20] % SYMBOLS.length];
    out += String(bytes[21] % 10);
    if (checkPasswordPolicy(out).ok) return out;
  }
}

export type BootstrapResult = {
  username: string;
  discordId: string;
  password: string;
  userCreated: boolean;
  memberSynced: { id: number; callsign: string | null; name: string } | null;
};

/**
 * Приводит учётную запись админа в рабочее состояние и возвращает итог.
 *
 * Вынесено в функцию, чтобы логика была тестируемой и переиспользуемой:
 * подключение к БД создаётся снаружи и закрывается вызывающим кодом.
 */
export async function bootstrapAdmin(
  pool: Pool,
  options: { username: string; discordId: string; password: string }
): Promise<BootstrapResult> {
  const { username, discordId, password } = options;

  const existing = await pool.query<{ id: number; role: string }>(
    "SELECT id, role FROM users WHERE username = $1",
    [username]
  );

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  let userCreated = false;

  if (existing.rowCount === 0) {
    // Пароль уже захеширован — отдаём его как есть, без повторного bcrypt
    await pool.query(
      "INSERT INTO users (username, password_hash, role, discord_id) VALUES ($1, $2, $3, $4)",
      [username, passwordHash, "admin", discordId]
    );
    userCreated = true;
  } else {
    // token_version + 1 разом отзывает все ранее выданные сессии панели:
    // восстановление доступа не должно оставлять живыми старые токены.
    await pool.query(
      "UPDATE users SET password_hash = $2, role = 'admin', discord_id = $3, " +
        "token_version = token_version + 1 WHERE username = $1",
      [username, passwordHash, discordId]
    );
  }

  // Боец с тем же Discord: связываем и даём тот же пароль. Позывной в проекте —
  // это логин кабинета, а статус active нужен, иначе вход закроет hasProfileAccess().
  const memberRows = await pool.query<{
    id: number;
    callsign: string | null;
    name: string;
    status: string;
  }>(
    "SELECT id, callsign, name, status FROM division_members " +
      "WHERE lower(coalesce(callsign, '')) = ANY($1) OR lower(name) = ANY($1) " +
      "ORDER BY id LIMIT 1",
    [MEMBER_LOOKUPS]
  );

  let memberSynced: BootstrapResult["memberSynced"] = null;
  if (memberRows.rowCount && memberRows.rows[0]) {
    const member = memberRows.rows[0];
    // member_token_version отзывает cookie кабинета — по той же логике, что и
    // token_version у панели (пароль сменили принудительно).
    await pool.query(
      "UPDATE division_members SET discord_id = $2, password_hash = $3, " +
        "callsign = coalesce(callsign, $4), status = 'active', active = true, " +
        "member_token_version = member_token_version + 1 WHERE id = $1",
      [member.id, discordId, passwordHash, "Volkov"]
    );
    memberSynced = { id: member.id, callsign: member.callsign || "Volkov", name: member.name };
  }

  return { username, discordId, password, userCreated, memberSynced };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "[bootstrap-admin] DATABASE_URL не задан. Проверьте .env " +
        "(для локального запуска нужен адрес с 127.0.0.1:5432)."
    );
    process.exit(1);
  }

  if (!USERNAME) {
    console.error("[bootstrap-admin] BOOTSTRAP_USERNAME пуст");
    process.exit(1);
  }

  if (!isDiscordId(DISCORD_ID)) {
    console.error(
      `[bootstrap-admin] Некорректный Discord ID «${DISCORD_ID}»: ожидаются только цифры`
    );
    process.exit(1);
  }

  // Пароль: свой из BOOTSTRAP_PASSWORD либо сгенерированный. Политику проверяем
  // всегда — «Admin12345!» она отклоняет, и лучше упасть здесь, чем выдать
  // пароль, который панель позже откажется принять при смене.
  const provided = (process.env.BOOTSTRAP_PASSWORD || "").trim();
  const password = provided || generatePassword();
  if (provided) {
    const check = checkPasswordPolicy(provided);
    if (!check.ok) {
      console.error(`[bootstrap-admin] BOOTSTRAP_PASSWORD не проходит политику: ${check.error}`);
      console.error(
        "[bootstrap-admin] Требования: минимум 10 символов и минимум два вида " +
          "символов, без распространённых слов (admin/password/qwerty/…) и дат."
      );
      process.exit(1);
    }
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await bootstrapAdmin(pool, {
      username: USERNAME,
      discordId: DISCORD_ID,
      password,
    });

    console.log(
      `[bootstrap-admin] Учётная запись «${result.username}» ` +
        (result.userCreated ? "создана" : "обновлена") +
        ` (роль admin, Discord ${result.discordId} привязан, прежние сессии отозваны).`
    );
    if (result.memberSynced) {
      console.log(
        `[bootstrap-admin] Боец #${result.memberSynced.id} «${result.memberSynced.name}» ` +
          `связан с Discord ${result.discordId}, статус active, пароль тот же.`
      );
    } else {
      console.log(
        "[bootstrap-admin] В division_members нет бойца с позывным Volkov/Данил — " +
          "блок бойца пропущен (табель не заполнялся, запись не создаём)."
      );
    }
    console.log("");
    console.log("  Логин:  " + result.username);
    console.log("  Пароль: " + result.password);
    console.log("");
  } finally {
    await pool.end();
  }
}

// main() выполняется только при прямом запуске: импорт модуля из тестов
// не должен трогать БД и печатать пароль.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error("[bootstrap-admin] Ошибка:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}