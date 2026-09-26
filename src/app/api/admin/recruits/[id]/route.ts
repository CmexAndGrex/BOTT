/**
 * Решение штаба по рапорту: одобрить, отклонить или перевести в отпуск.
 *
 * Одобрение делает две вещи в одном шаге: переводит бойца в active и
 * дописывает его в Google Таблицу ШДС через существующий src/lib/gsheets.ts
 * (applyShdsRequest со сценарием «Добавление в ШДС»). Модуль таблицы не
 * менялся — используется его публичный контракт ParsedRequest.
 *
 * Если таблица недоступна, боец всё равно зачисляется: рапорт уже одобрен
 * штабом, и терять это решение нельзя. Ошибка синхронизации возвращается в
 * ответе (ok: false у sheets) и попадает в журнал — модератор повторит.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { logs, members } from "@/db/schema";
import { requireStaff } from "@/lib/member-auth";
import {
  DEFAULT_RANK,
  isMemberRole,
  MANUAL_DISCORD_ID,
  MEMBER_STATUS,
  RANKS,
  readApplication,
  UNITS,
  type MemberStatus,
} from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Синхронизация с Google Таблицей может занять несколько секунд */
export const maxDuration = 60;

type Action = "approve" | "reject" | "vacation" | "reactivate" | "save";

type UpdateBody = {
  id?: unknown;
  action?: unknown;
  callsign?: unknown;
  discordId?: unknown;
  rank?: unknown;
  unit?: unknown;
  role?: unknown;
  reason?: unknown;
};

const ACTIONS: readonly Action[] = ["approve", "reject", "vacation", "reactivate", "save"];

function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

export async function PATCH(req: NextRequest) {
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  let body: UpdateBody;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const memberId = Number(body.id);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return NextResponse.json({ ok: false, error: "Некорректный ID бойца" }, { status: 400 });
  }

  if (!isAction(body.action)) {
    return NextResponse.json({ ok: false, error: "Неизвестное действие" }, { status: 400 });
  }
  const action: Action = body.action;

  try {
    const [member] = await db.select().from(members).where(eq(members.id, memberId));
    if (!member) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

    const patch = buildPatch(member, body, action);
    if (!patch.ok) return NextResponse.json({ ok: false, error: patch.error }, { status: 400 });

    const [updated] = await db
      .update(members)
      .set(patch.values)
      .where(eq(members.id, memberId))
      .returning();

    if (!updated) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

    const author = auth.member.callsign
      ? `${auth.member.role === "admin" ? "Администратор" : "Командир"} ${auth.member.callsign}`
      : "Штаб";

    await db.insert(logs).values({
      category: "edit",
      author,
      action: descriptionFor(action, updated.callsign || updated.name),
      details: {
        "Боец": updated.callsign || updated.name,
        "Статус": updated.status,
        "Звание": updated.rank,
        "Подразделение": updated.unit || "не назначено",
      },
      kind: "system",
      title: action === "approve" ? "Рапорт одобрен" : "Решение по рапорту",
      detail: descriptionFor(action, updated.callsign || updated.name),
      ok: true,
    });

    // В таблицу пишем только при зачислении в состав. Возврат из отпуска
    // (reactivate) таблицу не трогает: боец уже в ней, а повторное «Добавление»
    // заняло бы новую строку «Вакант» и оставило старую с его именем.
    let sheets: { ok: boolean; message?: string; error?: string } | null = null;
    if (action === "approve") {
      sheets = await addToShdsSheet(updated);
      if (!sheets.ok) {
        console.error("[recruits] Синхронизация с таблицей не удалась:", sheets.error);
      }
    }

    return NextResponse.json({
      ok: true,
      status: updated.status,
      sheets,
      member: {
        id: updated.id,
        callsign: updated.callsign,
        rank: updated.rank,
        unit: updated.unit,
        status: updated.status,
        role: updated.role,
        discordId: updated.discordId,
        application: readApplication(updated.applicationData),
      },
    });
  } catch (e) {
    console.error("[recruits] Ошибка решения по рапорту:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}
/* ------------------------------------------------------------------ */
/* Подготовка изменений                                                */
/* ------------------------------------------------------------------ */

type MemberRow = typeof members.$inferSelect;

type PatchResult = { ok: true; values: Partial<MemberRow> } | { ok: false; error: string };

function descriptionFor(action: Action, who: string): string {
  switch (action) {
    case "approve":
      return `одобрил рапорт ${who} и зачислил в состав`;
    case "reject":
      return `отклонил рапорт ${who}`;
    case "vacation":
      return `отправил ${who} в отпуск`;
    case "reactivate":
      return `вернул ${who} в строй из отпуска`;
    default:
      return `отредактировал карточку ${who}`;
  }
}

/**
 * Собирает поля для UPDATE: правки модератора + смена статуса.
 *
 * Модератор может поправить позывной, вписать Discord ID (если кандидат его не
 * привязал), назначить звание, подразделение и уровень доступа. Все значения
 * проверяются: звание и подразделение попадают в Google Таблицу, роль — в
 * проверку доступа, поэтому произвольный текст здесь недопустим.
 */
function buildPatch(member: MemberRow, body: UpdateBody, action: Action): PatchResult {
  const values: Partial<MemberRow> = { updatedAt: new Date() };
  const app = readApplication(member.applicationData);

  // --- Правки полей (доступны и при одобрении, и отдельным сохранением) ---
  if (typeof body.callsign === "string") {
    const callsign = body.callsign.trim();
    if (callsign && callsign !== member.callsign) {
      if (callsign.length < 3 || callsign.length > 32) {
        return { ok: false, error: "Позывной: 3–32 символа" };
      }
      values.callsign = callsign;
      // Позывной — это ещё и имя бойца в табеле и в ШДС, держим их вместе
      values.name = callsign;
    }
  }

  if (typeof body.discordId === "string") {
    const raw = body.discordId.trim();
    if (!raw) {
      // Пустое поле = «Discord не привязан»: NULL, а не пустая строка,
      // иначе второй боец без Discord нарушил бы уникальность столбца
      values.discordId = null;
    } else {
      const digits = raw.replace(/\D/g, "");
      if (!/^\d{5,25}$/.test(digits)) {
        return { ok: false, error: "Discord ID: ожидается числовой ID (только цифры)" };
      }
      values.discordId = digits;
    }
  }

  if (typeof body.rank === "string" && body.rank.trim()) {
    const rank = body.rank.trim();
    if (!(RANKS as readonly string[]).includes(rank)) {
      return { ok: false, error: `Неизвестное звание «${rank}»` };
    }
    values.rank = rank;
  }

  if (typeof body.unit === "string") {
    const unit = body.unit.trim();
    if (!unit) {
      values.unit = null;
    } else if (!(UNITS as readonly string[]).includes(unit)) {
      // Подразделение = имя листа Google Таблицы: произвольное значение
      // привело бы к ошибке «лист не найден» при синхронизации
      return { ok: false, error: `Неизвестное подразделение «${unit}»` };
    } else {
      values.unit = unit;
    }
  }

  if (typeof body.role === "string" && body.role.trim()) {
    const role = body.role.trim();
    if (!isMemberRole(role)) {
      return { ok: false, error: `Неизвестный уровень доступа «${role}»` };
    }
    values.role = role;
  }

  // --- Смена статуса ---
  // «save» статус не меняет: это отдельное действие «сохранить правки», чтобы
  // редактирование позывного не приводило незаметно к зачислению бойца
  const nextStatus: MemberStatus | null =
    action === "approve" || action === "reactivate"
      ? MEMBER_STATUS.ACTIVE
      : action === "reject"
        ? MEMBER_STATUS.DISMISSED
        : action === "vacation"
          ? MEMBER_STATUS.VACATION
          : null;

  if (action === "approve") {
    // Зачисление без подразделения бессмысленно: синхронизация с ШДС не знает,
    // в какой лист писать, и боец остался бы в базе «без места»
    const unit = values.unit ?? member.unit;
    if (!unit) {
      return { ok: false, error: "Выберите подразделение — от него зависит лист Google Таблицы" };
    }
    if (!member.passwordHash && !member.discordId) {
      return { ok: false, error: "У бойца нет ни пароля, ни Discord — вход будет невозможен" };
    }
    values.rank = values.rank ?? (member.rank || DEFAULT_RANK);
    values.role = values.role ?? (member.role === "recruit" ? "member" : member.role);
    values.active = true;
    values.applicationData = {
      ...app,
      reviewedBy: member.callsign || member.name,
      reviewedAt: new Date().toISOString(),
    };
  }

  if (action === "reject") {
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    values.applicationData = {
      ...app,
      decisionReason: reason,
      reviewedAt: new Date().toISOString(),
    };
    // Отклонённому вход закрыт: отзываем все выданные ранее сессии
    values.memberTokenVersion = sql`${members.memberTokenVersion} + 1` as unknown as number;
  }

  if (action === "save") {
    // Правки карточки: фиксируем, кто их внёс — история правок видна штабу
    values.applicationData = {
      ...app,
      reviewedAt: new Date().toISOString(),
    };
  }

  values.status = nextStatus ?? member.status;
  return { ok: true, values };
}
/* ------------------------------------------------------------------ */
/* Синхронизация с Google Таблицей ШДС                                 */
/* ------------------------------------------------------------------ */

/**
 * Дописывает бойца в Google Таблицу через существующий модуль gsheets.ts.
 *
 * Используется его публичный контракт: ParsedRequest + applyShdsRequest с
 * действием «Добавление в ШДС». Правок в самом модуле не требуется — поэтому
 * текущие процессы Discord-бота продолжают работать как раньше.
 */
async function addToShdsSheet(
  member: MemberRow
): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (!member.unit) {
    return { ok: false, error: "Не назначено подразделение — некуда записывать бойца" };
  }

  try {
    // Импорт динамический: модуль таблицы читает настройки и «паспорт»
    // сервисного аккаунта, незачем нагружать этим каждое решение по рапорту
    const { applyShdsRequest, SHDS_ACTIONS } = await import("@/lib/gsheets");
    const result = await applyShdsRequest({
      raw: "Синхронизация из панели (одобрение рапорта)",
      isVacation: false,
      vacationRemove: false,
      shdsAction: SHDS_ACTIONS.ADD,
      // Имя листа = подразделение бойца (см. UNITS в recruits.ts)
      unit: member.unit,
      userName: member.callsign || member.name,
      rank: member.rank || DEFAULT_RANK,
      steamId: "",
      discordId:
        member.discordId && member.discordId !== MANUAL_DISCORD_ID ? member.discordId : "",
      отделение: "",
      должность: member.post || "",
      exams: [],
      grade: "",
      examiner: "",
      rolesGive: "",
      rolesRemove: "",
      vacationDates: "",
      reason: "Зачисление по рапорту",
    });
    return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
  } catch (e) {
    // Модуль бросает ошибку, если не настроен сервисный аккаунт Google
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}