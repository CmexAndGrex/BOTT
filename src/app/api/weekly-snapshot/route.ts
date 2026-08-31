import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, weeklyStats } from "@/db/schema";
import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  const token = req.cookies.get("auth_token")?.value;
  let isAuthorized = false;

  if (key && key === process.env.CRON_SECRET) {
    isAuthorized = true;
  } else if (token) {
    try {
      await jwtVerify(token, SECRET);
      isAuthorized = true;
    } catch (e) {}
  }

  if (!isAuthorized) {
    return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  }

  try {
    const allMembers = await db.select().from(members).where(eq(members.active, true));
    let processedCount = 0;

    for (const fighter of allMembers) {
      await db.insert(weeklyStats).values({
        memberId: fighter.id,
        hours: fighter.hours,
        vacation: fighter.vacation,
      });

      let newWarnings = fighter.warnings;
      if (!fighter.vacation) {
        if (fighter.hours < 10) newWarnings += 1;
        else newWarnings = 0;
      }
      if (newWarnings > 2) newWarnings = 2;

      await db.update(members).set({ warnings: newWarnings }).where(eq(members.id, fighter.id));
      processedCount++;
    }

    return NextResponse.json({ ok: true, message: `Срез выполнен. Бойцов: ${processedCount}` });
  } catch (error) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}