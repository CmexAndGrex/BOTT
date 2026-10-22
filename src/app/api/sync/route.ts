import { NextRequest, NextResponse } from "next/server";
import { syncRoster } from "@/lib/tasks";
import { requireStaff } from "@/lib/member-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Синхронизация состава: командиры и админы.
  //
  // requireStaff считает права единым правилом resolvePanelRights: роль обеих
  // сессий, должность и звание. Поэтому синк доступен и администратору, и
  // командиру подразделения — в том числе вошедшему только в кабинет
  // (member_token), а не в панель.
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  const result = await syncRoster("manual");
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
