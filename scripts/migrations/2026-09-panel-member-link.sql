-- ============================================================================
-- Связка учётной записи панели с бойцом состава (личный кабинет по сессии панели)
-- ============================================================================
-- Зачем этот файл, если есть drizzle-kit:
--   * `drizzle-kit push` (сервис `migrate` в Docker) добавит колонку сам;
--   * на уже работающей базе нужен только ALTER TABLE + заполнение связки,
--     поэтому для установок, обновляемых вручную, миграция лежит здесь.
--
-- Что решает: вход в панель по логину и паролю не связывал аккаунт с бойцом
-- (в отличие от входа через Discord, где связь идёт по discord_id). Из-за этого
-- командир открывал /profile и видел заглушку «войдите в личный кабинет».
--
-- Применение (вручную, на копии базы сначала!):
--   psql "$DATABASE_URL" -f scripts/migrations/2026-09-panel-member-link.sql
--
-- Миграция идемпотентна: повторный запуск ничего не ломает.
-- ============================================================================

-- 1. Колонка связки ----------------------------------------------------------
-- nullable: у администратора, который ведёт бота, бойца в табеле может не быть.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "member_id" integer;

-- 2. Внешний ключ ------------------------------------------------------------
-- ON DELETE SET NULL: чистка состава не должна ломать вход в панель.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_member_id_division_members_id_fk'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_member_id_division_members_id_fk"
      FOREIGN KEY ("member_id") REFERENCES "public"."division_members"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

-- 3. Уникальность: у бойца не может быть двух учётных записей панели --------
-- Уникальный индекс вместо констрейнта: drizzle создаёт именно его, и так
-- повторный запуск миграции не упрётся в «already exists».
CREATE UNIQUE INDEX IF NOT EXISTS "users_member_id_unique"
  ON "users" ("member_id");

-- 4. Заполнение связки для уже существующих учётных записей ------------------
-- Приоритет у Discord ID: это уже подтверждённая связь (её ставит OAuth2).
UPDATE "users" u
   SET "member_id" = m."id"
  FROM "division_members" m
 WHERE u."member_id" IS NULL
   AND u."discord_id" IS NOT NULL
   AND m."discord_id" = u."discord_id";

-- Затем — по позывному: в проекте позывной это и есть логин бойца.
-- Сравнение без учёта регистра, только при отсутствии другой связи.
UPDATE "users" u
   SET "member_id" = m."id"
  FROM "division_members" m
 WHERE u."member_id" IS NULL
   AND m."callsign" IS NOT NULL
   AND lower(m."callsign") = lower(u."username")
   AND NOT EXISTS (
     SELECT 1 FROM "users" other WHERE other."member_id" = m."id"
   );

-- 5. Проверка ----------------------------------------------------------------
-- Ожидаемые значения: колонка присутствует, тип integer, nullable.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'users'
   AND column_name = 'member_id';

-- Сколько учётных записей уже связано с бойцом (после установки — сколько нашлось).
SELECT count(*) AS linked_accounts FROM "users" WHERE "member_id" IS NOT NULL;