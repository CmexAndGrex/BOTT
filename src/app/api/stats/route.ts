import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { members, snapshots } from "@/db/schema";
import { computeStats, pctColor } from "@/lib/tasks";
import { getSettings, normHours } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const map = await getSettings();
  const norm = normHours(map);

  const rows = await db.select().from(members).where(eq(members.active, true));
  const live = computeStats(rows, norm);

  const historyDesc = await db
    .select()
    .from(snapshots)
    .orderBy(desc(snapshots.id))
    .limit(24);
  const history = historyDesc.reverse();

  return NextResponse.json({
    norm,
    live,
    color: pctColor(live.percent),
    latestSnapshot: historyDesc[0] ?? null,
    history,
  });
}
