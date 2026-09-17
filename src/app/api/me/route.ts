import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Роль берём из БД (учёт tokenVersion и актуальных прав), гостю — "guest"
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ role: "guest" });
  return NextResponse.json({ ok: true, role: user.role, username: user.username });
}
