import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_SETTINGS,
  ensureCookieSyncKey,
  getSettings,
  maskCookie,
  setSettingQuiet,
  setSettings,
} from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET_KEYS = new Set(["rs_cookie", "discord_token"]);

export async function GET() {
  const map = await getSettings(true);
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = map.get(key) ?? "";
    out[key] = SECRET_KEYS.has(key) ? maskCookie(value) : value;
  }
  const cookieSyncKey = await ensureCookieSyncKey();
  return NextResponse.json({
    settings: out,
    cookieSyncKey,
    cookieUpdatedAt: map.get("_cookie_updated_at") || null,
    env: {
      hasToken: !!(process.env.DISCORD_BOT_TOKEN || "").trim(),
      hasCookie: !!(process.env.RS_RED_COOKIE || "").trim(),
    },
  });
}

export async function PUT(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  // Перегенерация ключа для расширения
  if (String(body.regenerate_key) === "true") {
    const cookieSyncKey = randomBytes(18).toString("hex");
    await setSettingQuiet("_cookie_sync_key", cookieSyncKey);
    return NextResponse.json({ ok: true, cookieSyncKey });
  }

  const patch: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const raw = body[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (SECRET_KEYS.has(key)) {
      // Пустое или замаскированное значение = не менять
      if (!value || value.includes("••")) continue;
      patch[key] = value;
      continue;
    }
    if (key === "op_enabled" || key === "weekly_enabled") {
      patch[key] = value === "true" ? "true" : "false";
      continue;
    }
    if (key === "weekly_time") {
      if (/^\d{1,2}:\d{2}$/.test(value)) {
        const [h, m] = value.split(":");
        patch[key] = `${h.padStart(2, "0")}:${m}`;
      }
      continue;
    }
    patch[key] = value;
  }

  await setSettings(patch);
  return NextResponse.json({ ok: true });
}
