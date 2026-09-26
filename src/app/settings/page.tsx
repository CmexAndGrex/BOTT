"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlarmClockCheck,
  Bot,
  CalendarClock,
  CheckCircle2,
  Copy,
  Cookie,
  Download,
  FileText,
  KeyRound,
  Link2,
  Puzzle,
  RefreshCw,
  Save,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Section, Spinner, Toggle, fmtDateLong } from "@/components/ui";

const DAY_OPTIONS = [
  { n: 1, label: "Пн" },
  { n: 2, label: "Вт" },
  { n: 3, label: "Ср" },
  { n: 4, label: "Чт" },
  { n: 5, label: "Пт" },
  { n: 6, label: "Сб" },
  { n: 0, label: "Вс" },
];

const TIMEZONES = [
  "Europe/Moscow",
  "Europe/Kyiv",
  "Europe/Minsk",
  "Europe/Kaliningrad",
  "Asia/Yekaterinburg",
  "Asia/Novosibirsk",
  "Asia/Vladivostok",
  "UTC",
];

type SettingsState = Record<string, string>;

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [env, setEnv] = useState<{ hasToken: boolean; hasCookie: boolean } | null>(null);
  const [syncKey, setSyncKey] = useState("");
  const [cookieUpdatedAt, setCookieUpdatedAt] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings", { cache: "no-store" });

    // Роут отдаёт настройки только администратору: 401 — нет сессии,
    // 403 — вошёл командир. Раньше ответ был анонимным, поэтому обрабатываем явно.
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Нет доступа к настройкам");
    }

    const data = await res.json();
    if (!data.settings) throw new Error(data.error || "Пустой ответ настроек");
    setSettings(data.settings);
    setEnv(data.env);
    setSyncKey(data.cookieSyncKey || "");
    setCookieUpdatedAt(data.cookieUpdatedAt || null);
  }, []);

  useEffect(() => {
    load().catch((e: unknown) =>
      setNotice({
        ok: false,
        text: e instanceof Error ? e.message : "Не удалось загрузить настройки",
      })
    );
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5500);
    return () => clearTimeout(t);
  }, [notice]);

  const set = (key: string, value: string) =>
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(label);
    setTimeout(() => setCopied(null), 1600);
  };

  const days = (settings?.weekly_days ?? "")
    .split(/[,\s]+/)
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isInteger(n));

  const toggleDay = (n: number) => {
    const next = days.includes(n) ? days.filter((d) => d !== n) : [...days, n];
    set("weekly_days", next.sort((a, b) => a - b).join(","));
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (data.ok) {
        setNotice({ ok: true, text: "Настройки сохранены. Расписание и токен применились автоматически." });
        await load();
      } else {
        setNotice({ ok: false, text: data.error || "Ошибка сохранения" });
      }
    } catch {
      setNotice({ ok: false, text: "Сбой сети" });
    } finally {
      setSaving(false);
    }
  };

  const regenerateKey = async () => {
    setRegenerating(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate_key: "true" }),
      });
      const data = await res.json();
      if (data.cookieSyncKey) {
        setSyncKey(data.cookieSyncKey);
        setNotice({ ok: true, text: "Ключ перевыпущен — расширение обновит его при следующем заходе на сайт." });
      }
    } finally {
      setRegenerating(false);
    }
  };

  if (!settings) {
    return (
      <div className="flex flex-col gap-4">
        <div className="skeleton" style={{ height: 60 }} />
        <div className="skeleton" style={{ height: 260 }} />
        <div className="skeleton" style={{ height: 260 }} />
      </div>
    );
  }

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

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">конфигурация // бот</div>
          <h1 className="display text-[34px] font-black leading-tight sm:text-[40px]">Настройки</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Всё управляется отсюда — сервер перезапускать не нужно.
          </p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? <Spinner /> : <Save size={15} />}
          Сохранить всё
        </button>
      </header>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="card flex items-center gap-2.5 px-4 py-3"
            style={{ borderColor: notice.ok ? "rgba(61,220,132,.4)" : "rgba(255,61,61,.45)" }}
          >
            {notice.ok ? (
              <CheckCircle2 size={16} style={{ color: "var(--green)" }} />
            ) : (
              <XCircle size={16} style={{ color: "var(--red)" }} />
            )}
            <span className="text-[13px]" style={{ color: "var(--muted)" }}>
              {notice.text}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Discord */}
        <Section
          title="Discord"
          eyebrow="токен · канал · роль"
          action={
            <span className="chip">
              <span
                className={`dot ${tokenState === "не задан" ? "dot-err pulse-dot" : "dot-ok"}`}
              />
              токен: {tokenState}
            </span>
          }
        >
          <div className="flex flex-col gap-4 px-5 py-5">
            <div>
              <div className="label mb-1.5">Токен бота</div>
              <input
                className="input input-mono"
                placeholder="MTIz… из Discord Developer Portal → Bot → Token"
                value={settings.discord_token}
                onChange={(e) => set("discord_token", e.target.value)}
                spellCheck={false}
              />
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                Хранится в базе и используется только для запросов к api.discord.com. Если поле
                пустое — берётся переменная окружения <span className="kbd">DISCORD_BOT_TOKEN</span>.
              </p>
            </div>
            <div>
              <div className="label mb-1.5">ID канала для пингов</div>
              <input
                className="input input-mono"
                placeholder="например 1185432109876543210"
                value={settings.discord_channel_id}
                onChange={(e) => set("discord_channel_id", e.target.value.replace(/[^\d]/g, ""))}
              />
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                ПКМ по каналу → «Копировать ID канала» (нужен режим разработчика в Discord).
              </p>
            </div>
            <div>
              <div className="label mb-1.5">ID роли для пинга на операцию</div>
              <input
                className="input input-mono"
                placeholder="например 1185432109876543999"
                value={settings.discord_role_id}
                onChange={(e) => set("discord_role_id", e.target.value.replace(/[^\d]/g, ""))}
              />
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                Настройки сервера → Роли → ПКМ по роли → «Копировать ID роли».
              </p>
            </div>
            <hr className="divider" />
            <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              <Bot size={14} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
              <span>
                У бота на сервере должны быть права: отправка сообщений, встраивание ссылок,
                добавление реакций. Замаскированное значение при сохранении не затирает старое.
              </span>
            </div>
          </div>
        </Section>

        {/* Бот заявок: ШДС / отпуск + Google Таблица */}
        <Section
          title="Бот заявок и Google Таблица"
          eyebrow="ШДС · отпуск · gsheets"
          action={
            <span className="chip">
              <Bot size={12} />
              заявки: {settings.shds_channel_id ? "ШДС" : "—"}
              {settings.vacation_channel_id ? " + отпуск" : ""}
            </span>
          }
        >
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1.5">ID канала заявок ШДС (SHDS_CHANNEL_ID)</div>
                <input
                  className="input input-mono"
                  placeholder="например 1085141850966458519"
                  value={settings.shds_channel_id}
                  onChange={(e) => set("shds_channel_id", e.target.value.replace(/[^\d]/g, ""))}
                />
              </div>
              <div>
                <div className="label mb-1.5">ID канала заявок на отпуск (VACATION_CHANNEL_ID)</div>
                <input
                  className="input input-mono"
                  placeholder="например 1085141850966458519"
                  value={settings.vacation_channel_id}
                  onChange={(e) => set("vacation_channel_id", e.target.value.replace(/[^\d]/g, ""))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1.5">
                  ID канала заявок на вступление (RECRUITS_CHANNEL_ID)
                </div>
                <input
                  className="input input-mono"
                  placeholder="пусто — публикуется в канал ШДС"
                  value={settings.recruits_channel_id}
                  onChange={(e) => set("recruits_channel_id", e.target.value.replace(/[^\d]/g, ""))}
                />
                <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Сюда приходят заявки с формы /apply — с кнопками «Одобрить / Отклонить».
                </p>
              </div>
              <div>
                <div className="label mb-1.5">ID канала рапортов состава (REPORTS_CHANNEL_ID)</div>
                <input
                  className="input input-mono"
                  placeholder="пусто — публикуется в канал ШДС"
                  value={settings.reports_channel_id}
                  onChange={(e) => set("reports_channel_id", e.target.value.replace(/[^\d]/g, ""))}
                />
                <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Рапорты бойцов (экзамены, отпуск, резерв, специальность, ШДС). Сама очередь
                  всегда доступна штабу: <span className="kbd">/admin/reports</span>.
                </p>
              </div>
            </div>
            <div>
              <div className="label mb-1.5">ID канала запросов ролей (ROLES_CHANNEL_ID)</div>
              <input
                className="input input-mono"
                placeholder="например 1090516508725215253"
                value={settings.roles_channel_id}
                onChange={(e) => set("roles_channel_id", e.target.value.replace(/[^\d]/g, ""))}
              />
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                В этом канале бот принимает команды вида <b>«Выдать Капитан ТР, снять Друг АТК»</b>.
                Формат сообщения: <span className="kbd">@получатель</span>,{" "}
                <span className="kbd">@экзаменатор</span>, затем команда со списком ролей
                (несколько через запятую, «Выдать …» и «Снять …» в одном сообщении).
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1.5">ID роли модератора заявок</div>
                <input
                  className="input input-mono"
                  value={settings.moderator_role_id}
                  onChange={(e) => set("moderator_role_id", e.target.value.replace(/[^\d]/g, ""))}
                />
                <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Всегда может подтверждать/отклонять заявки.
                </p>
              </div>
              <div>
                <div className="label mb-1.5">ID роли «Отпуск»</div>
                <input
                  className="input input-mono"
                  value={settings.leave_role_id}
                  onChange={(e) => set("leave_role_id", e.target.value.replace(/[^\d]/g, ""))}
                />
              </div>
            </div>
            <div>
              <div className="label mb-1.5">Разрешённые вебхуки заявок (ID через запятую)</div>
              <input
                className="input input-mono"
                placeholder="например 1085141850966458519, 1090516508725215253"
                value={settings.allowed_webhook_ids}
                onChange={(e) => set("allowed_webhook_ids", e.target.value)}
              />
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                Заявки приходят в каналы ШДС/отпуска от вебхуков Discord. Бот выполняет
                только сообщения вебхуков из этого списка — так поддельная заявка от
                постороннего вебхука не будет принята. ID вебхука виден в его URL
                (Discord: Настройки канала → Интеграции → Вебхуки).
                <b> Если список пуст, заявки от вебхуков не принимаются вообще.</b>
              </p>
            </div>
            <hr className="divider" />
            <div>
              <div className="label mb-1.5">ID Google-таблицы (ШДС)</div>
              <input
                className="input input-mono"
                placeholder="строка из URL между /d/ и /edit"
                value={settings.gsheet_spreadsheet_id}
                onChange={(e) => set("gsheet_spreadsheet_id", e.target.value.trim())}
              />
              <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                Из ссылки: <span className="kbd">docs.google.com/spreadsheets/d/ВОТ_ЭТО_ID/edit</span>
              </p>
            </div>
            <div>
              <div className="label mb-1.5">Паспорт сервисного аккаунта Google (JSON)</div>
              <textarea
                className="textarea"
                style={{ minHeight: 110 }}
                placeholder='{"type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…"}'
                value={settings.gsheet_service_account}
                onChange={(e) => set("gsheet_service_account", e.target.value)}
                spellCheck={false}
              />
              <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                Содержимое JSON-файла сервисного аккаунта (Google Cloud → IAM → Service Accounts → Keys).
                Хранится скрыто; замаскированное значение при сохранении не затирает старое. Если пусто —
                используется файл <span className="kbd">src/lib/google-service-account.json</span>.
              </p>
            </div>
            <hr className="divider" />
            <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              <Bot size={14} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
              <span>
                Бот ждёт ручную реакцию ❌ или зелёного круга / :ATK: под заявкой от пользователя
                с упомянутой в заявке ролью (или от модератора). Отказ → [ОТКАЗАНО] + ЛС для отпуска,
                одобрение → [ОДОБРЕНО И ВНЕСЕНО] и запись в Google Таблицу (лист = «Подразделение»).
                В ветке под заявкой публикуется, кто подтвердил или отказал.
              </span>
            </div>
          </div>
        </Section>

        {/* Google-форма и запас */}
        <Section
          title="Google-форма и запас"
          eyebrow="заявки от бойцов"
          action={
            <span className="chip">
              <Bot size={12} />
              форма: {settings.form_enabled === "true" ? "вкл" : "выкл"}
            </span>
          }
        >
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="flex items-center justify-between gap-3 rounded-xl border p-3" style={{ borderColor: "var(--stroke-soft)", background: "rgba(255,255,255,.02)" }}>
              <div>
                <div className="text-[13px] font-bold">Опрос Google-формы</div>
                <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Раз в минуту бот забирает новые ответы и публикует их как заявки в Discord
                </div>
              </div>
              <Toggle
                on={settings.form_enabled === "true"}
                onChange={(v) => set("form_enabled", v ? "true" : "false")}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1.5">Лист с ответами формы</div>
                <input
                  className="input input-mono"
                  placeholder="Ответы на форму 1"
                  value={settings.form_response_sheet}
                  onChange={(e) => set("form_response_sheet", e.target.value)}
                />
                <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Лист внутри Google-таблицы ШДС, куда форма пишет ответы.
                </p>
              </div>
              <div>
                <div className="label mb-1.5">ID роли «Запас»</div>
                <input
                  className="input input-mono"
                  placeholder="например 1166476218791645256"
                  value={settings.reserve_role_id}
                  onChange={(e) => set("reserve_role_id", e.target.value.replace(/[^\d]/g, ""))}
                />
                <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Выдаётся при уходе в запас и снимается при возврате.
                </p>
              </div>
              <div>
                <div className="label mb-1.5">Название листа «Запас»</div>
                <input
                  className="input input-mono"
                  placeholder="Запас"
                  value={settings.reserve_sheet_name}
                  onChange={(e) => set("reserve_sheet_name", e.target.value)}
                />
                <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Создаётся автоматически, если не существует.
                </p>
              </div>
            </div>

            <hr className="divider" />
            <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              <Bot size={14} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
              <span>
                Бот публикует заявки из формы в каналы (роли / отпуск / ШДС) — модератор подтверждает реакцией.
                Для «запаса» строка бойца переносится на отдельный лист, роли меняются автоматически.
                Подробная инструкция — в файле <span className="kbd">FORMS_SETUP.md</span> в репозитории.
              </span>
            </div>
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
            <div>
              <div className="label mb-1.5">Cookie сайта rs-red.com (ручной ввод)</div>
              <textarea
                className="textarea"
                style={{ minHeight: 74 }}
                placeholder="Обычно не нужно — cookie приходит сама из расширения ниже"
                value={settings.rs_cookie}
                onChange={(e) => set("rs_cookie", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1.5">ID подразделения</div>
                <input
                  className="input input-mono"
                  value={settings.rs_subdiv_id}
                  onChange={(e) => set("rs_subdiv_id", e.target.value.replace(/[^\d]/g, ""))}
                />
              </div>
              <div>
                <div className="label mb-1.5">Базовый URL</div>
                <input
                  className="input input-mono"
                  value={settings.rs_base_url}
                  onChange={(e) => set("rs_base_url", e.target.value)}
                />
              </div>
            </div>
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

        {/* Расписание операций */}
        <Section title="Пинги на операцию" eyebrow="задача №1"
          action={
            <div className="flex items-center gap-2">
              <span className="label">вкл</span>
              <Toggle
                on={settings.op_enabled === "true"}
                onChange={(v) => set("op_enabled", v ? "true" : "false")}
              />
            </div>
          }
        >
          <div className="flex flex-col gap-4 px-5 py-5">
            <div>
              <div className="label mb-1.5">Время пингов (через запятую, ЧЧ:ММ)</div>
              <input
                className="input input-mono"
                placeholder="14:45, 19:45"
                value={settings.op_times}
                onChange={(e) => set("op_times", e.target.value)}
              />
              <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                Ежедневно. Бот отправит случайный текст + гифку и поставит реакции ✅ ❌ ⏰ ❓.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
              <AlarmClockCheck size={14} style={{ color: "var(--red)" }} />
              Реакции: ✅ буду · ❌ не буду · ⏰ опоздаю · ❓ под вопросом — добавляются автоматически.
            </div>
          </div>
        </Section>

        {/* Проверка онлайна */}
        <Section title="Проверка онлайна" eyebrow="задача №2"
          action={
            <div className="flex items-center gap-2">
              <span className="label">вкл</span>
              <Toggle
                on={settings.weekly_enabled === "true"}
                onChange={(v) => set("weekly_enabled", v ? "true" : "false")}
              />
            </div>
          }
        >
          <div className="flex flex-col gap-4 px-5 py-5">
            <div>
              <div className="label mb-1.5">Дни проверки</div>
              <div className="flex flex-wrap gap-1.5">
                {DAY_OPTIONS.map((d) => (
                  <button key={d.n} className="day-pill" data-on={days.includes(d.n)} onClick={() => toggleDay(d.n)}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="label mb-1.5">Время</div>
                <input
                  className="input input-mono"
                  placeholder="12:00"
                  value={settings.weekly_time}
                  onChange={(e) => set("weekly_time", e.target.value)}
                />
              </div>
              <div>
                <div className="label mb-1.5">Норма в часах</div>
                <input
                  className="input input-mono"
                  type="number"
                  min={1}
                  value={settings.norm_hours}
                  onChange={(e) => set("norm_hours", e.target.value)}
                />
              </div>
              <div>
                <div className="label mb-1.5">Часовой пояс</div>
                <select
                  className="select"
                  value={settings.timezone}
                  onChange={(e) => set("timezone", e.target.value)}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
              <CalendarClock size={14} style={{ color: "var(--amber)" }} />
              Пингуются должники (&lt; нормы) без отпуска, у которых привязан Discord ID.
            </div>
          </div>
        </Section>

        {/* Снимок статистики */}
        <Section title="Снимок статистики" eyebrow="задача №3 · график"
          action={
            <div className="flex items-center gap-2">
              <span className="label">вкл</span>
              <Toggle
                on={settings.snapshot_enabled === "true"}
                onChange={(v) => set("snapshot_enabled", v ? "true" : "false")}
              />
            </div>
          }
        >
          <div className="flex flex-col gap-4 px-5 py-5">
            <div>
              <div className="label mb-1.5">Время снимка</div>
              <input
                className="input input-mono"
                placeholder="21:00"
                value={settings.snapshot_time}
                onChange={(e) => set("snapshot_time", e.target.value)}
              />
              <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
                Ежедневно. Сохраняет точку онлайн-статистики в таблицу графика на главной странице,
                запись об этом появляется в журнале (вкладка «Сайт»).
              </p>
            </div>
            <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
              <CalendarClock size={14} style={{ color: "var(--green)" }} />
              Часовой пояс — из настройки выше (по умолчанию Europe/Moscow).
            </div>
          </div>
        </Section>

        {/* Контроль вышедших из состава */}
        <Section title="Контроль вышедших из состава" eyebrow="задача №4 · пинг при выходе"
          action={
            <div className="flex items-center gap-2">
              <span className="label">вкл</span>
              <Toggle
                on={settings.left_members_check === "true"}
                onChange={(v) => set("left_members_check", v ? "true" : "false")}
              />
            </div>
          }
        >
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="grid grid-cols-2 items-start gap-3">
              <div className="flex min-w-0 flex-col items-start">
                <div className="label mb-1.5 flex min-h-[3rem] w-full items-end">ID канала проверок</div>
                <input
                  className="input input-mono w-full"
                  placeholder="например 1185432109876543210"
                  value={settings.left_check_channel_id}
                  onChange={(e) => set("left_check_channel_id", e.target.value.replace(/[^\d]/g, ""))}
                />
                <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                  Если пусто — используется основной канал для пингов из блока Discord.
                </p>
              </div>
              <div className="flex min-w-0 flex-col items-start">
                <div className="label mb-1.5 flex min-h-[3rem] w-full items-end">ID роли «Командирский состав»</div>
                <input
                  className="input input-mono w-full"
                  placeholder="например 1392552505162072264"
                  value={settings.command_role_id}
                  onChange={(e) => set("command_role_id", e.target.value.replace(/[^\d]/g, ""))}
                />
                <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                  Эта роль пингуется, если у вышедшего бойца сутки не сняты роли клана.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              <ShieldCheck size={14} className="mt-0.5 flex-none" style={{ color: "var(--amber)" }} />
              <span>
                Боец пропал из состава rs-red.com и с него не сняли роли клана в течение суток —
                бот отправит однократный пинг командирскому составу. При возвращении бойца в состав
                флаг сбрасывается, и проверка сработает снова при следующем выходе.
              </span>
            </div>
          </div>
        </Section>
      </div>

      {/* Автосинхронизация cookie */}
      <Section
        glow
        title="Автосинхронизация cookie"
        eyebrow="расширение v5 · автоматический перехват ключа"
        action={
          <a className="btn btn-primary btn-sm" href="https://addons.opera.com/ru/extensions/" target="_blank" rel="noreferrer">
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
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 8,
                      flex: "none",
                      fontSize: 11,
                      background: "var(--red-soft)",
                      color: "#ff7b7b",
                      border: "1px solid rgba(255,61,61,.3)",
                    }}
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
              Больше никаких ZIP-архивов. Расширение само отправляет cookie при входе на rs-red.com и каждые 10 минут, а также умеет «будить» панель.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <div className="label mb-1.5">Адрес сервера (для расширения)</div>
              <div className="flex gap-2">
                <input className="input input-mono" readOnly value={origin} onFocus={(e) => e.target.select()} />
                <button className="btn btn-icon" onClick={() => copy("origin", origin)} title="Скопировать">
                  {copied === "origin" ? <CheckCircle2 size={14} style={{ color: "var(--green)" }} /> : <Copy size={14} />}
                </button>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                Скрипт расширения получает этот адрес автоматически с этой страницы.
              </p>
            </div>
            <div>
              <div className="label mb-1.5">Ключ синхронизации</div>
              <div className="flex gap-2">
                <input className="input input-mono" readOnly value={syncKey} onFocus={(e) => e.target.select()} />
                <button className="btn btn-icon" onClick={() => copy("key", syncKey)} title="Скопировать">
                  {copied === "key" ? <CheckCircle2 size={14} style={{ color: "var(--green)" }} /> : <Copy size={14} />}
                </button>
                <button className="btn" onClick={regenerateKey} disabled={regenerating} title="Перевыпустить ключ">
                  {regenerating ? <Spinner /> : <RefreshCw size={14} />}
                  Новый
                </button>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                Ключ защищает панель от перезаписи данных. «Новый» — старый ключ мгновенно перестаёт работать.
              </p>
            </div>
            <div
              className="flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12px] leading-relaxed"
              style={{ borderColor: "var(--stroke-soft)", background: "rgba(255,255,255,.025)", color: "var(--muted)" }}
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

      {/* Контент */}
      <Section title="Тексты и гифки для операций" eyebrow="ротация контента" action={<FileText size={15} style={{ color: "var(--dim)" }} />}>
        <div className="grid gap-5 px-5 py-5 lg:grid-cols-2">
          <div>
            <div className="label mb-1.5">Тексты пинга — по одному на строку</div>
            <textarea
              className="textarea"
              style={{ minHeight: 180 }}
              value={settings.op_texts}
              onChange={(e) => set("op_texts", e.target.value)}
            />
            <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
              На каждый пинг выбирается случайная строка.
            </p>
          </div>
          <div>
            <div className="label mb-1.5">Гифки — прямые ссылки, по одной на строку</div>
            <textarea
              className="textarea"
              style={{ minHeight: 180 }}
              value={settings.op_gifs}
              onChange={(e) => set("op_gifs", e.target.value)}
            />
            <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
              Нужны прямые ссылки на .gif: с Giphy откройте гифку → «Copy Link» → вариант вида{" "}
              <span className="kbd">media.giphy.com/media/…/giphy.gif</span>. Если ссылка битая —
              сообщение уйдёт просто без картинки.
            </p>
          </div>
        </div>
      </Section>

      {/* Статус автоматики */}
      <Section title="Автоматика" eyebrow="что происходит само">
        <div className="grid gap-3 px-5 py-5 sm:grid-cols-3">
          {[
            {
              icon: Bot,
              title: "Каждую минуту",
              text: "Планировщик проверяет расписание и запускает задачи точно в слот",
            },
            {
              icon: Cookie,
              title: "Каждые 30 минут",
              text: "Состав подразделения обновляется с rs-red.com в фоне",
            },
            {
              icon: ShieldCheck,
              title: "Защита от дублей",
              text: "Каждый слот фиксируется в базе — повторных пингов не будет",
            },
          ].map((f) => (
            <div key={f.title} className="flex gap-3 rounded-2xl border p-4" style={{ borderColor: "var(--stroke-soft)", background: "rgba(255,255,255,.02)" }}>
              <f.icon size={17} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
              <div>
                <div className="text-[13px] font-bold">{f.title}</div>
                <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                  {f.text}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <button className="btn btn-primary self-end" onClick={save} disabled={saving}>
        {saving ? <Spinner /> : <Save size={15} />}
        Сохранить всё
      </button>

      {/* Скрытый блок для передачи данных в расширение (content.js) */}
      <div 
        id="atk-extension-data" 
        data-url={origin} 
        data-key={syncKey} 
        style={{ display: 'none' }}
      ></div>

    </div>
  );
}
