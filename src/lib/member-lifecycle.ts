/**
 * Жизненный цикл бойца: чистые правила действий «В запас» и «Уволить».
 *
 * Модуль намеренно не зависит ни от БД, ни от Next.js, ни от Discord — как
 * recruits.ts и validation.ts: правила проверяются тестами напрямую
 * (tests/member-lifecycle.test.ts) и используются одинаково на сервере
 * (роут /api/members/[id]/action) и в интерфейсе (кнопки в табеле и досье).
 * Если правило нужно и роуту, и кнопке — живёт здесь, а не копией в двух местах.
 */
import { isCorpsCommander, isDeputyCommander } from "@/lib/validation";
import { MEMBER_STATUS, normalizeMemberStatus, type MemberStatus } from "@/lib/recruits";

/** Административные действия над бойцом */
export const MEMBER_ACTIONS = {
  /** Перевести в запас: строка ШДС → лист «Запас», роль «Запас» в Discord */
  RESERVE: "reserve",
  /** Уволить: строка ШДС → «Вакант», служебные роли Discord снимаются */
  DISMISS: "dismiss",
} as const;

export type MemberAction = (typeof MEMBER_ACTIONS)[keyof typeof MEMBER_ACTIONS];

/** Проверка значения действия из запроса */
export function isMemberAction(value: unknown): value is MemberAction {
  const action = typeof value === "string" ? value.trim().toLowerCase() : "";
  return action === MEMBER_ACTIONS.RESERVE || action === MEMBER_ACTIONS.DISMISS;
}

/**
 * Discord ID Командира Корпуса (Волков Д. В.).
 *
 * Защищённая цель: действия «В запас»/«Уволить» к нему не применяются НИКОГДА
 * — ни из панели, ни из API. Командование корпуса ведётся отдельным листом
 * «Командование АТК», и перевод командира в запас сломал бы и лист, и роли.
 */
export const CORPS_COMMANDER_DISCORD_ID = "588629880002969600";

/** Признаки бойца, по которым его узнаёт правило защиты */
export type LifecycleFighter = {
  id?: number | null;
  name?: string | null;
  post?: string | null;
  discordId?: string | null;
  /** Статус учётной записи: нужен проверке повторного увольнения */
  status?: string | null;
};

/**
 * Боец защищён от административных действий.
 *
 * Два случая:
 *   1. Командир корпуса (Волков Д. В.) — по Discord ID (самый надёжный
 *      признак) ИЛИ по ФИО/должности (isCorpsCommander из validation.ts —
 *      то же правило, что защищает его от предупреждений в «Контроле»);
 *   2. заместители командира корпуса (Иванов И. А., Иванов К. М.) —
 *      защищённые офицеры командования по ФИО/должности.
 *
 * Правило одно на сервер и интерфейс: кнопки в табеле скрываются по нему же,
 * поэтому «кнопка есть, а сервер отвечает 403» разойтись не может.
 */
export function isProtectedLifecycleTarget(fighter: LifecycleFighter): boolean {
  const discordId = String(fighter?.discordId ?? "").trim();
  if (discordId && discordId === CORPS_COMMANDER_DISCORD_ID) return true;
  return (
    isCorpsCommander({ name: fighter?.name, post: fighter?.post }) ||
    isDeputyCommander({ name: fighter?.name, post: fighter?.post })
  );
}

/** Причина отказа в действии — человекочитаемая, для ответа API и подсказки UI */
export type LifecycleDenial = { ok: false; reason: string };

/**
 * Разрешено ли применить действие к бойцу.
 *
 * Проверяется цель, а не инициатор: права инициатора считает гвард роута
 * (requireRosterEditor), а здесь — только «можно ли трогать этого бойца».
 * Отдельно от isProtectedLifecycleTarget, чтобы причина отказа была точной:
 * «нельзя уволить самого себя» и «командование корпуса не увольняется» —
 * разные сообщения для штаба.
 */
export function checkLifecycleTarget(
  action: MemberAction,
  fighter: LifecycleFighter,
  /** ID бойца, связанного с текущей сессией (нельзя уволить самого себя) */
  selfMemberId: number | null | undefined
): { ok: true } | LifecycleDenial {
  if (typeof fighter?.id === "number" && typeof selfMemberId === "number" && fighter.id === selfMemberId) {
    return { ok: false, reason: "Нельзя применить это действие к самому себе" };
  }
  if (isProtectedLifecycleTarget(fighter)) {
    return {
      ok: false,
      reason: "Командование корпуса защищено от перевода в запас и увольнения",
    };
  }
  // Увольнение уже уволенного — не ошибка, но и не действие: повторная
  // отправка того же решения не должна перезаписывать дату dismissedAt
  if (action === MEMBER_ACTIONS.DISMISS) {
    const status = normalizeMemberStatus(fighter.status);
    if (status === MEMBER_STATUS.DISMISSED) {
      return { ok: false, reason: "Боец уже исключён из состава" };
    }
  }
  return { ok: true };
}

/**
 * Статус, который записывается в БД при действии.
 *
 * «В запас» — статус reserve (кабинет закрыт, табель показывает «в резерве»),
 * «Уволить» — dismissed. Чистая функция: роут не выбирает статус сам, иначе
 * UI и сервер разошлись бы в один правке.
 */
export function statusAfterAction(action: MemberAction): MemberStatus {
  return action === MEMBER_ACTIONS.RESERVE ? MEMBER_STATUS.RESERVE : MEMBER_STATUS.DISMISSED;
}

/**
 * Подразделение, которое остаётся в карточке после действия.
 *
 * Запас: unit сохраняется — по нему возврат из запаса находит лист ШДС и роли.
 * Увольнение: unit = null — выбывший не числится ни в одном подразделении.
 */
export function unitAfterAction(action: MemberAction, currentUnit: string | null): string | null {
  return action === MEMBER_ACTIONS.RESERVE ? currentUnit : null;
}

/** Заголовок действия для журнала и интерфейса */
export function memberActionLabel(action: MemberAction): string {
  return action === MEMBER_ACTIONS.RESERVE ? "Перевод в запас" : "Увольнение";
}
