/**
 * Список рапортов для панели модерации (/admin/recruits).
 *
 * Доступ строго для командиров и администраторов (requireStaff). Отдаются
 * только безопасные поля: ни хеш пароля, ни токен-версия наружу не уходят.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { members, recruitApplications } from "@/db/schema";
import { requireStaff } from "@/lib/member-auth";
import { isMemberStatus, readApplication, type MemberStatus } from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  // Фильтр по статусу: по умолчанию — очередь рапортов (pending)
  const requested = req.nextUrl.searchParams.get("status") || "pending";
  const status: MemberStatus | "all" = isMemberStatus(requested) ? requested : "all";

  try {
    const query = db
      .select({
        id: members.id,
        callsign: members.callsign,
        name: members.name,
        discordId: members.discordId,
        avatarUrl: members.avatarUrl,
        rank: members.rank,
        /** Должность: правится из панели, как и звание (приказ по офицеру) */
        post: members.post,
        unit: members.unit,
        status: members.status,
        role: members.role,
        applicationData: members.applicationData,
        createdAt: members.createdAt,
        updatedAt: members.updatedAt,
      })
      .from(members)
      .orderBy(desc(members.createdAt));

    /**
     * Статус pending ставится по умолчанию и строкам, которые создаёт
     * синхронизация состава с rs-red.com: это уже служащие бойцы, а не рапорты.
     * Чтобы очередь модерации не тонула в них, показываем только тех, у кого
     * есть аккаунт (задан пароль), и тех, на кого есть ожидающая заявка —
     * даже если пароля у карточки ещё нет. Остальные доступны во вкладке «Все».
     */
    const pendingMemberIds = db
      .select({ id: recruitApplications.memberId })
      .from(recruitApplications)
      .where(sql`${recruitApplications.status} IN ('pending', 'new')`);

    const rows =
      status === "pending"
        ? await query.where(
            and(
              eq(members.status, "pending"),
              or(isNotNull(members.passwordHash), inArray(members.id, pendingMemberIds))
            )
          )
        : status === "all"
          ? await query
          : await query.where(eq(members.status, status));

    return NextResponse.json({
      ok: true,
      status,
      recruits: rows.map((row) => ({
        ...row,
        application: readApplication(row.applicationData),
        applicationData: undefined,
      })),
    });
  } catch (e) {
    console.error("[recruits] Не удалось получить список рапортов:", e);
    return NextResponse.json({ ok: false, error: "Ошибка БД" }, { status: 500 });
  }
}