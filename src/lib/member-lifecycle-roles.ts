/**
 * Роли Discord при переводе в запас и увольнении: чистый план.
 *
 * Отдельный модуль от member-lifecycle.ts, потому что план ролей опирается на
 * справочник ролей сервера (roles.ts) и настройки — это домен Discord, а не
 * общие правила карточки. План считается ЧИСТОЙ функцией (planLifecycleRoles):
 * тесты проверяют его без сети и без БД, а применение делает оркестратор
 * (member-lifecycle-apply.ts) через safeDiscord-обёртку.
 *
 * Правила повторяют desiredRoles() из role-sync.ts для состояний «в запасе» и
 * «вне состава», но без чтения текущих ролей участника: действие выполняется
 * немедленно, и роли, которых нет, Discord просто пропустит (снятие отсутствующей
 * роли — не ошибка).
 */
import {
  CLAN_ROLE_IDS,
  COMMON_ROLE_IDS,
  RANK_ROLE_IDS,
  SUBDIV_ROLE_IDS,
} from "@/lib/roles";
import { MEMBER_ACTIONS, type MemberAction } from "@/lib/member-lifecycle";

/** Что сделать с ролями Discord */
export type LifecycleRolePlan = {
  /** Выдать (ID ролей) */
  add: string[];
  /** Снять (ID ролей) */
  remove: string[];
  /** Человекочитаемое пояснение для журнала и ответа API */
  notes: string[];
};

/**
 * План ролей для действия.
 *
 * «В запас» (reserve):
 *   * выдать роль «Запас» (если настроена);
 *   * снять роли активной боевой службы: подразделения (ТР/АД), корпус,
 *     категорию «Звания», роль звания, «Новобранец», «Берет», «Отпуск»;
 *   * звание и доступ к общим каналам сохраняются — то есть роль звания НЕ
 *     снимается, а роль корпуса остаётся (запасник остаётся частью корпуса).
 *
 * «Уволить» (dismiss):
 *   * снять ВСЕ служебные роли: звание, подразделение, корпус, категорию
 *     «Звания», «Новобранец», «Берет», «Отпуск», «Запас»;
 *   * выдать «Друг АТК» — роль бывшего бойца (то же правило, что в
 *     desiredRoles для выбывшего).
 *
 * Роль «Запас» передаётся настройкой reserveRoleId: пустое значение — роли на
 * сервере нет, и план честно сообщает об этом (не ошибка, а предупреждение).
 */
export function planLifecycleRoles(input: {
  action: MemberAction;
  /** ID роли «Запас» из настроек (reserve_role_id) */
  reserveRoleId: string | null | undefined;
  /** ID роли «Отпуск» из настроек (leave_role_id) */
  leaveRoleId: string | null | undefined;
  /** ID роли «Берет» (настройка или поиск по имени) */
  beretRoleId?: string | null;
  /** ID роли должности из post_role_map, если должность бойца там есть */
  postRoleIds?: readonly string[];
}): LifecycleRolePlan {
  const notes: string[] = [];
  const add: string[] = [];
  const remove: string[] = [];

  const reserveRoleId = (input.reserveRoleId ?? "").trim();
  const leaveRoleId = (input.leaveRoleId ?? "").trim();
  const beretRoleId = (input.beretRoleId ?? "").trim();
  const postRoleIds = (input.postRoleIds ?? []).map((id) => id.trim()).filter(Boolean);

  if (input.action === MEMBER_ACTIONS.RESERVE) {
    // Роли активной боевой службы: экипажи ТР, расчёты АД, закрытые боевые
    // каналы — всё, что привязано к подразделению и должности
    remove.push(...Object.values(SUBDIV_ROLE_IDS));
    remove.push(COMMON_ROLE_IDS.RANKS_CATEGORY);
    remove.push(COMMON_ROLE_IDS.RECRUIT);
    remove.push(...postRoleIds);
    if (beretRoleId) remove.push(beretRoleId);
    // Отпуск и запас несовместимы: уйдя в запас, боец не может оставаться
    // «в отпуске» — роль снимается
    if (leaveRoleId) remove.push(leaveRoleId);

    if (reserveRoleId) {
      add.push(reserveRoleId);
      notes.push("выдана роль «Запас»");
    } else {
      notes.push("роль «Запас» не задана (Настройки → Discord → reserve_role_id) — выдайте вручную");
    }
    notes.push("сняты роли подразделения, должности и боевых допусков; звание сохранено");
    return { add, remove, notes };
  }

  // Увольнение: снимаются ВСЕ служебные роли, включая звание и корпус
  remove.push(...Object.values(RANK_ROLE_IDS));
  remove.push(...Object.values(SUBDIV_ROLE_IDS));
  remove.push(
    COMMON_ROLE_IDS.ATK_CORPS,
    COMMON_ROLE_IDS.RANKS_CATEGORY,
    COMMON_ROLE_IDS.RECRUIT
  );
  remove.push(...postRoleIds);
  if (beretRoleId) remove.push(beretRoleId);
  if (leaveRoleId) remove.push(leaveRoleId);
  if (reserveRoleId) remove.push(reserveRoleId);

  add.push(COMMON_ROLE_IDS.FRIEND);
  notes.push("сняты все служебные роли (звание, подразделение, допуски); выдана роль «Друг АТК»");
  return { add, remove, notes };
}

/**
 * Роли, которые план имеет право снять.
 *
 * Страховка на случай ошибки в плане: снятие идёт только по справочнику ролей
 * клана и явно настроенным ролям состояния (запас/отпуск/берет/должности).
 * Кастомные роли («Игроман», «Модератор») не трогаются никогда — то же
 * правило, что у managedRoleIds() в role-sync.ts.
 */
export function lifecycleManagedRoleIds(input: {
  reserveRoleId: string | null | undefined;
  leaveRoleId: string | null | undefined;
  beretRoleId?: string | null;
  postRoleIds?: readonly string[];
}): Set<string> {
  const ids = new Set<string>(CLAN_ROLE_IDS);
  ids.add(COMMON_ROLE_IDS.FRIEND);
  for (const key of ["reserveRoleId", "leaveRoleId", "beretRoleId"] as const) {
    const id = (input[key] ?? "").trim();
    if (id) ids.add(id);
  }
  for (const id of input.postRoleIds ?? []) {
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids;
}
