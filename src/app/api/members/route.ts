import { NextResponse } from "next/server";
import { db } from "@/db";
import { members } from "@/db/schema";
import { desc } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Просто отдаем список всех бойцов всем желающим (чтение разрешено всем)
    const rows = await db.select().from(members).orderBy(desc(members.id));
    return NextResponse.json({ data: rows });
  } catch (error) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}