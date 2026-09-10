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

  // Делаем тихий снимок для графика
  await db.insert(snapshots).values({
    total: live.total,
    zeroHours: live.zeroHours,
    passed: live.passed,
    failed: live.failed,
    onVacation: live.onVacation,
    percent: live.percent,
    source: "daily-cron",
  });

  return NextResponse.json({ ok: true, message: "Точка графика добавлена тихо" });
}
