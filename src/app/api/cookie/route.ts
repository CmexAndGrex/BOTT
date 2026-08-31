import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { getSettings, setSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, service: "RED OPS Cookie Endpoint" });
}

export async function POST(req: NextRequest) {
  let body: { key?: string; cookie?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const map = await getSettings(true);
  const expected = (map.get("_cookie_sync_key") || "").trim();

  if (!expected || !body.key || body.key.trim() !== expected) {
    return NextResponse.json({ ok: false, error: "Неверный ключ синхронизации" }, { status: 403 });
  }

  const cookie = (body.cookie || "").trim();
  if (cookie.length < 8 || !cookie.includes("=")) {
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