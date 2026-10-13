/**
 * Полное удаление профиля бойца администратором.
 *
 * Почему правила и работа с базой живут отдельным модулем, а не в роуте:
 *   1. Необратимость. Удаление стирает личное дело, вход в кабинет, допуски и
 *      историю, поэтому решение «кому это можно» и защита от случайного клика
 *      обязаны быть проверяемыми без поднятия HTTP-слоя. Здесь чистая часть
 *      (memberDeletionDecision, memberDeletionConfirmation) — те же функции
 *      вызывает и роут, и интерфейс, поэтому «на клиенте окно открыто, а
 *      сервер отвечает 403» разойтись не может.
 *   2. Транзакция. Удаление затрагивает пять таблиц. Разложить это по роуту
 *      значит получить код, который нельзя ни прочитать, ни протестировать
 *      подменой хранилища. Работа с БД вынесена в memberDeletionStore, а
 *      бизнес-порядок — в deleteMemberProfile: ровно один и тот же порядок
 *      выполняет боевая обёртка над db.transaction.
 *
 * Права. Удалять профиль вправе ТОЛЬКО администратор (роль admin в сессии
 * панели или в карточке бойца) — ни командир подразделения, ни офицер, ни тем
 * более сам боец. Прочие правила проекта (resolvePanelRights) расширяют права
 * командира на правку состава, поэтому здесь они намеренно НЕ используются:
 * «правка отпуска» и «удаление личного дела» — разные полномочия.
 */

/* ------------------------------------------------------------------ */
/* Права доступа                                                       */
/* ------------------------------------------------------------------ */

/** Итог проверки доступа к удалению */
export type MemberDeletionDecision = "allow" | "forbidden" | "unauthenticated";

/**
 * Решение по двум найденным сессиям (панель и кабинет бойца).
 *
 * admin в любой из сессий допускается: у администратора панели может не быть
 * строки в табеле, а у бойца-администратора — cookie панели.
 *
 * Вошедший, но не администратор, получает «forbidden» (403), а не
 * «unauthenticated» (401): код ответа должен соответствовать реальности, иначе
 * командир, потерявший права, будет искать проблему в cookie вместо роли.
 * undefined/null роли означают «сессии нет вовсе» — это 401.
 */
export function memberDeletionDecision(
  panelRole: unknown,
  memberRole: unknown
): MemberDeletionDecision {
  if (panelRole === "admin" || memberRole === "admin") return "allow";
  if (panelRole != null || memberRole != null) return "forbidden";
  return "unauthenticated";
}

/* ------------------------------------------------------------------ */
/* Идентификатор бойца из адреса                                       */
/* ------------------------------------------------------------------ */

/**
 * Разбор id из пути роута.
 *
 * Number.parseInt здесь не годится: на «7.5» он вернул бы 7, и запрос с
 * дробным адресом удалял бы бойца с id 7 — то есть промах в адресе приводил бы
 * к удалению чужого профиля. Принимаются только целые положительные значения
 * без хвостов: «7», «007» → 7; «7.5», «7abc», «0», «-5», «» → null.
 */
export function parseMemberId(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------ */
/* Подтверждение необратимого действия                                 */
/* ------------------------------------------------------------------ */

/**
 * Что вводит администратор в окне подтверждения.
 * Позывной бойца: осознанное действие вместо случайного клика по корзине.
 * Если позывного нет, подтверждением служит имя из табеля — тогда в окне
 * показано именно оно (memberDeletionConfirmationLabel), и админ вводит то,
 * что видит.
 */
export function memberDeletionConfirmationLabel(member: {
  callsign?: string | null;
  name: string;
}): string {
  const callsign = (member.callsign ?? "").trim();
  return callsign || member.name.trim();
}

/**
 * Проверка подтверждения. Сравнение нечувствительно к регистру и лишним
 * пробелам: цель — не дать удалить чужую карточку одной кнопкой, а не
 * заставить администратора угадывать регистр позывного.
 */
export function memberDeletionConfirmationMatches(
  typed: unknown,
  member: { callsign?: string | null; name: string }
): boolean {
  if (typeof typed !== "string") return false;
  const expected = memberDeletionConfirmationLabel(member);
  if (!expected) return false;
  return typed.trim().toLowerCase() === expected.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Аудит                                                               */
/* ------------------------------------------------------------------ */

/** Позывной бойца для журнала и ответа API: пустой заменяется прочерком */
export function memberCallsignLabel(member: { callsign?: string | null; name: string }): string {
  const callsign = (member.callsign ?? "").trim();
  return callsign || member.name.trim() || "—";
}

/**
 * Подпись администратора в журнале.
 *
 * Роль в подписи фиксирована («Администратор»), потому что к удалению допущен
 * только администратор: командир сюда не попадает вовсе. Логин панели
 * предпочтительнее позывного бойца — по нему в «Доступах» ищут учётную запись.
 */
export function memberDeletionAuthor(actor: {
  username?: string | null;
  callsign?: string | null;
}): string {
  const login = (actor.username ?? "").trim() || (actor.callsign ?? "").trim();
  return login ? `Администратор ${login}` : "Администратор";
}

/** Формулировка действия из ТЗ: «Администратор [username] удалил личное дело бойца [callsign] (ID: [id])» */
export function memberDeletionAction(member: {
  callsign?: string | null;
  name: string;
  id: number;
}): string {
  return `удалил личное дело бойца ${memberCallsignLabel(member)} (ID: ${member.id})`;
}

/* ------------------------------------------------------------------ */
/* Работа с базой                                                      */
/* ------------------------------------------------------------------ */

/** Боец, чьё личное дело удаляется: нужен минимум полей для журнала и ответа */
export type MemberDeletionTarget = {
  id: number;
  name: string;
  callsign: string | null;
};

export type MemberDeletionResult = {
  /** Строки, вычищенные в связанных таблицах — возвращаются для ответа и журнала */
  removed: {
    /** Сессии кабинета бойца (member_sessions); при ON DELETE CASCADE их снимет и сама база */
    sessions: number;
    /** Снимки недельной статистики (weekly_stats) */
    weeklyStats: number;
  };
  /** Сколько учётных записей панели было привязано к бойцу и отвязано */
  unlinkedPanelAccounts: number;
};

/**
 * Хранилище удаления.
 *
 * Интерфейс, а не прямые вызовы db: тесты подменяют его, чтобы проверить
 * порядок шагов и очистку связей («сессии удалены, users.member_id обнулён»)
 * на настоящей функции удаления, а не на её копии в тесте.
 */
export type MemberDeletionStore = {
  /** Вернуть карточку бойца её внутренней строкой или null, если её нет */
  findMember(id: number): Promise<MemberDeletionTarget | null>;
  /** Отвязать учётные записи панели: users.member_id = NULL. Возвращает число строк */
  unlinkPanelAccounts(id: number): Promise<number>;
  /** Удалить сессии кабинета бойца. Возвращает число строк */
  clearMemberSessions(id: number): Promise<number>;
  /** Удалить снимки недельной статистики. Возвращает число строк (строгий FK) */
  clearWeeklyStats(id: number): Promise<number>;
  /** Удалить саму строку табеля. false — строки уже нет */
  deleteMember(id: number): Promise<boolean>;
};

/**
 * Зависимости удаления.
 *
 * `clearRelated` — очистка зависимых таблиц, внешние ключи которых объявлены
 * строгими (RESTRICT / NO ACTION). Она не часть MemberDeletionStore, потому что
 * выполняется сырым SQL по фактической схеме базы: список связанных таблиц
 * отличается между установками, а «жёсткий» список в коде — это лишний повод
 * для 500 на живой базе.
 */
export type MemberDeletionDeps = {
  store: MemberDeletionStore;
  /** Очистка зависимых строк, ссылающихся на бойца (статистика, снапшоты, заявки) */
  clearRelated?: (id: number) => Promise<void>;
};

/** Ошибка удаления: код нужен роуту, чтобы выбрать статус ответа */
export class MemberDeletionError extends Error {
  readonly code: "not_found";
  constructor(code: "not_found", message: string) {
    super(message);
    this.name = "MemberDeletionError";
    this.code = code;
  }
}

/**
 * Полное удаление профиля бойца — один неделимый шаг.
 *
 * Порядок шагов намеренный:
 *   1. существование бойца: без этого «успех» на несуществующем id маскировал
 *      бы опечатку в адресе, а журнал получал бы запись об удалении призрака;
 *   2. отвязка учётных записей панели (users.member_id = NULL) — ДО удаления
 *      строки. Хотя FK объявлен ON DELETE SET NULL, полагаться только на него
 *      нельзя: в развёрнутых вручную базах ограничение могло быть создано без
 *      этого действия, и тогда удаление бойца упало бы на FK, заблокировав
 *      администратора. Явный UPDATE делает исход одинаковым на любой схеме;
 *   3. сессии кабинета: токены бойца должны умереть вместе с карточкой, а не
 *      жить в member_sessions до истечения срока;
 *   4. очистка зависимых таблиц со строгими ключами;
 *   5. сама строка табеля;
 *   6. если строки не оказалось — гонка (параллельный DELETE), и транзакция
 *      откатывается ошибкой not_found, а не отчётом об успехе.
 *
 * Журнал пишет вызывающая сторона (роут) ПОСЛЕ фиксации транзакции: запись в
 * bot_logs внутри транзакции исчезла бы вместе с откатом, и об удалении не
 * осталось бы следа.
 */
export async function deleteMemberProfile(
  id: number,
  deps: MemberDeletionDeps
): Promise<{ member: MemberDeletionTarget; result: MemberDeletionResult }> {
  const { store, clearRelated } = deps;

  const member = await store.findMember(id);
  if (!member) throw new MemberDeletionError("not_found", "Боец не найден");

  const unlinkedPanelAccounts = await store.unlinkPanelAccounts(id);
  const sessions = await store.clearMemberSessions(id);
  const weeklyStats = await store.clearWeeklyStats(id);

  if (clearRelated) await clearRelated(id);

  const deleted = await store.deleteMember(id);
  if (!deleted) throw new MemberDeletionError("not_found", "Боец не найден");

  return { member, result: { removed: { sessions, weeklyStats }, unlinkedPanelAccounts } };
}

/* ------------------------------------------------------------------ */
/* Очистка зависимых таблиц по фактической схеме                       */
/* ------------------------------------------------------------------ */

/** Колонка, по которой таблица ссылается на бойца */
export type RelatedColumn = { table: string; column: string };

/** Строка каталога внешних ключей, как её отдаёт PostgreSQL */
export type ForeignKeyRow = {
  /** Схема и имя таблицы-потомка, например public.weekly_stats */
  child: string;
  /** Колонки-потомки (составной ключ даёт несколько значений) */
  columns: string[];
  /** Действие при удалении: c — cascade, n — set null, r — restrict, a — no action */
  action: string;
  /** Имя ограничения: нужно, чтобы отличить собственное KEY бойца от чужих ссылок */
  constraint: string;
};

/**
 * Действия, при которых база сама НЕ уберёт ссылку на удаляемого бойца.
 * Для таких таблиц строку придётся очистить явно, иначе DELETE упадёт на FK.
 */
export const STRICT_FK_ACTIONS: readonly string[] = ["r", "a"];

/**
 * Разбор полей ограничения «a,b» без ложных срабатываний на пробелы внутри имени.
 * Регистр не меняем: имена таблиц и колонок в PostgreSQL значимы.
 */
function splitFieldList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** Имя таблицы состава: по нему узнаём self-reference, который чистить нельзя */
export const MEMBERS_TABLE = "division_members";

/**
 * Какие таблицы нужно вычистить перед удалением бойца.
 *
 * Вход — строки pg_constraint (как их отдаёт запрос в роуте). Логика:
 *   * берём только ограничения внешнего ключа (тип f);
 *   * пропускаем каскадные и SET NULL — с ними справится сама база;
 *   * отбрасываем строки без списка колонок (NULL — признак ограничения уровня
 *     таблицы, к ссылке на бойца не относящегося);
 *   * сама таблица состава исключается: self-reference на division_members
 *     означал бы, что «очистка» удалит цель операции.
 *
 * Функция чистая: её проверяют тесты, а роут лишь исполняет её вывод.
 */
export function relatedColumnsToClear(rows: readonly ForeignKeyRow[]): RelatedColumn[] {
  const out: RelatedColumn[] = [];
  for (const row of rows) {
    if (!row.child) continue;
    // Имя потомка приходит как «schema.table» либо «table» — схему отбрасываем
    const table = row.child.split(".").pop() ?? "";
    if (table === MEMBERS_TABLE) continue;
    if (!STRICT_FK_ACTIONS.includes((row.action || "").toLowerCase())) continue;
    const columns = row.columns ?? [];
    if (columns.length === 0) continue;
    // Составной ключ на бойца в проекте не встречается: одна колонка = одна ссылка
    const column = columns[0];
    out.push({ table: row.child, column });
  }
  return out;
}

/**
 * Имя таблицы для подстановки в SQL: разрешаем только «схема.имя» из букв,
 * цифр и подчёркиваний. Всё остальное (кавычки, точка с запятой, пробелы)
 * отклоняется: значения приходят из pg_constraint, но запрос собирается
 * подстановкой и должен быть защищён от экзотических имён.
 */
export function isSafeRelationName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name);
}

/** Запрос каталога внешних ключей, ссылающихся на division_members */
export const MEMBER_FOREIGN_KEYS_SQL = [
  "SELECT",
  "  c.conrelid::regclass::text AS child,",
  "  (SELECT array_agg(a.attname ORDER BY k.ord)",
  "     FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)",
  "     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,",
  "  c.confdeltype::text AS action,",
  "  c.conname AS constraint",
  "FROM pg_constraint c",
  "WHERE c.contype = 'f'",
  "  AND c.confrelid = 'division_members'::regclass",
].join("\n");

/**
 * Названия связанных таблиц из ТЗ — используются в комментариях и тестах
 * как перечень известных потомков бойца.
 */
export const KNOWN_MEMBER_TABLES: readonly string[] = [
  "member_sessions",
  "weekly_stats",
  "service_reports",
  "recruit_applications",
  "users",
];