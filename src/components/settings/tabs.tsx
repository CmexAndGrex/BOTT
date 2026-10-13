"use client";

/**
 * Вкладки страницы настроек: состав, типы и синхронизация с адресом.
 *
 * Зачем вкладки. Раньше /settings была одной длинной простыней карточек: токен
 * бота, каналы, тексты пингов, резервные копии — всё в одном потоке. Чтобы
 * поправить время снимка, приходилось прокручивать экран через полсотни полей,
 * а «Сохранить всё» внизу относилось сразу ко всем разделам. Вкладки делят
 * страницу по задачам администратора:
 *
 *   * «Интеграции»   — куда бот подключён (Discord, Google Таблица, rs-red, расширение);
 *   * «Планировщик»  — что и когда запускается само (задачи №1–5);
 *   * «Контент и роли» — что бот пишет и как называет роли (тексты, гифки, карта должностей);
 *   * «Обслуживание» — ручные действия: сверка ролей, синхронизация, копии, дампы.
 *
 * Активный таб хранится в адресе (?tab=…), а не только в состоянии компонента:
 * ссылку на нужный раздел можно передать коллеге, а F5 не сбрасывает выбор.
 * Используем history.replaceState вместо router.push — переключение вкладки не
 * должно считаться навигацией и не перезапрашивает настройки заново.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  Plug,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";

/** Настройки приходят плоской картой строк — как в GET /api/settings */
export type SettingsState = Record<string, string>;

/** Установка одного поля: страница-контейнер владеет состоянием и сохранением */
export type SetSetting = (key: string, value: string) => void;

/** Идентификаторы вкладок: они же значения ?tab= в адресе */
export type SettingsTabId = "integrations" | "scheduler" | "content" | "maintenance";

export type SettingsTab = {
  id: SettingsTabId;
  label: string;
  /** Короткое пояснение под заголовком вкладки */
  hint: string;
  icon: typeof Plug;
};

export const SETTINGS_TABS: SettingsTab[] = [
  {
    id: "integrations",
    label: "Интеграции",
    hint: "Discord, Google Таблица, rs-red.com и расширение панели",
    icon: Plug,
  },
  {
    id: "scheduler",
    label: "Планировщик",
    hint: "Задачи №1–5: пинги, проверка онлайна, снимок статистики, контроль состава",
    icon: CalendarClock,
  },
  {
    id: "content",
    label: "Контент и роли",
    hint: "Тексты пингов, гифки и карта должностей",
    icon: SlidersHorizontal,
  },
  {
    id: "maintenance",
    label: "Обслуживание",
    hint: "Сверка ролей, ручная синхронизация, резервные копии и дампы",
    icon: Wrench,
  },
];

/** Вкладка по умолчанию: с неё начинают, когда ничего не выбрано */
export const DEFAULT_TAB: SettingsTabId = "integrations";

const TAB_IDS = new Set<string>(SETTINGS_TABS.map((t) => t.id));

/**
 * Разбор адреса: имя таба из ?tab= или из #hash.
 *
 * Поддерживаем оба варианта, потому что закладки у людей разные: кто-то
 * копирует ссылку с query, кто-то — с якорем. Неизвестное значение тихо
 * заменяется на вкладку по умолчанию: опечатка в ссылке не должна ломать
 * страницу.
 */
export function tabFromLocation(search: string, hash: string): SettingsTabId {
  let fromSearch = "";
  try {
    fromSearch = new URLSearchParams(search).get("tab") || "";
  } catch {
    fromSearch = "";
  }
  const candidate = (fromSearch || hash.replace(/^#/, "")).trim();
  return TAB_IDS.has(candidate) ? (candidate as SettingsTabId) : DEFAULT_TAB;
}

/** Запись выбора в адрес без перезагрузки и без записи в историю браузера */
export function writeTabToLocation(id: SettingsTabId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("tab", id);
  url.hash = "";
  window.history.replaceState(null, "", url.toString());
}

/**
 * Хук активной вкладки.
 *
 * Читается из адреса при первом рендере ЛЕНИВО (в useState), а не в эффекте:
 * иначе страница успевала показать «Интеграции» и тут же перепрыгнуть на таб из
 * ссылки. Подписка на popstate нужна, чтобы кнопки «назад/вперёд» работали.
 */
export function useSettingsTab(): [SettingsTabId, (id: SettingsTabId) => void] {
  const [tab, setTabState] = useState<SettingsTabId>(() =>
    typeof window === "undefined"
      ? DEFAULT_TAB
      : tabFromLocation(window.location.search, window.location.hash)
  );

  useEffect(() => {
    const onPopState = () =>
      setTabState(tabFromLocation(window.location.search, window.location.hash));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const setTab = useCallback((id: SettingsTabId) => {
    setTabState(id);
    writeTabToLocation(id);
  }, []);

  return [tab, setTab];
}

/**
 * Таб-бар.
 *
 * Роли: tablist/tab + aria-selected — переключение доступно с клавиатуры, а
 * скринридер объявляет выбранный раздел. Стрелки обрабатываются вручную: у
 * кнопок-табов браузер сам по себе фокус не переставляет.
 */
export function SettingsTabBar({
  active,
  onChange,
}: {
  active: SettingsTabId;
  onChange: (id: SettingsTabId) => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const index = SETTINGS_TABS.findIndex((t) => t.id === active);
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = SETTINGS_TABS[(index + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    onChange(next.id);
  };

  return (
    <div className="tabs" role="tablist" aria-label="Разделы настроек" onKeyDown={onKeyDown}>
      {SETTINGS_TABS.map((t) => {
        const Icon = t.icon;
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`settings-panel-${t.id}`}
            className="tab"
            data-on={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
          >
            <Icon size={14} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Обёртка панели вкладки: связывает её с кнопкой таба через aria-controls */
export function SettingsTabPanel({
  id,
  children,
}: {
  id: SettingsTabId;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`settings-panel-${id}`}
      aria-labelledby={`settings-tab-${id}`}
      className="flex flex-col gap-5"
    >
      {children}
    </div>
  );
}