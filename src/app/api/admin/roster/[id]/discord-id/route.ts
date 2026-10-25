/**
 * Правка Discord ID бойца из табеля «Состав» (PATCH /api/admin/roster/[id]/discord-id).
 *
 * Только администратор: изменение меняет не только базу панели, но и Google
 * Таблицу ШДС — по колонке Discord ID штаб сверяет состав с таблицей, а бот
 * упоминает человека. Командиру доступна прежняя правка через
 * PATCH /api/members/[id] (база панели); запись в ШДС оставлена администратору
 * как операция с внешним документом.
 *
 * Доступ: командир подразделения и администратор (requireRosterEditor — единое
 * правило прав, см. lib/panel-rights.ts). Ранее требовалась строго роль admin,
 * из-за чего командиру табеля поле правки было недоступно; при этом правку
 * можно и нужно вести из панели «Состав», а не просить администратора.
 *
 * Порядок действий намеренный:
 *   1. проверка роли и формата (общий валидатор validateRosterDiscordId —
 *      тот же, что показывает требование в интерфейсе);
 *   2. запись в PostgreSQL (division_members.discord_id);
 *   3. обновление ячейки в Google Таблице и запись в журнал.
 *
 * Если Google недоступен, правка в базе НЕ откатывается: штаб уже принял
 * решение, и терять его нельзя. Ответ содержит поле sheets со статусом
 * синхронизации, панель показывает предупреждение вместо ложного успеха.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { logs, members, recruitApplications } from "@/db/schema";
import { requireRosterEditor } from "@/lib/member-auth";
import { isCrossSiteRequest, isUnsafeMethod } from "@/lib/csrf";
import {
  MEMBER_STATUS,
  isUnit,
  isUnassignedUnit,
  normalizeMemberStatus,
  type Unit,
} from "@/lib/recruits";
import { decideDiscordConflict, needsUnitLookup } from "@/lib/discord-conflict";
import { validateRosterDiscordId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Запись в Google Таблицу может занять несколько секунд */
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * Статус синхронизации с листом ШДС.
 *
 * `skipped` — запись сознательно пропущена (подразделение не назначено, лист
 * неизвестен). Это не сбой Google: ID уже сохранён в базе, и повторять запрос
 * бессмысленно, пока штаб не назначит подразделение. Панель показывает по
 * такому статусу отдельное предупреждение, а не «ошибку таблицы».
 */
type SheetStatus = { ok: boolean; message?: string; error?: string; skipped?: boolean };

/**
 * Подпись автора правки для журнала.
 *
 * Правку ведут и администратор, и командир подразделения, поэтому роль берётся
 * из карточки сессии (офицер → «Командир»), а не приписывается администратору:
 * в журнале сверяются с тем, кто именно распорядился правкой ШДС.
 */
function authorLabel(member: { role: string; callsign: string }): string {
  const role = member.role === "admin" ? "Администратор" : "Командир";
  return member.callsign ? `${role} ${member.callsign}` : role;
}

/**
 * Запись ячейки на листе подразделения.
 *
 * Импорт динамический: модуль таблицы читает «паспорт» сервисного аккаунта и
 * настройки панели, и незачем нагружать этим каждый запрос к роуту.
 */
async function syncSheet(
  member: { unit: string | null; callsign: string | null; name: string },
  discordId: string
): Promise<SheetStatus> {
  // «не назначено» — та же пустота, что и null: лист по такой пометке не найти.
  // Это не ошибка записи: ID уже лежит в базе, а лист появится, когда штаб
  // назначит подразделение. Раньше здесь возвращался ok:false с «ошибкой
  // Google», и панель выглядела так, будто сохранение провалилось целиком.
  if (!member.unit || isUnassignedUnit(member.unit)) {
    return {
      ok: false,
      skipped: true,
      error:
        "У бойца не назначено подразделение — запись в лист ШДС пропущена (ID сохранён только в базе панели)",
    };
  }
  try {
    const { syncDiscordIdToSheet } = await import("@/lib/gsheets");
    return await syncDiscordIdToSheet({
      unit: member.unit,
      // Два кандидата имени: в панели боец может быть записан ФИО с rs-red.com,
      // а в ШДС — позывным (см. syncDiscordIdToSheet)
      names: [member.callsign ?? "", member.name],
      discordId,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Подразделение бойца для записи в ШДС.
 *
 * Если в карточке пусто (или служебная пометка «не назначено»), пробуем вывести
 * подразделение по ролям участника Discord — ровно так же, как это делает форма
 * рапорта (resolveMemberUnitFromDiscord). Без этого сохранение Discord ID
 * упиралось в «лист ШДС не определён», хотя боец уже носил роль подразделения.
 *
 * Найденное значение сразу пишется в карточку: иначе следующий PATCH снова
 * начинал бы с пустого поля. Сбой Discord или записи в БД не мешает привязке —
 * функция возвращает то, что удалось узнать, и роут сохранит ID в базе.
 */
async function resolveSheetUnit(member: {
  id: number;
  unit: string | null;
  discordId: string | null;
}): Promise<Unit | null> {
  if (isUnit(member.unit)) return member.unit;
  if (!needsUnitLookup(member.unit)) return null;

  try {
    const [{ resolveMemberUnitFromDiscord }, { getSettings }] = await Promise.all([
      import("@/lib/review"),
      import("@/lib/settings"),
    ]);
    const detected = await resolveMemberUnitFromDiscord(
      { unit: member.unit, discordId: member.discordId },
      await getSettings()
    );
    if (!detected) return null;
    try {
      await db
        .update(members)
        .set({ unit: detected, updatedAt: new Date() })
        .where(eq(members.id, member.id));
    } catch (e) {
      console.warn("[roster/discord-id] Не удалось сохранить подразделение бойца:", e);
    }
    return detected;
  } catch (e) {
    console.warn("[roster/discord-id] Не удалось определить подразделение по ролям Discord:", e);
    return null;
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  // Командир подразделения или администратор: правка меняет и базу панели, и
  // Google Таблицу ШДС. Требование разрешает её командирам, поэтому гвард —
  // requireRosterEditor (единое правило прав), а не жёсткая роль admin.
  const auth = await requireRosterEditor(req);
  if (!auth.ok) return auth.response;

  // Проверка источника дублируется намеренно: middleware — не единственный
  // барьер (его matcher может быть сужен), а запрос меняет внешний документ
  if (isUnsafeMethod(req.method) && isCrossSiteRequest(req)) {
    return NextResponse.json(
      { ok: false, error: "Запрос с чужого источника отклонён" },
      { status: 403 }
    );
  }

  const { id } = await params;
  const memberId = Number.parseInt(id, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return NextResponse.json({ ok: false, error: "Некорректный ID бойца" }, { status: 400 });
  }

  let body: { discordId?: unknown };
  try {
    body = (await req.json()) as { discordId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  // Пустая строка — осознанная очистка привязки, а не ошибка
  const validated = validateRosterDiscordId(body.discordId);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }
  const discordId = validated.value;

  const [member] = await db.select().from(members).where(eq(members.id, memberId));
  if (!member) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  /**
   * Конфликт Discord ID: одна снежинка — один боец.
   *
   * Правило снятия конфликта вынесено в lib/discord-conflict.ts:
   *   - если ID держит ВЫБЫВШАЯ карточка (старый ник после переименования,
   *     исключённый, отклонённая заявка) — снимаем ID с неё и привязываем
   *     действующему бойцу без ошибки. Раньше здесь возвращался 409, и штаб не
   *     мог привязать Discord человеку, пока вручную не найдёт дубль;
   *   - если ID держит ДРУГОЙ ДЕЙСТВУЮЩИЙ боец — отвечаем 409 с его именем,
   *     чтобы было видно, кого именно нужно развязать.
   *
   * Пустое значение (осознанная очистка привязки) конфликта не создаёт.
   */
  const released: { id: number; name: string }[] = [];
  if (discordId) {
    const occupants = await db
      .select({
        id: members.id,
        name: members.name,
        active: members.active,
        status: members.status,
      })
      .from(members)
      .where(eq(members.discordId, discordId));

    const decision = decideDiscordConflict(occupants, memberId);
    if (decision.kind === "blocked") {
      return NextResponse.json(
        { ok: false, error: decision.message, conflictMemberId: decision.occupant.id },
        { status: 409 }
      );
    }
    if (decision.kind === "release") {
      const ids = decision.release.map((occupant) => occupant.id);
      await db
        .update(members)
        .set({ discordId: null, updatedAt: new Date() })
        .where(inArray(members.id, ids));
      released.push(...decision.release.map((occupant) => ({ id: occupant.id, name: occupant.name })));
    }
  }

  const before = member.discordId ?? null;

  /**
   * Привязка Discord ID — это и есть подтверждение личности бойца штабом.
   *
   * Поэтому `pending` в момент сохранения ID переводится в `active`
   * (требование): иначе человек с привязанным Discord продолжал бы видеть
   * «рапорт на рассмотрении» при входе, хотя командир уже вписал ему ID и тем
   * самым принял его. `dismissed` не трогаем — исключение не отменяется
   * привязкой. Заявки бойца закрываются тем же действием, чтобы очередь
   * модерации не показывала уже принятого.
   */
  const wasPending = normalizeMemberStatus(member.status) === MEMBER_STATUS.PENDING;
  const autoActivated = wasPending && !!discordId;

  const [updated] = await db
    .update(members)
    .set({
      discordId,
      ...(autoActivated
        ? { status: MEMBER_STATUS.ACTIVE, active: true }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(members.id, memberId))
    .returning();
  if (!updated) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  /**
   * Подразделение для ШДС: если оно не назначено, пробуем вывести его по ролям
   * Discord. Без этого запись в таблицу падала бы на «лист не определён», хотя
   * привязка ID уже состоялась в базе. Если определить не удалось — ШДС
   * пропускается, а ID остаётся в базе (это не ошибка привязки).
   */
  let sheetUnit = updated.unit;
  if (discordId && needsUnitLookup(updated.unit)) {
    const detected = await resolveSheetUnit({
      id: updated.id,
      unit: updated.unit,
      discordId: updated.discordId,
    });
    if (detected) sheetUnit = detected;
  }

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
      // Заявка — историческая запись: сбой не отменяет уже сохранённую привязку
      console.error("[roster/discord-id] Не удалось закрыть заявку бойца:", e);
    }
  }

  // Пустая строка очищает ячейку в листе; null приводим к "" тем же вызовом
  const sheets = await syncSheet({ ...updated, unit: sheetUnit }, discordId ?? "");
  /** Запись в ШДС пропущена (нет подразделения) — это не ошибка правки */
  const sheetSkipped = sheets.skipped === true;

  // Журнал пишется всегда: даже при сбое Google правка в базе уже состоялась,
  // и штаб должен видеть это в истории, а не узнавать по факту расхождения
  const sheetNote = sheets.ok
    ? ""
    : sheetSkipped
      ? " · ШДС пропущена: подразделение не назначено"
      : ` · ШДС: ${sheets.error || "не обновлена"}`;
  const statusNote = autoActivated ? " · статус: pending → active" : "";
  const releaseNote = released.length
    ? ` · Discord ID снят с выбывших: ${released.map((r) => r.name).join(", ")}`
    : "";

  await db.insert(logs).values({
    category: "edit",
    // Автор — по флагу администратора, а не по одному username: правку ведёт
    // и командир, и в журнале должно быть видно, кто именно распорядился
    author: authorLabel(auth.member),
    action: discordId
      ? `изменил Discord ID на "${discordId}" бойцу ${member.name}`
      : `снял Discord ID бойцу ${member.name}`,
    details: {
      "Боец": member.name,
      "Позывной": member.callsign ?? "—",
      "Discord ID": discordId ?? "не указан",
      "Было": before ?? "не указан",
      "Лист ШДС": sheetUnit ?? "не назначено",
      ...(released.length
        ? { "Снят у выбывших": released.map((r) => `${r.name} (#${r.id})`).join(", ") }
        : {}),
      "Итог": sheets.ok
        ? sheets.message ?? "обновлено"
        : sheetSkipped
          ? "пропущено (подразделение не назначено)"
          : sheets.error ?? "ошибка",
    },
    kind: "system",
    title: "Правка Discord ID",
    detail: `Discord ID бойца ${member.name}: ${before ?? "пусто"} → ${discordId ?? "пусто"}${statusNote}${releaseNote}${sheetNote}`,
    // Пропуск записи в ШДС — не сбой: правка в базе состоялась и корректна
    ok: sheets.ok || sheetSkipped,
    error: sheets.ok || sheetSkipped ? null : sheets.error ?? null,
  });

  /**
   * Предупреждение для панели: правка в базе есть, но таблица отстала.
   * Отдельная формулировка для неназначенного подразделения — это не сбой
   * Google, а отсутствие листа: запись в ШДС пропущена, ID в базе сохранён.
   */
  const warningText = sheets.ok
    ? null
    : sheetSkipped
      ? "ID сохранён в панели. Подразделение не назначено — запись в Google Таблицу пропущена: назначьте подразделение бойцу, затем сохраните ID повторно"
      : `ID сохранён в панели, но Google Таблица не обновлена: ${sheets.error ?? "ошибка"}`;

  return NextResponse.json({
    ok: true,
    member: { ...updated, unit: sheetUnit },
    sheets,
    // Панель показывает, что доступ в кабинет открылся вместе с привязкой
    autoActivated,
    status: updated.status,
    // Кого пришлось развязать, чтобы освободить снежинку (выбывшие дубли)
    released: released.map((r) => r.name),
    // Предупреждение для панели: правка сохранена, но таблица отстала
    warning: warningText,
  });
}