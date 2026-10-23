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
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { logs, members, recruitApplications } from "@/db/schema";
import { sendDirectMessage } from "@/lib/discord";
import { requireStaff } from "@/lib/member-auth";
import {
  DEFAULT_RANK,
  isFullNameWithInitials,
  isMemberRole,
  MANUAL_DISCORD_ID,
  MEMBER_STATUS,
  normalizePersonName,
  RANKS,
  readApplication,
  UNITS,
  type MemberStatus,
} from "@/lib/recruits";
import { recruitDmText, refreshRecruitMessage } from "@/lib/review";
import { statusTrackingFields } from "@/lib/roles-monitor";
import { generateTempPassword } from "@/lib/temp-password";
import { applyVacationRole } from "@/lib/vacation-roles";

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

    /**
     * Защита от дубля при зачислении.
     *
     * Карточка из /apply приходит со статусом pending, но тот же человек может
     * уже быть в division_members — его завела синхронизация rs-red.com, бот
     * или прошлая заявка. Если просто перевести pending в active, в составе и
     * в табеле ШДС окажутся две строки одного бойца. Поэтому второй строки не
     * появляется: заявка сливается с существующей карточкой (её статус
     * доводится до active, пароль не меняется), а карточка-заявка гасится.
     */
    if (action === "approve") {
      const duplicate = await findDuplicateMember(member);
      if (duplicate) {
        // Второй действующей строки быть не должно: доводим до строя ту
        // карточку, что уже есть, а заявку закрываем как одобренную на неё
        const merged = await mergeIntoExistingMember(duplicate, member, auth);
        return NextResponse.json(merged);
      }
    }

    const patch = buildPatch(member, body, action);
    if (!patch.ok) return NextResponse.json({ ok: false, error: patch.error }, { status: 400 });

    /**
     * Одобрение ожидающей карточки выдаёт доступ: пароль из открытого текста
     * нигде не хранится, поэтому генерируем временный и сохраняем только хеш.
     * Для уже действующего бойца пароль не трогаем — иначе «одобрить» повторно
     * означало бы сменить ему пароль без запроса.
     */
    const issueCredentials =
      action === "approve" &&
      (member.status === MEMBER_STATUS.PENDING || String(member.status) === "new");
    let tempPassword = "";
    if (issueCredentials) {
      tempPassword = generateTempPassword();
      patch.values.passwordHash = await bcrypt.hash(tempPassword, 10);
      // Смена пароля отзывает ранее выданные сессии
      patch.values.memberTokenVersion = sql`${members.memberTokenVersion} + 1` as unknown as number;
    }

    const [updated] = await db
      .update(members)
      .set(patch.values)
      .where(eq(members.id, memberId))
      .returning();

    if (!updated) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

    const author = auth.member.callsign
      ? `${auth.member.role === "admin" ? "Администратор" : "Командир"} ${auth.member.callsign}`
      : "Штаб";

    /**
     * ЛС — «мягкий» шаг: закрытые личные сообщения Discord не должны отменять
     * уже принятое решение. Пароль в этом случае вернётся модератору в ответе.
     */
    let dmSent = false;
    if (tempPassword) {
      const discordId = (updated.discordId || "").trim();
      if (/^\d{5,25}$/.test(discordId)) {
        try {
          const dm = await sendDirectMessage(discordId, {
            content: recruitDmText(updated.callsign || updated.name, tempPassword),
          });
          dmSent = dm.ok;
          if (!dm.ok) {
            console.warn(`[recruits] ЛС бойцу ${discordId} не доставлено: ${dm.error}`);
          }
        } catch (e) {
          console.warn("[recruits] Ошибка отправки ЛС с доступом:", e);
        }
      }
    }

    /**
     * Связанная заявка закрывается тем же решением: иначе она осталась бы
     * висеть в очереди /admin/reports и её можно было бы одобрить повторно.
     * Возврат из запаса не трогаем — у него своя процедура переноса строки ШДС.
     */
    let linked: (typeof recruitApplications.$inferSelect)[] = [];
    if (action === "approve" || action === "reject") {
      linked = await db
        .update(recruitApplications)
        .set({
          status: action === "approve" ? "approved" : "rejected",
          memberId: updated.id,
          reviewedBy: author,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(recruitApplications.memberId, updated.id),
            eq(recruitApplications.kind, "recruit"),
            sql`${recruitApplications.status} IN ('pending', 'new')`
          )
        )
        .returning();

      for (const application of linked) {
        await refreshRecruitMessage(
          application,
          action === "approve" && tempPassword && !dmSent
            ? "ЛС не доставлено — доступ передаст штаб"
            : null
        );
      }
    }

    /**
     * Роль Discord «Отпуск» — по тем же правилам, что и кнопка в табеле.
     *
     * Ошибка Discord не отменяет решение штаба: в базе отпуск уже стоит.
     * Поэтому результат уходит в ответ (панель предупредит модератора) и в
     * журнал, но не превращается в 500.
     */
    let vacationRole: Awaited<ReturnType<typeof applyVacationRole>> | null = null;
    if (action === "vacation" || action === "reactivate") {
      vacationRole = await applyVacationRole({
        discordId: updated.discordId,
        vacation: action === "vacation",
        memberName: updated.callsign || updated.name,
        source: action === "vacation" ? "решение по рапорту: отпуск" : "решение по рапорту: возврат",
      });
    }

    await db.insert(logs).values({
      category: "edit",
      author,
      action: descriptionFor(action, updated.callsign || updated.name),
      details: {
        "Боец": updated.callsign || updated.name,
        "Статус": updated.status,
        "Звание": updated.rank,
        "Подразделение": updated.unit || "не назначено",
        ...(vacationRole
          ? {
              "Роль «Отпуск»": vacationRole.ok
                ? vacationRole.message
                : `не изменена: ${vacationRole.error ?? vacationRole.message}`,
            }
          : {}),
        ...(tempPassword
          ? { "ЛС с доступом": dmSent ? "доставлено" : "не доставлено" }
          : {}),
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
      // Итог по роли Discord: модератор должен видеть, что она не изменилась
      // (нет прав, роль выше роли бота, нет Discord ID) — решение уже принято
      vacationRole: vacationRole
        ? {
            ok: vacationRole.ok,
            action: vacationRole.action,
            message: vacationRole.message,
            error: vacationRole.error ?? null,
          }
        : null,
      // Если ЛС закрыто, модератор видит логин и временный пароль и передаёт их сам
      dmSent: tempPassword ? dmSent : undefined,
      tempPassword: tempPassword || undefined,
      login: tempPassword ? updated.callsign || updated.name : undefined,
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

/**
 * Ищет другую карточку того же человека: сначала по Discord ID (уникален),
 * затем по нормализованному ФИО (normalizePersonName — «Розгов А.В.» ==
 * «Розгов А. В.», «ё» → «е», латинские двойники в инициалах).
 *
 * Только по ФИО: позывной меняется, а ФИО в табеле остаётся, поэтому поиск
 * дубля по нему надёжнее. Односложные имена (старые строки без ФИО) не
 * сравниваются: «Скиф» — это позывной, и совпадение по нему не доказывает,
 * что речь об одном человеке.
 */
async function findDuplicateMember(member: MemberRow): Promise<MemberRow | null> {
  const all = await db.select().from(members);
  const discordId = (member.discordId || "").trim();
  const nameKey = normalizePersonName(member.name);
  const nameLooksLikeFullName = nameKey.includes(" ") && nameKey.includes(".");

  return (
    all.find((row) => {
      if (row.id === member.id) return false;
      if (discordId && /^\d{5,25}$/.test(discordId) && row.discordId === discordId) return true;
      if (!nameLooksLikeFullName) return false;
      return normalizePersonName(row.name) === nameKey;
    }) ?? null
  );
}

/**
 * Слияние заявки с уже существующей карточкой бойца.
 *
 * Одобрение НЕ создаёт второй строки в division_members: у человека, которого
 * завела синхронизация rs-red.com или бот, уже есть карточка. Действуем так:
 *   1. существующую карточку переводим в active (отпуск сохраняем) и
 *      привязываем к ней Discord ID из заявки;
 *   2. пароль переносим, только если у существующей карточки его нет —
 *      иначе одобрение молча сменило бы действующему бойцу рабочий пароль;
 *   3. карточку-заявку гасим как dismissed: она больше не должна попадать в
 *      очередь и не должна давать вход (версия токена сбрасывает сессии);
 *   4. заявку закрываем как approved со ссылкой на настоящую карточку.
 *
 * Возвращает готовый ответ роуту: интерфейс модерации увидит, с кем именно
 * объединена заявка.
 */
async function mergeIntoExistingMember(
  existing: MemberRow,
  pending: MemberRow,
  auth: Awaited<ReturnType<typeof requireStaff>> & { ok: true }
): Promise<Record<string, unknown>> {
  const author = auth.member.callsign
    ? `${auth.member.role === "admin" ? "Администратор" : "Командир"} ${auth.member.callsign}`
    : "Штаб";

  const keepVacation =
    String(existing.status) === MEMBER_STATUS.VACATION || existing.vacation === true;

  // Признак отпуска в карточке держим согласованным со статусом: иначе
  // MEMBER_STATUS.VACATION при vacation=false показывал бы «отпуск» в табеле,
  // но планировщик отпусков бойца не видел.
  const vacationFlag = keepVacation;

  /**
   * Позывной карточки-заявки сначала освобождаем.
   *
   * members.callsign уникален, и без этого UPDATE существующей карточки
   * позывным из заявки падал бы на нарушении индекса: строка-заявка ещё
   * держит занятый логин. Сама карточка-заявка всё равно гасится ниже.
   */
  const takenCallsign = (pending.callsign || "").trim();
  const freeCallsign =
    !existing.callsign &&
    takenCallsign !== "" &&
    takenCallsign !== (existing.callsign || "").trim();
  if (freeCallsign) {
    await db.update(members).set({ callsign: null }).where(eq(members.id, pending.id));
  }

  await db
    .update(members)
    .set({
      status: keepVacation ? MEMBER_STATUS.VACATION : MEMBER_STATUS.ACTIVE,
      active: true,
      vacation: vacationFlag,
      // Discord ID из заявки актуальнее: боец мог привязать новый аккаунт
      discordId: pending.discordId || existing.discordId,
      ...(freeCallsign && pending.callsign ? { callsign: pending.callsign } : {}),
      passwordHash: existing.passwordHash || pending.passwordHash,
      role: existing.role === "recruit" ? "member" : existing.role,
      rank: existing.rank || DEFAULT_RANK,
      ...statusTrackingFields(
        keepVacation ? MEMBER_STATUS.VACATION : MEMBER_STATUS.ACTIVE,
        existing.status
      ),
      updatedAt: new Date(),
    })
    .where(eq(members.id, existing.id));

  // Карточка-заявка: вход закрыт, история остаётся (удалять её нельзя —
  // это журнал решения штаба, и на неё ссылаются заявки)
  await db
    .update(members)
    .set({
      status: MEMBER_STATUS.DISMISSED,
      active: false,
      applicationData: {
        ...readApplication(pending.applicationData),
        decisionReason: `Дубль: объединено с карточкой #${existing.id}`,
        reviewedAt: new Date().toISOString(),
      },
      memberTokenVersion: sql`${members.memberTokenVersion} + 1` as unknown as number,
      ...statusTrackingFields(MEMBER_STATUS.DISMISSED, pending.status),
      updatedAt: new Date(),
    })
    .where(eq(members.id, pending.id));

  // Заявка закрывается на существующую карточку: иначе она осталась бы
  // в очереди и её можно было бы «одобрить» повторно
  await db
    .update(recruitApplications)
    .set({ status: "approved", memberId: existing.id, reviewedBy: author, updatedAt: new Date() })
    .where(and(eq(recruitApplications.memberId, pending.id), eq(recruitApplications.kind, "recruit")));

  await db.insert(logs).values({
    category: "edit",
    author,
    action: `одобрил заявку ${pending.callsign || pending.name} слиянием с карточкой #${existing.id}`,
    details: {
      "Заявка": `#${pending.id}`,
      "Карточка": `#${existing.id} (${existing.callsign || existing.name})`,
      "Причина": "боец уже в составе — вторая строка не создавалась",
    },
    kind: "system",
    title: "Заявка одобрена",
    detail: `${pending.callsign || pending.name} уже в составе: обновлена карточка #${existing.id}`,
    ok: true,
  });

  return {
    ok: true,
    merged: true,
    status: keepVacation ? MEMBER_STATUS.VACATION : MEMBER_STATUS.ACTIVE,
    sheets: null,
    existingMemberId: existing.id,
    message: `Боец уже в составе (#${existing.id}, ${existing.callsign || existing.name}) — карточка обновлена, дубль не создан`,
    member: {
      id: existing.id,
      callsign: existing.callsign || pending.callsign,
      rank: existing.rank,
      unit: existing.unit,
      status: keepVacation ? MEMBER_STATUS.VACATION : MEMBER_STATUS.ACTIVE,
      role: existing.role === "recruit" ? "member" : existing.role,
      discordId: pending.discordId || existing.discordId,
      application: readApplication(pending.applicationData),
    },
  };
}

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
      /**
       * Имя в табеле подтягивается к позывному ТОЛЬКО когда оно ещё не ФИО.
       *
       * Раньше name перезаписывалось всегда, и правка позывного стирала ФИО,
       * которое форма /apply теперь требует обязательно. По этому ФИО при
       * одобрении ищется дубль в составе (normalizePersonName) — без него
       * защита от повторной строки переставала работать.
       */
      if (!isFullNameWithInitials(member.name)) {
        values.name = callsign;
      }
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

  /**
   * Флаг отпуска ведётся вместе со статусом.
   *
   * Раньше действие «vacation» ставило только `status = "vacation"`, а флаг
   * `members.vacation` оставался false. Последствия: шедулер окончания отпуска
   * выбирает именно `vacation = true`, поэтому такой отпуск никогда не
   * закрывался, а боец исключался из пингов и статистики навсегда. Обратная
   * ошибка была у «reactivate»: статус возвращался в active, а флаг — нет, и
   * боец оставался «в отпуске» по данным, на которые смотрит вся остальная
   * логика (норма часов, снапшоты, сводки).
   *
   * Дата возвращения при возврате из отпуска снимается: это закрытый отпуск,
   * и оставшийся срок показывал бы бейдж «в отпуске · до …» у бойца в строю.
   */
  if (action === "vacation") {
    values.vacation = true;
    // Дата не задана: отпуск бессрочный, шедулер его не тронет — закрыть
    // сможет только штаб. Это осознанный выбор модератора, а не сбой.
    values.vacationNotified = false;
  } else if (action === "reactivate") {
    values.vacation = false;
    values.vacationUntil = null;
    values.vacationNotified = false;
  } else if (action === "reject") {
    // Отклонённая заявка не может остаться «в отпуске»: вход закрыт, и срок
    // отпуска держал бы бойца в выборке шедулера.
    values.vacation = false;
    values.vacationUntil = null;
    values.vacationNotified = false;
  }

  // Фиксация момента исключения/возврата в строй: по dismissedAt фоновая
  // задача контроля ролей отсчитывает сутки до напоминания комсоставу о
  // неснятых ролях Discord. Считается от ПРЕДЫДУЩЕГО статуса карточки, а не
  // от действия: повторное «сохранить» с тем же статусом не должно начинать
  // отсчёт заново — иначе правка примечания откладывала бы напоминание.
  Object.assign(values, statusTrackingFields(values.status, member.status));

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