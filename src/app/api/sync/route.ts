import { NextRequest, NextResponse } from "next/server";
import { syncRoster } from "@/lib/tasks";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  
  try {
    await jwtVerify(token, SECRET);
  } catch (err) {
    return NextResponse.json({ error: "Сессия устарела" }, { status: 403 });
  }

  const result = await syncRoster("manual");
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}