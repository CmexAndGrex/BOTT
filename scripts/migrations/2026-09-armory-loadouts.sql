-- ============================================================================
-- Модуль «Арсенал» (/armory): таблица пресетов выкладок
-- ============================================================================
-- Зачем этот файл, если есть drizzle-kit:
--   * `drizzle-kit generate` собирает миграцию с нуля, но папка drizzle/ в
--     .gitignore и в репозиторий не попадает;
--   * на уже работающей базе полный CREATE TABLE упал бы с «already exists»,
--     поэтому для существующих установок нужен идемпотентный скрипт.
--
-- Применение (вручную, сначала на копии базы):
--   psql "$DATABASE_URL" -f scripts/migrations/2026-09-armory-loadouts.sql
--
-- Развёртывание через Docker ничего применять не требует: сервис `migrate`
-- вызывает drizzle-kit push и создаст таблицу сам (scripts/docker-migrate.sh).
-- ============================================================================

CREATE TABLE IF NOT EXISTS "armory_loadouts" (
  "id" serial PRIMARY KEY NOT NULL,
  -- Название комплекта: «Механик-водитель Т-90А», «Стрелок КМБТ»
  "title" text NOT NULL,
  -- Раздел каталога: 'Танковая рота' | 'Артиллерийский дивизион'
  --                  | 'Учебная часть' | 'Общий' (см. ARMORY_DIVISIONS)
  "division" varchar(64) NOT NULL,
  -- Внутренний код специальности / MOS
  "specialty_code" text,
  "description" text,
  -- Выкладка для интерфейса: ключи uniform, vest, helmet, backpack,
  -- primary_weapon, secondary_weapon, medical[{name,count}],
  -- magazines[{name,count}], misc[string]
  "equipment_breakdown" jsonb,
  -- Дословная строка для вставки в ACE Arsenal (Ctrl+V)
  "ace_import_string" text DEFAULT '' NOT NULL,
  -- Готовый массив для setUnitLoadout (Eden)
  "sqf_code" text DEFAULT '' NOT NULL,
  "created_by" text,
  -- Архив: неактивные шаблоны скрыты из каталога, но не удаляются
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Каталог: фильтр по разделу среди действующих шаблонов
CREATE INDEX IF NOT EXISTS "armory_loadouts_division_active_idx"
  ON "armory_loadouts" USING btree ("division", "is_active");

-- Проверка
-- Ожидается: 12 колонок и один индекс.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'armory_loadouts'
 ORDER BY ordinal_position;

SELECT indexname FROM pg_indexes WHERE tablename = 'armory_loadouts' ORDER BY indexname;