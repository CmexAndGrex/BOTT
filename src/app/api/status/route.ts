import { NextResponse } from "next/server";
import { getBotUser, type BotUser } from "@/lib/discord";
import { checkSite } from "@/lib/tasks";
import { getSettings, nextRuns, resolveToken } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

declare global {
  // eslint-disable-next-line no-var
  var __redopsStatusCache:
    | {
        at: number;
        bot: { ok: boolean; user?: BotUser; error?: string };
        site: { ok: boolean; error?: string };
      }
    | undefined;
}

export async function GET() {
  const map = await getSettings();
  const token = resolveToken(map);

  const cached = globalThis.__redopsStatusCache;
  const fresh = cached && Date.now() - cached.at < 60_000;

  let bot: { ok: boolean; user?: BotUser; error?: string };
  let site: { ok: boolean; error?: string };

  if (fresh && cached) {
    bot = cached.bot;
    site = cached.site;
  } else {
    if (token) {
      try {
        const user = await getBotUser();
        bot = { ok: true, user };
      } catch (e) {
        bot = { ok: false, error: e instanceof Error ? e.message : "Ошибка" };
      }
    } else {
      bot = { ok: false, error: "Токен бота не задан (ни в настройках, ни в окружении)" };
    }
    site = await checkSite();
    globalThis.__redopsStatusCache = { at: Date.now(), bot, site };
  }

  const heartbeat = map.get("_heartbeat") || null;
  const runs = nextRuns(map);

  return NextResponse.json({
    bot: { configured: !!token, ...bot },
    site,
    schedulerAlive: heartbeat ? Date.now() - Date.parse(heartbeat) < 90_000 : false,
    heartbeat,
    nextRuns: runs,
    timezone: map.get("timezone") || "Europe/Moscow",
  });
}
