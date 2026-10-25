import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, weeklyStats } from "@/db/schema";
import { desc } from "drizzle-orm";
import { requireStaff } from "@/lib/member-auth";
import { isRosterActive } from "@/lib/recruits";

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
    /**
     * «Учёт онлайна» показывает ВЕСЬ действующий состав, а не одно
     * подразделение командира.
     *
     * Раньше здесь стоял фильтр `unit = auth.member.unit`: командир роты видел
     * только бойцов роты, а артиллерийский дивизион, командование корпуса и
     * бойцы без заполненного unit пропадали из таблицы совсем. При этом в
     * «Составе» (/members) те же люди числились — счётчики расходились
     * (37 против 20), и штаб не видел должников из другого подразделения.
     *
     * Фильтр намеренно снят: учёт онлайна — сводный документ по всему составу,
     * разграничение доступа к странице делает requireStaff. Кого считать
     * действующим, решает общее правило isRosterActive — то же, что использует
     * табель, поэтому оба раздела показывают одно и то же число бойцов.
     */
    const allMembers = await db.select().from(members);
    const activeMembers = allMembers.filter((fighter) => isRosterActive(fighter));

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
