import { NextResponse } from "next/server";
import { syncRoster } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const result = await syncRoster("manual");
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
