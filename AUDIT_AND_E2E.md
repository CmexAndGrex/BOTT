# Функциональный аудит и E2E‑тестирование — ATK RED

> Документ содержит две части:
> 1. **Отчёт аудита** — анализ модулей (ШДС/личный состав, экзамены, контроль онлайна) и найденных уязвимостей с группировкой по severity.
> 2. **E2E‑чек‑лист** — пошаговая инструкция ручной проверки всех модулей при локальном запуске.
>
> Всё описание проверено по фактическому коду проекта (Next.js App Router, Drizzle ORM/PostgreSQL, Discord REST).

---

## Часть 1. Отчёт аудита

### 0. Карта модулей (что где лежит)

| Модуль | Страницы | API‑роуты | Домен‑модули |
|---|---|---|---|
| ШДС / личный состав | [`/members`](src/app/members/page.tsx:1), [`/roster`](src/app/roster/page.tsx:1) | [`/api/members`](src/app/api/members/route.ts:1), [`/api/members/[id]`](src/app/api/members/[id]/route.ts:1), [`/api/admin/roster/[id]/discord-id`](src/app/api/admin/roster/[id]/discord-id/route.ts:1), [`/api/admin/members/[id]`](src/app/api/admin/members/[id]/route.ts:1), [`/api/sync`](src/app/api/sync/route.ts:1) | [`recruits.ts`](src/lib/recruits.ts:1), [`gsheets.ts`](src/lib/gsheets.ts), [`tasks.ts`](src/lib/tasks.ts:1), [`member-deletion.ts`](src/lib/member-deletion.ts) |
| Экзамены / аттестация | [`/exams`](src/app/exams/page.tsx:1), [`/apply`](src/app/apply/page.tsx:1), [`/admin/recruits`](src/app/admin/recruits/page.tsx:1), [`/admin/reports`](src/app/admin/reports/page.tsx:1) | [`/api/member/reports`](src/app/api/member/reports/route.ts:1), [`/api/admin/reports`](src/app/api/admin/reports/route.ts:1), [`/api/admin/recruits/[id]`](src/app/api/admin/recruits/[id]/route.ts:1), [`/api/apply`](src/app/api/apply/route.ts:1), [`/api/member/dossier`](src/app/api/member/dossier/route.ts:1) | [`exams.ts`](src/lib/exams.ts:1), [`reports.ts`](src/lib/reports.ts:1), [`review.ts`](src/lib/review.ts:1), [`vehicles.ts`](src/lib/vehicles.ts) |
| Контроль онлайна | [`/control`](src/app/control/page.tsx:1) | [`/api/control`](src/app/api/control/route.ts:1), [`/api/warn`](src/app/api/warn/route.ts:1), [`/api/stats`](src/app/api/stats/route.ts:1), [`/api/actions`](src/app/api/actions/route.ts:1) | [`tasks.ts`](src/lib/tasks.ts:1), [`validation.ts`](src/lib/validation.ts:1), [`roles-monitor.ts`](src/lib/roles-monitor.ts) |
| Авторизация | [`/login`](src/app/login/page.tsx:1) | [`/api/auth/dev-login`](src/app/api/auth/dev-login/route.ts:1), [`/api/auth/member-login`](src/app/api/auth/member-login/route.ts), [`/api/me`](src/app/api/me/route.ts:1) | [`member-auth.ts`](src/lib/member-auth.ts:1), [`api-auth.ts`](src/lib/api-auth.ts:1), [`panel-rights.ts`](src/lib/panel-rights.ts:1), [`dev-accounts.ts`](src/lib/dev-accounts.ts:1) |

Точки входа (`middleware`) и CSRF‑правила собраны в [`src/middleware.ts`](src/middleware.ts:1) и [`src/lib/csrf.ts`](src/lib/csrf.ts).

---

### 1. Модуль ШДС и управление личным составом

#### 1.1 Создание / редактирование / архивация бойца

**Добавление бойца** происходит двумя путями:

- *Самостоятельный рапорт* → [`/api/apply`](src/app/api/apply/route.ts:1) создаёт бойца со `status: "pending"`, `role: "recruit"`, `unit: null`.
- *Одобрение штабом* → [`approveRecruitApplication()`](src/lib/review.ts:516) создаёт бойца со `status: "active"`, генерирует временный пароль (`generateTempPassword`) и хеширует его bcryptjs (10 раундов). Пароль уходит рекруту в ЛС Discord, а при закрытых ЛС возвращается офицеру в ответе API.
- *Синхронизация* → [`syncRoster()`](src/lib/tasks.ts:104) подтягивает строки с rs‑red.com и **не трогает** локальные поля (`discordId`, `vacation`, `warnings`) — приоритет у панели.

**Обязательные поля** (по [`division_members`](src/db/schema.ts:45) и валидаторам):

| Поле | Обязательно? | Где проверяется |
|---|---|---|
| `pid` | нет (`unique`, nullable) | приходит из синка rs‑red.com |
| `name` | да (`notNull`) | equal to callsign при создании |
| `rank_name` | нет (`rank` имеет `default("Курсант")`) | [`recruits.ts RANKS`](src/lib/recruits.ts) |
| `post` | нет | свободный текст, валидируется в контексте |
| `discord_id` | нет (`unique`, nullable) | [`validateRosterDiscordId`](src/lib/validation.ts:83) при ручном вводе |

**Валидация уникальных полей и дубликатов:**

- `callsign` — `unique`; при подаче рапорта дубликат → 409 «Позывной уже занят» ([`/api/apply`](src/app/api/apply/route.ts:246)).
- `discord_id` — `unique`; дубликат ловится в трёх местах: [`/api/members/[id]`](src/app/api/members/[id]/route.ts:74), [`/api/admin/roster/[id]/discord-id`](src/app/api/admin/roster/[id]/discord-id/route.ts:128), [`/api/apply`](src/app/api/apply/route.ts:255). Везде 409.
- Повторное одобрение заявки (бот упал на полпути) обрабатывается идемпотентно через [`lookupCallsignForApplication()`](src/lib/review.ts:145): «свежая» карточка новобранца распознаётся как созданная этой же заявкой → процедура доводится до конца.
- Правка `callsign` синхронизирует `name` (см. [`buildPatch()`](src/app/api/admin/recruits/[id]/route.ts:172)).

**Архивация / увольнение:**

- Перевод в запас (рапорт `reserve`) → [`applyReport()` case "reserve"](src/lib/review.ts:1109): строка ШДС уезжает на лист «Запас», в БД ставится `active=false`, `status="dismissed"` + [`statusTrackingFields()`](src/lib/roles-monitor.ts) для отсчёта контроля ролей.
- Полное удаление профиля — **строго администратор**: [`/api/admin/members/[id]`](src/app/api/admin/members/[id]/route.ts:1) в транзакции чистит связи (сессии, weekly_stats, строгие FK из `pg_constraint`) и требует ввести позывной для подтверждения.

#### 1.2 Отпуск (`vacation`, `vacationUntil`) и напоминания

- Статус отпуска меняется через [`PATCH /api/members/[id]`](src/app/api/members/[id]/route.ts:36). Снятие отпуска принудительно ставит `status = active`, чтобы боец вернулся в рабочий строй (онлайн‑норма и снапшоты снова его считают).
- `vacationUntil` парсится и валидируется как дата; некорректная строка превращается в `null`.
- Напоминание за 24 часа реализовано полем [`vacationNotified`](src/db/schema.ts:56) и сбрасывается при выставлении отпуска из рапорта ([`applyReport()`](src/lib/review.ts:1073)).
- Роль «Отпуск» выдаётся ботом как «мягкий» шаг: сбой Discord не отменяет статус в БД (см. `safeDiscord`).

#### 1.3 Точки отказа при пустых ключах Google/Discord

| Ситуация | Поведение |
|---|---|
| Нет `CRON_SECRET` | [`authorizeCron()`](src/lib/api-auth.ts:326) → 503, роут отключён |
| Заглушка‑секрет в production | [`authorizeCron()`](src/lib/api-auth.ts:342) → 503 |
| Нет cookie rs‑red.com | [`syncRoster()`](src/lib/tasks.ts:109) → `ok:false`, `NO_COOKIE`, запись в журнал |
| Нет `discord_token` | [`/api/warn`](src/app/api/warn/route.ts:84) → 400 «Настройте Discord», **счётчик НЕ растёт** |
| Не задан канал Discord | [`publishReviewMessage()`](src/lib/review.ts:1239) → рапорт остаётся в БД и виден в панели |
| Не настроен сервисный аккаунт Google | [`addToShdsSheet()`](src/app/api/admin/recruits/[id]/route.ts:340) → `ok:false`, решение штаба всё равно сохраняется |

Ключевая архитектурная гарантия: **Discord и Google обрабатываются как «мягкие» внешние сервисы** — их сбой никогда не откатывает решение штаба (см. [`safeDiscord`](src/lib/review.ts:91) и порядок шагов в [`approveServiceReport()`](src/lib/review.ts:1288)).

---

### 2. Экзамены, аттестация и допуски к технике

#### 2.1 Жизненный цикл экзамена

1. **Подача** — боец через кабинет ([`/api/member/reports`](src/app/api/member/reports/route.ts:82)) отправляет рапорт `type: "exam"`. Payload проходит доменный [`validateReportPayload()`](src/lib/reports.ts), который сверяет нормативы с каталогом (`EXAM_GRADES`, `EXAM_CATALOG`). КМБТ — без оценки (`graded:false`).
2. **Публикация** — рапорт записывается в `service_reports` со `status:"pending"` и (при настроенном канале) публикуется в Discord с кнопками «Одобрить/Отклонить» ([`publishReviewMessage()`](src/lib/review.ts:1232)).
3. **Решение** — и кнопки Discord, и панель ([`/api/admin/reports` POST](src/app/api/admin/reports/route.ts:145)) вызывают **одни и те же** [`approveServiceReport()`](src/lib/review.ts:1288) / [`rejectServiceReport()`](src/lib/review.ts:1347). Это гарантирует, что решения из сайта и из Discord не разойдутся.
4. **Применение** ([`applyReport()`](src/lib/review.ts:847)) — закрашивает столбцы в ШДС через [`columnExamFor()`](src/lib/reports.ts), проставляет оценки по столбцам (`examGrades`), и **автоматически закрывает «Берет»**, когда сданы все 4 норматива ([`isBeretPassed()`](src/lib/exams.ts)).

#### 2.2 Меняются ли звание / должность / допуски после одобрения

- **Допуски** — да: столбцы закрашиваются, а [`getAvailableVehicles()`](src/lib/vehicles.ts) пересчитывает матрицу техники в [`/api/member/dossier`](src/app/api/member/dossier/route.ts:125).
- **Должность** — меняется только рапортом `role` / `position_transfer` ([`applyReport()`](src/lib/review.ts:978)). При `position_transfer` сначала проверяются обязательные нормативы секции ([`missingSectionExams()`](src/lib/reports.ts)), строка переезжает в ШДС, и только потом обновляется `post` — при сбое Google таблица и БД не расходятся.
- **Звание** — автоматически **не меняется**: по свободному тексту это небезопасно, штаб выдаёт вручную (см. комментарий в [`applyReport()` case "role"](src/lib/review.ts:978)).

#### 2.3 Уведомление / роль в Discord после сдачи

- Роль «Берет» выдаётся сразу при закрытии (через [`addGuildMemberRole`](src/lib/review.ts:961)).
- Прочие роли — только текстовая пометка «выдаёт штаб в канале запросов ролей». Фоновая сверка [`role-sync.ts`](src/lib/role-sync.ts) догоняет расхождения.

#### 2.4 Сидирование тестовых экзаменов ([`scripts/dev-seed.ts`](scripts/dev-seed.ts:1))

Скрипт создаёт **трёх бойцов** из [`DEV_ACCOUNTS`](src/lib/dev-accounts.ts:73) и для каждого — один `approved` рапорт‑экзамен:

| Аккаунт | Позывной | Подразделение | Нормативы в сиде |
|---|---|---|---|
| commander | Волков | Танковая рота | — (нет) |
| tank | Сокол | Танковая рота | КМБТ, Снаряжение…, Огневая подготовка |
| artillery | Буря | Артиллерийский дивизион | КМБТ, Миномётное дело (Экзамен) |

Рапорт создаётся со `status='approved'`, чтобы кабинет сразу показывал не пустую матрицу допусков. Идемпотентно: повторный запуск обновляет тот же рапорт, а не плодит дубли. Также создаётся учётная запись панели `dev-commander` (роль `admin`) со связкой `member_id` командира.

> Примечание: сид создаёт **одобренные** рапорты. Чтобы протестировать именно цикл «подача → одобрение», нужно подать новый рапорт из UI и одобрить его (см. чек‑лист, сценарий B).

---

### 3. Модуль контроля онлайна и дисциплины (`/control`)

#### 3.1 Цепочка чтения

[`/control/page.tsx`](src/app/control/page.tsx:40) делает три запроса параллельно: `/api/control`, `/api/stats`, `/api/me`.

- [`/api/control`](src/app/api/control/route.ts:1) — гвард [`requireStaff`](src/lib/member-auth.ts:450); читает `active`‑бойцов (**фильтр по `unit` для командира**), подтягивает `weekly_stats` и привязывает до 4 последних недель к каждому бойцу.
- [`/api/stats`](src/app/api/stats/route.ts:24) — норма часов и живые срезы.
- [`/api/me`](src/app/api/me/route.ts:30) — флаги `isCommander`/`isAdmin` считаются единым правилом [`resolvePanelRights()`](src/lib/panel-rights.ts:164).

#### 3.2 Выдача предупреждений ([`/api/warn`](src/app/api/warn/route.ts:1))

Кнопки `1/2 Пред.` и `2/2 Пред.` ([`control/page.tsx`](src/app/control/page.tsx:203)) шлют `POST /api/warn` с `{ memberId, type, norm }`.

Логика счётчика — [`nextWarningCount()`](src/lib/validation.ts:155): **только растёт**, повторная «1/2» не сбрасывает накопленное, явная «2/2» доводит до максимума (2). Текст в Discord строится по фактическому счётчику, чтобы не писать «1/2» при уже 2/2.

Антиспам — [`CooldownLimiter`](src/lib/validation.ts:167) с ключом `оператор:боец` (разные офицеры не мешают друг другу).

IDOR‑защита — боец чужого подразделения отклоняется 403, кроме админа ([`/api/warn`](src/app/api/warn/route.ts:61)).

#### 3.3 Поведение при отсутствии `discord_id` или токена бота

Порядок проверок в [`/api/warn`](src/app/api/warn/route.ts:77):

1. если `discord_id` нет → пинг‑текст подставляет **имя бойца** вместо `<@id>` (`ping = fighter.discordId ? ...: fighter.name`) — **не падает**;
2. если ID канала невалиден → 400 до любого сетевого запроса;
3. если нет `botToken` → 400 «Настройте Discord»;
4. сообщение отправляется в Discord **до** записи счётчика: при ошибке Discord (400/404/сеть) возвращается 400, а `warnings` **не увеличивается** — боец не получает «исключение 2/2» без самого предупреждения.

**Вывод: безопасного локального fallback‑лога без токена нет — запрос честно вернёт 400 и предупреждение не сохранится.** Это осознанное решение (не «притворяться успешным»). Если для локального стенда нужен «сухой прогон», токен и канал должны быть заданы (можно тестовые, из вашего нового канала).

---

### 4. Найденные уязвимости и логические баги

#### 🔴 [CRITICAL]

**C‑1. Утечка `password_hash` и `member_token_version` из `/api/control`.**
Файл: [`src/app/api/control/route.ts:21-37`](src/app/api/control/route.ts:21).

```ts
const activeMembers = auth.member.unit
  ? await db.select().from(members).where(...)   // ← полная строка
  : await db.select().from(members).where(eq(members.active, true));
...
const data = activeMembers.map((fighter) => ({ ...fighter, stats: fighterStats }));
```

`db.select().from(members)` возвращает **все** колонки, включая `passwordHash`, `memberTokenVersion`, `applicationData`. Эти поля уезжают в браузер любого пользователя, прошедшего `requireStaff` (в т.ч. командира‑офицера). Хеш пароля другого бойца/администратора оказывается в JSON и в DevTools.

*Исправление* — выбрать только безопасные поля (по образцу [`/api/members`](src/app/api/members/route.ts:50)):

```ts
const rows = await db
  .select({
    id: members.id, name: members.name, rankName: members.rankName,
    post: members.post, hours: members.hours, vacation: members.vacation,
    active: members.active, warnings: members.warnings,
    callsign: members.callsign, unit: members.unit, discordId: members.discordId,
  })
  .from(members)
  .where(whereClause);
```

#### 🟠 [MAJOR]

**M‑1. Отсутствие проверки подразделения (IDOR) в правке состава.**
Файлы: [`src/app/api/members/[id]/route.ts:18`](src/app/api/members/[id]/route.ts:18), [`src/app/api/admin/roster/[id]/discord-id/route.ts:89`](src/app/api/admin/roster/[id]/discord-id/route.ts:89).

Оба роута проверяют только `requireRosterEditor`, но **не сверяют `unit` оператора с `unit` бойца** (в отличие от [`/api/warn`](src/app/api/warn/route.ts:61)). Командир «Танковой роты» по прямому знанию чужого `memberId` может поставить/снять отпуск и изменить Discord ID бойцу «Артиллерийского дивизиона», в т.ч. переписав ячейку ШДС.

*Исправление* — добавить ту же проверку подразделения, что в `/api/warn` (с исключением для `admin`).

**M‑2. Небезопасный порядок в `syncRoster`: настройки читаются вне `try`.**
Файл: [`src/lib/tasks.ts:107-108`](src/lib/tasks.ts:104).

`const map = await getSettings(true)` стоит **до** `try`, поэтому при сбое чтения настроек исключение вылетает наружу, а вызывающий роут [`/api/sync`](src/app/api/sync/route.ts:18) не оборачивает вызов в `try/catch` → необработанный reject на уровне route handler. Перенести получение настроек внутрь `try`.

**M‑3. Отсутствие scoping по подразделению в решениях штаба.**
Файлы: [`src/app/api/admin/reports/route.ts:145`](src/app/api/admin/reports/route.ts:145), [`src/app/api/admin/recruits/[id]/route.ts:54`](src/app/api/admin/recruits/[id]/route.ts:54).

Командир одного подразделения может одобрять/отклонять рапорты и заявки любого подразделения и назначать любое `unit` при зачислении. Если это не задумано как «общий штаб» — нужна фильтрация, аналогичная `/api/control`.

**M‑4. Полный скан `weekly_stats` для всех бойцов при каждом заходе на `/control`.**
Файл: [`src/app/api/control/route.ts:29`](src/app/api/control/route.ts:29). `db.select().from(weeklyStats)` тянет всю историю, а фильтрация по бойцу делается в JS. На большом составе это лишняя нагрузка — стоит ограничить выборку join/`inArray` по `memberId` отобранных бойцов.

**M‑5. `runWeeklyRecord` выполняет по 2 запроса на каждого бойца в цикле.**
Файл: [`src/lib/tasks.ts:466`](src/lib/tasks.ts:466). При 300 бойцах — 600 последовательных запросов. Рекомендуется batch‑insert через `values([...])`.

#### 🟡 [MINOR]

**m‑1. Ошибочный fallback автора в логах `/api/warn`.**
Файл: [`src/app/api/warn/route.ts:43`](src/app/api/warn/route.ts:43). Ключ `operator.id || operator.callsign || "unknown"`: у панельного админа без связки `id = 0` (фalsy) → используется `callsign`, что нормально, но для чистой карточки (`EMPTY_SESSION_MEMBER`) оба пусты → ключ `"unknown"` для всех таких операторов, из‑за чего разные админы делят один ключ лимита. Лучше `operator.id || operator.callsign || auth.user?.username`.

**m‑2. `/api/members` отдаёт гостям `hours`, `warnings`, `status`.**
Файл: [`src/app/api/members/route.ts:49`](src/app/api/members/route.ts:49). Технические данные (онлайн, предупреждения) видны всем без авторизации. Для внутренней панели обычно приемлемо, но стоит подтвердить требование.

**m‑3. Мелкие расхождения типов Drizzle.**
Файл: [`src/app/api/admin/recruits/[id]/route.ts:273`](src/app/api/admin/recruits/[id]/route.ts:273). `values.memberTokenVersion = sql\`...\`` приводится через `as unknown as number` — обход типизации, хрупко при обновлении схемы.

**m‑4. Отсутствие `try/catch` вокруг записи в БД в нескольких роутах.**
Пример: [`src/app/api/members/[id]/route.ts:92`](src/app/api/members/[id]/route.ts:92) — `db.update(...).returning()` не обёрнут. Next вернёт 500, но клиент не получит осмысленного сообщения. Желательно единообразие с `/api/warn`, где есть общий `catch`.

**m‑5. `applyReport` case "role" принимает `role.post` в БД.**
Файл: [`src/lib/review.ts:983`](src/lib/review.ts:983). Значение проходит через `validateReportPayload`, но стоит подтвердить, что список допустимых должностей закрыт — иначе свободный текст попадёт в `post` и в ШДС.

#### Что проверено и **не** является проблемой

- **Публичный табель безопасен**: [`/api/members`](src/app/api/members/route.ts:76) обнуляет `discordId` для гостей на сервере, а не только в разметке.
- **CSRF**: небезопасные методы к cookie‑роутам отсекаются в [`middleware`](src/middleware.ts:155) и продублированы в роутах (`isCrossSiteRequest`).
- **Dev‑login защищён двумя ключами**: [`isDevLoginEnabled()`](src/lib/dev-accounts.ts:131) требует `NODE_ENV !== production` **и** `ENABLE_DEV_LOGIN === "true"`, иначе 404.
- **CRON_SECRET**: сравнение через `timingSafeEqual`, заглушки и пустое значение запрещены ([`authorizeCron()`](src/lib/api-auth.ts:326)).
- **Управление ролями и званиями** намеренно не автоматизировано — защита от самоповышения.
- **Идемпотентность зачисления** решена через `lookupCallsignForApplication`.
- **Транзакция удаления профиля** с чистой зависимостей по `pg_constraint` и аудитом после COMMIT.

#### Вердикт

`REQUEST_CHANGES` — блокером является **C‑1** (утечка хешей паролей из `/api/control`). M‑1 (IDOR по подразделению) следует закрыть до сдачи стенда. Остальное — улучшения.

---

## Часть 2. E2E‑чек‑лист (ручная проверка)

### Предварительные требования

1. **Зависимости и БД:**
   ```cmd
   npm install
   ```
   В `.env` заданы `DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET`.
2. **dev‑вход** (для сценариев под командиром):
   ```cmd
   set ENABLE_DEV_LOGIN=true
   ```
   > На боевом стенде переменную не задавать никогда.
3. **Сидирование**:
   ```cmd
   npm run dev:seed
   ```
4. **Запуск приложения:**
   ```cmd
   npm run dev
   ```
   Приложение — `http://localhost:3000`.
5. **Discord** (для сценариев с пинком/ролью): в `Settings → Discord` задать `discord_token`, `discord_channel_id` (ваш новый тестовый канал) и тестовую ШДС‑таблицу. Без токена `/api/warn` ожидаемо вернёт 400 (см. §3.3).

---

### Сценарий «0»: вход

#### 0.1 Вход под админом/командиром через dev‑логин

1. Открыть [`/login`](src/app/login/page.tsx:1).
2. Нажать кнопку **«Войти как Волков Д. В. (Командир)»** (блок «Dev Login» виден только при `ENABLE_DEV_LOGIN=true`).
3. Убедиться: редирект на `/profile`, в сайдбаре появилась секция «УПРАВЛЕНИЕ».
4. Проверить `GET /api/me`:

   ```cmd
   curl -i http://localhost:3000/api/me
   ```
   Ожидаем `"isCommander": true, "isAdmin": true, "cabinet": "ok"`.

#### 0.2 Вход под бойцом

1. На `/login` нажать **«Войти как боец Танковой роты»** (Сокол).
2. Ожидаем: `/profile`, секции «УПРАВЛЕНИЕ» **нет**, кнопки предупреждений в `/control` недоступны.

#### 0.3 Ошибочный сценарий

1. На `/login` ввести логин `dev-commander`, пароль `неверный`.
2. Ожидаем: сообщение об ошибке, **без** создания сессии.

---

### Сценарий «A»: создание нового бойца в ШДС

1. Войти под админом (сценарий 0.1).
2. Открыть [`/admin/recruits`](src/app/admin/recruits/page.tsx:1) — очередь заявок.
3. Проверить очередь через API:
   ```cmd
   curl -s "http://localhost:3000/api/admin/recruits?status=pending"
   ```
   Ожидаем `{"ok":true,"recruits":[...]}`.
4. **Подать заявку как кандидат** (имитация с фронта):
   ```cmd
   curl -i -X POST http://localhost:3000/api/apply ^
     -H "Content-Type: application/json" ^
     -d "{\"callsign\":\"Тест-Боец\",\"password\":\"TestPass-2026!x\",\"age\":25,\"armaExperience\":\"500 часов\",\"specialization\":\"Танкист\",\"comment\":\"тест\"}"
   ```
   Ожидаем `ok:true`, `id` заявки. **Проверить отрицательный кейс:** повторить тот же запрос → 409 «Позывной уже занят».
5. Открыть `/admin/recruits`, найти заявку «Тест‑Боец».
6. **Одобрить** через API (аналог кнопки «Одобрить»):
   ```cmd
   curl -i -X PATCH http://localhost:3000/api/admin/recruits/<ID_БОЙЦА> ^
     -H "Content-Type: application/json" ^
     -d "{\"id\":<ID_БОЙЦА>,\"action\":\"approve\",\"unit\":\"Танковая рота\",\"rank\":\"Рядовой\"}"
   ```
   Проверить тело ответа: `sheets.ok` и предупреждение, если Google недоступен (решение всё равно сохранено).
7. Проверить, что боец появился в табеле:
   ```cmd
   curl -s http://localhost:3000/api/members
   ```
8. Проверить создание без подразделения (негатив): `action:"approve"` без `unit` → 400 «Выберите подразделение».

---

### Сценарий «B»: отправка и проверка экзамена

1. Боец («Сокол») — открыть [`/exams`](src/app/exams/page.tsx:1), вкладка «Механик‑водитель».
2. Нажать **«Сдать норматив»** у нужного норматива → откроется модальное окно рапорта с предвыбранным пунктом.
3. Альтернатива через API (от имени бойца, cookie `member_token`):
   ```cmd
   curl -i -X POST http://localhost:3000/api/member/reports ^
     -H "Content-Type: application/json" ^
     -b "member_token=<ВАШ_ТОКЕН>" ^
     -d "{\"type\":\"exam\",\"payload\":{\"exams\":[{\"exam_code\":\"Огневая подготовка\",\"grade\":\"Отлично\"}]}}"
   ```
   Ожидаем `ok:true`, `published` (true/false в зависимости от настроек Discord).
4. **Проверить негативный кейс**: тот же запрос с нормативом «Берет» → должен быть отклонён валидатором (производный норматив нельзя сдать вручную).
5. Штаб — открыть [`/admin/reports`](src/app/admin/reports/page.tsx:1), найти рапорт.
6. **Одобрить** через API:
   ```cmd
   curl -i -X POST http://localhost:3000/api/admin/reports ^
     -H "Content-Type: application/json" ^
     -d "{\"scope\":\"report\",\"action\":\"approve\",\"id\":<ID_РАПОРТА>}"
   ```
7. Проверить результат:
   - в ШДС закрасился столбец норматива;
   - `GET /api/member/dossier` (от бойца) вернул норматив в `serviceSummary.qualifications`;
   - на `/exams` бейдж стал зелёным.
8. **Проверить повторное решение**: повторить approve того же рапорта → 409 «Решение по этой записи уже принято».
9. **Проверить «Берет»**: одобрить все 4 норматива (`Топография`, `Связь`, `Строевая подготовка`, `Должностные лица`) → в ответе одобрения должно появиться «выдана роль «Берет»» (при настроенном `guild_id`).

---

### Сценарий «C»: `/control` и предупреждения

1. Войти под командиром, открыть [`/control`](src/app/control/page.tsx:1).
2. Проверить таблицу: до 4 недель истории, текущая живая неделя, бейдж предупреждений.
3. **Нажать «1/2 Пред»** у должника → подтвердить в диалоге.
   - Ожидаем: уведомление «Предупреждение 1/2 успешно выдано!», бейдж стал `1/2`, в Discord ушёл пинг с именем бойца (или упоминанием `<@id>`).
4. **Нажать «2/2 Пред»** → счётчик `2/2`, текст «Исключён!».
5. **Проверить, что повторная «1/2» не сбрасывает счётчик** (после 2/2 нажать 1/2 → остаётся 2/2).
6. **Негативные кейсы через API:**
   ```cmd
   rem без токена бота (если убрать discord_token в настройках)
   curl -i -X POST http://localhost:3000/api/warn ^
     -H "Content-Type: application/json" ^
     -d "{\"memberId\":<ID>,\"type\":1,\"norm\":10}"
   ```
   Ожидаем `400` «Настройте Discord», и счётчик `warnings` **не** изменился.
   ```cmd
   rem боец чужого подразделения (командир роты → боец дивизиона)
   ```
   Ожидаем `403` «Боец другого подразделения».
   ```cmd
   rem слишком часто (дважды подряд)
   ```
   Ожидаем `429` «Слишком часто».
7. **Проверить доступ**: войти бойцом (Сокол) → `/control` показывает «Доступ запрещен. Только для командиров».

---

### Сценарий «D»: служебные задачи и синхронизация

1. Ручной синк состава (командир):
   ```cmd
   curl -i -X POST http://localhost:3000/api/sync
   ```
   Ожидаем: при отсутствии cookie rs‑red.com — `ok:false`, `error: "NO_COOKIE"` (без падения).
2. Ручной запуск задач:
   ```cmd
   curl -i -X POST http://localhost:3000/api/actions -H "Content-Type: application/json" -d "{\"action\":\"weekly\"}"
   curl -i -X POST http://localhost:3000/api/actions -H "Content-Type: application/json" -d "{\"action\":\"left-check\"}"
   curl -i -X POST http://localhost:3000/api/actions -H "Content-Type: application/json" -d "{\"action\":\"roles-monitor\"}"
   ```
   Проверить, что каждая вернула `ok` либо понятную ошибку конфигурации, и что в `/logs` появились записи.
3. Cron‑роуты без секрета:
   ```cmd
   curl -i http://localhost:3000/api/weekly-snapshot
   ```
   Ожидаем `503` (CRON_SECRET не задан) или `403` (неверный ключ), но **не** `200`.

---

### Сценарий «E»: проверка найденных уязвимостей (после их устранения — регресс)

1. **C‑1**: под командиром выполнить
   ```cmd
   curl -s http://localhost:3000/api/control
   ```
   и убедиться, что в JSON **нет** полей `passwordHash` / `memberTokenVersion` / `applicationData`.
2. **M‑1**: командующий танковой роты пытается изменить отпуск бойцу артдивизиона:
   ```cmd
   curl -i -X PATCH http://localhost:3000/api/members/<ID_БОЙЦА_ДИВИЗИОНА> ^
     -H "Content-Type: application/json" ^
     -d "{\"vacation\":true}"
   ```
   Ожидаем `403` (после внедрения проверки подразделения).
3. **M‑2**: временно сломать чтение настроек (некорректный `DATABASE_URL`) и вызвать `/api/sync` — приложение должно вернуть управляемую ошибку, а не Unhandled Rejection в консоли.

---

### Быстрая шпаргалка: нужные cURL‑команды

| Проверка | Команда |
|---|---|
| Кто вошёл | `curl -s http://localhost:3000/api/me` |
| Табель | `curl -s http://localhost:3000/api/members` |
| Очередь рапортов | `curl -s "http://localhost:3000/api/admin/reports?status=pending"` |
| Подать рапорт (боец) | `curl -X POST .../api/member/reports -d '{"type":"exam","payload":{"exams":[...]}}'` |
| Одобрить рапорт | `curl -X POST .../api/admin/reports -d '{"scope":"report","action":"approve","id":N}'` |
| Контроль онлайна | `curl -s http://localhost:3000/api/control` |
| Выдать предупреждение | `curl -X POST .../api/warn -d '{"memberId":N,"type":1,"norm":10}'` |
| Синхронизация состава | `curl -X POST .../api/sync` |
| Ручные задачи | `curl -X POST .../api/actions -d '{"action":"weekly"}'` |

---

### Контроль качества после правок (обязательно)

```cmd
npx tsc --noEmit
npm test
```
