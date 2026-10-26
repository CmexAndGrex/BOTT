import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/api-auth";
import { getSessionMember } from "@/lib/member-auth";
import { resolvePanelRights } from "@/lib/panel-rights";
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
 * Флаги прав (isCommander/isAdmin/role) считаются ОДНИМ правилом —
 * resolvePanelRights — по обеим сессиям и по должности со званием из табеля.
 * Раньше здесь отдавалась только роль панельной cookie, поэтому командир
 * подразделения («Волков») с сессией кабинета читался на клиенте как «guest»:
 * страница «Контроль» отвечала «Доступ запрещен», а в сайдбаре не появлялась
 * секция «УПРАВЛЕНИЕ». Роль в ответе — 'commander', а не внутреннее 'officer':
 * так её называет требование, и так её ждёт интерфейс.
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

  const rights = resolvePanelRights({
    panelRole: user?.role,
    memberRole: member?.role,
    memberPost: member?.post,
    memberRank: member?.rank,
  });

  const cabinet = member
    ? hasProfileAccess(member.status)
      ? "ok"
      : "no_access"
    : rights.isCommander
      ? "not_linked"
      : "no_session";

  return NextResponse.json({
    role: rights.accessRole,
    // Явные флаги: страницы и компоненты не должны выводить права сами
    isCommander: rights.isCommander,
    isAdmin: rights.isAdmin,
    /** Право видеть приватные поля состава (Discord ID) */
    canViewPrivate: rights.canViewPrivate,
    username: user?.username ?? null,
    member: member
      ? {
          id: member.id,
          callsign: member.callsign,
          name: member.name,
          rank: member.rank,
          post: member.post,
          status: member.status,
          statusLabel: statusLabel(member.status),
          role: member.role,
          /**
           * Аватар и Discord ID нужны карточке пользователя в сайдбаре: там
           * рисуется та же аватарка, что и в досье. Раньше отдавался только
           * avatarUrl, и при пустом значении карточка «теряла» лицо бойца,
           * хотя дефолтную аватарку Discord можно собрать из ID.
           */
          avatarUrl: member.avatarUrl,
          discordId: member.discordId,
        }
      : null,
    /** Состояние кабинета: ok | not_linked | no_access | no_session */
    cabinet,
  });
}
