import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/api-auth";
import { getSessionMember } from "@/lib/member-auth";
import { statusLabel } from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Кто сейчас в системе — для интерфейса.
 *
 * Возвращает и сессию панели (роль admin/officer), и сессию бойца (позывной,
 * статус). Обе могут существовать одновременно: командир заходит в панель и
 * отдельно в свой кабинет бойца, и интерфейс должен показать обе возможности.
 */
export async function GET(req: NextRequest) {
  // Роль берём из БД (учёт tokenVersion и актуальных прав), гостю — "guest"
  const user = await getAuthUser(req);
  const member = await getSessionMember(req);

  return NextResponse.json({
    role: user ? user.role : "guest",
    username: user?.username ?? null,
    member: member
      ? {
          id: member.id,
          callsign: member.callsign,
          status: member.status,
          statusLabel: statusLabel(member.status),
          role: member.role,
          avatarUrl: member.avatarUrl,
        }
      : null,
  });
}
