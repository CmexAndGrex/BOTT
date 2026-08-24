import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { getSettings, setSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Расширение шлёт запросы кросс-доменно — открываем CORS (инициатор всё равно защищён ключом) */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

/** Preflight-запрос браузера перед POST с Content-Type: application/json */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** Проверка доступности эндпоинта */
export async function GET() {
  return NextResponse.json(
    { ok: true, service: "RED OPS Cookie Endpoint" },
    { headers: CORS }
  );
}

/**
 * Приём cookie от браузерного расширения RED OPS Cookie Sync.
 * Защищается ключом синхронизации из панели настроек.
 */
export async function POST(req: NextRequest) {
  let body: { key?: string; cookie?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Некорректный JSON" },
      { status: 400, headers: CORS }
    );
  }

  const map = await getSettings(true);
  const expected = (map.get("_cookie_sync_key") || "").trim();

  if (!expected || !body.key || body.key.trim() !== expected) {
    return NextResponse.json(
      { ok: false, error: "Неверный ключ синхронизации" },
      { status: 403, headers: CORS }
    );
  }

  const cookie = (body.cookie || "").trim();
  if (cookie.length < 8 || !cookie.includes("=")) {
    return NextResponse.json(
      { ok: false, error: "Cookie пустая или повреждена" },
      { status: 400, headers: CORS }
    );
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

  return NextResponse.json({ ok: true }, { headers: CORS });
}
