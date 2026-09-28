/**
 * Связка учётной записи панели с бойцом состава.
 *
 * Зачем отдельный модуль: правило нужно и входу (выдать сессию кабинета сразу),
 * и страницам кабинета (объяснить, почему личного дела нет), и модерации
 * («Доступы» — связать аккаунт с бойцом). Копия правила в трёх местах разошлась
 * бы: аккаунт считался бы связанным в одном месте и не связанным в другом.
 *
 * Модуль намеренно НЕ зависит ни от БД, ни от Next.js — как recruits.ts,
 * vehicles.ts и dossier.ts: правило проверяется тестами напрямую
 * (tests/panel-profile-access.test.ts), а обращение к базе живёт в member-auth.ts.
 */
import { hasProfileAccess, type MemberRole, type MemberStatus } from "@/lib/recruits";
import { normalizeCallsign } from "@/lib/recruits";

/**
 * Кандидат в бойцы, которому может принадлежать учётная запись панели.
 * Поля — минимум, нужный для решения: кто это и можно ли ему в кабинет.
 */
export type PanelMemberCandidate = {
  id: number;
  /** Позывной: в проекте он же логин бойца */
  callsign: string | null;
  /** ФИО: показывается в интерфейсе, если позывного нет */
  name: string;
  /** Discord ID бойца — уже подтверждённая связь, если совпал */
  discordId: string | null;
  status: MemberStatus;
  role: MemberRole;
};

/** Учётная запись панели в том виде, в каком её видит правило связки */
export type PanelAccountIdentity = {
  username: string;
  discordId: string | null;
};

/**
 * Какому бойцу принадлежит учётная запись панели. null — связи нет.
 *
 * Порядок проверок и почему именно такой:
 *   1. Discord ID — единственная подтверждённая связь: её установил сам человек
 *      через OAuth2, совпадение случайным быть не может. Поэтому она главнее
 *      позывного: если администратор переименовал аккаунт, связь не потеряется.
 *   2. Позывной (без учёта регистра) — так связаны командиры, вошедшие по логину
 *      и паролю: логин панели в проекте совпадает с позывным бойца.
 *
 * Неоднозначность трактуется как «связи нет»: если под правило подходят два
 * разных бойца, молча выбрать первого значило бы показать одному человеку
 * чужое личное дело. Лучше отказать и потребовать явной связки в «Доступах».
 */
export function pickMemberForPanelAccount(
  account: PanelAccountIdentity,
  candidates: readonly PanelMemberCandidate[]
): PanelMemberCandidate | null {
  const discordId = (account.discordId || "").trim();
  if (discordId) {
    const byDiscord = candidates.filter(
      (candidate) => (candidate.discordId || "").trim() === discordId
    );
    // discord_id бойца не уникален на уровне схемы (так исторически): при
    // нескольких совпадениях выбор неоднозначен — берём самый ранний id, как
    // это уже делает вход через Discord (там тоже берётся первая запись).
    if (byDiscord.length > 0) {
      return byDiscord.reduce((first, next) => (next.id < first.id ? next : first));
    }
  }

  const username = normalizeCallsign(account.username).toLowerCase();
  if (!username) return null;

  // Позывной (в проекте он же логин бойца) — основной ключ для входа по паролю
  const byCallsign = candidates.filter(
    (candidate) => normalizeCallsign(candidate.callsign).toLowerCase() === username
  );
  if (byCallsign.length === 1) return byCallsign[0];
  // Совпадений больше одного — «связь» была бы догадкой, отказываем
  if (byCallsign.length > 1) return null;

  /**
   * ФИО — крайний случай: у бойцов из синхронизации rs-red.com позывного может
   * не быть вовсе, и единственный ключ — имя. Правило совпадает с тем, по
   * которому ищет бойца восстановление доступа (scripts/bootstrap-admin.ts:
   * «позывной или имя»), поэтому поведение входа и скриптов не расходится.
   * Требуем ровно одно совпадение: однофамильцы в табеле — не редкость, а
   * показать чужое личное дело хуже, чем не показать ничего.
   */
  const byName = candidates.filter(
    (candidate) => normalizeCallsign(candidate.name).toLowerCase() === username
  );
  return byName.length === 1 ? byName[0] : null;
}

/**
 * Доступен ли кабинет бойцу, связанному с учётной записью панели.
 *
 * Правило не дублируется: статус проверяется боевой hasProfileAccess (кабинет
 * открыт «в строю» и «в отпуске»). Функция существует, чтобы у вызывающего
 * кода было одно место для этого решения — как у canViewPrivateFields.
 */
export function canOpenCabinet(status: MemberStatus): boolean {
  return hasProfileAccess(status);
}

/**
 * Состояние личного кабинета для интерфейса.
 *
 * Значения специально различимы: «войдите» (сессии нет вовсе) — это не то же
 * самое, что «аккаунт не связан с бойцом». Раньше и то и другое показывало
 * заглушку с кнопкой «Войти», и человек попадал в цикл: /profile → /login →
 * /profile → та же заглушка.
 */
export type CabinetState = "ok" | "no_session" | "not_linked" | "no_access";

/** Тексты состояний кабинета — одни и те же на странице и в API */
export const CABINET_STATE_MESSAGES: Record<Exclude<CabinetState, "ok">, string> = {
  no_session: "Войдите в личный кабинет, чтобы увидеть личное дело",
  not_linked:
    "Учётная запись панели не связана с бойцом в табеле. Свяжите её в разделе «Доступы»",
  no_access: "Личное дело доступно бойцам, зачисленным в подразделение",
};