---
name: drizzle-db
description: Use when writing database queries, changing Drizzle schema, creating PostgreSQL migrations, or handling member data integrity.
---

# PostgreSQL & Drizzle ORM Guidelines

## 1. Схема и миграции
- Файл схемы: `src/db/schema.ts`.
- Никогда не выполнять деструктивные операции `DROP COLUMN` на таблицах `division_members` и `weekly_stats`.
- При добавлении колонок всегда использовать `DEFAULT` или `nullable`, чтобы не ломать существующие записи.
- Миграции создавать через `npx drizzle-kit generate` либо класть идемпотентный SQL в `scripts/migrations/`.

## 2. Безопасность данных бойцов
- `division_members.discord_id`: поле с уникальным ограничением.
- При сохранении Discord ID проверять конфликт через `decideDiscordConflict`: если ID занят выбывшей или неактивной записью — обнулять старую запись и привязывать к действующей.
- Защищённые профили: Иванов И.А. (ID `1394327098801389762`) всегда имеет статус Старший лейтенант / Танковая рота / Зам. командира корпуса.