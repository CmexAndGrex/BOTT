import { NextResponse } from "next/server";
import { desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { members, snapshots } from "@/db/schema";
import { computeStats, pctColor } from "@/lib/tasks";
import { getSettings, normHours, nowInTz } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Начало текущей недели (Понедельник 00:00) в часовом поясе из настроек
async function getMonday() {
  const map = await getSettings();
  const tz = map.get("timezone") || "Europe/Moscow";
  const now = nowInTz(tz);
  const [y, m, d] = now.dateStr.split("-").map(Number);
  // now.weekday: 0 = вс, 1 = пн … 6 = сб
  const diff = now.weekday === 0 ? 6 : now.weekday - 1;
  const monday = new Date(Date.UTC(y, m - 1, d - diff));
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

export async function GET() {
  const map = await getSettings();
  const norm = normHours(map);

  const rows = await db.select().from(members).where(eq(members.active, true));
  const live = computeStats(rows, norm);

  const monday = await getMonday();

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
