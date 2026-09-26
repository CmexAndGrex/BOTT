/**
 * Состав подразделения для интерфейса.
 *
 * Роут читают и гости: табель открыт всем, а Discord ID — технический
 * идентификатор, по которому человека можно упомянуть и увести в личку.
 * Поэтому поле отдаётся только штабу (сессия панели ИЛИ сессия бойца с ролью
 * officer/admin), а не «скрывается в разметке»: то, что уехало в браузер,
 * спрятать уже нельзя.
 *
 * Наружу уходит строго перечисленный набор полей: хеш пароля, версия токена и
 * анкета рапорта клиенту не нужны вовсе.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import { getAuthUser } from "@/lib/api-auth";
import { getSessionMember } from "@/lib/member-auth";
import { canViewPrivateFields } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Имеет ли зритель право видеть приватные поля бойцов (Discord ID) */
async function canViewPrivate(req: NextRequest): Promise<boolean> {
  const [user, member] = await Promise.all([getAuthUser(req), getSessionMember(req)]);
  return canViewPrivateFields(user?.role, member?.role);
}

export async function GET(req: NextRequest) {
  try {
    const canSee = await canViewPrivate(req);

    const rows = await db
      .select({
        id: members.id,
        pid: members.pid,
        handle: members.handle,
        name: members.name,
        rankName: members.rankName,
        post: members.post,
        minutes: members.minutes,
        hours: members.hours,
        vacation: members.vacation,
        vacationUntil: members.vacationUntil,
        active: members.active,
        warnings: members.warnings,
        callsign: members.callsign,
        rank: members.rank,
        unit: members.unit,
        status: members.status,
        role: members.role,
        avatarUrl: members.avatarUrl,
        discordId: members.discordId,
        updatedAt: members.updatedAt,
      })
      .from(members)
      .orderBy(desc(members.id));

    // Гостям не отдаём Discord ID бойцов (в UI и так скрыто — не даём и в API)
    const safe = canSee ? rows : rows.map((m) => ({ ...m, discordId: null }));
    return NextResponse.json({ members: safe, data: safe });
  } catch (error) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
