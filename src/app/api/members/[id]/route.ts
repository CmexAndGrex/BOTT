import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { members, logs, recruitApplications } from "@/db/schema";
import { requireRosterEditor } from "@/lib/member-auth";
import { MEMBER_STATUS, normalizeMemberStatus } from "@/lib/recruits";
import { applyVacationRole, type VacationRoleOutcome } from "@/lib/vacation-roles";

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

  /**
   * Отпуск — одна операция, а не два независимых поля.
   *
   * Флаг `vacation` (по нему шедулер закрывает отпуск и исключает бойца из
   * пингов) и текстовый статус `status` (по нему работает вход в кабинет)
   * обязаны меняться вместе. Раньше здесь ставился только флаг: боец с
   * `vacation = true` и `status = "active"` показывался в табеле как «в
   * строю», а боец со снятым отпуском и `status = "vacation"` продолжал
   * считаться отсутствующим. Плюс ко всему роль Discord «Отпуск» в этой
   * точке не менялась вовсе — кнопка в панели правила только базу.
   */
  const previousStatus = normalizeMemberStatus(oldMember.status);
  let vacationRole: VacationRoleOutcome | null = null;

  if (typeof body.vacation === "boolean" && body.vacation !== oldMember.vacation) {
    set.vacation = body.vacation;
    changesDescription.push(`статус отпуска на "${body.vacation ? "В отпуске" : "Нет"}"`);
    detailsObj["Отпуск"] = body.vacation ? "В отпуске" : "Нет";

    // Статус ведём только у действующей карточки: у исключённого отпуск не
    // должен «воскрешать» доступ, а у заявки на рассмотрении статус `pending`
    // означает ещё не принятое решение.
    const serviceMember =
      previousStatus === MEMBER_STATUS.ACTIVE || previousStatus === MEMBER_STATUS.VACATION;
    if (serviceMember) {
      set.status = body.vacation ? MEMBER_STATUS.VACATION : MEMBER_STATUS.ACTIVE;
    }

    // Возврат из отпуска обнуляет дату: иначе бейдж «в отпуске · до …»
    // показывал бы устаревший срок, а шедулер видел бы закрытый отпуск.
    if (body.vacation === false && body.vacationUntil === undefined) {
      set.vacationUntil = null;
    }

    // Роль «Отпуск» в Discord — «мягкий» шаг: база обновляется в любом случае,
    // а точная причина отказа Discord возвращается в ответе и попадает в журнал
    // (см. applyVacationRole). Дискорд-вызов идёт ДО записи в БД, чтобы роль
    // выдавалась по актуальному Discord ID из запроса, если он меняется тем же
    // PATCH-ем.
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

  /**
   * Флаг «привязка Discord открыла доступ».
   *
   * Тот же эффект, что и в /api/admin/roster/[id]/discord-id: сохранение ID —
   * подтверждение личности штабом, поэтому боец со статусом `pending`
   * переводится в `active`. Иначе боец, которому командир вписал ID из этой
   * панели, продолжал бы видеть «рапорт на рассмотрении» при входе.
   */
  let autoActivated = false;

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

      // `dismissed` не трогаем: исключение не отменяется привязкой Discord
      if (cleanedDiscord && normalizeMemberStatus(oldMember.status) === MEMBER_STATUS.PENDING) {
        set.status = MEMBER_STATUS.ACTIVE;
        set.active = true;
        autoActivated = true;
        changesDescription.push("статус на \"В строю\"");
        detailsObj["Статус"] = "pending → active (привязан Discord)";
      }
    }
  }

  /**
   * Роль «Отпуск» в Discord применяется ДО записи в базу.
   *
   * Порядок именно такой: Discord ID из этого же запроса (если штаб привязал
   * аккаунт одновременно с отпуском) уже разобран выше, и роль должна уйти на
   * актуальный ID, а не на прежний из карточки. Отказ Discord не отменяет
   * изменение в базе — отпуск решён штабом, и роль можно выдать повторно
   * (кнопкой или ближайшим циклом сверки).
   */
  if (typeof set.vacation === "boolean") {
    const targetDiscordId =
      set.discordId !== undefined
        ? (set.discordId as string | null)
        : oldMember.discordId;

    vacationRole = await applyVacationRole({
      discordId: targetDiscordId,
      vacation: set.vacation as boolean,
      memberName: oldMember.callsign || oldMember.name,
      source: "панель состава",
    });

    detailsObj["Роль «Отпуск»"] = vacationRole.ok
      ? vacationRole.message
      : `не изменена: ${vacationRole.error ?? vacationRole.message}`;
  }

  const rows = await db.update(members).set(set).where(eq(members.id, memberId)).returning();
  if (!rows.length) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  // Заявки бойца закрываются вместе со статусом: очередь модерации не должна
  // показывать уже принятого человека (сбой записи не отменяет правку карточки)
  if (autoActivated) {
    try {
      await db
        .update(recruitApplications)
        .set({
          status: "approved",
          reviewedBy: "автоматически (привязан Discord ID)",
          updatedAt: new Date(),
        })
        .where(
          sql`${recruitApplications.memberId} = ${memberId} AND ${recruitApplications.status} IN ('pending', 'new')`
        );
    } catch (e) {
      console.error("[members] Не удалось закрыть заявки бойца:", e);
    }
  }

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

  return NextResponse.json({
    ok: true,
    member: rows[0],
    autoActivated,
    // Итог по роли Discord: панель показывает предупреждение, если роль не
    // изменилась (нет прав у бота, роль выше роли бота, нет Discord ID).
    // Молчать об этом нельзя — штаб думает, что отпуск оформлен полностью.
    vacationRole: vacationRole
      ? {
          ok: vacationRole.ok,
          action: vacationRole.action,
          message: vacationRole.message,
          error: vacationRole.error ?? null,
        }
      : null,
  });
}
