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
    return NextResponse.json({ ok: false, role: "guest", pendingDiscord });
  }

  // Анкету читаем отдельным запросом: она нужна только в кабинете/модерации,
  // и тянуть jsonb ради каждой проверки сессии незачем.
  const [row] = await db
    .select({ applicationData: members.applicationData })
    .from(members)
    .where(eq(members.id, member.id));

  return NextResponse.json({
    ok: true,
    member: {
      id: member.id,
      callsign: member.callsign,
      rank: member.rank,
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
  member?: {
    id: number;
    callsign: string;
    rank: string;
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