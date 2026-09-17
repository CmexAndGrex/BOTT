/**
 * Конфиг drizzle-kit для локальной разработки.
 *
 * Раньше здесь были зашиты логин/пароль (postgres:postgres) — они попадали в
 * репозиторий. Теперь строка подключения берётся из окружения (.env), а
 * значение по умолчанию подходит только для локальной БД.
 *
 * В Docker этот конфиг не используется: сервис `migrate` генерирует
 * drizzle.docker.config.json из переменных окружения (см. scripts/docker-migrate.sh).
 */
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  // out нужен drizzle-kit для корректного разбора конфига (без него CLI
  // ошибочно выбирает не тот драйвер). Папка не коммитится — см. .gitignore.
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
});