import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { requireStaff } from "@/lib/member-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Журнал содержит имена и действия сотрудников — доступен командирам и админам.
  // requireStaff допускает и сессию кабинета с правами штаба (роль officer/admin
  // или должность/звание командира подразделения), и сессию панели: командир,
  // работающий из кабинета, раньше получал 401 от requireRole(["officer"]).
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const offsetParam = url.searchParams.get("offset");
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
    const limit = 150;
    const category = url.searchParams.get("category");

    // Базовый запрос с сортировкой по убыванию id
    const baseQuery = db.select().from(logs).orderBy(desc(logs.id)).limit(limit).offset(offset);

    // Если указана категория — фильтруем по ней (для вкладки «Редактирование»)
    const rows = category
      ? await db
          .select()
          .from(logs)
          .where(eq(logs.category, category))
          .orderBy(desc(logs.id))
          .limit(limit)
          .offset(offset)
      : await baseQuery;

    return NextResponse.json({ logs: rows });
  } catch (error) {
    console.error("Ошибка при получении логов:", error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
