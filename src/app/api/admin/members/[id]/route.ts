/**
 * Полное удаление профиля бойца (DELETE /api/admin/members/[id]).
 *
 * Доступ: СТРОГО администратор. Ни командир подразделения, ни офицер, ни сам
 * боец профиль удалить не могут. Это отличает роут от правки карточки
 * (PATCH /api/members/[id], гвард requireRosterEditor) и от правки Discord ID
 * (PATCH /api/admin/roster/[id]/discord-id): там командир распоряжается рабочими
 * полями табеля, здесь — уничтожается личное дело вместе с допусками, историей
 * и связью с Discord. Права считает memberDeletionDecision (lib/member-deletion.ts) —
 * то же правило использует интерфейс, поэтому рассинхрона «кнопка есть, а 403»
 * не возникает.
 *
 * Порядок работ:
 *   1. роль (401 гостю, 403 вошедшему без прав admin);
 *   2. источник запроса (CSRF) — DELETE приходит с cookie сессии;
 *   3. подтверждение: администратор вводит позывной бойца, иначе 400. Проверка
 *      на сервере обязательна: окно в интерфейсе — удобство, а не защита, и
 *      случайный DELETE из консоли или скрипта не должен стирать карточку;
 *   4. транзакция: отвязка users.member_id, сессии кабинета, снимки статистики,
 *      очистка зависимых таблиц со строгими ключами, удаление строки табеля;
 *   5. запись в аудит-лог ПОСЛЕ фиксации транзакции — запись внутри неё
 *      исчезла бы при откате, и об удалении не осталось бы следа.
 *
 * Внешние ключи. Какие таблицы придётся вычистить, роут спрашивает у самой базы
 * (pg_constraint), а не предполагает: в схеме из src/db/schema.ts каскад и
 * SET NULL оставляют работу PostgreSQL, но установки, обновлённые вручную, могут
 * нести строгие ограничения — тогда DELETE упал бы на FK и профиль «не
 * удалялся бы» без внятной причины.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { logs, memberSessions, members, users, weeklyStats } from "@/db/schema";
import { getAuthUser, type AuthUser } from "@/lib/api-auth";
import { getSessionMember, type SessionMember } from "@/lib/member-auth";
import { isCrossSiteRequest, isUnsafeMethod } from "@/lib/csrf";
import {
  deleteMemberProfile,
  isSafeRelationName,
  MEMBER_FOREIGN_KEYS_SQL,
  memberDeletionAction,
  memberDeletionAuthor,
  memberDeletionConfirmationLabel,
  memberDeletionConfirmationMatches,
  memberDeletionDecision,
  MemberDeletionError,
  parseMemberId,
  relatedColumnsToClear,
  type ForeignKeyRow,
  type MemberDeletionStore,
  type MemberDeletionTarget,
} from "@/lib/member-deletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Удаление с чисткой связанных таблиц может занять несколько секунд */
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** Транзакция drizzle: тип выводим из db.transaction, не копируя его сигнатуру */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Источники данных и сессий.
 *
 * Параметр существует ради тестов (тот же приём, что в maintenance-guard.ts):
 * без базы подписанный токен не проверяется — роль читается из users и
 * division_members, — поэтому «настоящий» 403 для командира и успешное удаление
 * с очисткой связей иначе не проверить, а именно этого требует ТЗ. Боевой код
 * использует значения по умолчанию, подмены в продакшене нет.
 */
export type MemberDeletionApiDeps = {
  panel: (req: NextRequest) => Promise<AuthUser | null>;
  member: (req: NextRequest) => Promise<SessionMember | null>;
  /** Карточка бойца: существование и позывной для подтверждения */
  loadMember: (id: number) => Promise<MemberDeletionTarget | null>;
  /** Удаление в транзакции: возвращает удалённую карточку и счётчики очистки */
  remove: (id: number) => Promise<{
    member: MemberDeletionTarget;
    result: Awaited<ReturnType<typeof deleteMemberProfile>>["result"];
  }>;
  /** Запись в аудит-лог: выполняется после фиксации транзакции */
  log: (entry: LogEntry) => Promise<void>;
};

/** Запись аудита: состав полей нужен тестам, поэтому назван типом */
export type LogEntry = {
  category: string;
  author: string;
  action: string;
  details: Record<string, string>;
  kind: string;
  title: string;
  detail: string;
  ok: boolean;
};

/** Отказ: сессии нет вовсе */
function denyUnauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: "Нет доступа: авторизуйтесь" }, { status: 401 });
}

/** Отказ: вошедший, но не администратор (командир, офицер, боец) */
function denyForbidden(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "Недостаточно прав: удаление профиля доступно только администратору" },
    { status: 403 }
  );
}

/* ------------------------------------------------------------------ */
/* Хранилище поверх транзакции                                         */
/* ------------------------------------------------------------------ */

/** Кавычки вокруг имени таблицы или колонки: public.weekly_stats → "public"."weekly_stats" */
function quoteRelation(name: string): string {
  return name
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
}

/**
 * Хранилище удаления поверх конкретной транзакции.
 *
 * Каждый шаг выполняется в переданном tx, а не в глобальном db: иначе очистка
 * связей шла бы вне транзакции, и частично удалённый профиль было бы не откатить.
 */
function transactionStore(tx: Tx): MemberDeletionStore {
  return {
    async findMember(id) {
      const [row] = await tx
        .select({ id: members.id, name: members.name, callsign: members.callsign })
        .from(members)
        .where(eq(members.id, id));
      return row ?? null;
    },

    /**
     * Отвязка учётных записей панели.
     *
     * Явный UPDATE с условием member_id = id (а не «обнулить всё»): в развёрнутых
     * вручную базах внешний ключ мог быть создан без ON DELETE SET NULL, и без
     * этого шага удаление бойца упало бы на ограничении, заблокировав
     * администратора.
     */
    async unlinkPanelAccounts(id) {
      const rows = await tx
        .update(users)
        .set({ memberId: null })
        .where(eq(users.memberId, id))
        .returning({ id: users.id });
      return rows.length;
    },

    /** Сессии кабинета: токены бойца должны умереть вместе с карточкой */
    async clearMemberSessions(id) {
      const rows = await tx
        .delete(memberSessions)
        .where(eq(memberSessions.memberId, id))
        .returning({ id: memberSessions.id });
      return rows.length;
    },

    /** Снимки недельной статистики: в схеме это cascade, но ключ мог быть строгим */
    async clearWeeklyStats(id) {
      const rows = await tx
        .delete(weeklyStats)
        .where(eq(weeklyStats.memberId, id))
        .returning({ id: weeklyStats.id });
      return rows.length;
    },

    async deleteMember(id) {
      const rows = await tx.delete(members).where(eq(members.id, id)).returning({ id: members.id });
      return rows.length > 0;
    },
  };
}

/**
 * Очистка зависимых таблиц, чьи внешние ключи объявлены строгими (RESTRICT / NO ACTION).
 *
 * Список берётся из pg_constraint и фильтруется relatedColumnsToClear. Строки
 * удаляются целиком: это технические потомки бойца (снимки статистики, маркеры
 * обработки), а не документы — рапорты (service_reports) и заявки
 * (recruit_applications) в схеме переведены на SET NULL и сохраняются, потому
 * что позывной в них продублирован текстовой колонкой.
 */
async function clearStrictDependents(tx: Tx, id: number): Promise<void> {
  const result = await tx.execute<ForeignKeyRow>(sql.raw(MEMBER_FOREIGN_KEYS_SQL));
  const rows = (result.rows ?? []) as ForeignKeyRow[];

  for (const related of relatedColumnsToClear(rows)) {
    // Имена приходят из каталога, но запрос собирается подстановкой — экзотические
    // имена (кавычки, точка с запятой) пропускаем, а не исполняем
    if (!isSafeRelationName(related.table) || !isSafeRelationName(related.column)) continue;
    // id уже проверен как целое положительное; подставляем как число
    await tx.execute(
      sql.raw(
        `DELETE FROM ${quoteRelation(related.table)} WHERE ${quoteRelation(related.column)} = ${id}`
      )
    );
  }
}

/* ------------------------------------------------------------------ */
/* Боевые зависимости                                                  */
/* ------------------------------------------------------------------ */

const defaultDeps: MemberDeletionApiDeps = {
  panel: (req) => getAuthUser(req),
  member: (req) => getSessionMember(req),

  async loadMember(id) {
    const [row] = await db
      .select({ id: members.id, name: members.name, callsign: members.callsign })
      .from(members)
      .where(eq(members.id, id));
    return row ?? null;
  },

  remove: (id) =>
    db.transaction(async (tx) =>
      deleteMemberProfile(id, {
        store: transactionStore(tx),
        clearRelated: (memberId) => clearStrictDependents(tx, memberId),
      })
    ),

  async log(entry) {
    await db.insert(logs).values(entry);
  },
};

/* ------------------------------------------------------------------ */
/* Обработчик                                                          */
/* ------------------------------------------------------------------ */

/**
 * Текст подтверждения из запроса: JSON-тело { confirmation: "Позывной" } либо
 * параметр ?confirmation=. Принимаются оба варианта, потому что окно панели
 * шлёт тело, а проверка через curl (см. DEPLOYMENT.md) удобнее с параметром.
 */
async function readConfirmation(req: NextRequest): Promise<string | null> {
  const fromQuery = req.nextUrl.searchParams.get("confirmation");
  if (fromQuery) return fromQuery;

  try {
    const body = (await req.json()) as { confirmation?: unknown } | null;
    if (body && typeof body.confirmation === "string") return body.confirmation;
  } catch {
    // Тела нет или оно не JSON — подтверждение считается отсутствующим
  }
  return null;
}

/**
 * Удаление профиля. Вынесено с параметром зависимостей, чтобы правило доступа
 * и очистку связей можно было проверить на настоящем коде, а не на копии в тесте.
 */
export async function deleteMemberHandler(
  req: NextRequest,
  { params }: Params,
  deps: MemberDeletionApiDeps = defaultDeps
): Promise<NextResponse> {
  // 1. Роль. Обе сессии проверяются: у администратора панели может не быть
  // строки в табеле, а у бойца-администратора — cookie панели.
  const [panel, actor] = await Promise.all([deps.panel(req), deps.member(req)]);
  const decision = memberDeletionDecision(panel?.role, actor?.role);
  if (decision === "unauthenticated") return denyUnauthorized();
  if (decision === "forbidden") return denyForbidden();

  // 2. Источник запроса: middleware — не единственный барьер (его matcher может
  // быть сужен), а запрос необратим.
  if (isUnsafeMethod(req.method) && isCrossSiteRequest(req)) {
    return NextResponse.json(
      { ok: false, error: "Запрос с чужого источника отклонён" },
      { status: 403 }
    );
  }

  // Разбор строгий: «7.5» не должно означать бойца с id 7 (см. parseMemberId)
  const memberId = parseMemberId((await params).id);
  if (memberId === null) {
    return NextResponse.json({ ok: false, error: "Некорректный ID бойца" }, { status: 400 });
  }

  /**
   * 3. Существование бойца и подтверждение.
   *
   * Карточка читается до транзакции, чтобы отдать честные 404 и 400: внутри
   * транзакции отказ пришлось бы различать по коду исключения, а текст
   * подтверждения зависит от позывного, которого у несуществующего бойца нет.
   */
  const target = await deps.loadMember(memberId);
  if (!target) {
    return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });
  }

  const confirmation = await readConfirmation(req);
  if (!memberDeletionConfirmationMatches(confirmation, target)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Подтверждение не совпадает: введите позывной бойца, чтобы удалить профиль",
        confirmation: memberDeletionConfirmationLabel(target),
      },
      { status: 400 }
    );
  }

  // 4. Транзакция: всё или ничего.
  let outcome: Awaited<ReturnType<MemberDeletionApiDeps["remove"]>>;
  try {
    outcome = await deps.remove(memberId);
  } catch (e) {
    if (e instanceof MemberDeletionError && e.code === "not_found") {
      // Гонка: профиль удалили между проверкой и транзакцией
      return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });
    }
    // Текст ошибки базы (имена таблиц, ограничения, фрагменты SQL) остаётся в
    // логах сервера: клиенту он не помогает, зато раскрывает устройство схемы
    // и состав таблиц тому, кто вызвал сбой намеренно.
    console.error("[admin/members] Не удалось удалить профиль бойца:", e);
    return NextResponse.json(
      { ok: false, error: "Не удалось удалить профиль бойца. Обратитесь к логам сервера." },
      { status: 500 }
    );
  }

  // 5. Аудит. Запись делается после COMMIT: иначе откат транзакции стёр бы и её.
  const removed = outcome.result.removed;
  try {
    await deps.log({
      category: "edit",
      author: memberDeletionAuthor({ username: panel?.username, callsign: actor?.callsign }),
      action: memberDeletionAction(outcome.member),
      details: {
        Боец: outcome.member.name,
        Позывной: outcome.member.callsign ?? "—",
        ID: String(outcome.member.id),
        "Сессии кабинета": String(removed.sessions),
        "Снимки статистики": String(removed.weeklyStats),
        "Отвязано учётных записей": String(outcome.result.unlinkedPanelAccounts),
      },
      kind: "system",
      title: "Удаление профиля бойца",
      detail: `Личное дело бойца ${outcome.member.name} удалено безвозвратно`,
      ok: true,
    });
  } catch (e) {
    // Журнал не отменяет уже выполненное удаление: сообщаем об этом в консоли,
    // но отвечаем успехом — профиля действительно больше нет.
    console.error("[admin/members] Удаление прошло, но запись в журнал не удалась:", e);
  }

  return NextResponse.json({
    ok: true,
    member: {
      id: outcome.member.id,
      name: outcome.member.name,
      callsign: outcome.member.callsign,
    },
    removed: {
      sessions: removed.sessions,
      weeklyStats: removed.weeklyStats,
      unlinkedPanelAccounts: outcome.result.unlinkedPanelAccounts,
    },
    message: `Личное дело бойца ${memberDeletionConfirmationLabel(outcome.member)} удалено безвозвратно`,
  });
}

/** Боевой вход: зависимости — настоящие база, сессии и журнал */
export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  return deleteMemberHandler(req, { params });
}