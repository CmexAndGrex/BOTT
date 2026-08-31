import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, users } from "@/db/schema";
import { jwtVerify } from "jose";
import { DEFAULT_SETTINGS, ensureCookieSyncKey, getSettings, maskCookie, setSettingQuiet, setSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");
const SECRET_KEYS = new Set(["rs_cookie", "discord_token"]);

const SETTING_NAMES: Record<string, string> = {
  norm_hours: "норму часов", weekly_time: "время проверки онлайн", timezone: "часовой пояс",
  discord_channel_id: "ID канала Discord", discord_role_id: "ID роли Discord", rs_base_url: "адрес rs-red",
  rs_subdiv_id: "ID подразделения", op_enabled: "статус задачи пингов", weekly_enabled: "статус проверки онлайн",
  op_times: "время пингов", weekly_days: "дни проверки онлайн", op_texts: "тексты для операций",
  op_gifs: "гифки для операций", rs_cookie: "куки rs-red", discord_token: "токен Discord бота",
};

export async function GET() {
  const map = await getSettings(true);
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = map.get(key) ?? "";
    out[key] = SECRET_KEYS.has(key) ? maskCookie(value) : value;
  }
  const cookieSyncKey = await ensureCookieSyncKey();
  return NextResponse.json({
    settings: out, cookieSyncKey, cookieUpdatedAt: map.get("_cookie_updated_at") || null,
    env: { hasToken: !!(process.env.DISCORD_BOT_TOKEN || "").trim(), hasCookie: !!(process.env.RS_RED_COOKIE || "").trim() },
  });
}

export async function PUT(req: NextRequest) {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return NextResponse.json({ ok: false, error: "Нет доступа" }, { status: 401 });

  try {
    const verified = await jwtVerify(token, SECRET);
    if ((verified.payload as any).role !== "admin") return NextResponse.json({ ok: false, error: "Только администратор" }, { status: 403 });
  } catch (err) { return NextResponse.json({ ok: false, error: "Сессия устарела" }, { status: 403 }); }

  let body: Record<string, unknown>;
  try { body = await req.json(); } 
  catch { return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 }); }

  if (String(body.regenerate_key) === "true") {
    const cookieSyncKey = randomBytes(18).toString("hex");
    await setSettingQuiet("_cookie_sync_key", cookieSyncKey);
    return NextResponse.json({ ok: true, cookieSyncKey });
  }

  const oldMap = await getSettings(true);
  const patch: Record<string, string> = {};
  const changedKeys: string[] = [];
  const detailsObj: Record<string, string> = {};

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const raw = body[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();

    if (value.length > 20000) return NextResponse.json({ ok: false, error: `Текст в настройке "${key}" слишком длинный` }, { status: 400 });
    if (key === "rs_base_url" && value !== "https://rs-red.com" && value !== "") return NextResponse.json({ ok: false, error: "Недопустимый базовый URL" }, { status: 400 });

    const humanName = SETTING_NAMES[key] || `настройку "${key}"`;

    if (SECRET_KEYS.has(key)) {
      if (!value || value.includes("••")) continue;
      const oldValue = oldMap.get(key) ?? "";
      if (value !== oldValue) {
        patch[key] = value; changedKeys.push(humanName); detailsObj[humanName] = "Обновлено (скрыто)";
      }
      continue;
    }
    if (key === "op_enabled" || key === "weekly_enabled") {
      const valBool = value === "true" ? "true" : "false";
      const oldValue = oldMap.get(key) ?? "false";
      if (valBool !== oldValue) {
        patch[key] = valBool; changedKeys.push(humanName);
        detailsObj[humanName] = `было: "${oldValue === "true" ? "Включено" : "Выключено"}" ➔ стало: "${valBool === "true" ? "Включено" : "Выключено"}"`;
      }
      continue;
    }
    if (key === "weekly_time" && /^\d{1,2}:\d{2}$/.test(value)) {
      const [h, m] = value.split(":");
      const formattedTime = `${h.padStart(2, "0")}:${m}`;
      const oldValue = oldMap.get(key) ?? "";
      if (formattedTime !== oldValue) {
        patch[key] = formattedTime; changedKeys.push(humanName);
        detailsObj[humanName] = `было: "${oldValue || "пусто"}" ➔ стало: "${formattedTime}"`;
      }
      continue;
    }
    const oldValue = oldMap.get(key) ?? "";
    if (value !== oldValue) {
      patch[key] = value; changedKeys.push(humanName);
      detailsObj[humanName] = `было: "${oldValue || "пусто"}" ➔ стало: "${value}"`;
    }
  }

  if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true });
  await setSettings(patch);

  let authorFormatted = "Командир";
  try {
    const verified = await jwtVerify(token, SECRET);
    const payload = verified.payload as any;
    const username = payload.username || payload.sub || payload.name;
    if (username) {
      const [dbUser] = await db.select().from(users).where(eq(users.username, username));
      if (dbUser) authorFormatted = `${dbUser.role === "admin" ? "Администратор" : "Командир"} ${dbUser.username}`;
      else authorFormatted = `${payload.role === "admin" ? "Администратор" : "Командир"} ${username}`;
    }
  } catch { }

  await db.insert(logs).values({
    category: "edit", author: authorFormatted, action: `изменил ${changedKeys.join(", ")}`,
    details: detailsObj, kind: "system", title: "Изменение настроек", detail: "Обновлены конфигурации системы", ok: true,
  });

  return NextResponse.json({ ok: true });
}