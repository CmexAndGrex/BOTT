import { db } from "@/db";
import { cronRuns } from "@/db/schema";
import { runOperationPing, runWeeklyCheck, syncRoster } from "@/lib/tasks";
import {
  getSettings,
  nowInTz,
  parseDays,
  parseTimes,
  resolveCookie,
  setSettingQuiet,
} from "@/lib/settings";

declare global {
  // eslint-disable-next-line no-var
  var __redopsSchedulerStarted: boolean | undefined;
}

/** Атомарно резервирует слот запуска, чтобы не было дублей */
async function claim(key: string): Promise<boolean> {
  const rows = await db
    .insert(cronRuns)
    .values({ key })
    .onConflictDoNothing()
    .returning({ key: cronRuns.key });
  return rows.length > 0;
}

async function tick() {
  const map = await getSettings();
  const tz = map.get("timezone") || "Europe/Moscow";
  const now = nowInTz(tz);
  const hhmm = `${now.hh}:${now.mm}`;
  const slot = `${now.dateStr} ${hhmm}`;

  // Heartbeat для индикатора «планировщик жив»
  await setSettingQuiet("_heartbeat", new Date().toISOString());

  // Задача 1: ежедневные пинги на операцию
  if (map.get("op_enabled") === "true") {
    const times = parseTimes(map.get("op_times") || "");
    if (times.includes(hhmm)) {
      if (await claim(`operation:${slot}`)) {
        const r = await runOperationPing("schedule");
        console.log(`[scheduler] operation ping @ ${slot}: ${r.ok ? "ok" : r.error}`);
      }
    }
  }

  // Задача 2: недельная проверка онлайна (пт/сб/вс в настроенное время)
  if (map.get("weekly_enabled") === "true") {
    const days = parseDays(map.get("weekly_days") || "");
    const time = (map.get("weekly_time") || "12:00").trim();
    if (days.includes(now.weekday) && time === hhmm) {
      if (await claim(`weekly:${slot}`)) {
        const r = await runWeeklyCheck("schedule");
        console.log(`[scheduler] weekly check @ ${slot}: ${r.ok ? "ok" : r.error}`);
      }
    }
  }

  // Автосинхронизация состава раз в 30 минут, чтобы панель была актуальной
  if (resolveCookie(map)) {
    const last = Date.parse(map.get("_last_auto_sync") || "") || 0;
    if (Date.now() - last > 30 * 60 * 1000) {
      if (await claim(`autosync:${new Date().toISOString().slice(0, 13)}h`)) {
        await setSettingQuiet("_last_auto_sync", new Date().toISOString());
        const r = await syncRoster("auto");
        console.log(
          `[scheduler] auto sync: ${r.ok ? `${r.membersCount} members` : r.error}`
        );
      }
    }
  }
}

export function startScheduler() {
  if (globalThis.__redopsSchedulerStarted) return;
  globalThis.__redopsSchedulerStarted = true;

  console.log("[scheduler] RED OPS scheduler started (tick every 20s)");
  const safeTick = () => {
    tick().catch((e) => console.error("[scheduler] tick error:", e));
  };
  setInterval(safeTick, 20_000);
  setTimeout(safeTick, 5_000);
}
