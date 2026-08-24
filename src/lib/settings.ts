import { db } from "@/db";
import { settings } from "@/db/schema";

export const DEFAULT_SETTINGS: Record<string, string> = {
  // Discord
  discord_token: "",
  discord_channel_id: "",
  discord_role_id: "",
  // RS RED
  rs_base_url: "https://rs-red.com",
  rs_subdiv_id: "5",
  rs_cookie: "",
  // Расписание
  timezone: "Europe/Moscow",
  op_enabled: "true",
  op_times: "14:45, 19:45",
  weekly_enabled: "true",
  weekly_days: "5,6,0", // пт, сб, вс
  weekly_time: "12:00",
  norm_hours: "10",
  // Контент
  op_texts: [
    "Бойцы, на операцию! Сбор через 15 минут. Отметьтесь реакцией под сообщением.",
    "Общий сбор! Операция начинается совсем скоро. Кто в деле — жми реакцию.",
    "Внимание, Танковые Войска! Сегодня стреляем из всех стволов. Ты в деле?",
    "Операция на подходе. Экипажи — по местам! Подтвердите участие реакцией.",
    "Танки выезжают. Команда ждёт каждого — отметься, будешь ли ты.",
    "Заводи двигатели! Операция начнется через 15 минут.",
    "Сегодня мы пишем историю Танковых Войск. Будешь в списке героев?",
    "Перекличка перед боем: буду — ✅, мимо — ❌, опоздаю — ⏰, под вопросом — ❓.",
    "Командование объявляет общий сбор. Подтверди участие реакцией ниже!",
    "Лучший способ провести вечер — операция с ТВ. Погнали!",
    "Если ты читаешь это сообщение — ты уже почти на операции. Отметься!",
    "Время появляться на радаре. Операция близко — жми реакцию!",
  ].join("\n"),
  op_gifs: [
    "https://media.giphy.com/media/5GoVLqeAOo6PK/giphy.gif",
    "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif",
    "https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif",
    "https://media.giphy.com/media/l46Cy1rHbQ92uuLXa/giphy.gif",
    "https://media.giphy.com/media/uTuLngvL9p0Xe/giphy.gif",
  ].join("\n"),
};

type Cache = { map: Map<string, string>; at: number } | null;
let cache: Cache = null;

export function invalidateSettingsCache() {
  cache = null;
}

export async function getSettings(force = false): Promise<Map<string, string>> {
  if (!force && cache && Date.now() - cache.at < 5000) return cache.map;
  const rows = await db.select().from(settings);
  const map = new Map<string, string>(Object.entries(DEFAULT_SETTINGS));
  for (const row of rows) map.set(row.key, row.value);
  cache = { map, at: Date.now() };
  return map;
}

export async function setSettings(patch: Record<string, string>) {
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== "string") continue;
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }
  invalidateSettingsCache();
}

export async function setSettingQuiet(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

/** Ключ синхронизации расширения: создаётся один раз и хранится в базе */
export async function ensureCookieSyncKey(): Promise<string> {
  const map = await getSettings(true);
  let key = (map.get("_cookie_sync_key") || "").trim();
  if (!key) {
    const { randomBytes } = await import("node:crypto");
    key = randomBytes(18).toString("hex");
    await setSettingQuiet("_cookie_sync_key", key);
  }
  return key;
}

/** Куки: приоритет у значения из панели, запасной вариант — env */
export function resolveCookie(map: Map<string, string>): string {
  const fromDb = (map.get("rs_cookie") || "").trim();
  if (fromDb) return fromDb;
  return (process.env.RS_RED_COOKIE || "").trim();
}

/** Токен бота: приоритет у значения из панели, запасной вариант — env */
export function resolveToken(map: Map<string, string>): string {
  const fromDb = (map.get("discord_token") || "").trim();
  if (fromDb) return fromDb;
  return (process.env.DISCORD_BOT_TOKEN || "").trim();
}

export function maskCookie(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (v.length <= 8) return "••••••••";
  return `${v.slice(0, 4)}••••••••${v.slice(-4)}`;
}

export function parseLines(s: string): string[] {
  return (s || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseTimes(s: string): string[] {
  return (s || "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d{1,2}:\d{2}$/.test(x))
    .map((x) => {
      const [h, m] = x.split(":");
      return `${h.padStart(2, "0")}:${m}`;
    });
}

export function parseDays(s: string): number[] {
  return (s || "")
    .split(/[,\s]+/)
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

export function normHours(map: Map<string, string>): number {
  const n = parseFloat(map.get("norm_hours") || "10");
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** Локальное время в заданном поясе */
export function nowInTz(tz: string): {
  dateStr: string;
  hh: string;
  mm: string;
  weekday: number;
  label: string;
} {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hourCycle: "h23",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      parts.weekday
    );
    return {
      dateStr: `${parts.year}-${parts.month}-${parts.day}`,
      hh: parts.hour,
      mm: parts.minute,
      weekday: weekday < 0 ? 0 : weekday,
      label: `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`,
    };
  } catch {
    const d = new Date();
    return {
      dateStr: d.toISOString().slice(0, 10),
      hh: String(d.getUTCHours()).padStart(2, "0"),
      mm: String(d.getUTCMinutes()).padStart(2, "0"),
      weekday: d.getUTCDay(),
      label: d.toISOString(),
    };
  }
}

/** Ближайшие запуски для отображения в интерфейсе */
export function nextRuns(map: Map<string, string>): {
  operation: string | null;
  weekly: string | null;
} {
  const tz = map.get("timezone") || "Europe/Moscow";
  const now = nowInTz(tz);
  const wdNames = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

  const result: { operation: string | null; weekly: string | null } = {
    operation: null,
    weekly: null,
  };

  if (map.get("op_enabled") === "true") {
    const times = parseTimes(map.get("op_times") || "");
    const nowMin = parseInt(now.hh, 10) * 60 + parseInt(now.mm, 10);
    for (let off = 0; off <= 7 && !result.operation; off++) {
      for (const t of times) {
        const [h, m] = t.split(":").map((x) => parseInt(x, 10));
        const mins = h * 60 + m;
        if (off === 0 && mins < nowMin) continue;
        result.operation =
          off === 0 ? `сегодня в ${t}` : off === 1 ? `завтра в ${t}` : `через ${off} дн. в ${t}`;
        break;
      }
    }
  }

  if (map.get("weekly_enabled") === "true") {
    const days = parseDays(map.get("weekly_days") || "");
    const time = map.get("weekly_time") || "12:00";
    const [h, m] = time.split(":").map((x) => parseInt(x, 10));
    const mins = h * 60 + m;
    const nowMin = parseInt(now.hh, 10) * 60 + parseInt(now.mm, 10);
    for (let off = 0; off <= 7 && !result.weekly; off++) {
      const wd = (now.weekday + off) % 7;
      if (!days.includes(wd)) continue;
      if (off === 0 && mins < nowMin) continue;
      result.weekly =
        off === 0
          ? `сегодня в ${time}`
          : off === 1
            ? `завтра в ${time}`
            : `${wdNames[wd]} в ${time}`;
    }
  }

  return result;
}
