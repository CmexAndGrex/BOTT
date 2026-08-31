import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, snapshots } from "@/db/schema";
import { eq } from "drizzle-orm";
import { computeStats } from "@/lib/tasks";
import { getSettings, normHours } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Доступ запрещен" }, { status: 403 });
  }

  const map = await getSettings();
  const norm = normHours(map);
  const rows = await db.select().from(members).where(eq(members.active, true));
  const live = computeStats(rows, norm);

  const stats = live as any;

  // Делаем тихий снимок для графика
  await db.insert(snapshots).values({
    total: live.total,
    ok: stats.ok || stats.passed || stats.success || stats.okCount || 0,
    vacation: live.onVacation,
    percent: live.percent,
  } as any);

  return NextResponse.json({ ok: true, message: "Точка графика добавлена тихо" });
}