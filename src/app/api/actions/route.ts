import { NextRequest, NextResponse } from "next/server";
import { runOperationPing, runWeeklyCheck } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
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
