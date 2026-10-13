import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, weeklyStats } from "@/db/schema";
import { and, eq, desc } from "drizzle-orm";
import { requireStaff } from "@/lib/member-auth";

export async function GET(req: NextRequest) {
  // Страница «Контроль» доступна командирам и админам; роут отдаёт состав
  // вместе с Discord ID, поэтому проверяем права прямо здесь, а не только
  // на клиенте (защита от обхода middleware). requireStaff допускает и сессию
  // кабинета с правами штаба (роль officer/admin или должность/звание
  // командира подразделения), и сессию панели: командир, работающий из
  // кабинета, раньше получал 401 от requireRole(["officer"]).
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  try {
    // Командир видит только своё подразделение: фильтруем по unit из его
    // карточки сессии. У администратора без строки в табеле unit пуст — тогда
    // показываем весь активный состав (прежнее поведение).
    const activeMembers = auth.member.unit
      ? await db
          .select()
          .from(members)
          .where(and(eq(members.active, true), eq(members.unit, auth.member.unit)))
      : await db.select().from(members).where(eq(members.active, true));

    // Получаем всю историю, сортируя от свежей к старой
    const allStats = await db.select().from(weeklyStats).orderBy(desc(weeklyStats.createdAt));

    // Привязываем до 4 последних недель к каждому бойцу
    const data = activeMembers.map((fighter) => {
      const fighterStats = allStats
        .filter((s) => s.memberId === fighter.id)
        .slice(0, 4)
        .reverse(); // Переворачиваем, чтобы старые недели были слева, а новые справа
      const { passwordHash, memberTokenVersion, ...safeFighter } = fighter;
      return { ...safeFighter, stats: fighterStats };
    });

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
