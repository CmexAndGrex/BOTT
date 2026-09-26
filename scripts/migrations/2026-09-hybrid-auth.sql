-- ============================================================================
-- Гибридная авторизация новобранцев: инкрементальная миграция
-- ============================================================================
-- Зачем этот файл, если есть drizzle-kit:
--   * `npm run drizzle-kit generate` собирает миграцию с нуля (в репозитории
--     истории миграций нет — папка drizzle/ в .gitignore, а Docker применяет
--     схему через `drizzle-kit push --force`, см. scripts/docker-migrate.sh);
--   * на уже работающей базе полный CREATE TABLE упал бы с «already exists»,
--     поэтому для существующих установок нужны только ALTER TABLE.
--
-- Применение (вручную, на копии базы сначала!):
--   psql "$DATABASE_URL" -f scripts/migrations/2026-09-hybrid-auth.sql
--
-- Развёртывание через Docker ничего применять не требует: сервис `migrate`
-- вызывает drizzle-kit push и добавит колонки сам.
-- ============================================================================

-- 1. Колонки аккаунта бойца в таблице состава подразделения ----------------
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "callsign" text;
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "password_hash" text;
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "rank" text NOT NULL DEFAULT 'Курсант';
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "unit" text;
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "status" varchar(20) NOT NULL DEFAULT 'pending';
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "role" varchar(20) NOT NULL DEFAULT 'recruit';
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "avatar_url" text;
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "application_data" jsonb;
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "member_token_version" integer NOT NULL DEFAULT 1;
ALTER TABLE "division_members" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();

-- Позывной — это логин, поэтому он уникален. NULL допускается: бойцы, заведённые
-- синхронизацией rs-red.com или Discord-ботом, могут не иметь аккаунта в панели.
CREATE UNIQUE INDEX IF NOT EXISTS "division_members_callsign_unique"
  ON "division_members" ("callsign");

-- 2. Существующие бойцы состава не должны «зависнуть» в статусе pending ----
-- Пока идентификатор в новой модели не был обязателен для старых записей, все
-- они получили бы 'pending' и не смогли бы видеть кабинет. Бойцы, уже
-- находящиеся в строю (active = true), переводятся в 'active'.
UPDATE "division_members"
   SET "status" = 'active'
 WHERE "active" = true
   AND "status" = 'pending';

-- 3. Журнал входов бойцов --------------------------------------------------
CREATE TABLE IF NOT EXISTS "member_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "member_id" integer NOT NULL,
  "kind" varchar(20) DEFAULT 'password' NOT NULL,
  "ip" varchar(100),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL
);

-- Удаление бойца уносит и его сессии, иначе журнал входов накапливал бы сирот
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'member_sessions_member_id_division_members_id_fk'
  ) THEN
    ALTER TABLE "member_sessions"
      ADD CONSTRAINT "member_sessions_member_id_division_members_id_fk"
      FOREIGN KEY ("member_id") REFERENCES "public"."division_members"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

-- 4. Проверка ---------------------------------------------------------------
-- Ожидаемые значения: все 10 колонок присутствуют, статусов pending не осталось
-- у активных бойцов.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'division_members'
   AND column_name IN ('callsign','password_hash','rank','unit','status','role',
                       'avatar_url','application_data','member_token_version','created_at')
 ORDER BY column_name;

SELECT status, count(*) FROM "division_members" GROUP BY status ORDER BY status;