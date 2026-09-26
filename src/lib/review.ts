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
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, members, recruitApplications, serviceReports } from "@/db/schema";
import { editChannelMessage, sendDirectMessage, type DiscordActionRow } from "@/lib/discord";
import type { DiscordEmbed } from "@/lib/discord";
import {
  buildRecruitEmbed,
  buildReportEmbed,
  examColumnTokens,
  formatIsoDate,
  readReportPayload,
  reviewCustomId,
  type ExamPayload,
  type ReservePayload,
  type ReviewStatus,
  type RolePayload,
  type ShdsEntryPayload,
  type VacationPayload,
} from "@/lib/reports";
// Пароль — серверная часть (node:crypto), вынесена из reports.ts: тот модуль
// используется и в браузере, где crypto-модуль Node недоступен
import { generateTempPassword } from "@/lib/temp-password";
import { DEFAULT_RANK, MEMBER_STATUS } from "@/lib/recruits";
import { COMMON_ROLE_IDS } from "@/lib/roles";
import { getSettings } from "@/lib/settings";

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
/* Заявка на вступление                                                */
/* ------------------------------------------------------------------ */

/** Ссылка на вход в панель для ЛС рекруту */
function panelLoginUrl(): string {
  const explicit = (process.env.PANEL_URL || "").trim().replace(/\/+$/, "");
  return explicit ? `${explicit}/login` : "/login";
}

/** Текст ЛС рекруту: логин, временный пароль и ссылка на вход */
export function recruitDmText(callsign: string, password: string): string {
  return [
    "🎖️ **Заявка на вступление одобрена!**",
    "",
    `Позывной (логин): \`${callsign}\``,
    `Временный пароль: \`${password}\``,
    "",
    `Вход в личный кабинет: ${panelLoginUrl()}`,
    "",
    "Смените пароль сразу после входа в кабинете: временный действует до первой смены.",
  ].join("\n");
}

/**
 * Выдача базовой роли новобранца на сервере.
 *
 * Работает через Bot API (REST), а не через кэш гильдии: решение может прийти
 * из веб-панели, где шлюзового клиента Discord нет вовсе. `guild_id` берём из
 * настроек, а при его отсутствии — только при единственном сервере у бота:
 * иначе роль уехала бы «не на тот» сервер.
 */
async function grantRecruitRole(discordId: string | null): Promise<void> {
  if (!discordId) return;
  try {
    const map = await getSettings();
    const token =
      (map.get("discord_token") || "").trim() || (process.env.DISCORD_BOT_TOKEN || "").trim();
    if (!token) return;

    let guildId = (map.get("guild_id") || "").trim();
    const { addGuildMemberRole, getBotGuildIds } = await import("@/lib/discord");
    if (!guildId) {
      const ids = await getBotGuildIds();
      if (ids.length !== 1) {
        console.warn("[review] guild_id не задан, бот на нескольких серверах — роль не выдана");
        return;
      }
      [guildId] = ids;
    }

    await addGuildMemberRole(guildId, discordId, COMMON_ROLE_IDS.RECRUIT);
  } catch (e) {
    // Роль — не критичная часть: доступ в ЛК уже выдан
    console.warn("[review] Не удалось выдать роль новобранца:", e);
  }
}

export type ApproveRecruitResult = ReviewOutcome & {
  memberId?: number;
  /** true — рекрут получил ЛС с доступом (false: закрыты ЛС либо нет Discord ID) */
  dmDelivered?: boolean;
  /** Временный пароль: возвращается офицеру, если ЛС не доставлено */
  tempPassword?: string;
};

/**
 * Одобрение заявки: создаёт бойца, выдаёт доступ и уведомляет рекрута в ЛС.
 *
 * Порядок важен: сначала фиксируем решение и создаём аккаунт (необратимая
 * часть), затем уведомляем и правим сообщение. Если ЛС закрыто, решение
 * остаётся в силе, а пароль возвращается вызывающему — офицер продиктует сам.
 */
export async function approveRecruitApplication(
  applicationId: number,
  reviewer: string
): Promise<ApproveRecruitResult> {
  const [application] = await db
    .select()
    .from(recruitApplications)
    .where(eq(recruitApplications.id, applicationId));

  if (!application) return { ok: false, message: NOT_FOUND, error: NOT_FOUND };
  if (application.status !== "pending") {
    return { ok: false, message: ALREADY_DECIDED, error: ALREADY_DECIDED };
  }

  const callsign = (application.callsign || "").trim();
  if (!callsign) {
    return { ok: false, message: "У заявки нет позывного", error: "EMPTY_CALLSIGN" };
  }

  // Позывной — это логин: занятый позывной создал бы дубль в табеле ШДС
  const [taken] = await db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.callsign, callsign));
  if (taken) {
    return {
      ok: false,
      message: `Позывной «${callsign}» уже занят — поправьте его в панели модерации`,
      error: "CALLSIGN_TAKEN",
    };
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  try {
    const [created] = await db
      .insert(members)
      .values({
        name: callsign,
        callsign,
        passwordHash,
        rank: DEFAULT_RANK,
        // Подразделение назначает штаб в панели: от него зависит лист ШДС,
        // и угадывать его по заявке нельзя
        unit: null,
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

    const [updated] = await db
      .update(recruitApplications)
      .set({
        status: "approved",
        memberId: created.id,
        reviewedBy: reviewer,
        updatedAt: new Date(),
      })
      .where(eq(recruitApplications.id, applicationId))
      .returning();

    // Уведомление и роль — «мягкие» шаги: их сбой не отменяет зачисление
    let dmDelivered = false;
    if (application.discordId) {
      const dm = await sendDirectMessage(application.discordId, {
        content: recruitDmText(callsign, tempPassword),
      });
      dmDelivered = dm.ok;
      if (!dm.ok) {
        console.warn(
          `[review] ЛС рекруту ${application.discordId} не доставлено (закрыты ЛС?): ${dm.error}`
        );
      }
    }

    await grantRecruitRole(application.discordId);

    await db.insert(logs).values({
      category: "edit",
      author: reviewer || "Штаб",
      action: `одобрил заявку на вступление ${callsign}`,
      details: {
        "Заявка": `#${applicationId}`,
        "Позывной": callsign,
        "Discord": application.discordId || "не привязан",
        "ЛС с доступом": dmDelivered ? "доставлено" : "не доставлено",
      },
      kind: "system",
      title: "Заявка одобрена",
      detail: `${callsign} зачислен, доступ в ЛК выдан`,
      ok: true,
    });

    await refreshRecruitMessage(updated ?? { ...application, status: "approved" as ReviewStatus });

    return {
      ok: true,
      message: `${callsign} зачислен${
        dmDelivered ? ", доступ выслан в ЛС" : " — ЛС не доставлено, продиктуйте пароль"
      }`,
      memberId: created.id,
      dmDelivered,
      tempPassword,
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
  reason = ""
): Promise<ReviewOutcome> {
  const [application] = await db
    .select()
    .from(recruitApplications)
    .where(eq(recruitApplications.id, applicationId));

  if (!application) return { ok: false, message: NOT_FOUND, error: NOT_FOUND };
  if (application.status !== "pending") {
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
    if (updated) await refreshRecruitMessage({ ...updated, status: "rejected" });

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

/** Discord ID бойца: реальная снежинка, а не маркер «не привязан» */
function realDiscordId(value: string | null): string {
  return value && /^\d{5,25}$/.test(value) ? value : "";
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
        if (!member.unit) {
          parts.push("подразделение не назначено — экзамены в ШДС не отмечены");
          break;
        }
        const exams = (payload as ExamPayload).exams;
        // Все выбранные нормативы закрашиваются в ШДС, но оценка пишется в один
        // столбец заявки: берём оценку первого норматива с оценкой. Остальные
        // видны в исходном Embed рапорта — модератор их проверит при надобности.
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
          exams: examColumnTokens(exams.map((e) => e.exam_code)),
          grade: exams.find((e) => e.grade)?.grade || "",
          examiner: report.reviewedBy || "",
          rolesGive: "",
          rolesRemove: "",
          vacationDates: "",
          reason: `Рапорт на экзамены #${report.id}`,
        });
        parts.push(result.ok ? result.message : `ШДС: ошибка (${result.error})`);
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
            const { addGuildMemberRole } = await import("@/lib/discord");
            await addGuildMemberRole(guildId, discordId, leaveRoleId);
            parts.push("роль «Отпуск» выдана");
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
          // «Запас» — не строевой статус: кабинет закрывается, как при увольнении
          await db
            .update(members)
            .set({ active: false, status: MEMBER_STATUS.DISMISSED, updatedAt: new Date() })
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

/** Канал рапортов: настройка панели, при её отсутствии — канал ШДС */
export async function reportsChannelId(): Promise<string> {
  const map = await getSettings();
  return (
    (map.get("reports_channel_id") || "").trim() ||
    (process.env.DISCORD_REPORTS_CHANNEL_ID || "").trim() ||
    (map.get("shds_channel_id") || "").trim()
  );
}

/** Канал заявок на вступление: настройка панели, при её отсутствии — канал ШДС */
export async function recruitsChannelId(): Promise<string> {
  const map = await getSettings();
  return (
    (map.get("recruits_channel_id") || "").trim() ||
    (process.env.DISCORD_RECRUITS_CHANNEL_ID || "").trim() ||
    (map.get("shds_channel_id") || "").trim()
  );
}

/** Отправка Embed с кнопками «Одобрить / Отклонить» в указанный канал */
export async function publishReviewMessage(
  channelId: string,
  scope: "recruit" | "report",
  id: number,
  embed: DiscordEmbed
): Promise<PublishResult> {
  if (!channelId) {
    return { ok: false, error: "Канал Discord не настроен — решение доступно в панели модерации" };
  }
  try {
    const { sendChannelMessage } = await import("@/lib/discord");
    const message = await sendChannelMessage(channelId, {
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              custom_id: reviewCustomId(scope, "approve", id),
              label: "✅ Одобрить",
              style: 3,
            },
            {
              custom_id: reviewCustomId(scope, "reject", id),
              label: "❌ Отклонить",
              style: 4,
            },
          ],
        },
      ],
      // Упоминаний нет: Embed содержит позывные и свободный текст бойца
      allowed_mentions: { parse: [], users: [], roles: [] },
    });
    return { ok: true, messageId: message.id, channelId };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[review] Не удалось опубликовать сообщение в Discord:", e);
    return { ok: false, error };
  }
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
            .select({ unit: members.unit, rank: members.rank })
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
        { custom_id: approveId, label: approveLabel, style: 3, disabled: true },
        { custom_id: rejectId, label: rejectLabel, style: 4, disabled: true },
      ],
    },
  ];
}

/**
 * Перерисовывает сообщение-заявку: цвет и заголовок по статусу, кнопки
 * отключаются. Ошибка Discord не отменяет решение — источник правды в БД,
 * а сообщение при сбое можно поправить вручную, поэтому только логируем.
 */
export async function refreshRecruitMessage(
  application: typeof recruitApplications.$inferSelect
): Promise<boolean> {
  if (!application.discordMessageId || !application.discordChannelId) return false;
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
      discordTag: application.discordTag || "",
      discordId: application.discordId,
      age: application.age,
      armaExperience: application.armaExperience || "",
      about: application.about || "",
      createdAt: application.createdAt,
      status: application.status,
      reviewedBy: application.reviewedBy,
      outcome:
        application.status === "approved"
          ? `доступ в ЛК выслан${member?.unit ? `, подразделение «${member.unit}»` : ""}`
          : null,
    });

    await editChannelMessage(application.discordChannelId, application.discordMessageId, {
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
    console.error("[review] Не удалось обновить сообщение заявки в Discord:", e);
    return false;
  }
}

/** Обновление сообщения-рапорта: тот же принцип, что и у заявок */
export async function refreshReportMessage(
  report: typeof serviceReports.$inferSelect,
  member?: { unit: string | null; rank: string } | null,
  outcome?: string | null
): Promise<boolean> {
  if (!report.discordMessageId || !report.discordChannelId) return false;
  try {
    const embed = buildReportEmbed({
      id: report.id,
      type: report.type,
      callsign: report.callsign,
      unit: member?.unit ?? null,
      rank: member?.rank ?? null,
      payload: readReportPayload(report.type, report.payload),
      createdAt: report.createdAt,
      status: report.status,
      reviewedBy: report.reviewedBy,
      moderatorComment: report.moderatorComment,
      outcome,
    });

    await editChannelMessage(report.discordChannelId, report.discordMessageId, {
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
    console.error("[review] Не удалось обновить сообщение рапорта в Discord:", e);
    return false;
  }
}