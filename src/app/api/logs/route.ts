import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { logs } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // Считываем параметр offset из URL (например: /api/logs?offset=150)
    const url = new URL(req.url);
    const offsetParam = url.searchParams.get("offset");
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
    const limit = 150;

    // Выгружаем строго лимитированный кусок данных
    const rows = await db.select()
      .from(logs)
      .orderBy(desc(logs.id))
      .limit(limit)
      .offset(offset);

    return NextResponse.json({ logs: rows });
  } catch (error) {
    console.error("Ошибка при получении логов:", error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}