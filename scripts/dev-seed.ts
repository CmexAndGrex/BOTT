#!/usr/bin/env node
/**
 * dev-seed.ts — наполнение локальной базы для проверки входа и кабинета.
 *
 * Зачем отдельный скрипт, а не только кнопки на /login: кнопки требуют
 * работающего приложения и БД, а если база пустая или её только что подняли,
 * удобнее подготовить данные одной командой. Оба пути используют ОДИН список
 * (src/lib/dev-accounts.ts), поэтому кнопки и сид не разъедутся.
 *
 * Что делает:
 *   1. поднимает трёх бойцов (командир, танкист, наводчик) со статусом
 *      «в строю» и паролем, проходящим политику проекта;
 *   2. создаёт учётную запись панели для командира (роль admin);
 *   3. для танкиста и наводчика добавляет одобренные рапорты-экзамены, чтобы
 *      кабинет показал не пустой список допусков, а открытые категории техники.
 *
 * Идемпотентность: повторный запуск не плодит дубли (ON CONFLICT по позывному
 * и по логину панели), а приводит записи к тому же виду.
 *
 * Запуск (нужен DATABASE_URL с доступом к БД, см. .env):
 *   node scripts/dev-seed.ts
 *
 * Никаких боевых данных скрипт не трогает: он работает только с позывными из
 * DEV_ACCOUNTS и учётной записью DEV_PANEL_USERNAME. В production не запускать —
 * скрипт об этом предупреждает, но не блокирует: решение осознанное и ручное.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { checkPasswordPolicy } from "../src/lib/password-policy.ts";
import {
  DEV_ACCOUNTS,
  DEV_ADMIN_PASSWORD_DEFAULT,
  DEV_PANEL_USERNAME,
  type DevAccount,
} from "../src/lib/dev-accounts.ts";

/** Те же раунды, что в seed-admin.mjs и в роутах смены пароля */
const BCRYPT_ROUNDS = 10;

/**
 * Нормативы по подразделению: те же коды, что в EXAM_CATALOG (reports.ts).
 *
 * Танкисту — базовые, наводчику — миномётные: так кабинет сразу показывает
 * разные состояния матрицы техники (открытую по званию и открытую по допуску),
 * а не одинаковые пустые списки у всех трёх.
 *
 * КМБТ идёт без оценки: в каталоге он помечен graded: false, и оценка на нём
 * была бы отклонена общим валидатором (validateExams).
 */
const EXAMS_BY_KEY: Record<string, { code: string; grade: string }[]> = {
  commander: [],
  tank: [
    { code: "КМБТ", grade: "" },
    { code: "Снаряжение, обслуживание техники", grade: "Отлично" },
    { code: "Огневая подготовка", grade: "Хорошо" },
  ],
  artillery: [
    { code: "КМБТ", grade: "" },
    // Именно этот норматив открывает миномёты (см. ARTILLERY_CATEGORIES)
    { code: "Миномётное дело (Экзамен)", grade: "Отлично" },
  ],
};
/** Создаёт/обновляет бойца и возвращает его id */
async function upsertMember(pool: Pool, account: DevAccount, passwordHash: string): Promise<number> {
  const result = await pool.query(
    "INSERT INTO division_members " +
      "(callsign, name, rank, unit, post, status, active, role, password_hash, updated_at) " +
      "VALUES ($1, $2, $3, $4, $5, 'active', true, $6, $7, now()) " +
      "ON CONFLICT (callsign) DO UPDATE SET " +
      "name = excluded.name, rank = excluded.rank, unit = excluded.unit, post = excluded.post, " +
      "status = 'active', active = true, role = excluded.role, " +
      "password_hash = excluded.password_hash, updated_at = now() " +
      "RETURNING id",
    [
      account.callsign,
      account.name,
      account.rank,
      account.unit,
      account.post,
      account.role,
      passwordHash,
    ]
  );
  return result.rows[0].id as number;
}

/**
 * Учётная запись панели для командира.
 *
 * member_id связывается с бойцом командира: одна сессия панели даёт и личный
 * кабинет (см. src/lib/member-auth.ts). Без связки dev-командир после входа
 * упирался в заглушку «войдите в личный кабинет» на /profile.
 */
async function upsertPanelUser(
  pool: Pool,
  passwordHash: string,
  memberId: number | null
): Promise<void> {
  await pool.query(
    "INSERT INTO users (username, password_hash, role, member_id) VALUES ($1, $2, 'admin', $3) " +
      "ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, " +
      "role = 'admin', member_id = excluded.member_id",
    [DEV_PANEL_USERNAME, passwordHash, memberId]
  );
}

/**
 * Одобренный рапорт-экзамен: он и открывает категории техники в кабинете.
 *
 * Статус сразу approved — в кабинете учитываются только одобренные рапорты
 * (collectQualifications фильтрует по status === "approved"). Так сид даёт
 * кабинет в «рабочем» состоянии, а не с пустыми допусками.
 *
 * Рапорт у бойца один: повторный запуск переписывает его, а не плодит дубли,
 * иначе история службы в кабинете росла бы с каждым запуском.
 */
async function upsertExamReport(
  pool: Pool,
  memberId: number,
  callsign: string,
  exams: { code: string; grade: string }[]
): Promise<boolean> {
  if (exams.length === 0) return false;

  const payload = JSON.stringify({
    exams: exams.map((exam) => ({ exam_code: exam.code, grade: exam.grade })),
  });

  const existing = await pool.query(
    "SELECT id FROM service_reports WHERE member_id = $1 AND type = 'exam' LIMIT 1",
    [memberId]
  );

  if (existing.rowCount && existing.rowCount > 0) {
    await pool.query(
      "UPDATE service_reports SET payload = $2, status = 'approved', moderator_comment = $3, " +
        "reviewed_by = $4, updated_at = now() WHERE id = $1",
      [existing.rows[0].id, payload, "Зачтено (dev-seed)", "dev-seed"]
    );
    return false;
  }

  await pool.query(
    "INSERT INTO service_reports " +
      "(member_id, callsign, type, status, payload, moderator_comment, reviewed_by) " +
      "VALUES ($1, $2, 'exam', 'approved', $3, $4, $5)",
    [memberId, callsign, payload, "Зачтено (dev-seed)", "dev-seed"]
  );
  return true;
}

export type DevSeedResult = {
  password: string;
  panelUsername: string;
  members: { callsign: string; rank: string; unit: string; id: number }[];
  reportsCreated: number;
};

/** Наполняет базу dev-данными. Экспортируется ради тестов паритета. */
export async function devSeed(pool: Pool): Promise<DevSeedResult> {
  const password = DEV_ADMIN_PASSWORD_DEFAULT;

  // Пароль обязан проходить политику проекта: иначе сид создал бы бойца, чей
  // пароль панель позже откажется принять при смене (fail-fast, как в seed-admin)
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) {
    throw new Error(`Пароль dev-сида не проходит политику: ${policy.error}`);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const members: DevSeedResult["members"] = [];
  let reportsCreated = 0;
  /** Боец командира: к нему привязывается учётная запись панели */
  let commanderMemberId: number | null = null;

  for (const account of DEV_ACCOUNTS) {
    const id = await upsertMember(pool, account, passwordHash);
    if (account.key === "commander") commanderMemberId = id;
    members.push({
      id,
      callsign: account.callsign,
      rank: account.rank,
      unit: account.unit,
    });

    const created = await upsertExamReport(
      pool,
      id,
      account.callsign,
      EXAMS_BY_KEY[account.key] ?? []
    );
    if (created) reportsCreated++;
  }

  await upsertPanelUser(pool, passwordHash, commanderMemberId);

  return { password, panelUsername: DEV_PANEL_USERNAME, members, reportsCreated };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "[dev-seed] DATABASE_URL не задан. Проверьте .env " +
        "(для локального запуска нужен адрес с 127.0.0.1:5432)."
    );
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[dev-seed] ВНИМАНИЕ: NODE_ENV=production. Скрипт создаст отладочные учётные " +
        "записи в боевой базе. Прервите выполнение, если это не намеренно."
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await devSeed(pool);

    console.log("[dev-seed] Готово. Учётные записи бойцов (кабинет /profile):");
    for (const m of result.members) {
      console.log(`  ${m.callsign.padEnd(12)} ${m.rank.padEnd(14)} ${m.unit}`);
    }
    console.log("");
    console.log(`[dev-seed] Рапортов-экзаменов создано: ${result.reportsCreated}`);
    console.log("[dev-seed] Вход в панель (логин / пароль):");
    console.log(`  ${result.panelUsername} / ${result.password}`);
    console.log(`  Позывные бойцов вводятся в то же поле с тем же паролем.`);
    console.log("");
    console.log("[dev-seed] Быстрый вход: на /login откройте блок «Режим разработки».");
  } finally {
    await pool.end();
  }
}

// main() выполняется только при прямом запуске: импорт модуля из тестов
// не должен трогать БД и печатать пароль.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error("[dev-seed] Ошибка:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}