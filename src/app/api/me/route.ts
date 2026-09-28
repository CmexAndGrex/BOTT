import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/api-auth";
import { getSessionMember } from "@/lib/member-auth";
import { hasProfileAccess, statusLabel } from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Кто сейчас в системе — для интерфейса.
 *
 * Возвращает и сессию панели (роль admin/officer), и сессию бойца (позывной,
 * статус). Обе могут существовать одновременно: командир заходит в панель и
 * отдельно в свой кабинет бойца, и интерфейс должен показать обе возможности.
 *
 * `cabinet` — состояние личного кабинета: пункт меню «Личный кабинет» и его
 * подсветка опираются на него, а не на догадку о наличии cookie. Значение
 * `not_linked` (штаб без связи с бойцом) специально отличается от `no_session`:
 * первый не должен видеть кнопку «Войти» — он уже вошёл.
 */
export async function GET(req: NextRequest) {
  // Роль берём из БД (учёт текущей tokenVersion и актуальных прав), гостю — "guest"
  const user = await getAuthUser(req);
  const member = await getSessionMember(req);

  const cabinet = member
    ? hasProfileAccess(member.status)
      ? "ok"
      : "no_access"
    : user && (user.role === "admin" || user.role === "officer")
      ? "not_linked"
      : "no_session";

  return NextResponse.json({
    role: user ? user.role : "guest",
    username: user?.username ?? null,
    member: member
      ? {
          id: member.id,
          callsign: member.callsign,
          rank: member.rank,
          status: member.status,
          statusLabel: statusLabel(member.status),
          role: member.role,
          avatarUrl: member.avatarUrl,
        }
      : null,
    /** Состояние кабинета: ok | not_linked | no_access | no_session */
    cabinet,
  });
}
