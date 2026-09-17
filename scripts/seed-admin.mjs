#!/usr/bin/env node
/**
 * seed-admin.mjs — создание/обновление администратора панели RED OPS.
 * Вызывается из scripts/docker-migrate.sh после применения схемы БД.
 *
 * Логин и пароль администратора можно задать переменными окружения:
 *   ADMIN_USERNAME (по умолчанию "admin")
 *   ADMIN_PASSWORD (обязателен в production при первой установке)
 *
 * Безопасность пароля:
 *   - Существующий администратор НЕ перезаписывается при обычном деплое —
 *     иначе смена пароля вручную затиралась бы каждым `docker compose up`.
 *   - Сбросить пароль существующего админа можно только явным флагом
 *     ADMIN_PASSWORD_RESET=true.
 *   - В production при отсутствии администратора и незаданном ADMIN_PASSWORD
 *     скрипт завершается с ошибкой (fail-fast) вместо создания аккаунта
 *     с общеизвестным паролем.
 */
import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "[seed-admin] DATABASE_URL не задан. Проверьте, что файл .env существует " +
      "и в нём есть DATABASE_URL (или переменная задана в окружении)."
  );
  process.exit(1);
}

const username = (process.env.ADMIN_USERNAME || "admin").trim();
if (!username) {
  console.error("[seed-admin] ADMIN_USERNAME пуст");
  process.exit(1);
}

const rawPassword = process.env.ADMIN_PASSWORD || "";
const password = rawPassword.trim();
const resetRequested = process.env.ADMIN_PASSWORD_RESET === "true";
const isProduction = process.env.NODE_ENV === "production";
/** Пароль, который нельзя использовать для создания нового админа */
const KNOWN_DEFAULT = "admin-password";

/**
 * Та же политика, что и в панели (src/lib/password-policy.ts).
 * Дублируется здесь, потому что скрипт запускается отдельным процессом до
 * сборки приложения и не может импортировать TypeScript-модуль.
 */
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 72;
const WEAK_PASSWORDS = new Set([
  "password", "password1", "passw0rd", "пароль", "пароль123",
  "qwerty", "qwerty123", "qwertyuiop", "1234567890", "12345678",
  "admin", "admin123", "adminadmin", "administrator", "admin-password",
  "letmein", "welcome", "changeme", "iloveyou", "monkey", "dragon",
  "11111111", "00000000", "87654321", "abc12345", "asdfghjkl",
]);

/** Проверка пароля по политике. null — пароль допустим */
function passwordPolicyError(value) {
  if (typeof value !== "string" || !value) return "Пароль не задан";
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Пароль слишком короткий: минимум ${PASSWORD_MIN_LENGTH} символов`;
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return `Пароль слишком длинный: максимум ${PASSWORD_MAX_LENGTH} символов`;
  }
  if (WEAK_PASSWORDS.has(value.toLowerCase())) {
    return "Пароль слишком распространён — выберите другой";
  }
  // Косметические вариации слабых слов («Пароль12345!») тоже отклоняем
  const base = value.toLowerCase().replace(/[^a-zа-яё]/g, "");
  if (
    base.length >= 4 &&
    ["password", "passwd", "пароль", "qwerty", "qwert", "admin", "letmein",
     "welcome", "changeme", "iloveyou", "monkey", "dragon", "abc123", "asdf",
     "secret", "root", "test", "guest"].some((w) => base.startsWith(w) || base === w)
  ) {
    return "Пароль построен на распространённом слове — выберите другой";
  }
  if (/^(.)\1+$/.test(value)) {
    return "Пароль не должен состоять из одного повторяющегося символа";
  }
  const groups =
    Number(/[a-zа-яё]/.test(value)) +
    Number(/[A-ZА-ЯЁ]/.test(value)) +
    Number(/\d/.test(value)) +
    Number(/[^\wа-яёА-ЯЁ]/.test(value));
  if (groups < 2) {
    return "Пароль должен содержать минимум два вида символов: строчные, прописные, цифры или знаки";
  }
  if (/^(?:19|20)\d{2}\d{2}\d{2}$/.test(value)) return "Пароль не должен быть датой";
  return null;
}

// Явный таймаут подключения: не даёт сервису `migrate` зависнуть
// навсегда, если БД недоступна.
const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10_000,
});

async function main() {
  const existing = await pool.query(
    "SELECT id, role, password_hash FROM users WHERE username = $1",
    [username]
  );

  if (existing.rowCount > 0) {
    // Админ уже есть: пароль в обычном режиме НЕ трогаем — только гарантируем роль.
    if (existing.rows[0].role !== "admin") {
      await pool.query("UPDATE users SET role = $1 WHERE username = $2", [
        "admin",
        username,
      ]);
      console.log(
        `[seed-admin] Аккаунт «${username}» повышен до роли admin (пароль не изменён).`
      );
    } else {
      console.log(
        `[seed-admin] Администратор «${username}» уже существует — пароль не изменён.`
      );
    }

    if (resetRequested) {
      if (!password) {
        console.error(
          "[seed-admin] ADMIN_PASSWORD_RESET=true, но ADMIN_PASSWORD не задан — сброс отменён."
        );
        process.exit(1);
      }
      const policyError = passwordPolicyError(password);
      if (policyError) {
        console.error(`[seed-admin] Слабый пароль для сброса: ${policyError}`);
        process.exit(1);
      }
      const passwordHash = await bcrypt.hash(password, 10);
      // Инкремент token_version разом отзывает все ранее выданные сессии
      // этого администратора (смена пароля = принудительный выход).
      await pool.query(
        "UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE username = $2",
        [passwordHash, username]
      );
      console.log(
        `[seed-admin] Пароль администратора «${username}» сброшен (ADMIN_PASSWORD_RESET=true), старые сессии отозваны.`
      );
      console.warn(
        "[seed-admin] Не забудьте убрать ADMIN_PASSWORD_RESET из .env после сброса."
      );
    }
    return;
  }

  // Администратора ещё нет — создаём первого.
  if (!password) {
    if (isProduction) {
      console.error(
        "[seed-admin] Администратор отсутствует, а ADMIN_PASSWORD не задан.\n" +
          "            В production создание аккаунта с паролем по умолчанию запрещено.\n" +
          "            Задайте ADMIN_PASSWORD (32+ случайных символа) в .env и перезапустите миграцию."
      );
      process.exit(1);
    }
    console.warn(
      `[seed-admin] ВНИМАНИЕ: ADMIN_PASSWORD не задан — создаю администратора «${username}» ` +
        `с паролем по умолчанию «${KNOWN_DEFAULT}». Смените его сразу после входа!`
    );
  } else {
    // Пароль задан явно — проверяем по политике даже в dev,
    // чтобы «слабый» пароль не уехал в продакшен вместе с настройками
    const policyError = passwordPolicyError(password);
    if (policyError) {
      console.error(`[seed-admin] Пароль не соответствует политике: ${policyError}`);
      console.error(
        "[seed-admin] Требования: минимум 10 символов и минимум два вида символов " +
          "(строчные/прописные/цифры/знаки), без распространённых паролей и дат."
      );
      process.exit(1);
    }
  }

  const passwordHash = await bcrypt.hash(password || KNOWN_DEFAULT, 10);
  // ON CONFLICT DO NOTHING: гонка двух миграций не создаст дубль и не затрёт пароль
  const inserted = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) " +
      "ON CONFLICT (username) DO NOTHING",
    [username, passwordHash, "admin"]
  );

  if (inserted.rowCount > 0) {
    console.log(`[seed-admin] Создан администратор «${username}».`);
    if (!password) {
      console.warn(
        "[seed-admin] ВАЖНО: используется пароль по умолчанию. Смените его сразу после первого входа в панель."
      );
    }
  } else {
    console.log(
      `[seed-admin] Администратор «${username}» создан параллельным запуском — изменений не требуется.`
    );
  }
}

try {
  await main();
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error("[seed-admin] Ошибка:", e && e.message ? e.message : e);
  try {
    await pool.end();
  } catch {
    /* пул уже закрыт или не открывался */
  }
  process.exit(1);
}