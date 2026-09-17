import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, snapshots } from "@/db/schema";
import { eq } from "drizzle-orm";
import { computeStats } from "@/lib/tasks";
import { getSettings, normHours } from "@/lib/settings";
import { authorizeCron } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Проверка секрета внешнего cron: timing-safe + отказ при пустом CRON_SECRET
  const cron = authorizeCron(req);
  if (!cron.ok) return cron.response;

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
