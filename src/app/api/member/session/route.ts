/**
 * Текущий боец для интерфейса: карточка кабинета и состояние сессии.
 *
 * Роут анонимный по смыслу — он возвращает либо данные бойца, либо «гость»,
 * поэтому страница входа и форма рапорта могут спросить состояние, не
 * обрабатывая 401.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import { getSessionMember, MEMBER_OAUTH_PENDING_COOKIE, unpackDiscordProfile } from "@/lib/member-auth";
import { resolvePanelRights } from "@/lib/panel-rights";
import {
  readApplication,
  ROLE_LABELS,
  statusLabel,
  type MemberRole,
  type MemberStatus,
} from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const pendingDiscord = unpackDiscordProfile(req.cookies.get(MEMBER_OAUTH_PENDING_COOKIE)?.value);
  const member = await getSessionMember(req);

  if (!member) {
    // Флаги отдаются и гостю: клиент не должен решать права сам. У гостя они
    // ложные, поэтому страницы и сайдбар работают по одному и тому же контракту
    // и не различают «нет сессии» и «сессия без прав».
    return NextResponse.json({
      ok: false,
      role: "guest",
      isCommander: false,
      isAdmin: false,
      pendingDiscord,
    });
  }

  // Анкету читаем отдельным запросом: она нужна только в кабинете/модерации,
  // и тянуть jsonb ради каждой проверки сессии незачем.
  const [row] = await db
    .select({ applicationData: members.applicationData })
    .from(members)
    .where(eq(members.id, member.id));

  // Права считает единое правило (resolvePanelRights): оно учитывает и роль
  // бойца, и должность со званием из табеля. Командир подразделения («Волков»)
  // получает isCommander = true даже когда роль штаба в колонке role не
  // выставлена, — иначе страница «Контроль» отвечала ему отказом.
  const rights = resolvePanelRights({
    memberRole: member.role,
    memberPost: member.post,
    memberRank: member.rank,
  });

  return NextResponse.json({
    ok: true,
    // Роль сессии бойца остаётся внутренней (recruit/member/officer/admin):
    // по ней клиент различает уровни доступа, а флаги ниже уже учитывают
    // должность командира
    role: member.role,
    isCommander: rights.isCommander,
    isAdmin: rights.isAdmin,
    member: {
      id: member.id,
      callsign: member.callsign,
      // ФИО нужно форме рапорта: карточка в Discord показывает реальное имя
      name: member.name,
      rank: member.rank,
      post: member.post,
      unit: member.unit,
      status: member.status,
      statusLabel: statusLabel(member.status),
      role: member.role,
      roleLabel: ROLE_LABELS[member.role],
      avatarUrl: member.avatarUrl,
      discordId: member.hasDiscord ? member.discordId : null,
      hasDiscord: member.hasDiscord,
      hasPassword: member.hasPassword,
      createdAt: member.createdAt,
      application: readApplication(row?.applicationData),
    },
    pendingDiscord,
  });
}

/** Типы для клиента (экспорт в отдельном модуле-типе не нужен: см. components) */
export type SessionResponse = {
  ok: boolean;
  role?: string;
  /** Флаги прав: считаются общим правилом, клиент их не выводит */
  isCommander?: boolean;
  isAdmin?: boolean;
  member?: {
    id: number;
    callsign: string;
    name: string;
    rank: string;
    post: string | null;
    unit: string | null;
    status: MemberStatus;
    statusLabel: string;
    role: MemberRole;
    roleLabel: string;
    avatarUrl: string | null;
    discordId: string | null;
    hasDiscord: boolean;
    hasPassword: boolean;
    createdAt: string;
  };
};