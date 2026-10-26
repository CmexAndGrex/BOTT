import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import { requireRosterEditor } from "@/lib/member-auth";
import {
  checkLifecycleTarget,
  isMemberAction,
  memberActionLabel,
} from "@/lib/member-lifecycle";
import { applyMemberAction } from "@/lib/member-lifecycle-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Административные действия над бойцом: «В запас» и «Уволить».
 *
 * POST /api/members/[id]/action { action: 'reserve' | 'dismiss', reason?: string }
 *
 * Права: только администраторы и офицеры — гвард requireRosterEditor (то же
 * правило, что у правки состава: командир подразделения по должности из
 * кабинета тоже допускается). Право считает сервер, интерфейс лишь отражает.
 *
 * Защита цели проверяется ДВАЖДЫ: в гварде (быстрый отказ до похода в БД) и в
 * оркестраторе. Запрещено применять к командиру корпуса (Волков Д. В.) и к
 * текущему пользователю — «самострел» не проходит ни в каком виде.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireRosterEditor(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const memberId = parseInt(id, 10);
  if (!Number.isFinite(memberId)) {
    return NextResponse.json({ ok: false, error: "Некорректный ID" }, { status: 400 });
  }

  let body: { action?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  if (!isMemberAction(body.action)) {
    return NextResponse.json(
      { ok: false, error: "Неизвестное действие: ожидается reserve или dismiss" },
      { status: 400 }
    );
  }
  const action = body.action;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  const [member] = await db.select().from(members).where(eq(members.id, memberId));
  if (!member) {
    return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });
  }

  /**
   * Защита цели: сам пользователь и командование корпуса.
   *
   * ID бойца сессии берём из карточки гварда (auth.member.id): у панельной
   * сессии без связки он 0, и сравнение с реальным ID не сработает — как и
   * задумано (у администратора без карточки «самострела» нет).
   */
  const target = checkLifecycleTarget(action, member, auth.member.id);
  if (!target.ok) {
    return NextResponse.json({ ok: false, error: target.reason }, { status: 403 });
  }

  // Подпись инициатора для журнала: роль панели + позывной (как в PATCH /api/members/[id])
  const roleRu = auth.member.role === "admin" ? "Администратор" : "Командир";
  const authorLabel = auth.member.callsign
    ? `${roleRu} ${auth.member.callsign}`
    : roleRu;

  try {
    const result = await applyMemberAction({ action, member, authorLabel, reason });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.message, sheets: result.sheets },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      message: result.message,
      action,
      actionLabel: memberActionLabel(action),
      member: result.member,
      sheets: result.sheets,
      discord: result.discord,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[members/action] ${memberActionLabel(action)} #${memberId}:`, error);
    return NextResponse.json(
      { ok: false, error: `Сбой выполнения действия: ${error}` },
      { status: 500 }
    );
  }
}
