/**
 * Контроль снятия ролей Discord у исключённых бойцов: правила.
 *
 * Задача: боец переведён в статус `dismissed` (исключён по рапорту, переведён в
 * запас, отклонена заявка), но роль подразделения на сервере осталась. Пока её
 * не снимут, исключённый продолжает читать закрытые каналы. Роли снимает живой
 * человек в канале запросов ролей, поэтому через сутки комсоставу нужен
 * напоминательный пинг.
 *
 * Разделение как в role-sync.ts: здесь только ПРАВИЛА — кого считать
 * кандидатом, висит ли ещё роль и как выглядит уведомление. База, Discord REST
 * и журнал живут в runDismissedRolesCheck (src/lib/tasks.ts). Так правила
 * проверяются тестами без сети и БД, а границы сроков и флагов — а это ровно
 * то, где ошибка означает либо спам каждый цикл, либо молчание вместо пинга —
 * не остаются непроверенными.
 */
import { CLAN_ROLE_IDS, COMMON_ROLE_IDS } from "@/lib/roles";
import type { DiscordEmbed } from "@/lib/discord";

/* ------------------------------------------------------------------ */
/* Сроки                                                               */
/* ------------------------------------------------------------------ */

/** Через сколько после исключения напоминать комсоставу, мс (по умолчанию) */
export const ROLES_ALERT_DELAY_MS = 24 * 60 * 60 * 1000;

/** Границы настройки «сколько часов ждать снятия ролей» */
export const ROLES_ALERT_MIN_HOURS = 1;
export const ROLES_ALERT_MAX_HOURS = 24 * 30;

/**
 * Срок ожидания из настроек панели.
 *
 * Значение приходит строкой (bot_settings — текстовые пары), поэтому его нужно
 * проверить: пустое, мусорное или отрицательное значение молча превратило бы
 * проверку в «пинг сразу после исключения», то есть в спам комсоставу.
 * Границы спасают и от опечатки: «2400» вместо «24» отложило бы напоминание на
 * месяцы, и о неснятой роли никто бы не узнал.
 */
export function resolveAlertDelayMs(hours?: string | number | null): number {
  const parsed =
    typeof hours === "number" ? hours : Number.parseFloat(String(hours ?? "").trim());
  if (!Number.isFinite(parsed)) return ROLES_ALERT_DELAY_MS;
  const bounded = Math.min(
    Math.max(Math.floor(parsed), ROLES_ALERT_MIN_HOURS),
    ROLES_ALERT_MAX_HOURS
  );
  return bounded * 60 * 60 * 1000;
}

/** Цвет Embed напоминания — тот же янтарный, что у остальных предупреждений */
export const ROLES_ALERT_COLOR = 0xffb020;

/**
 * Основная роль подразделения — роль «АТК» в терминах задачи.
 *
 * Отдельная константа, а не CLAN_ROLE_IDS целиком: пинг нужен тогда, когда у
 * исключённого остался доступ к подразделению, а «Друг АТК» — это роль бывшего
 * бойца, и требовать её снятия нельзя (тогда уведомление приходило бы почти
 * на каждого исключённого и перестало бы что-либо значить).
 */
export const DIVISION_ROLE_ID = COMMON_ROLE_IDS.ATK_CORPS;

/* ------------------------------------------------------------------ */
/* Условия выборки                                                     */
/* ------------------------------------------------------------------ */

/**
 * Боец, как его отдаёт выборка кандидатов.
 *
 * Минимум полей: правила не должны зависеть от того, что ещё лежит в карточке.
 */
export type DismissedCandidate = {
  id: number;
  /** ФИО или позывной для текста уведомления */
  name: string;
  /** Позывной бойца — приоритетный источник для заголовка Embed */
  callsign?: string | null;
  discordId: string | null;
  status: string;
  dismissedAt: Date | string | null;
  rolesAlertSentAt: Date | string | null;
};

/** Момент времени в мс. null — значения нет или оно нечитаемо */
export function toMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Пора ли напоминать комсоставу про этого бойца.
 *
 * Одна функция на все условия выборки намеренно: если бы часть условий жила в
 * SQL, а часть — здесь, они разошлись бы, и ошибка «через 23 часа» или
 * «dismissedAt пуст — считается готовым» проявилась бы только в бою.
 *
 * Правила:
 *   - статус именно `dismissed`: активный боец роль имеет по праву;
 *   - `dismissedAt` задан и прошло не меньше 24 часов. Пустое значение
 *     означает «момент исключения неизвестен» — напоминать по карточке, у
 *     которой неизвестно даже начало отсчёта, нельзя;
 *   - `rolesAlertSentAt` не задан: напоминание отправляется однократно;
 *   - `discordId` задан и похож на снежинку — без него не запросить участника.
 */
export function isAlertDue(
  candidate: DismissedCandidate,
  now: Date = new Date(),
  delayMs: number = ROLES_ALERT_DELAY_MS
): boolean {
  if (candidate.status !== "dismissed") return false;
  if (candidate.rolesAlertSentAt) return false;
  if (!isSnowflake(candidate.discordId)) return false;

  const dismissed = toMillis(candidate.dismissedAt);
  if (dismissed === null) return false;

  const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : ROLES_ALERT_DELAY_MS;
  return now.getTime() - dismissed >= delay;
}

/** Discord ID — только цифры: строка «manual» и пустое значение не подходят */
export function isSnowflake(value: unknown): boolean {
  const id = String(value ?? "").trim();
  return /^\d{5,25}$/.test(id);
}

/** Отбор кандидатов из строк выборки (порядок сохраняется) */
export function selectAlertCandidates<T extends DismissedCandidate>(
  rows: readonly T[],
  now: Date = new Date(),
  delayMs: number = ROLES_ALERT_DELAY_MS
): T[] {
  return rows.filter((row) => isAlertDue(row, now, delayMs));
}

/* ------------------------------------------------------------------ */
/* Фиксация момента исключения                                         */
/* ------------------------------------------------------------------ */

/**
 * Поля отслеживания, которые нужно записать при смене статуса бойца.
 *
 * Одна функция на все точки смены статуса (решение по рапорту, возврат из
 * запаса, перевод в запас по рапорту). Если бы каждая точка проставляла поля
 * сама, рано или поздно одна из них забыла бы это сделать — и контроль ролей
 * молча не сработал бы именно для того способа исключения, который забыли.
 *
 * Повторное «исключение уже исключённого» не перезаписывает момент: модератор
 * может сохранить карточку с тем же статусом, и отсчёт 24 часов не должен
 * начинаться заново — иначе напоминание откладывалось бы правкой примечания.
 */
export function statusTrackingFields(
  nextStatus: string,
  previousStatus: string | null | undefined,
  now: Date = new Date()
): {
  dismissedAt?: Date | null;
  rolesAlertSentAt?: Date | null;
} {
  const was = String(previousStatus ?? "");
  const next = String(nextStatus ?? "");

  if (next === "dismissed") {
    if (was === "dismissed") return {};
    return { dismissedAt: now, rolesAlertSentAt: null };
  }

  // Возвращение в строй: и момент исключения, и признак отправленного
  // напоминания снимаются — при следующем исключении отсчёт начнётся заново.
  if (was === "dismissed") {
    return { dismissedAt: null, rolesAlertSentAt: null };
  }

  return {};
}

/* ------------------------------------------------------------------ */
/* Проверка ролей                                                      */
/* ------------------------------------------------------------------ */

/**
 * Какие роли подразделения всё ещё висят у участника.
 *
 * `memberRoles === null` означает «участника на сервере нет» (404 от Discord
 * или ошибка запроса) — это НЕ «роли сняты», но и не повод для пинга: человек
 * вышел с сервера, и роли ушли вместе с ним. Различие важно вынести наружу:
 * вызывающий код по нему решает, писать ли предупреждение или просто закрыть
 * бойца флагом.
 */
export function pendingDivisionRoles(
  memberRoles: readonly string[] | null,
  divisionRoleId: string = DIVISION_ROLE_ID
): string[] {
  if (!memberRoles) return [];
  const target = String(divisionRoleId || "").trim();
  if (!target) return [];
  return memberRoles.filter((id) => id === target);
}

/**
 * Остались ли у исключённого роли клана — для подробностей в журнале.
 *
 * Считается по всему справочнику CLAN_ROLE_IDS: командир, разбирающий
 * уведомление, должен видеть, что именно не снято, а не только «роль АТК».
 */
export function leftoverClanRoles(memberRoles: readonly string[] | null): string[] {
  if (!memberRoles) return [];
  return memberRoles.filter((id) => CLAN_ROLE_IDS.has(id));
}

/* ------------------------------------------------------------------ */
/* Уведомление                                                         */
/* ------------------------------------------------------------------ */

/** Отображаемое имя бойца: позывной, иначе ФИО, иначе заглушка */
export function candidateLabel(candidate: {
  name?: string | null;
  callsign?: string | null;
}): string {
  const callsign = String(candidate.callsign ?? "").trim();
  if (callsign) return callsign;
  const name = String(candidate.name ?? "").trim();
  return name || "неизвестный боец";
}

/**
 * Текст Embed для канала комсостава.
 *
 * Собирается отдельной функцией, а не в точке отправки: текст — единственное,
 * что увидит командир, и он должен проверяться тестом. Упоминание бойца идёт
 * через <@id> — Discord подсветит его в канале, и по ссылке сразу открывается
 * профиль, кому снимать роли.
 */
export function buildRolesAlertEmbed(
  candidate: DismissedCandidate,
  options: { divisionRoleId?: string; leftover?: readonly string[] } = {}
): DiscordEmbed {
  const label = candidateLabel(candidate);
  const discordId = String(candidate.discordId ?? "").trim();
  const leftover = options.leftover ?? [];

  const fields: { name: string; value: string; inline?: boolean }[] = [];
  const dismissed = toMillis(candidate.dismissedAt);
  if (dismissed !== null) {
    fields.push({
      name: "Исключён",
      value: `<t:${Math.floor(dismissed / 1000)}:R>`,
      inline: true,
    });
  }
  fields.push({
    name: "Осталось ролей подразделения",
    value: String(leftover.length),
    inline: true,
  });

  return {
    title: "⚠️ Контроль личного состава // Не сняты роли",
    description:
      `Боец **${label}** (<@${discordId}>) покинул подразделение более 24 часов назад, ` +
      `но до сих пор имеет роль **АТК** на сервере.\n` +
      `Пожалуйста, снимите роли подразделения.`,
    color: ROLES_ALERT_COLOR,
    fields,
    footer: { text: "Проверка ролей исключённых · напоминание отправляется однократно" },
  };
}

/** Текст записи в аудит-журнал (bot_logs) о неснятых ролях */
export function rolesAlertLogText(
  candidate: DismissedCandidate,
  leftover: readonly string[]
): string {
  const label = candidateLabel(candidate);
  const roles = leftover.length ? leftover.join(", ") : "—";
  return `${label} (Discord ${candidate.discordId}): роли подразделения не сняты более 24 часов. Роли: ${roles}`;
}