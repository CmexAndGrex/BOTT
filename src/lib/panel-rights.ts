/**
 * Эффективные права пользователя: панель + кабинет бойца.
 *
 * Зачем отдельный модуль. До него право «командир» вычислялось в каждом месте
 * по-своему: страница «Контроль» смотрела только роль панельной сессии
 * (/api/me), табель «Состав» — тоже только панель, а гвард роута правки
 * Discord ID требовал строго «admin». Командир подразделения («Волков»),
 * у которого есть должность «Командир подразделения» и роль бойца officer,
 * но нет cookie панели, во всех этих местах читался как гость:
 *   * /control показывал «Доступ запрещен. Только для командиров»;
 *   * в сайдбаре не появлялась секция «УПРАВЛЕНИЕ» с пунктом «Контроль»;
 *   * в табеле «Состав» колонка Discord ID была доступна только на чтение.
 * Правило одно, и живёт оно здесь: интерфейс и роуты спрашивают одно и то же,
 * поэтому «на клиенте пустили, на сервере отказали» больше разойтись не может.
 *
 * Модуль намеренно НЕ зависит ни от БД, ни от Next.js — как recruits.ts и
 * validation.ts: правило проверяется тестами напрямую (tests/panel-rights.test.ts).
 *
 * Про терминологию. В БД и в токенах роли панели исторически названы
 * `admin`/`officer` (см. PANEL_STAFF_ROLES и MEMBER_ROLES), а в требованиях
 * командир называется «commander». Оба написания означают одно и то же
 * право, поэтому `commander` принимается как алиас `officer`
 * (normalizeCommanderRole) — иначе требование «role = 'commander'» не
 * выполнялось бы на данных, где записано «officer».
 */
import { isMemberRole, type MemberRole } from "@/lib/recruits";

/* ------------------------------------------------------------------ */
/* Кто считается командиром подразделения                              */
/* ------------------------------------------------------------------ */

/**
 * Должности, дающие права командира подразделения.
 *
 * Сравнение идёт по нормализованной строке (регистр, «ё», лишние пробелы),
 * потому что должность приходит и из rs-red.com (`subdivpost`), и из
 * Google Таблицы, и вписывается руками в панели модерации — «Командир
 * подразделения», «командир  подразделения» и «КОМАНДИР ПОДРАЗДЕЛЕНИЯ»
 * обязаны распознаваться одинаково.
 *
 * Список явный, а не «любая должность со словом командир»: иначе командир
 * отделения получил бы права на правку внешнего документа ШДС, а это
 * полномочие штаба подразделения.
 */
export const COMMANDER_POSTS: readonly string[] = [
  "командир подразделения",
  "командир части",
  "командир роты",
  "командир дивизиона",
];

/**
 * Звания, при которых боец считается командиром подразделения.
 *
 * Отдельный признак нужен по прямому требованию: в подразделении командир
 * носит звание «Полковник», а должность в табеле может быть не заполнена
 * (или записана иначе). Признак намеренно узкий — одно высшее звание
 * подразделения; расширять его значит раздавать права штаба по званию.
 */
export const COMMANDER_RANKS: readonly string[] = ["полковник"];

/** Нормализация строки для сравнения должностей и званий */
function normalizeToken(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

/** Должность бойца — должность командира подразделения */
export function isCommanderPost(post: unknown): boolean {
  const value = normalizeToken(post);
  if (!value) return false;
  return COMMANDER_POSTS.some((known) => normalizeToken(known) === value);
}

/** Звание бойца — звание командира подразделения */
export function isCommanderRank(rank: unknown): boolean {
  const value = normalizeToken(rank);
  if (!value) return false;
  return COMMANDER_RANKS.some((known) => normalizeToken(known) === value);
}

/**
 * Боец является командиром подразделения: по должности ИЛИ по званию.
 *
 * Должность главнее звания, но оба признака равноправны по результату: боец
 * с незаполненной должностью, но званием «Полковник», обязан сохранить доступ
 * (это ровно случай из отчёта — у командира не было прав из-за пустой
 * панельной сессии, а не из-за отсутствия должности).
 */
export function isCommanderAppointment(post: unknown, rank: unknown): boolean {
  return isCommanderPost(post) || isCommanderRank(rank);
}

/* ------------------------------------------------------------------ */
/* Роли: алиас «commander» и вычисление прав                           */
/* ------------------------------------------------------------------ */

/**
 * Роль командира в написании «commander» → внутреннее «officer».
 *
 * Требование называет роль командира `commander`, а БД и токены проекта —
 * `officer`; `admin` пишется одинаково. Функция сводит оба написания к
 * внутреннему значению, чтобы правило было одно. Неизвестное значение
 * возвращает null: мусор в колонке роли не должен давать прав.
 */
export function normalizeCommanderRole(role: unknown): MemberRole | null {
  const value = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!value) return null;
  // Панельная роль officer и требуемая commander — одно и то же право
  if (value === "commander") return "officer";
  return isMemberRole(value) ? value : null;
}

/** Роли штаба: командир («officer»/«commander») и администратор */
function isStaffRoleValue(role: MemberRole | null): boolean {
  return role === "officer" || role === "admin";
}

/** Эффективная роль доступа для интерфейса и ответов API */
export type AccessRole = "admin" | "commander" | "guest";

export type PanelRights = {
  /** Администратор: полный доступ, включая настройки и обслуживание системы */
  isAdmin: boolean;
  /** Командир: роль штаба или должность командира подразделения */
  isCommander: boolean;
  /** Эффективная роль: admin | commander | guest */
  accessRole: AccessRole;
  /** Доступ к разделу «Контроль» и его роутам */
  canControl: boolean;
  /** Правка Discord ID с записью в Google Таблицу ШДС */
  canEditRosterDiscordId: boolean;
  /** Право видеть приватные поля состава (Discord ID) */
  canViewPrivate: boolean;
};

export type PanelRightsInput = {
  /** Роль сессии панели (auth_token): admin / officer / commander / null */
  panelRole?: unknown;
  /** Роль бойца из кабинета (member_token → division_members.role) */
  memberRole?: unknown;
  /** Должность бойца из табеля */
  memberPost?: unknown;
  /** Звание бойца из табеля */
  memberRank?: unknown;
};

/**
 * Права пользователя по обеим сессиям сразу.
 *
 * Сессии панели и кабинета могут существовать одновременно (командир входит и
 * в панель, и в досье), поэтому флаги объединяются по ИЛИ: право, полученное
 * любой из сессий, действует. Право никогда не понижается связкой — иначе
 * командир, чья учётная запись привязана к бойцу-«member», потерял бы доступ,
 * который уже имел (то же правило, что в roleAfterLink).
 *
 * `memberPost`/`memberRank` учитываются намеренно: у командира подразделения
 * может не быть ни роли штаба в колонке role, ни cookie панели — только
 * должность и звание в табеле, и именно этот случай приходил как баг.
 */
export function resolvePanelRights(input: PanelRightsInput): PanelRights {
  const panelRole = normalizeCommanderRole(input.panelRole);
  const memberRole = normalizeCommanderRole(input.memberRole);

  const isAdmin = panelRole === "admin" || memberRole === "admin";
  const staff = isAdmin || isStaffRoleValue(panelRole) || isStaffRoleValue(memberRole);
  const appointed = isCommanderAppointment(input.memberPost, input.memberRank);
  const isCommander = staff || appointed;

  return {
    isAdmin,
    isCommander,
    accessRole: isAdmin ? "admin" : isCommander ? "commander" : "guest",
    canControl: isCommander,
    // Правка ID меняет внешний документ ШДС: её доверяем командиру и админу
    canEditRosterDiscordId: isCommander,
    canViewPrivate: isCommander,
  };
}

/** Права гостя — значения по умолчанию для страниц и роутов */
export const GUEST_RIGHTS: PanelRights = {
  isAdmin: false,
  isCommander: false,
  accessRole: "guest",
  canControl: false,
  canEditRosterDiscordId: false,
  canViewPrivate: false,
};