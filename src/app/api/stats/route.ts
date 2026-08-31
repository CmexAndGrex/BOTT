import { NextResponse } from "next/server";
import { desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { members, snapshots } from "@/db/schema";
import { computeStats, pctColor } from "@/lib/tasks";
import { getSettings, normHours } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Вычисляем начало текущей недели (Понедельник 00:00:00)
function getMonday() {
  const now = new Date();
  const day = now.getDay();
  // Если сегодня воскресенье (0), отнимаем 6 дней. Иначе отнимаем (день - 1)
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

export async function GET() {
  const map = await getSettings();
  const norm = normHours(map);

  const rows = await db.select().from(members).where(eq(members.active, true));
  const live = computeStats(rows, norm);

  const monday = getMonday();

  // Запрашиваем снимки только за текущую неделю (начиная с понедельника)
  const historyDesc = await db
    .select()
    .from(snapshots)
    .where(gte(snapshots.createdAt, monday))
    .orderBy(desc(snapshots.id))
    .limit(50); // Увеличен лимит, чтобы влезли все точки за 7 дней
    
  const history = historyDesc.reverse();

  return NextResponse.json({
    norm,
    live,
    color: pctColor(live.percent),
    latestSnapshot: historyDesc[0] ?? null,
    history,
  });
}