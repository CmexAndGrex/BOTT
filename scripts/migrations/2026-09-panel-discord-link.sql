-- ============================================================================
-- Связка учётных записей панели с Discord: инкрементальная миграция
-- ============================================================================
-- Зачем этот файл, если есть drizzle-kit:
--   * `drizzle-kit push` (сервис `migrate` в Docker) добавит колонку сам;
--   * на уже работающей базе нужен только ALTER TABLE, поэтому для установок,
--     обновляемых вручную, миграция лежит здесь.
--
-- Применение (вручную, на копии базы сначала!):
--   psql "$DATABASE_URL" -f scripts/migrations/2026-09-panel-discord-link.sql
--
-- Миграция идемпотентна: повторный запуск ничего не ломает.
-- ============================================================================

-- 1. Колонка Discord ID у учётных записей панели -----------------------------
-- nullable: вход по логину и паролю остаётся резервным способом.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_id" varchar(32);

-- 2. Уникальность: один Discord не должен уехать двум аккаунтам --------------
-- Уникальный индекс вместо констрейнта: drizzle создаёт именно его, и так
-- повторный запуск миграции не упрётся в «already exists».
CREATE UNIQUE INDEX IF NOT EXISTS "users_discord_id_unique"
  ON "users" ("discord_id");

-- 3. Проверка ---------------------------------------------------------------
-- Ожидаемые значения: колонка присутствует, тип character varying, nullable.
SELECT column_name, data_type, is_nullable, character_maximum_length
  FROM information_schema.columns
 WHERE table_name = 'users'
   AND column_name = 'discord_id';

-- Сколько аккаунтов уже привязано к Discord (после установки — 0).
SELECT count(*) AS linked_accounts FROM "users" WHERE "discord_id" IS NOT NULL;