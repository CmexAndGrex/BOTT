import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { jwtVerify } from "jose";
import { db } from "@/db";
import { members } from "@/db/schema";
import { getJwtSecret } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET = getJwtSecret();

/** Имеет ли гость право видеть приватные поля бойцов (Discord ID) */
async function canViewPrivate(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return ["admin", "officer"].includes((payload as any).role);
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  try {
    const canSee = await canViewPrivate(req);
    const rows = await db.select().from(members).orderBy(desc(members.id));
    // Гостям не отдаём Discord ID бойцов (в UI и так скрыто — не даём и в API)
    const safe = canSee ? rows : rows.map((m) => ({ ...m, discordId: null }));
    return NextResponse.json({ members: safe, data: safe });
  } catch (error) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
