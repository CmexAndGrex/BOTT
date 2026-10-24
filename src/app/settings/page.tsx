"use client";

/**
 * Страница настроек: контейнер вкладок.
 *
 * Роль этого файла — только каркас: заголовок, таб-бар, кнопка сохранения и
 * всплывающее уведомление. Состояние настроек и вся логика сохранения тоже
 * здесь, потому что «Сохранить всё» одно на страницу и отправляет один
 * PUT /api/settings со всей картой значений — вкладки лишь делят разметку, а не
 * данные. Так настройки, разложенные по вкладкам, сохраняются одной кнопкой, и
 * переключение вкладки не может «потерять» правки из соседней.
 *
 * Разметка разнесена по компонентам вкладок:
 *   * integrations-tab.tsx — Discord, Google Таблица, rs-red.com, расширение;
 *   * enlistment-tab.tsx   — роли Discord при вступлении и листы ШДС;
 *   * scheduler-tab.tsx    — задачи №1–5 и сводка автоматики;
 *   * content-tab.tsx      — тексты пингов, гифки, карта должностей;
 *   * maintenance-tab.tsx  — сверка ролей и панель обслуживания с копиями.
 *
 * Активная вкладка хранится в адресе (?tab=…): ссылкой можно поделиться, а
 * перезагрузка страницы не сбрасывает выбранный раздел.
 */
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Save, XCircle } from "lucide-react";
import { Spinner } from "@/components/ui";
import {
  SettingsTabBar,
  SettingsTabPanel,
  SETTINGS_TABS,
  useSettingsTab,
  type SettingsState,
} from "@/components/settings/tabs";
import IntegrationsTab from "@/components/settings/integrations-tab";
import EnlistmentTab from "@/components/settings/enlistment-tab";
import SchedulerTab from "@/components/settings/scheduler-tab";
import ContentTab from "@/components/settings/content-tab";
import MaintenanceTab from "@/components/settings/maintenance-tab";

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
  const [tab, setTab] = useSettingsTab();

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

  /**
   * Сохранение всей карты настроек.
   *
   * Отправляем целиком, а не «только текущую вкладку»: роут сравнивает значения
   * со старыми и пишет в журнал ровно то, что изменилось, поэтому лишние поля
   * ничего не портят, зато правки с разных вкладок не теряются.
   */
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

  const current = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0];

  if (!settings) {
    return (
      <div className="flex flex-col gap-4">
        <div className="skeleton" style={{ height: 60 }} />
        <div className="skeleton" style={{ height: 260 }} />
        <div className="skeleton" style={{ height: 260 }} />
      </div>
    );
  }

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
            style={{ borderColor: notice.ok ? "rgba(16,185,129,.4)" : "rgba(190,18,60,.45)" }}
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

      <div className="flex flex-col gap-3">
        <SettingsTabBar active={tab} onChange={setTab} />
        <p className="text-[12px]" style={{ color: "var(--dim)" }}>
          {current.hint}
        </p>
      </div>

      {/* Панель рендерится только активной вкладки: неактивные не запрашивают
          данные и не держат в DOM десятки полей. */}
      {tab === "integrations" && (
        <SettingsTabPanel id="integrations">
          <IntegrationsTab
            settings={settings}
            set={set}
            env={env}
            cookieUpdatedAt={cookieUpdatedAt}
            syncKey={syncKey}
            origin={origin}
            copied={copied}
            copy={copy}
            regenerateKey={regenerateKey}
            regenerating={regenerating}
          />
        </SettingsTabPanel>
      )}

      {tab === "enlistment" && (
        <SettingsTabPanel id="enlistment">
          <EnlistmentTab settings={settings} set={set} />
        </SettingsTabPanel>
      )}

      {tab === "scheduler" && (
        <SettingsTabPanel id="scheduler">
          <SchedulerTab settings={settings} set={set} days={days} toggleDay={toggleDay} />
        </SettingsTabPanel>
      )}

      {tab === "content" && (
        <SettingsTabPanel id="content">
          <ContentTab settings={settings} set={set} />
        </SettingsTabPanel>
      )}

      {tab === "maintenance" && (
        <SettingsTabPanel id="maintenance">
          <MaintenanceTab settings={settings} set={set} />
        </SettingsTabPanel>
      )}

      <button className="btn btn-primary self-end" onClick={save} disabled={saving}>
        {saving ? <Spinner /> : <Save size={15} />}
        Сохранить всё
      </button>

      {/* Скрытый блок для передачи данных в расширение (content.js) */}
      <div
        id="atk-extension-data"
        data-url={origin}
        data-key={syncKey}
        style={{ display: "none" }}
      ></div>
    </div>
  );
}
