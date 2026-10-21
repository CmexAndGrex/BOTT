import { NextResponse } from "next/server";
import { asc, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { members, snapshots, weeklyStats } from "@/db/schema";
import { computeStats, pctColor } from "@/lib/tasks";
import { getSettings, normHours, nowInTz } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Минимальное число уникальных бойцов в неделе, чтобы она попала в табы.
 * В базе остались черновые тестовые срезы за август — в них 2–7 человек;
 * показывать их рядом с полноценными неделями бессмысленно.
 */
const MIN_WEEK_FIGHTERS = 15;

/** Начало текущей недели (Понедельник 00:00) в часовом поясе из настроек */
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

/**
 * Ключ недели (дата понедельника, YYYY-MM-DD) для момента времени в часовом поясе.
 *
 * weekly_stats.created_at — момент записи в UTC, а неделя в подразделении
 * считается по локальному календарю. Поэтому группируем по дате,
 * полученной через Intl, а не по UTC-дню: воскресный вечер в Москве уже
 * понедельник по UTC, и такая запись попала бы в чужую неделю.
 */
function weekKeyFor(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const diff = weekday === 0 ? 6 : weekday - 1;
  return new Date(Date.UTC(y, m - 1, d - diff)).toISOString().slice(0, 10);
}

/** Подпись диапазона недели: «13.10 – 19.10» */
function weekLabel(startKey: string): string {
  const [y, m, d] = startKey.split("-").map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d)}.${pad(m)} – ${pad(end.getUTCDate())}.${pad(end.getUTCMonth() + 1)}`;
}

type WeekRow = { hours: number; vacation: boolean };

function aggregateWeek(rows: WeekRow[], norm: number) {
  const total = rows.length;
  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
  const passed = rows.filter((r) => Math.floor(r.hours) >= norm).length;
  const zeroHours = rows.filter((r) => Math.floor(r.hours) === 0).length;
  const onVacation = rows.filter((r) => r.vacation).length;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    total,
    totalHours: round1(totalHours),
    avgHours: total > 0 ? round1(totalHours / total) : 0,
    passed,
    zeroHours,
    onVacation,
    percent: total > 0 ? round1((passed / total) * 100) : 0,
  };
}

export async function GET() {
  const map = await getSettings();
  const norm = normHours(map);
  const tz = map.get("timezone") || "Europe/Moscow";

  const rows = await db.select().from(members).where(eq(members.active, true));
  const live = computeStats(rows, norm);

  const monday = await getMonday();
  const currentKey = monday.toISOString().slice(0, 10);

  // Запрашиваем снимки только за текущую неделю (начиная с понедельника)
  const historyDesc = await db
    .select()
    .from(snapshots)
    .where(gte(snapshots.createdAt, monday))
    .orderBy(desc(snapshots.id))
    .limit(50); // Увеличен лимит, чтобы влезли все точки за 7 дней

  const history = historyDesc.reverse();

  /**
   * Прошлые недели: weekly_stats пишется по строке на бойца при недельном
   * срезе, но задача могла запускаться несколько раз за неделю. Группируем
   * строго по member_id и берём только последнюю запись бойца за неделю
   * (created_at, затем id) — иначе один человек считался бы несколько раз,
   * раздувая и число бойцов, и суммарный налёт.
   */
  const weeklyRows = await db
    .select({
      memberId: weeklyStats.memberId,
      hours: weeklyStats.hours,
      vacation: weeklyStats.vacation,
      createdAt: weeklyStats.createdAt,
    })
    .from(weeklyStats)
    .orderBy(asc(weeklyStats.createdAt), asc(weeklyStats.id));

  const byWeek = new Map<string, Map<number, WeekRow>>();
  for (const row of weeklyRows) {
    const key = weekKeyFor(row.createdAt, tz);
    // Текущая неделя считается по актуальным division_members.hours, а не по
    // записи среза: снимок мог быть сделан в начале недели.
    if (key >= currentKey) continue;
    let week = byWeek.get(key);
    if (!week) {
      week = new Map();
      byWeek.set(key, week);
    }
    // Порядок сортировки — от старых к новым, поэтому последняя запись
    // бойца перезаписывает предыдущие.
    week.set(row.memberId, { hours: row.hours, vacation: row.vacation });
  }

  const pastKeys = Array.from(byWeek.keys()).sort();
  const weeks = pastKeys
    // Отсекаем старые черновые недели с неполным составом.
    .filter((key) => (byWeek.get(key)?.size ?? 0) >= MIN_WEEK_FIGHTERS)
    .map((key) => ({
      key,
      label: weekLabel(key),
      start: key,
      end: new Date(new Date(`${key}T00:00:00.000Z`).getTime() + 6 * 86_400_000).toISOString().slice(0, 10),
      isCurrent: false,
      ...aggregateWeek(Array.from(byWeek.get(key)?.values() ?? []), norm),
    }));

  // Текущая неделя — всегда последняя в списке
  weeks.push({
    key: currentKey,
    label: "Текущая неделя",
    start: currentKey,
    end: new Date(monday.getTime() + 6 * 86_400_000).toISOString().slice(0, 10),
    isCurrent: true,
    ...aggregateWeek(rows.map((r) => ({ hours: r.hours, vacation: r.vacation })), norm),
  });

  return NextResponse.json({
    norm,
    live,
    color: pctColor(live.percent),
    latestSnapshot: historyDesc[0] ?? null,
    history,
    weeks,
  });
}
