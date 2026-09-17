import { NextRequest, NextResponse } from "next/server";
import { syncRoster } from "@/lib/tasks";
import { requireRole } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Синхронизация состава: командиры и админы
  const auth = await requireRole(req, ["officer"]);
  if (!auth.ok) return auth.response;

  const result = await syncRoster("manual");
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
