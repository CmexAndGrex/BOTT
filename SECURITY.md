# Безопасность ATK BOT

Документ описывает процедуры, которые нужно выполнять руками: **ротацию
секретов** и **очистку git-истории**. Автоматический сканер
([`scripts/secret-scan.mjs`](scripts/secret-scan.mjs)) и CI-джоба `secret-scan`
не дают закоммитить новый секрет, но не могут отозвать уже утёкший — это делают
по шагам ниже.

---

## 1. Что считается секретом в проекте

| Секрет | Где лежит | Что даёт злоумышленнику |
|---|---|---|
| Токен Discord-бота | `bot_settings.discord_token` / `DISCORD_BOT_TOKEN` | Управление ролями и сообщениями на сервере |
| Паспорт Google Service Account | `bot_settings.gsheet_service_account` / `src/lib/google-service-account.json` | Полный доступ к Google Таблице ШДС |
| Cookie сессии rs-red.com | `bot_settings.rs_cookie` / `RS_RED_COOKIE` | Доступ к личному кабинету сайта подразделения |
| Ключ синхронизации расширения | `bot_settings._cookie_sync_key` | Подмена cookie rs-red через `/api/cookie` |
| Вебхуки заявок | `bot_settings.allowed_webhook_ids` | Подделка заявок в канал ШДС |
| `JWT_SECRET` | окружение | Подпись токена с ролью `admin` |
| `CRON_SECRET` | окружение | Запуск задач расписания от имени системы |
| Пароль БД (`POSTGRES_PASSWORD`) | `.env` / `docker-compose` | Прямой доступ к базе со всеми персональными данными |

---

## 2. Признаки компрометации — когда ротировать немедленно

- Секрет найден в файле под контролем версий или в истории git.
- Дамп/выгрузка БД скопированы на чужой носитель (см. инцидент с
  `backup-before-staging.sql`).
- Стенд/staging собирался с боевыми `.env` и был доступен извне.
- Секрет попал в логи, скриншоты, переписку.

**Правило: факт компрометации = секрет считается раскрытым. Ротация, а не
надежда, что «никто не увидел».**

---

## 3. Порядок ротации (по каждому секрету)

### 3.1. Токен Discord-бота
1. Discord Developer Portal → приложение бота → **Bot → Reset Token**.
2. Скопировать новый токен и сохранить в панели: **Настройки → Discord**,
   либо в `DISCORD_BOT_TOKEN` в `.env`.
3. Перезапустить приложение (`docker compose restart app`) — токен читается из
   настроек/окружения при старте и кэшируется на цикл.
4. Проверить: **Настройки → статус бота** зелёный, `/api/status` отдаёт
   `bot.configured: true`.

### 3.2. Паспорт Google Service Account
1. GCP Console → IAM & Admin → Service Accounts → аккаунт
   `atk-bot@red-ops-bot.iam.gserviceaccount.com` → **Keys**.
2. **Удалить** старый ключ (`d94beca2…`) → **Add key → Create new key → JSON**.
3. Новый JSON вставить в **Настройки → Google-форма и запас → паспорт
   сервисного аккаунта** (поле `gsheet_service_account`).
4. В Google Таблице ШДС убедиться, что доступ выдан новому `client_email`
   (он не меняется при ротации ключа того же аккаунта).
5. Проверить: синхронизация состава и правка Discord ID проходят без ошибок
   ШДС.

### 3.3. Cookie rs-red.com
1. Войти на rs-red.com под служебной учётной записью.
2. Получить свежую cookie (`rs.sid=…`) и обновить: **Настройки → Интеграции →
   cookie rs-red**. Кнопка «Скачать расширение» больше не нужна — cookie можно
   вставить вручную.
3. Проверить синхронизацию состава.
4. **Обязательно перегенерировать ключ синхронизации** (см. 3.4) — он позволял
   подменить cookie без доступа к панели.

### 3.4. Ключ синхронизации расширения
1. **Настройки → Интеграции → Перегенерировать ключ** (или
   `PUT /api/settings` с `regenerate_key: "true"`).
2. Все ранее скачанные архивы расширения перестанут работать — раздать новый
   архив пользователям расширения.

### 3.5. Вебхуки заявок
1. В каждом канале Discord: **Интеграции → Вебхуки** → удалить старый → создать
   новый.
2. Обновить URL вебхуков в Google Apps Script (см. [`FORMS_SETUP.md`](FORMS_SETUP.md))
   и список `allowed_webhook_ids` в настройках панели
   (это **ID вебхуков**, а не токены).
3. Проверить приём заявки тестовой формой.

### 3.6. `JWT_SECRET`
1. Сгенерировать новый: `openssl rand -base64 48` (32+ символа).
2. Заменить `JWT_SECRET` в `.env` / секретах docker-compose.
3. `docker compose up -d app` — **все сессии панели и кабинета станут
   недействительны**, пользователи войдут заново (это ожидаемо).

### 3.7. `CRON_SECRET`
1. Сгенерировать новый: `openssl rand -hex 32`.
2. Заменить в `.env` и в настройках внешнего расписания (uptime-робот/cron).
3. Перезапустить приложение.

### 3.8. Пароль PostgreSQL
1. Новый пароль в `.env` (`POSTGRES_PASSWORD`) **и** обновить `DATABASE_URL`
   в `.env`/docker-compose.
2. Сменить пароль в самом Postgres:
   `docker compose exec db psql -U postgres -c "ALTER USER postgres WITH PASSWORD '<new>';"`
3. `docker compose down && docker compose up -d` (migrate применит подключение).

---

## 4. Очистка git-истории

Выполняется, **только если секрет реально попал в коммиты** (проверить:
`git log -p --all -- <файл>` или `gitleaks detect`). Для дампов вида
`backup-*.sql`, которые не отслеживались (были локальными), чистить историю
**не нужно** — достаточно удалить файл с диска.

Очистка переписывает историю — это деструктивная операция. Делайте её на
свежем зеркале и не в одиночку (координация с другими разработчиками
обязательна: их локальные клоны придётся переклонировать).

Помощник (не трогает рабочий репозиторий):

```bash
# Показать, какие команды будут выполнены (dry-run, ничего не меняет)
bash scripts/clean-history.sh --file backup-before-staging.sql

# Выполнить в отдельном зеркале (создаст ../BOT-clean и покажет инструкцию)
bash scripts/clean-history.sh --file backup-before-staging.sql --run
```

Ручной путь через `git filter-repo`:

```bash
# 1. Свежее зеркало (вне рабочего каталога), чтобы не потерять оригинал
git clone --mirror <repo-url> ../BOT-mirror && cd ../BOT-mirror

# 2. Удалить файл из всей истории
git filter-repo --path backup-before-staging.sql --invert-paths --force

# 3. Проверить, что файла в истории нет
git log --all --oneline -- backup-before-staging.sql   # должно быть пусто

# 4. Запушить переписанную историю
git push --force --all
git push --force --tags
```

Альтернатива — [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/):

```bash
java -jar bfg.jar --delete-files backup-before-staging.sql ../BOT-mirror
cd ../BOT-mirror && git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force --all
```

**После очистки истории секреты всё равно ротировать** (раздел 3): копии
успели разойтись по локальным клонам, форкам и бэкапам.

---

## 5. Регулярные проверки

- CI: джоба `secret-scan` выполняется до сборки (см.
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- Локально перед коммитом:
  `git config core.hooksPath .githooks` — включит
  [`.githooks/pre-commit`](.githooks/pre-commit).
- Вручную: `npm run secret:scan`.
- Внешний детектор: `gitleaks detect --config .gitleaks.toml`.
