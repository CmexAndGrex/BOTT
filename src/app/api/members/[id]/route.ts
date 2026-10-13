import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { members, logs } from "@/db/schema";
import { requireRosterEditor } from "@/lib/member-auth";
import { MEMBER_STATUS } from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  // Редактирование бойцов (отпуск, Discord ID) — командиры и админы. Гвард
  // requireRosterEditor считает права общим правилом (resolvePanelRights):
  // командир подразделения по должности, работающий из кабинета (member_token),
  // тоже допускается — раньше requireAuth требовал cookie панели и отвечал 401.
  const auth = await requireRosterEditor(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const memberId = parseInt(id, 10);
  if (!Number.isFinite(memberId)) return NextResponse.json({ ok: false, error: "Некорректный ID" }, { status: 400 });

  let body: { vacation?: boolean; vacationUntil?: string | null; discordId?: string | null };
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 }); }

  const [oldMember] = await db.select().from(members).where(eq(members.id, memberId));
  if (!oldMember) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  const set: Record<string, unknown> = { updatedAt: new Date() };
  const changesDescription: string[] = [];
  const detailsObj: Record<string, string> = { "Боец": oldMember.name };

  if (typeof body.vacation === "boolean" && body.vacation !== oldMember.vacation) {
    set.vacation = body.vacation;
    changesDescription.push(`статус отпуска на "${body.vacation ? "В отпуске" : "Нет"}"`);
    detailsObj["Отпуск"] = body.vacation ? "В отпуске" : "Нет";
    // Снятие отпуска возвращает бойца в рабочий строй: текстовый статус
    // принудительно становится «active». Иначе он оставался "vacation", и
    // проверки активности (онлайн-норма, снапшоты) продолжали считать бойца
    // отсутствующим, хотя отпуск уже снят.
    if (body.vacation === false) {
      set.status = MEMBER_STATUS.ACTIVE;
    }
  }

  // Дата возвращения из отпуска: управляется отдельным полем. Снятие отпуска
  // обнуляет дату, чтобы бейдж «В ОТПУСКЕ» не показывал устаревшую дату.
  if (body.vacationUntil !== undefined) {
    const parsed = body.vacationUntil ? new Date(body.vacationUntil) : null;
    const valid = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    const prev = oldMember.vacationUntil ? new Date(oldMember.vacationUntil) : null;
    const changed = valid?.getTime() !== prev?.getTime();
    if (changed) {
      set.vacationUntil = valid;
      changesDescription.push(
        valid
          ? `дату возвращения на "${valid.toISOString().slice(0, 10)}"`
          : "дату возвращения (снята)"
      );
      detailsObj["Дата возвращения"] = valid ? valid.toISOString().slice(0, 10) : "не указана";
    }
  }

  if (body.discordId !== undefined) {
    const v = body.discordId;
    const cleanedDiscord = v === null || String(v).trim() === "" ? null : String(v).replace(/[^\d]/g, "");
    if (cleanedDiscord !== oldMember.discordId) {
      // Дубликат Discord ID запрещён: один Discord — один боец, иначе бот
      // упоминал бы двух человек по одной снежинке, а сверка ролей путалась.
      // Свою же запись (повторная установка того же ID) проверка не ловит.
      if (cleanedDiscord) {
        const [taken] = await db
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.discordId, cleanedDiscord), ne(members.id, memberId)));
        if (taken) {
          return NextResponse.json(
            { ok: false, error: "Этот Discord ID уже привязан к другому бойцу" },
            { status: 409 }
          );
        }
      }
      set.discordId = cleanedDiscord;
      changesDescription.push(`Discord ID на "${cleanedDiscord || "пусто"}"`);
      detailsObj["Discord ID"] = cleanedDiscord || "не указан";
    }
  }

  const rows = await db.update(members).set(set).where(eq(members.id, memberId)).returning();
  if (!rows.length) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  if (changesDescription.length > 0) {
    // Роль автора берём из карточки сессии (requireRosterEditor возвращает её
    // по панельной сессии, когда она есть): admin → «Администратор», иначе — «Командир».
    const roleRu = auth.member.role === "admin" ? "Администратор" : "Командир";
    const authorFormatted = auth.member.callsign
      ? `${roleRu} ${auth.member.callsign}`
      : roleRu;

    await db.insert(logs).values({
      category: "edit",
      author: authorFormatted,
      action: `изменил ${changesDescription.join(" и ")} бойцу ${oldMember.name}`,
      details: detailsObj,
      kind: "system",
      title: "Редактирование бойца",
      detail: `Изменен боец ${oldMember.name}`,
      ok: true,
    });
  }

  return NextResponse.json({ ok: true, member: rows[0] });
}
