-- ============================================================================
-- Удаление профиля бойца администратором (сохранение истории рапортов и заявок)
-- ============================================================================
-- Зачем этот файл, если есть drizzle-kit:
--   * `drizzle-kit push` (сервис `migrate` в Docker) приведёт внешние ключи к
--     схеме из src/db/schema.ts сам;
--   * на уже работающей базе нужно заменить ровно два ограничения, поэтому для
--     установок, обновляемых вручную, миграция лежит здесь.
--
-- Что решает. Профиль бойца удаляется вместе с его карточкой, сессиями
-- кабинета и снимками статистики. А вот документы штаба — рапорты
-- (service_reports) и заявки (recruit_applications) — стирать нельзя: в них
-- лежат решения модераторов и комментарии офицеров, и позывной бойца там уже
-- продублирован отдельной текстовой колонкой. Было ON DELETE CASCADE
-- (рапорты исчезали молча) и внешний ключ по умолчанию (NO ACTION — удаление
-- профиля упиралось в ошибку ограничения). Стало ON DELETE SET NULL: запись
-- остаётся, привязка к карточке обнуляется.
--
-- Применение (вручную, на копии базы сначала!):
--   psql "$DATABASE_URL" -f scripts/migrations/2026-09-member-profile-delete.sql
--
-- Миграция идемпотентна: повторный запуск ничего не ломает.
-- ============================================================================

-- 1. Рапорты действующего состава -------------------------------------------
-- Имя ограничения drizzle: <таблица>_<колонка>_<целевая таблица>_<целевая колонка>_fk
ALTER TABLE "service_reports"
  DROP CONSTRAINT IF EXISTS "service_reports_member_id_division_members_id_fk";

ALTER TABLE "service_reports"
  ADD CONSTRAINT "service_reports_member_id_division_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."division_members"("id")
  ON DELETE set null ON UPDATE no action;

-- 2. Заявки на вступление ----------------------------------------------------
ALTER TABLE "recruit_applications"
  DROP CONSTRAINT IF EXISTS "recruit_applications_member_id_division_members_id_fk";

ALTER TABLE "recruit_applications"
  ADD CONSTRAINT "recruit_applications_member_id_division_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."division_members"("id")
  ON DELETE set null ON UPDATE no action;

-- 3. Проверка ----------------------------------------------------------------
-- Ожидаемые значения confdeltype: 'n' (SET NULL) у обоих ограничений.
-- 'c' — cascade (история стирается), 'a' — no action (удаление упадёт на FK).
SELECT conname, confdeltype
  FROM pg_constraint
 WHERE conname IN (
   'service_reports_member_id_division_members_id_fk',
   'recruit_applications_member_id_division_members_id_fk'
 )
 ORDER BY conname;

-- Полный каталог ссылок на состав: что база уберёт сама, а что удержит.
--   c / n — действие выполняет PostgreSQL;
--   a / r — строку обязан очистить роут удаления, иначе DELETE упадёт на FK.
SELECT
  c.conrelid::regclass::text AS child,
  c.conname AS constraint,
  c.confdeltype::text AS action
FROM pg_constraint c
WHERE c.contype = 'f'
  AND c.confrelid = 'division_members'::regclass
ORDER BY child;