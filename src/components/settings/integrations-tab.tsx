"use client";

/**
 * Вкладка «Интеграции»: к чему подключена панель.
 *
 * Сюда попало всё, что описывает внешние сервисы, а не расписание и не контент:
 *   * Discord — токен бота, каналы (ШДС, отпуск, заявки, рапорты, роли) и роли;
 *   * Google Таблица — ID таблицы ШДС и паспорт сервисного аккаунта;
 *   * rs-red.com — cookie и ID подразделения;
 *   * расширение браузера — адрес сервера и ключ синхронизации.
 *
 * Что изменилось по сравнению с прежней простынёй:
 *   * ID каналов и ролей больше не идут длинным списком одинаковых блоков во всю
 *     ширину — они собраны в адаптивную сетку по два в ряд (FieldGrid);
 *   * паспорт сервисного аккаунта Google свёрнут в бейдж «Ключ загружен» с
 *     кнопкой «Заменить ключ» (SecretKeyField);
 *   * убраны поля, которых в интерфейсе быть не должно: базовый URL rs-red.com
 *     (зафиксирован константой RS_RED_BASE_URL) и лимиты Discord API
 *     (зафиксированы в DEFAULT_QUEUE_OPTIONS).
 */
import {
  Bot,
  CheckCircle2,
  Cookie,
  Copy,
  Download,
  Link2,
  Puzzle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Section, Spinner, fmtDateLong } from "@/components/ui";
import { Field, FieldGrid, SecretKeyField } from "@/components/settings/fields";
import type { SetSetting, SettingsState } from "@/components/settings/tabs";

export type IntegrationsTabProps = {
  settings: SettingsState;
  set: SetSetting;
  /** Наличие токена и cookie в переменных окружения: показываем источник значения */
  env: { hasToken: boolean; hasCookie: boolean } | null;
  cookieUpdatedAt: string | null;
  syncKey: string;
  origin: string;
  copied: string | null;
  copy: (label: string, value: string) => void;
  regenerateKey: () => void;
  regenerating: boolean;
};

/** Подсказка «ПКМ по каналу → Копировать ID»: повторялась под каждым полем канала */
const CHANNEL_ID_HINT = "ПКМ по каналу → «Копировать ID канала» (нужен режим разработчика в Discord).";

/** Формат квадратного бейджа-шага в инструкции по расширению */
const stepStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  flex: "none",
  fontSize: 11,
  borderRadius: 8,
  background: "var(--red-soft)",
  color: "#fda4af",
  border: "1px solid rgba(190,18,60,.3)",
};

export default function IntegrationsTab({
  settings,
  set,
  env,
  cookieUpdatedAt,
  syncKey,
  origin,
  copied,
  copy,
  regenerateKey,
  regenerating,
}: IntegrationsTabProps) {
  const tokenState = settings.discord_token
    ? "в базе"
    : env?.hasToken
      ? "из окружения"
      : "не задан";
  const cookieState = settings.rs_cookie
    ? "в базе"
    : env?.hasCookie
      ? "из окружения"
      : "не задана";

  /** Только цифры: ID Discord иначе не примет ни один вызов API */
  const digits = (key: string) => (v: string) => set(key, v.replace(/[^\d]/g, ""));

  return (
    <>
      {/* Discord: токен */}
      <Section
        title="Discord — бот"
        eyebrow="токен · права"
        action={
          <span className="chip">
            <span className={`dot ${tokenState === "не задан" ? "dot-err pulse-dot" : "dot-ok"}`} />
            токен: {tokenState}
          </span>
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <Field
            label="Токен бота"
            hint={
              <>
                Хранится в базе и используется только для запросов к api.discord.com. Если поле
                пустое — берётся переменная окружения <span className="kbd">DISCORD_BOT_TOKEN</span>.
              </>
            }
          >
            <input
              className="input input-mono"
              placeholder="MTIz… из Discord Developer Portal → Bot → Token"
              value={settings.discord_token}
              onChange={(e) => set("discord_token", e.target.value)}
              spellCheck={false}
            />
          </Field>

          <FieldGrid>
            <Field label="ID канала для пингов" hint={CHANNEL_ID_HINT}>
              <input
                className="input input-mono"
                placeholder="например 1185432109876543210"
                value={settings.discord_channel_id}
                onChange={(e) => digits("discord_channel_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли для пинга на операцию"
              hint="Настройки сервера → Роли → ПКМ по роли → «Копировать ID роли»."
            >
              <input
                className="input input-mono"
                placeholder="например 1185432109876543999"
                value={settings.discord_role_id}
                onChange={(e) => digits("discord_role_id")(e.target.value)}
              />
            </Field>
          </FieldGrid>

          <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            <Bot size={14} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
            <span>
              У бота на сервере должны быть права: отправка сообщений, встраивание ссылок,
              добавление реакций. Замаскированное значение при сохранении не затирает старое.
            </span>
          </div>
        </div>
      </Section>

      {/* Discord: каналы и роли */}
      <Section
        title="Каналы и роли Discord"
        eyebrow="заявки · рапорты · роли"
        action={
          <span className="chip">
            <Bot size={12} />
            заявки: {settings.shds_channel_id ? "ШДС" : "—"}
            {settings.vacation_channel_id ? " + отпуск" : ""}
          </span>
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <FieldGrid>
            <Field label="ID канала заявок ШДС (SHDS_CHANNEL_ID)">
              <input
                className="input input-mono"
                placeholder="например 1085141850966458519"
                value={settings.shds_channel_id}
                onChange={(e) => digits("shds_channel_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID канала заявок на отпуск (VACATION_CHANNEL_ID)"
              hint="Сюда уходят рапорты на отпуск с сайта (/reports/new) и заявки бота. Пусто — DISCORD_VACATION_CHANNEL_ID из окружения."
            >
              <input
                className="input input-mono"
                placeholder="например 1085141850966458519"
                value={settings.vacation_channel_id}
                onChange={(e) => digits("vacation_channel_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID канала заявок на вступление (RECRUITS_CHANNEL_ID)"
              hint="Сюда приходят заявки с формы /apply — с кнопками «Одобрить / Отклонить»."
            >
              <input
                className="input input-mono"
                placeholder="пусто — публикуется в канал ШДС"
                value={settings.recruits_channel_id}
                onChange={(e) => digits("recruits_channel_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID канала рапортов состава (REPORTS_CHANNEL_ID)"
              hint={
                <>
                  Рапорты бойцов (экзамены, отпуск, резерв, специальность, ШДС). Сама очередь
                  всегда доступна штабу: <span className="kbd">/admin/reports</span>.
                </>
              }
            >
              <input
                className="input input-mono"
                placeholder="пусто — публикуется в канал ШДС"
                value={settings.reports_channel_id}
                onChange={(e) => digits("reports_channel_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли модератора заявок"
              hint={
                <>
                  Всегда может подтверждать и отклонять заявки и рапорты. Эта же роль
                  пингуется при публикации рапорта в канале. Пусто — переменная{" "}
                  <span className="kbd">DISCORD_MODERATOR_ROLE_ID</span>.
                </>
              }
            >
              <input
                className="input input-mono"
                value={settings.moderator_role_id}
                onChange={(e) => digits("moderator_role_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли «Танковая рота»"
              hint="Нужна автоопределению подразделения, если в карточке бойца оно не задано. Пусто — ищется по имени."
            >
              <input
                className="input input-mono"
                placeholder="пусто — ищется по имени «Танковая рота»"
                value={settings.tank_role_id}
                onChange={(e) => digits("tank_role_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли «Артиллерийский дивизион»"
              hint="Та же логика, что у роли роты: подразделение выводится по ролям участника."
            >
              <input
                className="input input-mono"
                placeholder="пусто — ищется по имени «Артиллерийский дивизион»"
                value={settings.art_role_id}
                onChange={(e) => digits("art_role_id")(e.target.value)}
              />
            </Field>
            <Field label="ID роли «Отпуск»" hint="Выдаётся на время отпуска и снимается при возврате.">
              <input
                className="input input-mono"
                value={settings.leave_role_id}
                onChange={(e) => digits("leave_role_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли «Берет»"
              hint={
                <>
                  Выдаётся автоматически, когда боец сдал все четыре норматива экзамена на берет.
                  Роль ищется по имени, ID нужен только при нестандартном названии.
                </>
              }
            >
              <input
                className="input input-mono"
                placeholder="пусто — ищется по имени «Берет»"
                value={settings.beret_role_id}
                onChange={(e) => digits("beret_role_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли «Запас»"
              hint="Выдаётся при уходе в запас и снимается при возврате."
            >
              <input
                className="input input-mono"
                placeholder="например 1166476218791645256"
                value={settings.reserve_role_id}
                onChange={(e) => digits("reserve_role_id")(e.target.value)}
              />
            </Field>
            <Field
              label="ID роли «Командирский состав»"
              hint="Пингуется, если у вышедшего бойца сутки не сняты роли клана."
            >
              <input
                className="input input-mono"
                placeholder="например 1392552505162072264"
                value={settings.command_role_id}
                onChange={(e) => digits("command_role_id")(e.target.value)}
              />
            </Field>
            <Field label="ID сервера Discord" hint="Нужен для списка ролей в карточках бойцов.">
              <input
                className="input input-mono"
                placeholder="сервер → ПКМ → «Копировать ID сервера»"
                value={settings.guild_id}
                onChange={(e) => digits("guild_id")(e.target.value)}
              />
            </Field>
          </FieldGrid>

          <Field
            label="ID канала запросов ролей (ROLES_CHANNEL_ID)"
            hint={
              <>
                В этом канале бот принимает команды вида <b>«Выдать Капитан ТР, снять Друг АТК»</b>.
                Формат сообщения: <span className="kbd">@получатель</span>,{" "}
                <span className="kbd">@экзаменатор</span>, затем команда со списком ролей.
                Сюда же уходят рапорты на смену роли/специальности с сайта. Пусто —
                переменная <span className="kbd">DISCORD_ROLE_REQUESTS_CHANNEL_ID</span>.
              </>
            }
          >
            <input
              className="input input-mono"
              placeholder="например 1090516508725215253"
              value={settings.roles_channel_id}
              onChange={(e) => digits("roles_channel_id")(e.target.value)}
            />
          </Field>

          <Field
            label="Разрешённые вебхуки заявок (ID через запятую)"
            hint={
              <>
                Заявки приходят в каналы ШДС и отпуска от вебхуков Discord. Бот выполняет только
                сообщения вебхуков из этого списка — так поддельная заявка от постороннего вебхука
                не будет принята. <b>Если список пуст, заявки от вебхуков не принимаются вообще.</b>
              </>
            }
          >
            <input
              className="input input-mono"
              placeholder="например 1085141850966458519, 1090516508725215253"
              value={settings.allowed_webhook_ids}
              onChange={(e) => set("allowed_webhook_ids", e.target.value)}
            />
          </Field>

          <hr className="divider" />
          <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            <Bot size={14} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
            <span>
              Бот ждёт ручную реакцию ❌ или зелёного круга / :ATK: под заявкой от пользователя с
              упомянутой ролью (или от модератора). Отказ → [ОТКАЗАНО] + ЛС для отпуска, одобрение
              → [ОДОБРЕНО И ВНЕСЕНО] и запись в Google Таблицу (лист = «Подразделение»). В ветке под
              заявкой публикуется, кто подтвердил или отказал.
            </span>
          </div>
        </div>
      </Section>

      {/* Google Таблица */}
      <Section title="Google Таблица (ШДС)" eyebrow="синхронизация состава · ШДС">
        <div className="flex flex-col gap-4 px-5 py-5">
          <FieldGrid>
            <Field
              label="ID Google-таблицы"
              hint={
                <>
                  Из ссылки: <span className="kbd">docs.google.com/spreadsheets/d/ВОТ_ЭТО_ID/edit</span>
                </>
              }
            >
              <input
                className="input input-mono"
                placeholder="строка из URL между /d/ и /edit"
                value={settings.gsheet_spreadsheet_id}
                onChange={(e) => set("gsheet_spreadsheet_id", e.target.value.trim())}
              />
            </Field>
            <Field
              label="Название листа «Запас»"
              hint="Создаётся автоматически, если такого листа в таблице нет."
            >
              <input
                className="input input-mono"
                placeholder="Запас"
                value={settings.reserve_sheet_name}
                onChange={(e) => set("reserve_sheet_name", e.target.value)}
              />
            </Field>
            <Field
              label="Лист с ответами Google-формы"
              hint="Лист внутри таблицы ШДС, куда форма пишет ответы бойцов."
            >
              <input
                className="input input-mono"
                placeholder="Ответы на форму 1"
                value={settings.form_response_sheet}
                onChange={(e) => set("form_response_sheet", e.target.value)}
              />
            </Field>
          </FieldGrid>

          <SecretKeyField
            label="Паспорт сервисного аккаунта Google (JSON)"
            value={settings.gsheet_service_account}
            onChange={(v) => set("gsheet_service_account", v)}
            placeholder='{"type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…"}'
            hint={
              <>
                Содержимое JSON-файла сервисного аккаунта (Google Cloud → IAM → Service Accounts →
                Keys). Хранится скрыто; замаскированное значение при сохранении не затирает старое.
                Если пусто — используется файл{" "}
                <span className="kbd">src/lib/google-service-account.json</span>.
              </>
            }
          />
        </div>
      </Section>

      {/* RS-RED */}
      <Section
        title="RS-RED"
        eyebrow="источник онлайна"
        action={
          <span className="chip">
            <Cookie size={12} />
            cookie: {cookieState}
            {cookieUpdatedAt ? ` · ${fmtDateLong(cookieUpdatedAt)}` : ""}
          </span>
        }
      >
        <div className="flex flex-col gap-4 px-5 py-5">
          <FieldGrid>
            <Field
              label="ID подразделения"
              hint="Число из адреса страницы подразделения на rs-red.com."
            >
              <input
                className="input input-mono"
                value={settings.rs_subdiv_id}
                onChange={(e) => digits("rs_subdiv_id")(e.target.value)}
              />
            </Field>
            <Field
              label="Адрес сайта"
              hint="Зафиксирован в коде — сайт подразделения один и тот же, поле настройки было лишним."
            >
              <input className="input input-mono" value="https://rs-red.com" readOnly />
            </Field>
          </FieldGrid>

          <Field label="Cookie сайта rs-red.com (ручной ввод)">
            <textarea
              className="textarea"
              style={{ minHeight: 74 }}
              placeholder="Обычно не нужно — cookie приходит сама из расширения ниже"
              value={settings.rs_cookie}
              onChange={(e) => set("rs_cookie", e.target.value)}
            />
          </Field>

          <hr className="divider" />
          <div className="text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            <div className="mb-1.5 flex items-center gap-1.5 font-semibold" style={{ color: "var(--text)" }}>
              <ShieldCheck size={13} style={{ color: "var(--green)" }} />
              Резервный способ, если расширение недоступно
            </div>
            <ol className="ml-4 list-decimal space-y-1">
              <li>Откройте <span className="kbd">rs-red.com</span> и войдите через Steam.</li>
              <li>Нажмите <span className="kbd">F12</span> → вкладка «Сеть» (Network).</li>
              <li>Обновите страницу, кликните первый запрос к rs-red.com.</li>
              <li>В «Заголовках» найдите <span className="kbd">Cookie</span> и вставьте значение сюда.</li>
            </ol>
          </div>
        </div>
      </Section>

      {/* Расширение и ключ синхронизации */}
      <Section
        glow
        title="Расширение и автосинхронизация cookie"
        eyebrow="расширение v5 · автоматический перехват ключа"
        action={
          <a
            className="btn btn-primary btn-sm"
            href="https://addons.opera.com/ru/extensions/"
            target="_blank"
            rel="noreferrer"
          >
            <Download size={13} />
            Установить из магазина
          </a>
        }
      >
        <div className="grid gap-6 px-5 py-5 lg:grid-cols-2">
          <div>
            <div className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold">
              <Puzzle size={14} style={{ color: "var(--red)" }} />
              Установка в один клик
            </div>
            <ol className="flex flex-col gap-2.5">
              {[
                "Установите расширение RED ATK из магазина Opera (кнопка справа вверху).",
                "Просто обновите эту страницу (или зайдите на сайт).",
                "Расширение само перехватит ваш уникальный ключ и начнёт работу.",
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span
                    className="display flex items-center justify-center font-bold"
                    style={stepStyle}
                  >
                    {i + 1}
                  </span>
                  <span className="text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
                    {step}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
              Больше никаких ZIP-архивов. Расширение само отправляет cookie при входе на rs-red.com
              и каждые 10 минут, а также умеет «будить» панель.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <Field
              label="Адрес сервера (для расширения)"
              hint="Скрипт расширения получает этот адрес автоматически с этой страницы."
            >
              <div className="flex gap-2">
                <input className="input input-mono" readOnly value={origin} onFocus={(e) => e.target.select()} />
                <button className="btn btn-icon" onClick={() => copy("origin", origin)} title="Скопировать">
                  {copied === "origin" ? (
                    <CheckCircle2 size={14} style={{ color: "var(--green)" }} />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
              </div>
            </Field>
            <Field
              label="Ключ синхронизации"
              hint="Ключ защищает панель от перезаписи данных. «Новый» — старый ключ мгновенно перестаёт работать."
            >
              <div className="flex gap-2">
                <input className="input input-mono" readOnly value={syncKey} onFocus={(e) => e.target.select()} />
                <button className="btn btn-icon" onClick={() => copy("key", syncKey)} title="Скопировать">
                  {copied === "key" ? (
                    <CheckCircle2 size={14} style={{ color: "var(--green)" }} />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
                <button className="btn" onClick={regenerateKey} disabled={regenerating} title="Перевыпустить ключ">
                  {regenerating ? <Spinner /> : <RefreshCw size={14} />}
                  Новый
                </button>
              </div>
            </Field>
            <div
              className="flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12px] leading-relaxed"
              style={{
                borderColor: "var(--stroke-soft)",
                background: "rgba(255,255,255,.025)",
                color: "var(--muted)",
              }}
            >
              <Link2 size={14} className="mt-0.5 flex-none" style={{ color: "var(--amber)" }} />
              <span>
                {cookieUpdatedAt
                  ? `Последняя cookie получена ${fmtDateLong(cookieUpdatedAt)}. Если сайт начнёт отвечать 403 — просто откройте rs-red.com, расширение само передаст свежую.`
                  : "Cookie ещё ни разу не приходила от расширения. Установите его из магазина и зайдите на этот сайт, чтобы передать настройки."}
              </span>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}