import { NextRequest, NextResponse } from "next/server";
import { syncRoster } from "@/lib/tasks";
import { requireStaff } from "@/lib/member-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Синхронизация состава: командиры и админы.
  //
  // requireStaff вместо requireRole(["officer"]): допускается и сессия
  // кабинета с правами штаба (командир подразделения по должности), а не
  // только cookie панели — иначе командир роты получал 401 на ручном синке.
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  const result = await syncRoster("manual");
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
