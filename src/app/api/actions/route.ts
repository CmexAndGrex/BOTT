import { NextRequest, NextResponse } from "next/server";
import { runDismissedRolesCheck, runLeftMembersCheck, runOperationPing, runWeeklyCheck } from "@/lib/tasks";
import { requireStaff } from "@/lib/member-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Ручной запуск задач: командиры и админы.
  //
  // requireStaff считает права единым правилом resolvePanelRights: роль обеих
  // сессий, должность и звание. Иначе администратор или командир роты с
  // сессией кабинета (member_token) получал отказ на ручном запуске.
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

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
  if (body.action === "left-check") {
    const r = await runLeftMembersCheck("manual");
    return NextResponse.json(r, { status: r.ok ? 200 : 502 });
  }
  if (body.action === "roles-monitor") {
    const r = await runDismissedRolesCheck("manual");
    return NextResponse.json(r, { status: r.ok ? 200 : 502 });
  }
  return NextResponse.json({ ok: false, error: "Неизвестное действие" }, { status: 400 });
}
