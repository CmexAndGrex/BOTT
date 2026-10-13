-- Контроль снятия ролей Discord у исключённых бойцов.
--
-- Боец может быть исключён (status = 'dismissed') по рапорту, при переводе в
-- запас или при отклонении заявки, но роли подразделения на сервере Discord
-- снимает живой человек в канале запросов ролей. Если он этого не сделал,
-- исключённый сохраняет доступ к закрытым каналам и видит внутреннюю
-- переписку — это и есть причина задачи: через 24 часа после исключения
-- планировщик напоминает комсоставу о неснятых ролях.
--
-- Почему отдельные колонки, а не существующий updated_at:
--   * updated_at меняет ЛЮБАЯ правка карточки (Discord ID, отпуск, звание),
--     поэтому «прошло ли 24 часа» по нему сдвигалось бы бесконечно;
--   * left_notified относится к другой задаче — выходу из состава ШДС по
--     синхронизации с rs-red.com, а не к исключению в панели.

-- Точное время исключения/перевода в запас. NULL — боец не исключён.
ALTER TABLE "division_members"
  ADD COLUMN IF NOT EXISTS "dismissed_at" timestamp with time zone;

-- Время отправки напоминания комсоставу. NULL — напоминание не отправлялось;
-- заполненное значение закрывает бойца для повторных проверок.
ALTER TABLE "division_members"
  ADD COLUMN IF NOT EXISTS "roles_alert_sent_at" timestamp with time zone;

-- Выборка кандидатов в фоновой задаче: status = 'dismissed'
-- AND dismissed_at <= NOW() - 24h AND roles_alert_sent_at IS NULL
-- AND discord_id IS NOT NULL, идёт по каждому циклу планировщика.
CREATE INDEX IF NOT EXISTS "division_members_roles_alert_idx"
  ON "division_members" ("status", "roles_alert_sent_at", "dismissed_at");

-- Разовая заливка уже исключённых бойцов: без неё задача увидела бы только тех,
-- кого исключат после обновления, а текущие висели бы со статусом dismissed и
-- неснятыми ролями без напоминания. Моментом исключения берётся updated_at —
-- лучшее, что есть в базе для исторических записей.
UPDATE "division_members"
   SET "dismissed_at" = "updated_at"
 WHERE "status" = 'dismissed'
   AND "dismissed_at" IS NULL;