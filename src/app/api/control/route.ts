import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, weeklyStats } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    // Получаем только активный состав
    const activeMembers = await db.select().from(members).where(eq(members.active, true));
    
    // Получаем всю историю, сортируя от свежей к старой
    const allStats = await db.select().from(weeklyStats).orderBy(desc(weeklyStats.createdAt));

    // Привязываем до 4 последних недель к каждому бойцу
    const data = activeMembers.map((fighter) => {
      const fighterStats = allStats
        .filter((s) => s.memberId === fighter.id)
        .slice(0, 4)
        .reverse(); // Переворачиваем, чтобы старые недели были слева, а новые справа
      return { ...fighter, stats: fighterStats };
    });

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}