import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { getSettings, setSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Сравнение секретов без утечки по времени */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** Простейшая защита от спама/брутфорса: не более N запросов в окно на IP */
const hits = new Map<string, { count: number; resetAt: number }>();
const MAX_HITS = 20;
const WINDOW_MS = 60_000;
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now > e.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 5000) hits.clear(); // защита от разрастания карты
    return false;
  }
  e.count++;
  return e.count > MAX_HITS;
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "RED OPS Cookie Endpoint" });
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ ok: false, error: "Слишком много запросов" }, { status: 429 });
  }

  let body: { key?: string; cookie?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const map = await getSettings(true);
  const expected = (map.get("_cookie_sync_key") || "").trim();

  if (!expected || !body.key || !safeEqual(body.key.trim(), expected)) {
    return NextResponse.json({ ok: false, error: "Неверный ключ синхронизации" }, { status: 403 });
  }

  const cookie = (body.cookie || "").trim();
  if (cookie.length < 8 || cookie.length > 8192 || !cookie.includes("=")) {
    return NextResponse.json({ ok: false, error: "Cookie пустая или повреждена" }, { status: 400 });
  }

  await setSettings({
    rs_cookie: cookie,
    _cookie_updated_at: new Date().toISOString(),
  });

  await db.insert(logs).values({
    kind: "sync",
    title: "Cookie обновлена автоматически",
    detail: "Источник: расширение RED OPS Cookie Sync",
    ok: true,
  });

  return NextResponse.json({ ok: true });
}
