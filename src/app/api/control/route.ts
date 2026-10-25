import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, weeklyStats } from "@/db/schema";
import { desc } from "drizzle-orm";
import { requireStaff } from "@/lib/member-auth";
import { isRosterActive } from "@/lib/recruits";
import { getMondayWeeksAgo } from "@/lib/week-utils";
import { seedOfficialOnlineReports } from "@/lib/seed-official-reports";

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
    // Автоматический однократный засев эталонных данных за 3 недели октября 2026
    // (защищён идемпотентным флагом 'official_oct_2026_seeded_v1' в bot_settings)
    seedOfficialOnlineReports().catch((e) =>
      console.error("[control] Ошибка автозасева эталонных данных:", e)
    );

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

    // Вычисляем точные даты начала 4 недель (3 прошлых + текущая)
    // Каждая колонка таблицы жёстко привязана к дате: никакого позиционного смещения
    const week3Start = getMondayWeeksAgo(3); // 3 недели назад
    const week2Start = getMondayWeeksAgo(2); // 2 недели назад
    const week1Start = getMondayWeeksAgo(1); // прошлая неделя
    const week0Start = getMondayWeeksAgo(0); // текущая неделя

    // Загружаем все weekly_stats для активных бойцов за 4 нужные недели
    const allStats = await db.select().from(weeklyStats);
    const statsIndex = new Map<string, typeof allStats[0]>();
    for (const s of allStats) {
      statsIndex.set(`${s.memberId}_${s.weekStart}`, s);
    }

    // Привязываем данные каждого бойца строго по дате начала недели (week_start),
    // а не позиционно — это ключевое исправление бага со сдвигом колонок
    const data = activeMembers.map((fighter) => {
      const stat3 = statsIndex.get(`${fighter.id}_${week3Start}`) ?? null;
      const stat2 = statsIndex.get(`${fighter.id}_${week2Start}`) ?? null;
      const stat1 = statsIndex.get(`${fighter.id}_${week1Start}`) ?? null;
      // Текущая неделя: сначала ищем в weekly_stats (high-water mark),
      // если есть — берём МАКСИМУМ с текущими живыми часами
      const stat0raw = statsIndex.get(`${fighter.id}_${week0Start}`);
      const currentHoursHWM = stat0raw ? Math.max(stat0raw.hours, fighter.hours) : fighter.hours;

      const { passwordHash, memberTokenVersion, ...safeFighter } = fighter;
      return {
        ...safeFighter,
        // Текущие часы — максимум из live и high-water mark
        hours: currentHoursHWM,
        // История по неделям, строго по ключу week_start
        weekStats: {
          [week3Start]: stat3 ? { hours: stat3.hours, vacation: stat3.vacation } : null,
          [week2Start]: stat2 ? { hours: stat2.hours, vacation: stat2.vacation } : null,
          [week1Start]: stat1 ? { hours: stat1.hours, vacation: stat1.vacation } : null,
        },
        // Даты недель для фронтенда (чтобы он знал, к какой дате какая колонка)
        weekKeys: {
          week3: week3Start,
          week2: week2Start,
          week1: week1Start,
          week0: week0Start,
        },
      };
    });

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
