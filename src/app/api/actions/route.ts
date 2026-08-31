import { NextRequest, NextResponse } from "next/server";
import { runOperationPing, runWeeklyCheck } from "@/lib/tasks";
import { jwtVerify } from "jose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");

export async function POST(req: NextRequest) {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return NextResponse.json({ ok: false, error: "Нет доступа: авторизуйтесь" }, { status: 401 });

  try {
    await jwtVerify(token, SECRET);
  } catch (err) {
    return NextResponse.json({ ok: false, error: "Сессия устарела" }, { status: 403 });
  }

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  if (body.action === "operation") {
    const r = await runOperationPing("manual");
    return NextResponse.json(r, { status: r.ok ? 200 : 502 });
  }
  if (body.action === "weekly") {
    const r = await runWeeklyCheck("manual");
    return NextResponse.json(r, { status: r.ok ? 200 : 502 });
  }
  return NextResponse.json({ ok: false, error: "Неизвестное действие" }, { status: 400 });
}