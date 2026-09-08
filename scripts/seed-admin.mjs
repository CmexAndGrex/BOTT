#!/usr/bin/env node
/**
 * seed-admin.mjs — создание/обновление администратора панели RED OPS.
 * Вызывается из scripts/docker-migrate.sh после применения схемы БД.
 *
 * Логин и пароль администратора можно задать переменными окружения:
 *   ADMIN_USERNAME (по умолчанию "admin")
 *   ADMIN_PASSWORD (по умолчанию "admin-password" — СМЕНИТЕ при первом входе!)
 *
 * Скрипт идемпотентен: повторный запуск обновляет пароль и роль,
 * не создавая дубликатов (upsert по уникальному полю username).
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
const password = process.env.ADMIN_PASSWORD || "admin-password";

if (!username) {
  console.error("[seed-admin] ADMIN_USERNAME пуст");
  process.exit(1);
}
if (!password) {
  console.error("[seed-admin] ADMIN_PASSWORD пуст");
  process.exit(1);
}

// Явный таймаут подключения: не даёт сервису `migrate` зависнуть
// навсегда, если БД недоступна.
const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10_000,
});

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await pool.query(
    "SELECT id FROM users WHERE username = $1",
    [username]
  );

  if (existing.rowCount > 0) {
    await pool.query(
      "UPDATE users SET password_hash = $1, role = $2 WHERE username = $3",
      [passwordHash, "admin", username]
    );
    console.log(`[seed-admin] Администратор «${username}» обновлён (пароль и роль).`);
  } else {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)",
      [username, passwordHash, "admin"]
    );
    console.log(`[seed-admin] Создан администратор «${username}».`);
  }

  if (!process.env.ADMIN_PASSWORD) {
    console.warn(
      "[seed-admin] ВАЖНО: используется пароль по умолчанию «admin-password»." +
        "\n            Задайте ADMIN_PASSWORD в .env и перезапустите миграцию, либо" +
        "\n            смените пароль сразу после первого входа в панель."
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