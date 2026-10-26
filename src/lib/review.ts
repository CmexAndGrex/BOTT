/**
 * Принятие решений по заявкам на вступление и рапортам.
 *
 * Модуль общий для двух точек входа: кнопки в Discord (bot.ts) и панель
 * модерации (/admin/reports). Иначе правило пришлось бы писать дважды, и
 * расхождение («через сайт зачисляет, через Discord нет») вылезло бы только
 * на боевой очереди. Здесь: одна функция решения и одна функция обновления
 * сообщения в Discord, поэтому кнопки и веб-интерфейс делают одно и то же.
 */
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { logs, members, recruitApplications, serviceReports } from "@/db/schema";
import {
  editChannelMessage,
  getGuildMemberRoles,
  getGuildRoles,
  mentionRole,
  sendDirectMessage,
  type DiscordActionRow,
  type DmResult,
} from "@/lib/discord";
import type { DiscordEmbed } from "@/lib/discord";
import { isDefaultRank, isProtectedFighter } from "@/lib/protected-profiles";
import {
  BERET_CODE,
  buildRecruitApplicationMessage,
  buildRecruitEmbed,
  buildReportEmbed,
  columnExamFor,
  examColumnTokens,
  findPositionSection,
  formatIsoDate,
  missingSectionExams,
  readReportPayload,
  isPendingReviewStatus,
  normalizeReviewStatus,
  reviewCustomId,
  type ExamItem,
  type ExamPayload,
  type PositionTransferPayload,
  type ReservePayload,
  type ReviewStatus,
  type RolePayload,
  type ShdsEntryPayload,
  type VacationPayload,
} from "@/lib/reports";
// Пароль — серверная часть (node:crypto), вынесена из reports.ts: тот модуль
// используется и в браузере, где crypto-модуль Node недоступен
import { generateTempPassword } from "@/lib/temp-password";
import {
  APPLICATION_KIND_RESERVE_RETURN,
  CORPS_ROLE_NAME,
  isCommandUnit,
  isEnlistmentRank,
  isUnassignedUnit,
  isUnit,
  MEMBER_STATUS,
  normalizePersonName,
  RECRUIT_RANK,
  UNITS,
  type Unit,
} from "@/lib/recruits";
// Из roles.ts берутся только константы и поиск роли по имени; resolveBeretRoleId
// подгружается динамически в applyReport — так исторический контракт модуля
// (лёгкий импорт в тестах) не меняется
import { COMMON_ROLE_IDS, findRoleIdByName, PRIVATE_ROLE_ID, RANK_ROLE_IDS } from "@/lib/roles";
import { statusTrackingFields } from "@/lib/roles-monitor";
import { isBeretPassed } from "@/lib/exams";
import {
  CHANNEL_ENV_FALLBACKS,
  ENLISTMENT_ROLE_SETTINGS,
  getSettings,
  RECRUIT_CHANNEL_SETTING,
  REPORTS_CHANNEL_SETTING,
  ROLE_ENV_FALLBACKS,
  ROLE_REQUESTS_CHANNEL_SETTING,
  unitRoleId,
  unitRoleName,
  VACATION_CHANNEL_SETTING,
} from "@/lib/settings";
// Сданные нормативы можно проставить правкой таблицы, а не рапортом через
// панель: без чтения отметок из листа ШДС зачёт берёта и требований ступени
// опирался бы только на электронные рапорты и пропускал ручные отметки.
import { examsFromSheet } from "@/lib/gsheets";

/* ------------------------------------------------------------------ */
/* Общий тип результата решения                                        */
/* ------------------------------------------------------------------ */

export type ReviewOutcome = {
  /** Решение принято и записано в БД (даже если синхронизация ниже упала) */
  ok: boolean;
  /** Короткий итог для Embed, журнала и ответа интерфейсу */
  message: string;
  error?: string;
};

/** Тексты ошибок вынесены отдельно: одно и то же слово в боте и в панели */
const ALREADY_DECIDED = "Решение по этой записи уже принято";
const NOT_FOUND = "Запись не найдена";

/* ------------------------------------------------------------------ */
/* Discord — «мягкий» внешний сервис                                   */
/* ------------------------------------------------------------------ */

/**
 * Единая формулировка для журнала: по ней ищут инциденты «зачисление упало
 * из-за Discord». Текст один на все вызовы, чтобы не было двух похожих фраз и
 * поиск по логам не делился на два варианта.
 */
const DISCORD_WARNING = "[review] Ошибка Discord, продолжаем зачисление:";

/**
 * Безопасный вызов Discord.
 *
 * Почему обёртка, а не try/catch на каждом вызове: Discord — внешний сервис, и
 * его отказ (400 Invalid Form Body, 404 Unknown Message, 500 у самого Discord,
 * обрыв сети) не имеет права отменять решение штаба. Порядок в этом модуле
 * жёсткий — сначала PostgreSQL и ШДС, и любое исключение отсюда долетело бы до
 * catch вызывающей функции, превратив уже принятое решение в «ошибку
 * зачисления». Ошибка только журналируется, а вызывающий получает fallback.
 */
/**
 * Детальный разбор 400 Invalid Form Body.
 *
 * Discord кладёт в тело ответа путь до конкретного невалидного поля
 * (`embeds.0.fields.2.value`). Без этой записи в журнале остаётся только
 * «Invalid Form Body», и причину приходится угадывать по коду. Логируем
 * исключительно 400/50035: 404 и 429 — ожидаемые ответы (удалённое сообщение,
 * лимит), и засорять ими журнал незачем.
 */
function logDiscord400(err: unknown): void {
  const status = (err as { status?: unknown })?.status;
  const code = (err as { code?: unknown })?.code;
  const isFormError = status === 400 || code === 50035;
  if (!isFormError) return;

  console.error(
    "[DISCORD_400_DETAIL]",
    JSON.stringify(
      (err as { rawError?: unknown })?.rawError ??
        (err as { data?: unknown })?.data ??
        (err as { response?: { data?: unknown } })?.response?.data ??
        err,
      null,
      2
    )
  );
}

async function safeDiscord<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    logDiscord400(err);
    console.warn(DISCORD_WARNING, label, err);
    return fallback;
  }
}

/**
 * Реальный ID Discord (снежинка) или пустая строка.
 *
 * ID берутся из настроек панели и из БД и подставляются прямо в путь запроса
 * `/channels/:id/messages`. Значение-плейсхолдер («:id», «undefined», «123/../..»),
 * обрезанная строка или «не привязан» — это НЕ ID: сетевой запрос по такому
 * значению не отправляется вовсе (Discord ответил бы 400 «Invalid Form Body»),
 * а вызывающий код получает «не отправлено» вместо исключения.
 */
export function realDiscordId(value: string | null | undefined): string {
  const id = String(value ?? "").trim();
  return /^\d{5,25}$/.test(id) ? id : "";
}

/** Тип строки бойца: нужен там, где решение работает с уже существующей карточкой */
type MemberRow = typeof members.$inferSelect;

/**
 * Итог поиска бойца по позывному при одобрении заявки.
 *
 * Три состояния вместо «нашли/не нашли»: повторная попытка и чужой позывной —
 * принципиально разные случаи. Первый надо довести до конца, второй — отклонить
 * (иначе одобрение заявки перехватило бы чужой действующий аккаунт).
 */
type CallsignLookup =
  | { kind: "free" }
  | { kind: "retry"; member: MemberRow }
  | { kind: "taken" };

/**
 * Чей позывной уже занят при одобрении заявки.
 *
 * Зачем это нужно. Зачисление — не одна транзакция: сначала INSERT бойца, потом
 * решение в БД, потом Discord и синхронизация. Если на полпути что-то падает
 * (например, Discord отвечает 400 на отправку сообщения или запись в ШДС), боец
 * уже существует, а заявка осталась `pending`. Повторный клик офицера в этом
 * случае упирался в CALLSIGN_TAKEN, и зачисление нельзя было завершить вообще:
 * штаб должен был вручную править позывной, порождая дубль в табеле.
 *
 * Здесь такая карточка опознаётся как «созданная этой же заявкой» и
 * подхватывается. Признаки намеренно узкие: роль новобранца, статус «в строю»,
 * отсутствие подразделения и метка рассмотрения, оставленная предыдущей
 * попыткой. Действующий боец с тем же позывным под них не попадает — для него
 * сохраняется прежний отказ CALLSIGN_TAKEN.
 */
async function lookupCallsignForApplication(
  application: typeof recruitApplications.$inferSelect,
  callsign: string
): Promise<CallsignLookup> {
  const [taken] = await db.select().from(members).where(eq(members.callsign, callsign));
  if (!taken) return { kind: "free" };

  // Связь с заявкой записалась в прошлый раз — это точно та же попытка
  if (application.memberId === taken.id) return { kind: "retry", member: taken };

  const reviewed = Boolean(taken.applicationData?.reviewedAt && taken.applicationData?.reviewedBy);
  const freshRecruit =
    taken.role === "recruit" && taken.status === MEMBER_STATUS.ACTIVE && !taken.unit;
  const sameDiscord =
    Boolean(application.discordId) && application.discordId === taken.discordId;

  // Совпадение Discord ID подтверждает, что карточка заведена этой заявкой; при
  // заявке без Discord остаётся признак «свежая карточка новобранца без места»
  if (freshRecruit && reviewed && (sameDiscord || !application.discordId)) {
    return { kind: "retry", member: taken };
  }

  return { kind: "taken" };
}

/**
 * Поиск уже существующего бойца для одобряемой заявки.
 *
 * Зачем: /apply создаёт карточку в `pending`, а синхронизация rs-red.com и
 * бот заводят бойцов вообще без заявки. Без этой проверки повторное одобрение
 * или заявка от уже служащего человека создавала ВТОРУЮ строку в
 * division_members — дубль в составе и в табеле ШДС.
 *
 * Порядок поиска задан требованием: сначала Discord ID (он уникален), затем
 * нормализованный ФИО (normalizePersonName: «Розгов А.В.» == «Розгов А. В.»,
 * «ё» → «е», латинские двойники в инициалах). Позывной здесь не участвует:
 * человек мог его сменить, а ФИО осталось.
 */
/**
 * Свободен ли позывной; при занятости возвращает пустую строку.
 *
 * Уникальный индекс members.callsign не пропустит второй такой же логин, и
 * UPDATE упал бы 500-й уже после решения штаба. Здесь это выясняется заранее:
 * у строки из синхронизации позывного может не быть вовсе, и ей назначается
 * позывной из заявки — если он ещё ни за кем не закреплён.
 */
async function firstFreeCallsign(callsign: string, forMemberId: number): Promise<string> {
  const [taken] = await db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.callsign, callsign));
  return !taken || taken.id === forMemberId ? callsign : "";
}

async function findExistingMemberForApplication(
  application: typeof recruitApplications.$inferSelect
): Promise<MemberRow | null> {
  /**
   * Карточка, уже связанная с этой заявкой, дублем не считается: её создал
   * /apply в статусе pending, и её доводит отдельная ветка «повтор/завершение»
   * (lookupCallsignForApplication) — с выдачей временного пароля. Если бы мы
   * вернули её здесь, зачисление пошло бы по пути «боец уже служит» и не
   * выдало бы доступ.
   */
  const skipId = application.memberId;

  const discordId = (application.discordId || "").trim();
  if (discordId && /^\d{5,25}$/.test(discordId)) {
    const [byDiscord] = await db
      .select()
      .from(members)
      .where(eq(members.discordId, discordId));
    if (byDiscord && byDiscord.id !== skipId) return byDiscord;
  }

  const nameKey = normalizePersonName(application.fullName);
  if (!nameKey) return null;

  const all = await db.select().from(members);
  return (
    all.find(
      (row) => row.id !== skipId && normalizePersonName(row.name) === nameKey
    ) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* Заявка на вступление                                                */
/* ------------------------------------------------------------------ */

/** Ссылка на вход в панель для ЛС рекруту */
function panelLoginUrl(): string {
  const explicit = (process.env.PANEL_URL || "").trim().replace(/\/+$/, "");
  return explicit ? `${explicit}/login` : "https://atk-red.site/login";
}

/** Текст ЛС рекруту: логин, временный пароль и ссылка на вход */
export function recruitDmText(callsign: string, password: string): string {
  return [
    "🎖️ **Поздравляем с принятием в ATK RED!**",
    "",
    "Ваша заявка на вступление одобрена.",
    "",
    `Логин: \`${callsign}\``,
    `Временный пароль: \`${password}\``,
    "",
    `Вход в личный кабинет: ${panelLoginUrl()}`,
    "",
    "Смените пароль сразу после входа в кабинете: временный действует до первой смены.",
  ].join("\n");
}

/**
 * Подпись бойца для колонки «Фамилия, инициалы» в ШДС.
 *
 * Требование зачисления: в таблицу пишется ФИО, а не позывной — позывной
 * остаётся логином. У карточек синхронизации rs-red.com ФИО может быть не
 * заполнено (там лежит односложное имя), тогда откатываемся на позывной:
 * пустая ячейка имени сделала бы бойца ненаходимым на листе.
 */
function sheetNameFor(member: { name: string; callsign: string | null }): string {
  const name = (member.name || "").trim();
  const callsign = (member.callsign || "").trim();
  // ФИО содержит пробел («Иванов И.И.»); одиночное слово — это позывной
  if (name && name.includes(" ")) return name;
  return callsign || name;
}

/**
 * Выдача ролей Discord при зачислении новобранца.
 *
 * Требование: одобренный кандидат получает три роли —
 *   1. «Артиллерийско-Танковый Корпус» (основная роль корпуса);
 *   2. роль своего подразделения («Танковая рота» / «Артиллерийский дивизион»);
 *   3. роль начального звания («Рядовой» / «Курсант»).
 *
 * Порядок разрешения ID роли одинаков для всех трёх: настройка панели →
 * поиск по имени на сервере → «зашитая» константа только там, где она есть
 * (роль корпуса и «Рядовой» — официальные роли клана). Так зачисление работает
 * и на установке без настроек, и на сервере, где ID ролей другие.
 *
 * Ошибки Discord не пробрасываются: решение штаба уже записано в БД, а роль
 * повторно выдаст кнопка в панели или фоновая сверка ролей. Итог возвращается
 * текстом и попадает в ответ офицеру и в журнал.
 */
export async function grantEnlistmentRoles(
  discordId: string | null,
  unit: Unit | null,
  rank: string
): Promise<string> {
  if (!discordId) return "роли не выданы: у бойца нет Discord ID";

  try {
    const map = await getSettings();
    const token =
      (map.get("discord_token") || "").trim() || (process.env.DISCORD_BOT_TOKEN || "").trim();
    if (!token) return "роли не выданы: не задан токен бота";

    const guildId = await resolveGuildId((map.get("guild_id") || "").trim());
    if (!guildId) return "роли не выданы: сервер Discord не определён (guild_id)";

    const { addGuildMemberRole, getGuildRoles } = await import("@/lib/discord");
    // Список ролей нужен только как запасной путь: если все три ID заданы в
    // настройках, лишний запрос к Discord не делается
    const configuredCorps = realDiscordId(map.get(ENLISTMENT_ROLE_SETTINGS.corps));
    const configuredUnit = unit ? realDiscordId(unitRoleId(unit, map)) : "";
    const configuredRank =
      realDiscordId(map.get(`rank_role_${rank}`)) ||
      realDiscordId(map.get(ENLISTMENT_ROLE_SETTINGS.rank));
    const needsLookup =
      !configuredCorps || (unit && !configuredUnit) || !configuredRank;
    const roles = needsLookup ? await getGuildRoles(guildId) : [];

    const roleIds: { roleId: string; label: string }[] = [];

    // 1. Основная роль корпуса
    const corpsId =
      configuredCorps ||
      findRoleIdByName(roles, CORPS_ROLE_NAME) ||
      COMMON_ROLE_IDS.ATK_CORPS;
    if (corpsId) roleIds.push({ roleId: corpsId, label: "корпус" });

    // 2. Роль подразделения — только когда подразделение известно
    if (unit) {
      const unitId = configuredUnit || findRoleIdByName(roles, unitRoleName(unit));
      if (unitId) roleIds.push({ roleId: unitId, label: unit });
    }

    // 3. Роль начального звания
    const rankId =
      configuredRank ||
      findRoleIdByName(roles, rank) ||
      RANK_ROLE_IDS[rank] ||
      (rank === RECRUIT_RANK ? PRIVATE_ROLE_ID : "");
    if (rankId) roleIds.push({ roleId: rankId, label: rank });

    if (roleIds.length === 0) return "роли не выданы: ни одна роль не найдена на сервере";

    const granted: string[] = [];
    const failed: string[] = [];
    for (const { roleId, label } of roleIds) {
      try {
        await addGuildMemberRole(guildId, discordId, roleId);
        granted.push(label);
      } catch (e) {
        // Одна роль не должна отменять остальные: роли выдаются по очереди
        failed.push(`${label} (${e instanceof Error ? e.message : String(e)})`);
        console.warn(DISCORD_WARNING, `роль «${label}» не выдана`, e);
      }
    }

    if (granted.length === 0) {
      return `роли не выданы: ${failed.join("; ")}`;
    }
    return failed.length
      ? `выданы роли: ${granted.join(", ")}; не выданы: ${failed.join("; ")}`
      : `выданы роли: ${granted.join(", ")}`;
  } catch (e) {
    console.warn(DISCORD_WARNING, "роли при зачислении не выданы", e);
    return `роли не выданы: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Запись бойца в Google Таблицу (ШДС) при зачислении.
 *
 * Шаг намеренно «мягкий»: он идёт ПОСЛЕ записи в PostgreSQL, и падение Google
 * API не имеет права отменять уже принятое решение штаба. Ошибка возвращается
 * текстом в итог решения и попадает в журнал — штаб повторит синхронизацию из
 * панели, где для этого есть отдельное действие.
 *
 * Подразделение приходит из формы заявки, поэтому лист известен заранее. Пусто
 * оно только у заявок Google-формы и записей до появления поля: тогда строку
 * заводит штаб вручную, и мы говорим об этом прямо, а не молчим.
 */
async function writeMemberToShds(memberId: number, callsign: string): Promise<string> {
  try {
    const [member] = await db.select().from(members).where(eq(members.id, memberId));
    if (!member) return "боец для записи в ШДС не найден";
    if (!member.unit) return "подразделение не назначено — строку в ШДС заведёт штаб";
    // Командование корпуса ведётся листом «Командование АТК», а не листами
    // подразделений: resolveLayout такое название не знает, и «Добавление в
    // ШДС» упало бы с ошибкой на пустом месте.
    if (isCommandUnit(member.unit)) {
      return "служба в командовании корпуса — строка ведётся на листе «Командование АТК»";
    }

    const { applyShdsRequest, SHDS_ACTIONS } = await import("@/lib/gsheets");
    const result = await applyShdsRequest({
      raw: `Зачисление из панели модерации (${callsign})`,
      isVacation: false,
      vacationRemove: false,
      shdsAction: SHDS_ACTIONS.ADD,
      // Имя листа = подразделение бойца (настроенное имя листа — в getSheet)
      unit: member.unit,
      // В колонку «Фамилия, инициалы» пишется ФИО бойца, а не позывной
      userName: sheetNameFor(member),
      rank: member.rank || RECRUIT_RANK,
      steamId: "",
      discordId: realDiscordId(member.discordId),
      отделение: "",
      должность: member.post || "",
      exams: [],
      grade: "",
      examiner: "",
      rolesGive: "",
      rolesRemove: "",
      vacationDates: "",
      reason: "Одобрение заявки на вступление",
    });

    return result.ok ? result.message : `ШДС: ошибка (${result.error})`;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[review] Запись в ШДС при зачислении не удалась:", e);
    return `ШДС: ошибка (${error})`;
  }
}

/**
 * Идемпотентная запись бойца в ШДС.
 *
 * Повторный проход по заявке (см. lookupCallsignForApplication) не должен
 * добавлять ВТОРУЮ строку в таблицу: боец с прежней попытки там уже может
 * стоять, и «Добавление в ШДС» заняло бы ещё одну строку «Вакант», оставив
 * первую с его именем. Поэтому сначала ищем бойца на листе подразделения —
 * findNameRow ищет ровно ту же строку по колонке имени, что и сценарий
 * добавления, — и только если его там нет, пишем.
 *
 * `extraNames` — дополнительные варианты имени для поиска. Нужны при слиянии
 * с существующей карточкой: в таблице боец подписан ФИО из заявки, а в
 * карточке мог остаться прежний позывной. Без них «Добавление в ШДС» заняло бы
 * вторую строку «Вакант», оставив первую с тем же человеком.
 */
async function ensureShdsRowForMember(
  memberId: number,
  callsign: string,
  extraNames: string[] = []
): Promise<string> {
  try {
    const [member] = await db.select().from(members).where(eq(members.id, memberId));
    if (!member?.unit) return "подразделение не назначено — строку в ШДС заведёт штаб";

    const { findNameRow, getSheet, resolveLayout } = await import("@/lib/gsheets");
    const sheet = await getSheet(member.unit);
    const layout = resolveLayout(member.unit);
    await sheet.loadCells();

    const names = [member.callsign, member.name, sheetNameFor(member), callsign, ...extraNames].filter(
      (n): n is string => Boolean(n && n.trim())
    );
    for (const name of names) {
      if (findNameRow(sheet, layout, name)) {
        return `боец уже стоит в листе «${sheet.title}» — повторная запись не нужна`;
      }
    }
  } catch (e) {
    // Проверка не удалась — не повод отказываться от записи: сценарий добавления
    // сам найдёт свободную строку, а расхождение штаб увидит по итогу решения
    console.warn("[review] Не удалось проверить строку бойца в ШДС:", e);
  }

  return writeMemberToShds(memberId, callsign);
}

export type ApproveRecruitResult = ReviewOutcome & {
  memberId?: number;
  /** Позывной (он же логин) зачисленного: показывается модератору вместе с паролем */
  callsign?: string;
  /** true — рекрут получил ЛС с доступом (false: закрыты ЛС либо нет Discord ID) */
  dmDelivered?: boolean;
  /** Временный пароль: возвращается офицеру, если ЛС не доставлено */
  tempPassword?: string;
};

/**
 * Решение по заявке на вступление с учётом её вида.
 *
 * Единая точка входа для кнопок Discord и панели модерации: обе обязаны
 * принимать одинаковое решение, а вид заявки («Новобранец» или «Возврат из
 * запаса») хранится в БД. Выбор вида живёт здесь, а не в каждом вызывающем
 * коде, — иначе панель и бот разошлись бы, и заявка на возврат зачислялась бы
 * как новый боец.
 */
export async function approveRecruitByKind(
  applicationId: number,
  reviewer: string,
  /**
   * Discord ID модератора, если решение принято кнопкой в канале. Нужен,
   * чтобы обновлённое сообщение содержало «Одобрено модератором @ник»
   * (требование). Из веб-панели значения нет — подписываем позывным.
   */
  reviewerDiscordId?: string | null
): Promise<ApproveRecruitResult> {
  const [application] = await db
    .select({ kind: recruitApplications.kind })
    .from(recruitApplications)
    .where(eq(recruitApplications.id, applicationId));

  if (!application) return { ok: false, message: NOT_FOUND, error: NOT_FOUND };

  return application.kind === APPLICATION_KIND_RESERVE_RETURN
    ? approveReserveReturn(applicationId, reviewer, reviewerDiscordId)
    : approveRecruitApplication(applicationId, reviewer, reviewerDiscordId);
}

/**
 * Одобрение возврата из запаса.
 *
 * Отличается от зачисления принципиально: бойца не создают заново, а
 * восстанавливают. Порядок шагов намеренный — сначала строка в Google Таблице
 * (её двигает returnFromReserve: лист «Запас» → свободная строка «Вакант»
 * подразделения, роль «Запас» и прежние роли из колонки AI; у записей старого
 * формата роли лежат в V), затем запись в базе панели.
 *
 * Почему не наоборот: перенос строки может отказать (боец не найден на листе
 * «Запас» или в подразделении кончились свободные строки), и тогда лучше
 * оставить бойца в запасе, чем «восстановить» его в панели при отсутствующей
 * строке в ШДС — расхождение пришлось бы разбирать вручную.
 *
 * Роли Discord возвращает бот: он один владеет сервером ролей и умеет снять
 * «Запас», а сохранённый список лежит в колонке AI листа «Запас» (его читает
 * returnFromReserve; у записей старого формата — в колонке V). Здесь
 * возвращается только отчёт о результате.
 */
export async function approveReserveReturn(
  applicationId: number,
  reviewer: string,
  reviewerDiscordId?: string | null
): Promise<ApproveRecruitResult> {
  const [application] = await db
    .select()
    .from(recruitApplications)
    .where(eq(recruitApplications.id, applicationId));

  if (!application) return { ok: false, message: NOT_FOUND, error: NOT_FOUND };
  if (!isPendingReviewStatus(application.status)) {
    return { ok: false, message: ALREADY_DECIDED, error: ALREADY_DECIDED };
  }

  // ФИО — ключ поиска строки на листе «Запас»: без него восстановление
  // невозможно, и выдумывать его по позывному нельзя (за время службы позывной
  // могли сменить, а в запасе строка подписана прежним ФИО)
  const fullName = (application.fullName || "").trim();
  if (!fullName) {
    return {
      ok: false,
      message: "У заявки нет ФИО — строку в «Запасе» найти нечем",
      error: "EMPTY_FULL_NAME",
    };
  }

  // Боец в панели ищется по ФИО или позывному: за время запаса его карточка
  // сохраняется, поэтому нужен именно тот же человек, а не однофамилец.
  // Сравнение — через normalizePersonName: «Розгов А.В.» и «Розгов А. В.»
  // это одна и та же строка, и точное сравнение строк не находило бы её,
  // предлагая «восстановить карточку» тому, кто уже есть в составе.
  const candidates = await db.select().from(members);
  const nameKey = normalizePersonName(fullName);
  const member = candidates.find((row) => {
    const rowName = normalizePersonName(row.name);
    const rowCallsign = normalizePersonName(row.callsign);
    return (nameKey !== "" && rowName === nameKey) || (nameKey !== "" && rowCallsign === nameKey);
  });

  if (!member) {
    return {
      ok: false,
      message: `Боец «${fullName}» не найден в составе — восстановите карточку до возврата`,
      error: "MEMBER_NOT_FOUND",
    };
  }

  try {
    /**
     * Подразделение возврата.
     *
     * Приоритет: поле карточки → выбор кандидата в форме заявки. Второй
     * источник нужен бойцам, у которых unit не заполнен (строки синхронизации
     * rs-red.com): возвращающийся сам указывает подразделение в форме, и
     * строка должна вернуться именно туда, а не «куда-нибудь».
     */
    const restoredUnit = isUnit(member.unit)
      ? member.unit
      : isUnit(application.unit)
        ? application.unit
        : member.unit || undefined;

    // 1. Google Таблица: строка целиком (с отметками экзаменов) возвращается в
    //    подразделение, лист «Запас» очищается, прежние роли читаются из колонки AI
    const { returnFromReserve } = await import("@/lib/reserve");
    const sheet = await returnFromReserve({
      userName: member.callsign || member.name,
      unit: restoredUnit,
      rank: member.rank,
      discordId: realDiscordId(member.discordId),
      post: member.post || "",
    });

    if (!sheet.ok) {
      // Решение не фиксируем: строка осталась в запасе, состояние согласовано,
      // и модератор повторит попытку после устранения причины
      return {
        ok: false,
        message: `Возврат из запаса не выполнен: ${sheet.error}`,
        error: "SHEET_FAILED",
      };
    }

    // 2. База панели: боец снова в строю (active = true), кабинет открывается
    const [updated] = await db
      .update(members)
      .set({
        active: true,
        status: MEMBER_STATUS.ACTIVE,
        // Подразделение заполняется выбором из формы, если карточка его не имела:
        // иначе поле осталось бы пустым и следующий рапорт снова упирался бы в
        // «подразделение не назначено»
        ...(isUnit(restoredUnit) && !isUnit(member.unit) ? { unit: restoredUnit } : {}),
        // Возврат в строй закрывает контроль ролей: момент исключения и признак
        // отправленного напоминания снимаются, при следующем исключении отсчёт
        // начнётся заново.
        ...statusTrackingFields(MEMBER_STATUS.ACTIVE, member.status),
        // Смена версии токена не нужна: боец возвращается, а не исключается
        updatedAt: new Date(),
      })
      .where(eq(members.id, member.id))
      .returning();

    // 3. Заявка закрывается с итогом — панель и Embed показывают результат
    const [decided] = await db
      .update(recruitApplications)
      .set({
        status: "approved",
        memberId: member.id,
        reviewedBy: reviewer,
        updatedAt: new Date(),
      })
      .where(eq(recruitApplications.id, applicationId))
      .returning();

    /**
     * Роли Discord: снятие «Запас» и возврат сохранённых ролей выполняет бот —
     * он единственный владеет шлюзом сервера. Здесь только фиксируем, что
     * список прежних ролей найден, чтобы штаб видел ожидаемый итог.
     */
    const rolesRestored = (sheet.roles?.length ?? 0) > 0;
    const outcome = rolesRestored
      ? `Строку вернули в подразделение, роль «Запас» снимает бот, прежних ролей к возврату: ${sheet.roles?.length}`
      : "Строку вернули в подразделение; сохранённых ролей в «Запасе» не было — выдайте их в канале запросов ролей";

    await db.insert(logs).values({
      category: "edit",
      author: reviewer || "Штаб",
      action: `одобрил возврат из запаса ${fullName}`,
      details: {
        "Заявка": `#${applicationId}`,
        "ФИО": fullName,
        "Позывной": member.callsign || "—",
        "Подразделение": member.unit || "не назначено",
        "Лист ШДС": sheet.message,
        "Роли": outcome,
      },
      kind: "system",
      title: "Возврат из запаса",
      detail: `${fullName} восстановлен: ${sheet.message}`,
      ok: true,
    });

    if (decided) {
      await refreshRecruitMessage(
        { ...decided, status: "approved" },
        outcome,
        reviewerDiscordId
      );
    }

    return {
      ok: true,
      message: `${fullName} возвращён из запаса. ${outcome}`,
      memberId: updated?.id ?? member.id,
      callsign: member.callsign || member.name,
      dmDelivered: false,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[review] Ошибка возврата из запаса:", e);
    return { ok: false, message: `Ошибка возврата из запаса: ${error}`, error };
  }
}

/**
 * Одобрение заявки: создаёт бойца, выдаёт доступ и уведомляет рекрута в ЛС.
 *
 * Порядок важен: сначала фиксируем решение и создаём аккаунт (необратимая
 * часть), затем уведомляем и правим сообщение. Если ЛС закрыто, решение
 * остаётся в силе, а пароль возвращается вызывающему — офицер продиктует сам.
 *
 * Повторный клик по «Одобрить» не падает с CALLSIGN_TAKEN, а ЗАВЕРШАЕТ начатое:
 * боец с таким позывным уже может существовать из-за упавшей предыдущей попытки
 * (Discord ответил 400, ШДС был недоступен), и офицер вправе просто нажать
 * кнопку ещё раз. Разбор — в lookupCallsignForApplication; действующий боец с
 * чужим позывным по-прежнему получает отказ.
 */
export async function approveRecruitApplication(
  applicationId: number,
  reviewer: string,
  reviewerDiscordId?: string | null
): Promise<ApproveRecruitResult> {
  const [application] = await db
    .select()
    .from(recruitApplications)
    .where(eq(recruitApplications.id, applicationId));

  if (!application) return { ok: false, message: NOT_FOUND, error: NOT_FOUND };
  if (!isPendingReviewStatus(application.status)) {
    return { ok: false, message: ALREADY_DECIDED, error: ALREADY_DECIDED };
  }

  const callsign = (application.callsign || "").trim();
  if (!callsign) {
    return { ok: false, message: "У заявки нет позывного", error: "EMPTY_CALLSIGN" };
  }

  /**
   * Подразделение, выбранное кандидатом в форме.
   *
   * Именно оно определяет лист ШДС (shds_sheet_tank / shds_sheet_art) и роль
   * Discord. У заявок Google-формы и записей до появления поля выбор пуст —
   * тогда подразделение остаётся за штабом, как раньше.
   */
  const chosenUnit: Unit | null = isUnit(application.unit) ? application.unit : null;

  /**
   * Боец уже есть в составе — по Discord ID или по нормализованному ФИО.
   *
   * Проверка стоит ДО разбора позывного: иначе заявка человека, который уже
   * служит (его завела синхронизация rs-red.com или бот) упиралась бы в
   * CALLSIGN_TAKEN, и модератор правил бы позывной руками, порождая дубль.
   * Здесь совпадение означает «доводим существующую карточку», а не «создаём».
   */
  const existingMember = await findExistingMemberForApplication(application);

  // Позывной — это логин: занятый позывной создал бы дубль в табеле ШДС.
  // Если боец уже найден по discord_id/ФИО, чужой позывной не помеха.
  const lookup: CallsignLookup = existingMember
    ? { kind: "free" }
    : await lookupCallsignForApplication(application, callsign);
  if (lookup.kind === "taken") {
    return {
      ok: false,
      message: `Позывной «${callsign}» уже занят — поправьте его в панели модерации`,
      error: "CALLSIGN_TAKEN",
    };
  }

  const isRetry = lookup.kind === "retry";

  /**
   * Логин зачисленного. Для новой карточки это позывной из заявки, но если
   * боец уже был в составе, его логин — ЕГО позывной: выдав в ЛС чужой/новый,
   * офицер отправил бы бойца входить не туда.
   */
  let loginName = callsign;

  /**
   * Временный пароль.
   *
   * При повторной попытке он ВСЕГДА перевыпускается: исходный открытый текст
   * жил только в памяти упавшего запроса и уже потерян. Оставить хеш прежним
   * означало бы бойца без входа — ни он, ни офицер пароля не знают. Прежний
   * временный пароль при этом становится недействительным, и офицер об этом
   * предупреждается в итоге решения: если прошлый проход успел-таки отправить
   * ЛС, бойцу нужно сообщить актуальный.
   */
  let tempPassword = "";
  let passwordNote = "";
  /** Итог записи в ШДС: он виден офицеру в ответе решения и в журнале */
  let shdsOutcome = "";

  try {
    let memberId: number;
    /** Свежая строка заявки после фиксации решения: из неё строится Embed */
    let decided: typeof recruitApplications.$inferSelect | null = null;

    if (isRetry) {
      memberId = lookup.member.id;
      tempPassword = generateTempPassword();
      /**
       * Карточка из /apply уже существует, но стоит в `pending`: без перевода
       * в active выданный пароль бесполезен — вход в кабинет закрыт до
       * одобрения. Повторная попытка после сбоя просто подтвердит active.
       */
      await db
        .update(members)
        .set({
          passwordHash: await bcrypt.hash(tempPassword, 10),
          status: MEMBER_STATUS.ACTIVE,
          active: true,
          role: lookup.member.role === "recruit" ? "member" : lookup.member.role,
          /**
           * Подразделение и звание доводятся до состояния «зачислен».
           *
           * Карточка из /apply уже содержит unit из формы, но заявка могла
           * быть подана до появления поля (или через Google-форму). Пустое
           * подразделение здесь заполняется выбором из заявки, если он есть.
           * Звание «Курсант» (значение по умолчанию при создании рапорта)
           * меняется на «Рядовой» — именно это звание записывается в ШДС и
           * висит ролью на сервере.
           *
           * Защищённая карточка командования (Иванов И. А.): заявка не имеет
           * права затирать звание и подразделение дефолтами («Курсант»,
           * «Рядовой», подразделение из формы). Уже сохранённые значения
           * (в том числе «Капитан» и смена должности приказом) остаются как
           * есть — заявка их не трогает вовсе.
           */
          ...(isProtectedFighter(lookup.member)
            ? isDefaultRank(lookup.member.rank)
              ? { rank: RECRUIT_RANK }
              : {}
            : {
                ...(chosenUnit && isUnassignedUnit(lookup.member.unit) ? { unit: chosenUnit } : {}),
                rank: application.rank || lookup.member.rank || RECRUIT_RANK,
              }),
          steamId: application.steamId || lookup.member.steamId,
          applicationData: {
            ...(lookup.member.applicationData ?? {}),
            reviewedBy: reviewer,
            reviewedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(members.id, memberId));
      passwordNote = ", временный пароль перевыпущен";
      console.warn(
        `[review] Повторное одобрение заявки #${applicationId}: боец «${callsign}» уже создан (id ${memberId}), доводим процедуру`
      );

      // Заявка закрывается тем же итогом, что и при первом проходе: иначе она
      // осталась бы в очереди модерации навсегда
      [decided] = await db
        .update(recruitApplications)
        .set({ status: "approved", memberId, reviewedBy: reviewer, updatedAt: new Date() })
        .where(eq(recruitApplications.id, applicationId))
        .returning();

      // Прогоняем и запись в ШДС: прошлая попытка могла не дойти до неё, а
      // «зачислен без строки в таблице» — то самое расхождение, которое штаб
      // потом разбирает вручную
      shdsOutcome = await ensureShdsRowForMember(memberId, callsign);
    } else {
      /**
       * Боец уже есть в составе (Discord ID или ФИО совпали).
       *
       * Новую строку НЕ создаём: иначе в division_members и в табеле ШДС
       * появился бы дубль. Вместо этого доводим существующую карточку до
       * состояния «служит»: статус active (отпуск сохраняем), discord_id из
       * заявки, доступ в кабинет. Пароль перевыпускается только если у
       * карточки его нет вовсе (строки синхронизации rs-red.com) — иначе
       * одобрение молча сменило бы действующему бойцу рабочий пароль.
       */
      const existing = existingMember;

      if (existing) {
        memberId = existing.id;
        /**
         * Защищённая карточка командования: заявка не затирает звание и
         * подразделение дефолтами. Сохранённое значение (в том числе
         * повышенное приказом) остаётся; поля трогает только явная правка.
         */
        const protectedCard = isProtectedFighter(existing);

        /**
         * Логин у существующей карточки. У строк синхронизации rs-red.com
         * позывного нет — тогда берём его из заявки, но только если он
         * свободен: уникальный индекс callsign иначе уронил бы одобрение.
         */
        const assignCallsign =
          existing.callsign || (await firstFreeCallsign(callsign, existing.id));
        loginName = assignCallsign || callsign;

        const needsPassword = !existing.passwordHash;
        if (needsPassword) {
          tempPassword = generateTempPassword();
          passwordNote = ", временный пароль выдан (доступ появился впервые)";
        }

        const discordFromApplication = realDiscordId(application.discordId);
        const currentStatus = String(existing.status);
        // Отпуск — действующий статус: одобрение заявки не выводит из отпуска
        const keepVacation =
          currentStatus === MEMBER_STATUS.VACATION || existing.vacation === true;

        /**
         * Карточка-заявка (pending), созданная формой /apply, при слиянии
         * становится лишней: настоящий боец — `existing`. Гасим её, иначе она
         * навсегда останется в очереди модерации и в табеле пустой строкой.
         * Делаем это ДО UPDATE основной карточки: освобождаем уникальный
         * позывной, который иначе конфликтует с назначаемым логином.
         */
        const pendingCardId = application.memberId;
        if (pendingCardId && pendingCardId !== existing.id) {
          const [pendingCard] = await db
            .select({ applicationData: members.applicationData })
            .from(members)
            .where(eq(members.id, pendingCardId));

          await db
            .update(members)
            .set({
              status: MEMBER_STATUS.DISMISSED,
              active: false,
              // Логин освобождаем: он переезжает на настоящую карточку
              callsign: null,
              applicationData: {
                ...(pendingCard?.applicationData ?? {}),
                decisionReason: `Дубль: заявка объединена с карточкой #${existing.id}`,
                reviewedAt: new Date().toISOString(),
              },
              // Версия токена отзывает сессии лишней карточки
              memberTokenVersion: sql`${members.memberTokenVersion} + 1` as unknown as number,
              updatedAt: new Date(),
            })
            .where(eq(members.id, pendingCardId));
        }

        await db
          .update(members)
          .set({
            status: keepVacation ? MEMBER_STATUS.VACATION : MEMBER_STATUS.ACTIVE,
            active: true,
            /**
             * Возврат в строй закрывает контроль снятия ролей: момент
             * исключения и признак отправленного напоминания снимаются, иначе
             * задача контроля продолжила бы пинговать комсостав по бойцу,
             * который снова служит.
             */
            ...statusTrackingFields(
              keepVacation ? MEMBER_STATUS.VACATION : MEMBER_STATUS.ACTIVE,
              existing.status
            ),
            // Discord ID из заявки — актуальный: кандидат мог привязать новый
            discordId: discordFromApplication || existing.discordId,
            /**
             * Подразделение: выбор из заявки заполняет пустое поле карточки.
             *
             * Существующий unit не перезаписываем — боец мог быть переведён в
             * другое подразделение приказом, и заявка не должна его «вернуть».
             * А вот пустое/«не назначено» поле заполняется выбором кандидата:
             * от него зависит лист ШДС при зачислении.
             */
            /**
             * Подразделение и звание: для защищённой карточки командования
             * (Иванов И. А.) заявка поля не трогает вовсе — ни звание, ни
             * подразделение. Значение «Курсант»/пустое доводится до «Рядового»
             * только у обычных бойцов: у офицера это был бы сброс приказа.
             * Присвоенное звание (например, «Капитан») сохраняется в любом
             * случае — заявка не понижает бойца.
             */
            ...(protectedCard
              ? isDefaultRank(existing.rank)
                ? { rank: RECRUIT_RANK }
                : {}
              : {
                  ...(chosenUnit && isUnassignedUnit(existing.unit) ? { unit: chosenUnit } : {}),
                  // Звание «Курсант»/пустое → «Рядовой»: именно его ждёт ШДС и роль
                  ...(isEnlistmentRank(existing.rank) ? { rank: RECRUIT_RANK } : {}),
                }),
            // Логин ставим только когда он свободен (см. assignCallsign)
            ...(assignCallsign && assignCallsign !== existing.callsign
              ? { callsign: assignCallsign }
              : {}),
            // Имя в табеле: одиночное слово (позывной) заменяем настоящим ФИО,
            // чтобы следующий поиск дубля сработал по normalizePersonName
            name:
              !existing.name.includes(" ") && application.fullName
                ? application.fullName
                : existing.name,
            ...(needsPassword
              ? { passwordHash: await bcrypt.hash(tempPassword, 10) }
              : {}),
            role: existing.role === "recruit" ? "member" : existing.role,
            applicationData: {
              ...(existing.applicationData ?? {}),
              age: application.age ?? existing.applicationData?.age,
              armaExperience:
                application.armaExperience || existing.applicationData?.armaExperience || "",
              comment: application.about || existing.applicationData?.comment || "",
              reviewedBy: reviewer,
              reviewedAt: new Date().toISOString(),
              source: application.discordId ? "discord" : "password",
            },
            updatedAt: new Date(),
          })
          .where(eq(members.id, existing.id));

        console.warn(
          `[review] Заявка #${applicationId}: боец «${loginName}» уже в составе (id ${existing.id}) — новая строка не создана`
        );

        [decided] = await db
          .update(recruitApplications)
          .set({ status: "approved", memberId, reviewedBy: reviewer, updatedAt: new Date() })
          .where(eq(recruitApplications.id, applicationId))
          .returning();

        // Строка в ШДС: проверяем и прежние имена (позывной / ФИО из заявки),
        // иначе «Добавление» заняло бы вторую строку «Вакант»
        shdsOutcome = await ensureShdsRowForMember(memberId, loginName, [
          application.fullName || "",
          callsign,
          existing.name,
          existing.callsign || "",
        ]);
      } else {
        tempPassword = generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        const [created] = await db
          .insert(members)
          .values({
            // name — ФИО для табеля ШДС: по нему ищется дубль при следующей
            // заявке, когда Discord ID нет. Позывной остаётся логином.
            name: application.fullName || callsign,
            callsign,
            steamId: application.steamId,
            passwordHash,
            // Звание бойца в строю: «Рядовой» (курсант — статус кандидата)
            rank: application.rank || RECRUIT_RANK,
            /**
             * Подразделение — из заявки.
             *
             * Раньше здесь было null, и лист ШДС выбирал модератор уже после
             * одобрения. Теперь кандидат выбирает подразделение в форме
             * обязательно: правильный лист известен сразу, и запись в ШДС
             * выполняется тем же решением. Пусто только у заявок, заведённых
             * Google-формой или до появления поля.
             */
            unit: chosenUnit,
            status: MEMBER_STATUS.ACTIVE,
            role: "recruit",
            discordId: application.discordId,
            applicationData: {
              age: application.age ?? undefined,
              armaExperience: application.armaExperience ?? "",
              comment: application.about ?? "",
              reviewedBy: reviewer,
              reviewedAt: new Date().toISOString(),
              source: application.discordId ? "discord" : "password",
            },
          })
          .returning({ id: members.id });

        if (!created) {
          return { ok: false, message: "Не удалось создать бойца", error: "INSERT_FAILED" };
        }
        memberId = created.id;

        [decided] = await db
          .update(recruitApplications)
          .set({
            status: "approved",
            memberId: created.id,
            reviewedBy: reviewer,
            updatedAt: new Date(),
          })
          .where(eq(recruitApplications.id, applicationId))
          .returning();

        shdsOutcome = await ensureShdsRowForMember(created.id, callsign);
      }
    }

    // Уведомление и роль — «мягкие» шаги: их сбой не отменяет зачисление
    let dmDelivered = false;
    const realDiscord = realDiscordId(application.discordId);
    if (realDiscord) {
      /**
       * ЛС отправляем только когда есть что сообщить. У действующего бойца с
       * паролем доступ уже есть, и сообщение «Временный пароль: <пусто>»
       * только запутало бы его — такой итог остаётся в ответе офицеру.
       */
      if (tempPassword) {
        const dm = await safeDiscord<DmResult>(
          `ЛС рекруту ${realDiscord}`,
          () => sendDirectMessage(realDiscord, { content: recruitDmText(loginName, tempPassword) }),
          { ok: false, error: "Discord недоступен" }
        );
        dmDelivered = dm.ok;
        if (!dm.ok) {
          console.warn(
            `[review] ЛС рекруту ${realDiscord} не доставлено (закрыты ЛС?): ${dm.error}`
          );
        }
      }
    } else if (application.discordId) {
      // Значение похоже на плейсхолдер («:id», «undefined») или обрезано —
      // запрос по нему не отправляем, боец просто получит пароль от офицера
      console.warn(
        `[review] Discord ID заявки #${applicationId} не является числовым — ЛС не отправлено`
      );
    }

    /**
     * Роли Discord выдаются по итоговой карточке бойца, а не по заявке.
     *
     * Разница принципиальна: подразделение могло быть унаследовано от
     * существующей карточки (перевод приказом), а звание — уже присвоено.
     * Читаем строку после всех UPDATE, чтобы роль подразделения и звания
     * совпали с тем, что записано в БД и в ШДС.
     */
    const [enlisted] = await db.select().from(members).where(eq(members.id, memberId));
    const enlistmentUnit: Unit | null = isUnit(enlisted?.unit) ? enlisted.unit : null;
    const enlistmentRank = (enlisted?.rank || application.rank || RECRUIT_RANK).trim() || RECRUIT_RANK;

    const rolesOutcome = await grantEnlistmentRoles(
      realDiscordId(application.discordId) || realDiscordId(enlisted?.discordId) || null,
      enlistmentUnit,
      enlistmentRank
    );

    await db.insert(logs).values({
      category: "edit",
      author: reviewer || "Штаб",
      action: `${isRetry ? "завершил зачисление" : "одобрил заявку на вступление"} ${loginName}`,
      details: {
        "Заявка": `#${applicationId}`,
        "Позывной": loginName,
        ...(application.fullName ? { "ФИО": application.fullName } : {}),
        "Discord": application.discordId || "не привязан",
        "Подразделение": enlistmentUnit || "не назначено",
        "Звание": enlistmentRank,
        "Роли": rolesOutcome,
        "ЛС с доступом": dmDelivered ? "доставлено" : "не доставлено",
        "ШДС": shdsOutcome || "не выполнялось",
        "Повтор": isRetry ? "да" : "нет",
      },
      kind: "system",
      title: "Заявка одобрена",
      detail: `${loginName} зачислен, доступ в ЛК выдан`,
      ok: true,
    });

    // Сообщение в Discord правится последним и «мягко»: даже отказ Discord не
    // должен менять уже сформированный ответ офицеру
    await safeDiscord(
      `обновление сообщения заявки #${applicationId}`,
      () =>
        refreshRecruitMessage(
          decided ?? { ...application, status: "approved" as ReviewStatus, memberId },
          null,
          reviewerDiscordId
        ),
      false
    );

    /**
     * Итог для офицера. Текст про «ЛС не доставлено» уместен только когда
     * пароль действительно был выдан: у действующего бойца с паролем доступ
     * уже есть, и «продиктуйте пароль» было бы ложью.
     */
    const accessNote = tempPassword
      ? dmDelivered
        ? ", доступ выслан в ЛС"
        : " — ЛС не доставлено, продиктуйте пароль"
      : ", доступ в кабинет сохранён (пароль не менялся)";

    return {
      ok: true,
      message: `${loginName} зачислен${accessNote}${passwordNote}${
        shdsOutcome ? `. ${shdsOutcome}` : ""
      }. ${rolesOutcome}`,
      memberId,
      callsign: loginName,
      dmDelivered,
      tempPassword: tempPassword || undefined,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[review] Ошибка одобрения заявки:", e);
    return { ok: false, message: `Ошибка зачисления: ${error}`, error };
  }
}

/** Отклонение заявки: Embed краснеет, кнопки отключаются */
export async function rejectRecruitApplication(
  applicationId: number,
  reviewer: string,
  reason = "",
  reviewerDiscordId?: string | null
): Promise<ReviewOutcome> {
  const [application] = await db
    .select()
    .from(recruitApplications)
    .where(eq(recruitApplications.id, applicationId));

  if (!application) return { ok: false, message: NOT_FOUND, error: NOT_FOUND };
  if (!isPendingReviewStatus(application.status)) {
    return { ok: false, message: ALREADY_DECIDED, error: ALREADY_DECIDED };
  }

  const comment = reason.trim().slice(0, 300);

  try {
    const [updated] = await db
      .update(recruitApplications)
      .set({ status: "rejected", reviewedBy: reviewer, updatedAt: new Date() })
      .where(eq(recruitApplications.id, applicationId))
      .returning();

    await db.insert(logs).values({
      category: "edit",
      author: reviewer || "Штаб",
      action: `отклонил заявку на вступление ${application.callsign}`,
      details: { "Заявка": `#${applicationId}`, "Причина": comment || "не указана" },
      kind: "system",
      title: "Заявка отклонена",
      detail: comment ? `${application.callsign}: ${comment}` : application.callsign,
      ok: true,
    });

    // Статус в объекте подменяем до вызова: embed строится «как есть», а
    // updated из RETURNING уже содержит rejected — здесь это явная страховка
    if (updated) {
      await refreshRecruitMessage(
        { ...updated, status: "rejected" },
        comment ? `причина: ${comment}` : null,
        reviewerDiscordId
      );
    }

    return {
      ok: true,
      message: `Заявка ${application.callsign} отклонена${comment ? `: ${comment}` : ""}`,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[review] Ошибка отклонения заявки:", e);
    return { ok: false, message: `Ошибка: ${error}`, error };
  }
}

/* ------------------------------------------------------------------ */
/* Рапорт действующего состава                                         */
/* ------------------------------------------------------------------ */

/** Данные бойца, нужные для применения рапорта (ШДС и роли) */
type ReportMember = {
  id: number;
  callsign: string | null;
  name: string;
  rank: string;
  unit: string | null;
  post: string | null;
  discordId: string | null;
  vacation: boolean;
  vacationUntil: Date | null;
};

/**
 * Дата окончания отпуска из рапорта.
 *
 * Дата «to» трактуется как день возвращения в 00:01 МСК — как и в
 * parseVacationUntil() из bot.ts для заявок из Discord/формы: иначе отпуск
 * закрывался бы на сутки раньше или позже в зависимости от часового пояса.
 */
export function vacationUntilFromReport(to: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const date = new Date(`${to}T00:01:00+03:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * ID сервера для выдачи ролей.
 *
 * Настройка `guild_id` приоритетна; при её отсутствии сервер определяется
 * автоматически только если он у бота единственный — иначе роль уехала бы не
 * на тот сервер, и боец остался бы без роли «Отпуск».
 */
async function resolveGuildId(configured: string): Promise<string> {
  if (configured) return configured;
  try {
    const { getBotGuildIds } = await import("@/lib/discord");
    const ids = await getBotGuildIds();
    return ids.length === 1 ? ids[0] : "";
  } catch {
    return "";
  }
}

/**
 * Ранее сданные нормативы бойца из одобренных рапортов.
 *
 * Нужно, чтобы «Берет» закрывался по совокупности: нормативы экзамена на берет
 * боец мог сдать разными рапортами и в разное время, а автоматически берет
 * засчитывается только когда сданы все четыре. Без этого чтения берет закрывался
 * бы лишь при подаче всех четырёх нормативов одним рапортом.
 *
 * Ошибка чтения не отменяет применение рапорта: без истории берет просто не
 * закроется автоматически, и его отметят следующим рапортом.
 */
async function previousExamsOf(memberId: number): Promise<Set<string>> {
  try {
    const rows = await db
      .select({ type: serviceReports.type, payload: serviceReports.payload, status: serviceReports.status })
      .from(serviceReports)
      .where(eq(serviceReports.memberId, memberId));

    const codes = new Set<string>();
    for (const row of rows) {
      if (row.type !== "exam" || row.status !== "approved") continue;
      const payload = readReportPayload(row.type, row.payload) as ExamPayload;
      for (const exam of payload.exams ?? []) {
        if (exam.exam_code) codes.add(exam.exam_code);
      }
    }
    return codes;
  } catch (e) {
    console.error("[review] Не удалось прочитать сданные нормативы бойца:", e);
    return new Set<string>();
  }
}

/**
 * Применение одобренного рапорта: Google Таблица, роли Discord и статусы БД.
 *
 * Возвращает текстовый итог для Embed/журнала; ошибку не бросает: рапорт уже
 * одобрен штабом, и терять это решение нельзя — при сбое таблицы итог опишет
 * проблему, а модератор повторит синхронизацию вручную.
 */
async function applyReport(report: typeof serviceReports.$inferSelect): Promise<string> {
  const payload = readReportPayload(report.type, report.payload);
  const [member] = report.memberId
    ? await db.select().from(members).where(eq(members.id, report.memberId))
    : [];

  if (!member) return "боец не найден в базе — синхронизация не выполнена";

  const discordId = realDiscordId(member.discordId);
  const parts: string[] = [];
  const map = await getSettings();

  try {
    switch (report.type) {
      case "exam": {
        /**
         * Подразделение на лету: поле пусто или «не назначено».
         *
         * Требование: если у бойца в базе unit не задан, определить его по
         * ролям Discord и СОХРАНИТЬ, чтобы оценки при одобрении экзамена
         * гарантированно попали в правильный лист ШДС. Порядок важен: сначала
         * определяем (и записываем в БД), затем пишем оценки — иначе столбец
         * нормативов пришлось бы выбирать «на глаз».
         */
        if (isUnassignedUnit(member.unit)) {
          const detected = await resolveMemberUnitFromDiscord(
            { unit: member.unit, discordId: member.discordId },
            map
          );
          if (detected) {
            member.unit = detected;
            try {
              await db
                .update(members)
                .set({ unit: detected, updatedAt: new Date() })
                .where(eq(members.id, member.id));
              parts.push(`подразделение определено по ролям Discord: «${detected}»`);
            } catch (e) {
              console.warn("[review] Не удалось сохранить подразделение бойца:", e);
            }
          }
        }

        if (!member.unit) {
          parts.push("подразделение не назначено — экзамены в ШДС не отмечены");
          break;
        }
        const exams = (payload as ExamPayload).exams;

        /**
         * Какие столбцы ШДС закрашивать.
         *
         * Все нормативы каталога (в том числе спецкурсы и экзамен на берет) имеют
         * свой столбец, поэтому в таблицу уходит весь список без разделения на
         * «столбцовые» и «ручные».
         *
         * Название при этом приводится к коду СТОЛБЦА своего листа
         * (columnExamFor): в роте норматив зовётся «Сдача на Мех. Водителя», а в
         * дивизионе — «Сдача на мехвода», и отправь мы написание панели — бот не
         * нашёл бы столбец.
         *
         * Отдельно проверяется берет: как только сданы все четыре норматива
         * экзамена, столбец «Берет» закрывается автоматически — боец уже сдал
         * его, отдельного рапорта не требуется. Требования ступени
         * (BERET_EXAM_CODES) ищутся среди СДАННЫХ ранее и текущего рапорта: иначе
         * при подаче четырёх нормативов одной заявкой берет остался бы незакрытым.
         */
        const passedCodes = await previousExamsOf(member.id);
        for (const exam of exams) passedCodes.add(exam.exam_code);

        // Плюс отметки, уже стоящие в листе ШДС: норматив могли зачесть правкой
        // таблицы (без рапорта), и тогда «Берет» должен закрыться по
        // совокупности — как и в переводе по должности ниже.
        const sheetExams = await examsFromSheet({
          unit: member.unit,
          names: [member.callsign || member.name, member.name],
        });
        for (const code of sheetExams) passedCodes.add(code);

        /** Код столбца → элемент рапорта (оценка нужна для записи в ячейку) */
        const toMark = new Map<string, ExamItem>();
        for (const exam of exams) {
          const column = columnExamFor(member.unit, exam.exam_code);
          if (!column) continue;
          toMark.set(column.code, exam);
        }
        if (isBeretPassed([...passedCodes].map((code) => ({ code })))) {
          const beret = columnExamFor(member.unit, BERET_CODE);
          if (beret) toMark.set(beret.code, { exam_code: beret.code });
        }

        if (toMark.size) {
          /**
           * Оценка каждого норматива передаётся ОТДЕЛЬНО (examGrades).
           *
           * Раньше в таблицу уезжала одна оценка — первая с оценкой, — и она
           * попадала во все закрашенные столбцы: боец, сдавший пять нормативов
           * с разными оценками (или часть без оценки), получал «Отлично» в
           * каждом. Поле `grade` оставлено для заявок из Discord, где оценка
           * действительно одна на всю заявку.
           */
          const items = [...toMark.values()];
          const { applyShdsRequest, SHDS_ACTIONS } = await import("@/lib/gsheets");
          const result = await applyShdsRequest({
            raw: `Рапорт #${report.id} (панель)`,
            isVacation: false,
            vacationRemove: false,
            shdsAction: SHDS_ACTIONS.EXAM,
            unit: member.unit,
            userName: member.callsign || member.name,
            rank: member.rank,
            steamId: "",
            discordId,
            отделение: "",
            должность: "",
            exams: examColumnTokens(items.map((e) => e.exam_code)),
            // Порядок нормативов тот же, что в `exams`: столбцы сопоставляются
            // тем же разбором, поэтому оценки не разъедутся с нормативами
            examGrades: items.map((e) => ({ code: e.exam_code, grade: e.grade })),
            grade: items.find((e) => e.grade)?.grade || "",
            examiner: report.reviewedBy || "",
            rolesGive: "",
            rolesRemove: "",
            vacationDates: "",
            reason: `Рапорт на экзамены #${report.id}`,
          });
          parts.push(result.ok ? result.message : `ШДС: ошибка (${result.error})`);
        }

        // Берет закрылся сам — выдаём серверную роль «Берет», не дожидаясь
        // следующего цикла фоновой сверки: боец видит результат сразу
        if (toMark.has(columnExamFor(member.unit, BERET_CODE)?.code ?? BERET_CODE) && discordId) {
          const guildId = await resolveGuildId((map.get("guild_id") || "").trim());
          if (guildId) {
            try {
              const { addGuildMemberRole, getGuildRoles } = await import("@/lib/discord");
              const { resolveBeretRoleId } = await import("@/lib/roles");
              const roleId = resolveBeretRoleId(
                map.get("beret_role_id"),
                await getGuildRoles(guildId)
              );
              if (roleId) {
                await addGuildMemberRole(guildId, discordId, roleId);
                parts.push("выдана роль «Берет»");
              } else {
                parts.push("роль «Берет» на сервере не найдена — выдайте её вручную");
              }
            } catch (e) {
              // Роль — «мягкий» шаг: отметки в ШДС уже стоят, а повторную выдачу
              // сделает фоновая сверка ролей (role-sync.ts)
              parts.push(`роль «Берет» не выдана (${e instanceof Error ? e.message : String(e)})`);
            }
          } else {
            parts.push("guild_id не задан — роль «Берет» не выдана");
          }
        }
        break;
      }

      case "role": {
        // Должность фиксируется в карточке бойца; состав ролей и звания меняет
        // штаб в канале запросов ролей. Автоматически переставлять звания по
        // свободному тексту нельзя — боец может написать что угодно.
        const role = payload as RolePayload;
        if (role.post) {
          await db
            .update(members)
            .set({ post: role.post, updatedAt: new Date() })
            .where(eq(members.id, member.id));
        }
        parts.push(
          `специальность «${role.role}»${role.post ? `, должность «${role.post}»` : ""} зафиксирована`
        );
        parts.push("роли и звание выдаёт штаб в канале запросов ролей");
        break;
      }

      case "position_transfer": {
        /**
         * Перевод по должности ШДС: строка бойца переезжает в секцию новой
         * должности вместе с отметками экзаменов, прежнее место возвращается в
         * «Вакант».
         *
         * Порядок шагов: сначала проверка требований ступени (несданные
         * нормативы — это не «ошибка синхронизации», а законное основание
         * отказать), затем строка в таблице, и только потом карточка в БД.
         * Так должность в панели не разойдётся с таблицей при сбое API Google.
         */
        const transfer = payload as PositionTransferPayload;
        const section = findPositionSection(transfer.section);
        if (!section) {
          parts.push("секция должности не распознана — перевод не выполнен");
          break;
        }
        if (!member.unit) {
          parts.push("подразделение не назначено — перевод в ШДС не выполнен");
          break;
        }
        if (section.unit !== member.unit) {
          // Секция есть только у своего подразделения: перевести танкиста в
          // блок артдивизиона нельзя, это разные листы
          parts.push(
            `должность «${section.title}» относится к «${section.unit}», а боец в «${member.unit}»`
          );
          break;
        }

        // Обязательные экзамены: сданные ранее (одобренные рапорты) плюс
        // отметки, уже стоящие в листе ШДС. Одного источника мало: норматив
        // могли зачесть правкой таблицы, а не рапортом через панель
        const passedCodes = await previousExamsOf(member.id);
        const { transferShdsPosition } = await import("@/lib/gsheets");
        const sheetExams = await examsFromSheet({
          unit: member.unit,
          names: [member.callsign || member.name, member.name],
        });
        for (const code of sheetExams) passedCodes.add(code);

        const missing = missingSectionExams(
          section,
          [...passedCodes].map((code) => ({ code }))
        );
        if (missing.length) {
          parts.push(
            `перевод на «${section.title}» не выполнен: не сданы ${missing.join(", ")}`
          );
          break;
        }

        const result = await transferShdsPosition({
          unit: member.unit,
          names: [member.callsign || member.name, member.name],
          section,
          passedExams: [...passedCodes].map((code) => ({ code })),
        });
        parts.push(result.ok ? result.message : `ШДС: ошибка (${result.error})`);

        // Карточка бойца обновляется только после успешного переноса строки
        if (result.ok) {
          await db
            .update(members)
            .set({ post: section.post, updatedAt: new Date() })
            .where(eq(members.id, member.id));
          parts.push(`должность «${section.post}» зафиксирована в карточке`);
        }
        break;
      }

      case "vacation": {
        const vacation = payload as VacationPayload;
        await db
          .update(members)
          .set({
            vacation: true,
            vacationUntil: vacationUntilFromReport(vacation.to),
            vacationNotified: false,
            status: MEMBER_STATUS.VACATION,
            updatedAt: new Date(),
          })
          .where(eq(members.id, member.id));

        const leaveRoleId = (map.get("leave_role_id") || "").trim();
        if (discordId && leaveRoleId) {
          const guildId = await resolveGuildId((map.get("guild_id") || "").trim());
          if (guildId) {
            // Роль — «мягкий» шаг: статус отпуска уже записан в БД, и отказ
            // Discord не должен отменять его. Обёртка нужна и потому, что без
            // неё исключение прервало бы обработку рапорта целиком
            const granted = await safeDiscord(
              `роль «Отпуск» для ${discordId}`,
              async () => {
                const { addGuildMemberRole } = await import("@/lib/discord");
                await addGuildMemberRole(guildId, discordId, leaveRoleId);
                return true;
              },
              false
            );
            parts.push(
              granted
                ? "роль «Отпуск» выдана"
                : "роль «Отпуск» не выдана (ошибка Discord) — выдайте вручную"
            );
          } else {
            parts.push("guild_id не задан — роль «Отпуск» не выдана");
          }
        }
        parts.push(`отпуск до ${formatIsoDate(vacation.to)} (${vacation.reason})`);
        break;
      }

      case "reserve": {
        const reserve = payload as ReservePayload;
        if (!member.unit) {
          parts.push("подразделение не назначено — перевод в запас не выполнен");
          break;
        }
        // Строка целиком уезжает на лист «Запас», отметки экзаменов сохраняются
        const { moveToReserve } = await import("@/lib/reserve");
        const result = await moveToReserve({
          userName: member.callsign || member.name,
          unit: member.unit,
          rank: member.rank,
          steamId: "",
          discordId,
          post: member.post || "",
          roles: [],
        });
        parts.push(
          result.ok ? `${result.message} (${reserve.reason})` : `запас: ошибка (${result.error})`
        );
        if (result.ok) {
          // «Запас» — не строевой статус: кабинет закрывается, как при увольнении.
          // Отсчёт контроля ролей начинается здесь: в запас уходит с той же
          // ролью подразделения на сервере, и через сутки комсоставу придёт
          // напоминание, если её не снимут.
          await db
            .update(members)
            .set({
              active: false,
              status: MEMBER_STATUS.DISMISSED,
              ...statusTrackingFields(MEMBER_STATUS.DISMISSED, member.status),
              updatedAt: new Date(),
            })
            .where(eq(members.id, member.id));
          parts.push("статус в базе: переведён в запас");
        }
        break;
      }

      case "shds_entry": {
        const entry = payload as ShdsEntryPayload;
        const { applyShdsRequest, SHDS_ACTIONS } = await import("@/lib/gsheets");
        const result = await applyShdsRequest({
          raw: `Рапорт #${report.id} (панель)`,
          isVacation: false,
          vacationRemove: false,
          shdsAction: SHDS_ACTIONS.ADD,
          unit: entry.unit,
          userName: member.callsign || member.name,
          rank: entry.rank,
          steamId: entry.steamId,
          discordId: entry.discordId || discordId,
          отделение: entry.отделение,
          должность: entry.должность,
          exams: [],
          grade: "",
          examiner: "",
          rolesGive: "",
          rolesRemove: "",
          vacationDates: "",
          reason: `Запись в ШДС по рапорту #${report.id}`,
        });
        parts.push(result.ok ? result.message : `ШДС: ошибка (${result.error})`);

        // Карточка синхронизируется с анкетой: подразделение — это имя листа
        if (result.ok) {
          await db
            .update(members)
            .set({
              unit: entry.unit,
              rank: entry.rank,
              post: entry.должность || member.post,
              updatedAt: new Date(),
            })
            .where(eq(members.id, member.id));
        }
        break;
      }
    }
  } catch (e) {
    parts.push(`ошибка применения: ${e instanceof Error ? e.message : String(e)}`);
  }

  return parts.join(". ") || "выполнено";
}

/**
 * Публикация записи в Discord: Embed + кнопки решения.
 *
 * Используется и страницей /apply (заявка на вступление), и формами рапортов.
 * Канал не задан — запись всё равно создаётся, а штаб видит её в панели
 * модерации: неправильно «терять» рапорт только из-за отсутствия настройки.
 */
export type PublishResult = { ok: true; messageId: string; channelId: string } | { ok: false; error: string };

/**
 * ID канала из настроек панели, при пустом значении — из окружения.
 *
 * Одна точка разрешения на все каналы: если правило «панель, затем env»
 * расписать по функциям, оно неизбежно разойдётся (в одном месте забудут env,
 * в другом — обрезку пробелов), и рапорт уйдёт не туда при смене настроек.
 */
async function configuredChannel(settingKey: string, envKey: string): Promise<string> {
  const map = await getSettings();
  return (
    (map.get(settingKey) || "").trim() || (process.env[envKey] || "").trim()
  );
}

/**
 * ID роли модератора заявок и рапортов: настройка панели, при её отсутствии —
 * переменная окружения DISCORD_MODERATOR_ROLE_ID. Пусто — пинг не ставим.
 *
 * Та же роль, по которой бот проверяет право нажать кнопку решения: пинг и
 * права обязаны указывать на один круг лиц, иначе упоминание уходило бы людям,
 * которые не могут принять решение.
 */
async function moderatorRoleId(): Promise<string> {
  const map = await getSettings();
  const raw =
    (map.get("moderator_role_id") || "").trim() ||
    (process.env[ROLE_ENV_FALLBACKS.moderator_role_id] || "").trim();
  return realDiscordId(raw);
}

/**
 * Подразделение по ролям участника гильдии.
 *
 * Чистая функция (без сети) — правило проверяется тестами напрямую: приоритет у
 * назначенного ID роли, при его отсутствии подразделение ищется по имени на
 * сервере (это делает вызывающий код). Рота приоритетнее дивизиона: роли
 * взаимоисключающие, но порядок фиксируем, чтобы результат был детерминирован.
 */
export function memberUnitFromRoles(
  memberRoleIds: readonly string[],
  mapping: { tank?: string | null; art?: string | null }
): Unit | null {
  const ids = new Set(memberRoleIds.map((id) => String(id).trim()).filter(Boolean));
  const tank = String(mapping.tank ?? "").trim();
  const art = String(mapping.art ?? "").trim();
  if (tank && ids.has(tank)) return "Танковая рота";
  if (art && ids.has(art)) return "Артиллерийский дивизион";
  return null;
}

/**
 * Определение подразделения бойца по ролям Discord, если оно не назначено.
 *
 * Требование: пока `division_members.unit` пусто или «не назначено», рапорт
 * выводит подразделение по ролям участника на сервере — «Танковая рота» или
 * «Артиллерийский дивизион» — и сохраняет найденное значение в карточку, чтобы
 * поле больше не оставалось пустым.
 *
 * Ошибки Discord не пробрасываются: без подразделения рапорт всё равно
 * создаётся, а сотрудник штаба назначит лист вручную.
 */
export async function resolveMemberUnitFromDiscord(
  member: { unit: string | null; discordId: string | null },
  map: Map<string, string>
): Promise<Unit | null> {
  const current = (member.unit || "").trim();
  if (UNITS.includes(current as Unit)) return current as Unit;
  // «не назначено» — та же пустота, что и null: идём определять по ролям
  if (!isUnassignedUnit(current) && current) return null;

  const discordId = realDiscordId(member.discordId);
  if (!discordId) return null;

  const guildId = await resolveGuildId((map.get("guild_id") || "").trim());
  if (!guildId) return null;

  try {
    const [roles, memberRoles] = await Promise.all([
      getGuildRoles(guildId),
      getGuildMemberRoles(guildId, discordId),
    ]);
    if (!memberRoles) return null;

    /**
     * ID ролей подразделений: сначала новая настройка (role_tank_id /
     * role_art_id), затем прежняя (tank_role_id / art_role_id), затем поиск по
     * имени на сервере. Три уровня нужны для установок, где настройки ещё не
     * заполнены в новом формате.
     */
    const tank =
      realDiscordId(unitRoleId("Танковая рота", map)) ||
      findRoleIdByName(roles, unitRoleName("Танковая рота"));
    const art =
      realDiscordId(unitRoleId("Артиллерийский дивизион", map)) ||
      findRoleIdByName(roles, unitRoleName("Артиллерийский дивизион"));

    return memberUnitFromRoles(memberRoles, { tank, art });
  } catch (e) {
    console.warn("[review] Не удалось определить подразделение по ролям Discord:", e);
    return null;
  }
}

/** Канал рапортов: настройка панели, при её отсутствии — канал ШДС */
export async function reportsChannelId(): Promise<string> {
  const map = await getSettings();
  const channel = await configuredChannel(
    REPORTS_CHANNEL_SETTING,
    CHANNEL_ENV_FALLBACKS[REPORTS_CHANNEL_SETTING]
  );
  // ШДС — последний запасной вариант: заявка не должна «исчезнуть» из-за
  // незаполненной настройки нового канала
  return channel || (map.get("shds_channel_id") || "").trim();
}

/** Канал заявок на вступление: настройка панели, при её отсутствии — канал ШДС */
export async function recruitsChannelId(): Promise<string> {
  const map = await getSettings();
  const channel = await configuredChannel(
    RECRUIT_CHANNEL_SETTING,
    CHANNEL_ENV_FALLBACKS[RECRUIT_CHANNEL_SETTING]
  );
  return channel || (map.get("shds_channel_id") || "").trim();
}

/**
 * Канал для рапорта по его типу.
 *
 * Зачем разделение: требования говорят, что рапорт на смену роли/специальности
 * идёт в канал запросов ролей, отпуск — в канал отпусков, а остальные
 * служебные — в журнал рапортов. Очередь модерации при этом одна
 * (/admin/reports), поэтому от выбора канала решение не зависит — теряется
 * только удобство, а не сам рапорт.
 *
 * Пустой результат означает «канал не настроен»: вызывающий код обязан
 * записать предупреждение и НЕ ронять создание рапорта.
 */
export async function reportChannelIdFor(type: string): Promise<string> {
  if (type === "role") {
    return configuredChannel(
      ROLE_REQUESTS_CHANNEL_SETTING,
      CHANNEL_ENV_FALLBACKS[ROLE_REQUESTS_CHANNEL_SETTING]
    );
  }
  if (type === "vacation") {
    return configuredChannel(
      VACATION_CHANNEL_SETTING,
      CHANNEL_ENV_FALLBACKS[VACATION_CHANNEL_SETTING]
    );
  }
  return reportsChannelId();
}

/**
 * Отправка Embed с кнопками «Одобрить / Отклонить» в указанный канал.
 *
 * Канал проверяется ДО запроса: настройка могла остаться плейсхолдером («:id»,
 * «undefined»), и POST по пути `/channels/:id/messages` Discord отвергает с
 * 400 Invalid Form Body — запись при этом уже в БД, и шумная ошибка ничего не
 * даёт. Возвращаем понятную причину, вызывающий код только пишет её в журнал.
 */
export async function publishReviewMessage(
  channelId: string,
  scope: "recruit" | "report",
  id: number,
  embed: DiscordEmbed,
  /**
   * Необязательный текст сообщения над Embed и упоминания.
   *
   * Нужен заявкам на вступление: требование задаёт строгий текстовый формат и
   * пинг командиров подразделения, а Discord не подсвечивает упоминания,
   * зашитые в Embed. Для рапортов текст не передаётся — свободный текст бойца
   * в упоминаниях не нужен.
   */
  extra: {
    content?: string;
    allowed_mentions?: { parse?: string[]; roles?: string[]; users?: string[] };
  } = {}
): Promise<PublishResult> {
  const channel = realDiscordId(channelId);
  if (!channelId) {
    return { ok: false, error: "Канал Discord не настроен — решение доступно в панели модерации" };
  }
  if (!channel) {
    return {
      ok: false,
      error: `Канал Discord задан некорректно («${channelId.slice(0, 40)}») — публикация только в панели модерации`,
    };
  }
  try {
    /**
     * Пинг модератора в канале.
     *
     * Требование: при публикации рапорта упоминание роли модератора должно
     * загораться у её участников. Discord НЕ подсвечивает упоминания внутри
     * Embed, поэтому пинг ставится в `content`, а `allowed_mentions.roles`
     * разрешает его явно — без этого Discord вырезал бы упоминание как
     * «неразрешённое». Если роль не настроена, content не передаётся вовсе:
     * пустая строка и «@unknown-role» в сообщении только мешают.
     */
    const pingRole = scope === "report" && !extra.content ? await moderatorRoleId() : "";
    const content = extra.content ?? (pingRole ? mentionRole(pingRole) : "");

    const { sendChannelMessage } = await import("@/lib/discord");
    const message = await sendChannelMessage(channel, {
      ...(content ? { content } : {}),
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              // type: 2 обязателен: без него Discord отвечает
              // 400 Invalid Form Body на каждую кнопку
              type: 2,
              custom_id: reviewCustomId(scope, "approve", id),
              // Заявку «принимают», рапорт «одобряют» — термины из ТЗ
              label: scope === "recruit" ? "✅ Принять" : "✅ Одобрить",
              style: 3,
            },
            {
              type: 2,
              custom_id: reviewCustomId(scope, "reject", id),
              label: "❌ Отклонить",
              style: 4,
            },
          ],
        },
      ],
      // По умолчанию упоминаний нет: Embed содержит позывные и свободный текст
      // бойца. Заявка на вступление передаёт явный список ролей для пинга,
      // рапорт — роль модератора (см. pingRole выше).
      allowed_mentions:
        extra.allowed_mentions ??
        (pingRole
          ? { parse: [], users: [], roles: [pingRole] }
          : { parse: [], users: [], roles: [] }),
    });
    return { ok: true, messageId: message.id, channelId: channel };
  } catch (e) {
    logDiscord400(e);
    const error = e instanceof Error ? e.message : String(e);
    console.warn(DISCORD_WARNING, `публикация ${scope} #${id}`, e);
    return { ok: false, error };
  }
}

/**
 * Упоминание командиров для пинга в заявке на вступление.
 *
 * Берём роль «Командирский состав», при её отсутствии — роль модератора
 * заявок: это те же ID, по которым бот проверяет права нажавшего на кнопку,
 * поэтому пинг и права всегда указывают на один круг лиц. Пусто — пинг не
 * ставим: несуществующая роль в тексте выглядит как «@unknown-role».
 */
async function commandersMention(): Promise<string | null> {
  try {
    const map = await getSettings();
    const roleId =
      (map.get("command_role_id") || "").trim() ||
      (map.get("moderator_role_id") || "").trim();
    return realDiscordId(roleId) ? `<@&${realDiscordId(roleId)}>` : null;
  } catch (e) {
    console.warn("[review] Не удалось прочитать роли командиров для пинга:", e);
    return null;
  }
}

/**
 * Публикация заявки на вступление в штабном канале.
 *
 * Один путь для /apply и опроса Google-формы: обе заявки обязаны попадать в
 * один канал с одинаковым Embed и кнопками. ID сообщения сохраняется в заявке,
 * чтобы решение потом перекрасило именно его.
 */
export async function publishRecruitApplication(
  application: typeof recruitApplications.$inferSelect
): Promise<PublishResult> {
  const mention = await commandersMention();
  const published = await publishReviewMessage(
    await recruitsChannelId(),
    "recruit",
    application.id,
    buildRecruitEmbed({
      id: application.id,
      callsign: application.callsign,
      steamId: application.steamId,
      rank: application.rank,
      discordTag: application.discordTag || "",
      discordId: application.discordId,
      age: application.age,
      armaExperience: application.armaExperience || "",
      about: application.about || "",
      createdAt: application.createdAt,
      status: normalizeReviewStatus(application.status),
      // Модератор сразу видит, что это возврат из запаса, а не зачисление
      kind: application.kind,
      fullName: application.fullName,
      // Подразделение из формы: по нему будет выбран лист ШДС при одобрении
      unit: application.unit ?? null,
    }),
    {
      // Строгий текстовый формат из требований: он же — единственное место,
      // где упоминание командиров реально подсвечивается (в Embed — нет)
      content: buildRecruitApplicationMessage({
        fullName: application.fullName,
        callsign: application.callsign,
        about: application.about,
        age: application.age,
        armaExperience: application.armaExperience || "",
        discordId: realDiscordId(application.discordId) || null,
        discordTag: application.discordTag,
        commanderMention: mention,
        unit: application.unit ?? null,
      }),
      allowed_mentions: {
        parse: [],
        users: [],
        // Пинг разрешён только для роли командиров — не для текста кандидата
        roles: mention ? [mention.replace(/[^\d]/g, "")] : [],
      },
    }
  );

  if (published.ok) {
    await db
      .update(recruitApplications)
      .set({ discordMessageId: published.messageId, discordChannelId: published.channelId })
      .where(eq(recruitApplications.id, application.id));
  }

  return published;
}

/**
 * Одобрение рапорта: применение к ШДС/ролям/БД, фиксация решения и обновление
 * сообщения в Discord.
 *
 * Порядок как у заявок: сначала БД (решение штаба), затем «мягкие» шаги —
 * синхронизация и правка сообщения. Падение Google Таблицы не откатывает
 * одобрение: итог с ошибкой уйдёт в Embed, и модератор повторит синхронизацию.
 */
export async function approveServiceReport(
  reportId: number,
  reviewer: string
): Promise<ReviewOutcome & { outcome?: string }> {
  const [report] = await db.select().from(serviceReports).where(eq(serviceReports.id, reportId));

  if (!report) return { ok: false, message: NOT_FOUND, error: NOT_FOUND };
  if (report.status !== "pending") {
    return { ok: false, message: ALREADY_DECIDED, error: ALREADY_DECIDED };
  }

  try {
    const outcome = await applyReport(report);

    const [updated] = await db
      .update(serviceReports)
      .set({ status: "approved", reviewedBy: reviewer, updatedAt: new Date() })
      .where(eq(serviceReports.id, reportId))
      .returning();

    await db.insert(logs).values({
      category: "edit",
      author: reviewer || "Штаб",
      action: `одобрил рапорт ${report.callsign}`,
      details: {
        "Рапорт": `#${reportId}`,
        "Тип": report.type,
        "Итог": outcome,
      },
      kind: "system",
      title: "Рапорт одобрен",
      detail: `${report.callsign}: ${outcome}`,
      ok: true,
    });

    if (updated) {
      // Карточка бойца могла измениться при применении (должность, подразделение,
      // отпуск) — передаём свежие значения, чтобы Embed не показывал устаревшее
      const [member] = updated.memberId
        ? await db
            .select({
              unit: members.unit,
              rank: members.rank,
              name: members.name,
              discordId: members.discordId,
            })
            .from(members)
            .where(eq(members.id, updated.memberId))
        : [];
      await refreshReportMessage({ ...updated, status: "approved" }, member ?? null, outcome);
    }

    return { ok: true, message: outcome, outcome };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[review] Ошибка одобрения рапорта:", e);
    return { ok: false, message: `Ошибка: ${error}`, error };
  }
}

/**
 * Отклонение рапорта: комментарий модератора сохраняется в БД и уезжает в Embed.
 * Комментарий важен: без него боец не понимает, что исправить в повторном рапорте.
 */
export async function rejectServiceReport(
  reportId: number,
  reviewer: string,
  comment = ""
): Promise<ReviewOutcome> {
  const [report] = await db
    .select()
    .from(serviceReports)
    .where(eq(serviceReports.id, reportId));

  if (!report) return { ok: false, message: NOT_FOUND, error: NOT_FOUND };
  if (report.status !== "pending") {
    return { ok: false, message: ALREADY_DECIDED, error: ALREADY_DECIDED };
  }

  const note = comment.trim().slice(0, 300);

  try {
    const [updated] = await db
      .update(serviceReports)
      .set({
        status: "rejected",
        moderatorComment: note || null,
        reviewedBy: reviewer,
        updatedAt: new Date(),
      })
      .where(eq(serviceReports.id, reportId))
      .returning();

    await db.insert(logs).values({
      category: "edit",
      author: reviewer || "Штаб",
      action: `отклонил рапорт ${report.callsign}`,
      details: {
        "Рапорт": `#${reportId}`,
        "Тип": report.type,
        "Комментарий": note || "не указан",
      },
      kind: "system",
      title: "Рапорт отклонён",
      detail: note ? `${report.callsign}: ${note}` : report.callsign,
      ok: true,
    });

    if (updated) await refreshReportMessage(updated, null, note ? `причина: ${note}` : null);

    return {
      ok: true,
      message: `Рапорт ${report.callsign} отклонён${note ? `: ${note}` : ""}`,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[review] Ошибка отклонения рапорта:", e);
    return { ok: false, message: `Ошибка: ${error}`, error };
  }
}

/* ------------------------------------------------------------------ */
/* Обновление сообщений в Discord                                      */
/* ------------------------------------------------------------------ */

/**
 * Ряд кнопок в «отключённом» виде.
 * Кнопки не убираем совсем: по ним видно, какое решение принято, а второй
 * клик невозможен (disabled + проверка статуса в БД перед решением).
 */
function disabledActionRow(
  approveLabel: string,
  rejectLabel: string,
  approveId: string,
  rejectId: string
): DiscordActionRow[] {
  return [
    {
      type: 1,
      components: [
        // type: 2 у каждой кнопки — требование Discord к форме запроса
        { type: 2, custom_id: approveId, label: approveLabel, style: 3, disabled: true },
        { type: 2, custom_id: rejectId, label: rejectLabel, style: 4, disabled: true },
      ],
    },
  ];
}

/**
 * Перерисовывает сообщение-заявку: цвет и заголовок по статусу, кнопки
 * отключаются. Ошибка Discord не отменяет решение — источник правды в БД,
 * а сообщение при сбое можно поправить вручную, поэтому только логируем.
 *
 * `outcomeOverride` нужен возврату из запаса: итог там свой (строка ШДС
 * перенесена, роли возвращает бот), а не «доступ в ЛК выслан». Без него
 * модератор видел бы в канале формулировку зачисления — и не понял бы,
 * что строка в таблице уже перенесена.
 */
export async function refreshRecruitMessage(
  application: typeof recruitApplications.$inferSelect,
  outcomeOverride?: string | null,
  /**
   * Discord ID нажавшего на кнопку: в тексте сообщения появляется
   * «Одобрено модератором <@id>» (требование). В вебе модератора нет — там
   * остаётся подпись офицера из reviewedBy.
   */
  reviewerDiscordId?: string | null
): Promise<boolean> {
  // ID проверяются ДО любого сетевого запроса: значение из БД могло остаться
  // плейсхолдером («:id», обрезанная строка), а PATCH по такому пути Discord
  // отвергает с 400 Invalid Form Body. Тихо выходим — сообщение просто не
  // перерисуется, а решение штаба останется в силе.
  const channelId = realDiscordId(application.discordChannelId);
  const messageId = realDiscordId(application.discordMessageId);
  if (!channelId || !messageId) {
    if (application.discordChannelId || application.discordMessageId) {
      console.warn(
        `[review] Заявка #${application.id}: ID сообщения Discord не числовой — сообщение не обновлено`
      );
    }
    return false;
  }

  try {
    const [member] = application.memberId
      ? await db
          .select({ unit: members.unit })
          .from(members)
          .where(eq(members.id, application.memberId))
      : [];

    const embed = buildRecruitEmbed({
      id: application.id,
      callsign: application.callsign,
      steamId: application.steamId,
      rank: application.rank,
      discordTag: application.discordTag || "",
      discordId: application.discordId,
      age: application.age,
      armaExperience: application.armaExperience || "",
      about: application.about || "",
      createdAt: application.createdAt,
      status: application.status,
      reviewedBy: application.reviewedBy,
      // Вид заявки и ФИО: без них Embed «Запроса на возврат из запаса»
      // потерял бы свой заголовок после решения
      kind: application.kind,
      fullName: application.fullName,
      // Подразделение из формы остаётся в карточке и после решения: по нему
      // видно, в какой лист ШДС записан боец
      unit: application.unit ?? null,
      outcome:
        outcomeOverride ??
        (application.status === "approved"
          ? `доступ в ЛК выслан${member?.unit ? `, подразделение «${member.unit}»` : ""}`
          : null),
    });

    /**
     * Текст над Embed после решения.
     *
     * Заменяем исходную заявку итогом: повторно читать список полей в канале
     * незачем, а модератору важно видеть, кто именно распорядился. Упоминание
     * человека не пингует его (allowed_mentions по умолчанию пуст), поэтому
     * «@ник» в тексте — просто читаемая ссылка на профиль.
     */
    const moderator = reviewerDiscordId
      ? `<@${reviewerDiscordId}>`
      : application.reviewedBy
        ? `**${application.reviewedBy}**`
        : "Штаб";
    const statusLine =
      application.status === "approved"
        ? `✅ Одобрено модератором ${moderator}`
        : application.status === "rejected"
          ? `🛑 Отклонено модератором ${moderator}`
          : `🕓 Заявка на рассмотрении`;

    await editChannelMessage(channelId, messageId, {
      content: statusLine,
      embeds: [embed],
      components: disabledActionRow(
        "✅ Одобрено",
        "❌ Отклонено",
        reviewCustomId("recruit", "approve", application.id),
        reviewCustomId("recruit", "reject", application.id)
      ),
    });
    return true;
  } catch (e) {
    console.warn(DISCORD_WARNING, `сообщение заявки #${application.id} не обновлено`, e);
    return false;
  }
}

/** Обновление сообщения-рапорта: тот же принцип, что и у заявок */
export async function refreshReportMessage(
  report: typeof serviceReports.$inferSelect,
  member?: {
    unit: string | null;
    rank: string;
    name?: string | null;
    discordId?: string | null;
  } | null,
  outcome?: string | null
): Promise<boolean> {
  // Та же проверка, что и у заявок: по нечисловому ID запрос не отправляется
  const channelId = realDiscordId(report.discordChannelId);
  const messageId = realDiscordId(report.discordMessageId);
  if (!channelId || !messageId) {
    if (report.discordChannelId || report.discordMessageId) {
      console.warn(
        `[review] Рапорт #${report.id}: ID сообщения Discord не числовой — сообщение не обновлено`
      );
    }
    return false;
  }

  try {
    const embed = buildReportEmbed({
      id: report.id,
      type: report.type,
      callsign: report.callsign,
      // ФИО и Discord ID — из свежей карточки бойца: в Embed поле «Боец»
      // показывает реальное имя и кликабельный пинг, а не голый позывной
      name: member?.name ?? null,
      discordId: member?.discordId ?? null,
      unit: member?.unit ?? null,
      rank: member?.rank ?? null,
      payload: readReportPayload(report.type, report.payload),
      createdAt: report.createdAt,
      status: report.status,
      reviewedBy: report.reviewedBy,
      moderatorComment: report.moderatorComment,
      outcome,
    });

    await editChannelMessage(channelId, messageId, {
      embeds: [embed],
      components: disabledActionRow(
        "✅ Одобрено",
        "❌ Отклонено",
        reviewCustomId("report", "approve", report.id),
        reviewCustomId("report", "reject", report.id)
      ),
    });
    return true;
  } catch (e) {
    console.warn(DISCORD_WARNING, `сообщение рапорта #${report.id} не обновлено`, e);
    return false;
  }
}