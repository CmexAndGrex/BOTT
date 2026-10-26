/**
 * Применение административных действий «В запас» и «Уволить».
 *
 * Оркестратор в три шага, и порядок важен:
 *   1. Google Таблица (ШДС) — перенос строки на лист «Запас» или очистка
 *      слота «Вакант». Идёт ПЕРВЫМ: если таблица недоступна, действие
 *      останавливается ДО записи в БД — иначе карточка в панели говорила бы
 *      «в запасе», а строка в ШДС оставалась бы в строю (рассинхрон, который
 *      потом разгребает ручная сверка).
 *   2. База данных — статус, должность, подразделение, аудит-лог.
 *   3. Discord — роли через safeDiscord-обёртку. Ошибки Discord НИКОГДА не
 *      отменяют уже записанное решение (то же правило, что у роли «Отпуск»
 *      в vacation-roles.ts): точный текст отказа возвращается в ответе и
 *      попадает в журнал.
 *
 * Модуль зависит от БД и внешних сервисов напрямую (роут вызывает его из
 * серверного рантайма Node.js); чистые правила живут в member-lifecycle.ts и
 * member-lifecycle-roles.ts и проверяются тестами без стенда.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, members } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { isSnowflake, statusTrackingFields } from "@/lib/roles-monitor";
import { MEMBER_STATUS, normalizeMemberStatus } from "@/lib/recruits";
import {
  MEMBER_ACTIONS,
  memberActionLabel,
  statusAfterAction,
  unitAfterAction,
  type MemberAction,
} from "@/lib/member-lifecycle";
import { planLifecycleRoles, lifecycleManagedRoleIds } from "@/lib/member-lifecycle-roles";
import { parsePostRoleMap, POST_ROLE_MAP_KEY, resolvePostRoleId } from "@/lib/role-sync";
import { resolveBeretRoleId } from "@/lib/roles";
import { getGuildRoles, addGuildMemberRole, removeGuildMemberRole, getBotGuildIds } from "@/lib/discord";

/** Итог применения действия — для ответа API и журнала */
export type LifecycleApplyResult = {
  ok: boolean;
  /** Сообщение для интерфейса */
  message: string;
  /** Итог по ШДС (null — таблица не трогалась) */
  sheets: { ok: boolean; message: string } | null;
  /** Итог по Discord (null — роли не трогались) */
  discord: { ok: boolean; message: string; error: string | null } | null;
  /** Обновлённая карточка бойца (null — при отказе) */
  member: typeof members.$inferSelect | null;
};

/** Карточка бойца в объёме, нужном оркестратору */
type MemberRow = typeof members.$inferSelect;

/** Текст ошибки: сообщение DiscordApiError уже содержит статус и причину */
function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * safeDiscord: сетевой вызов Discord, который не может уронить транзакцию.
 *
 * Ошибка логируется и возвращается текстом — решение штаба уже записано в БД,
 * и отказ внешнего сервиса не должен отменять его (правило из ТЗ).
 */
async function safeDiscord<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.warn(`[member-lifecycle] Discord отказал (${label}):`, errorText(err));
    return fallback;
  }
}

/**
 * Сервер Discord для применения ролей.
 *
 * То же правило, что в vacation-roles.ts и role-sync.ts: явный guild_id из
 * настроек, иначе — только единственный сервер бота. При нескольких серверах
 * угадывать нельзя: роли уехали бы не туда.
 */
async function resolveGuildId(
  configured: string | null | undefined
): Promise<{ guildId: string; error?: string }> {
  const explicit = String(configured ?? "").trim();
  if (explicit) return { guildId: explicit };

  try {
    const ids = await getBotGuildIds();
    if (ids.length === 1) return { guildId: ids[0] };
    return {
      guildId: "",
      error:
        ids.length === 0
          ? "бот не состоит ни на одном сервере — роли не изменены"
          : "не задан guild_id, а бот состоит на нескольких серверах — роли не изменены",
    };
  } catch (e) {
    return { guildId: "", error: `не удалось получить список серверов бота: ${errorText(e)}` };
  }
}

/**
 * Применить роли Discord для действия.
 *
 * Никогда не бросает: возвращает отчёт с точным текстом ошибки Discord API.
 */
async function applyDiscordRoles(input: {
  action: MemberAction;
  member: MemberRow;
  authorLabel: string;
}): Promise<{ ok: boolean; message: string; error: string | null }> {
  const label = input.member.callsign || input.member.name;

  // Без привязки Discord роли менять некому — это предупреждение, не ошибка
  if (!isSnowflake(input.member.discordId)) {
    return {
      ok: false,
      message: "не указан Discord ID — роли Discord не изменены",
      error: "не указан Discord ID",
    };
  }
  const discordId = String(input.member.discordId);

  let map: Map<string, string>;
  try {
    map = await getSettings(true);
  } catch (e) {
    const message = `настройки недоступны: ${errorText(e)}`;
    return { ok: false, message, error: message };
  }

  const resolved = await resolveGuildId(map.get("guild_id"));
  if (!resolved.guildId) {
    const message = resolved.error || "не удалось определить сервер Discord";
    return { ok: false, message, error: message };
  }

  // Роли сервера: для «Берет» (поиск по имени) и защиты managed-ролей
  const guildRoles = await safeDiscord("список ролей сервера", () => getGuildRoles(resolved.guildId), []);

  const postRoleMap = parsePostRoleMap(map.get(POST_ROLE_MAP_KEY));
  const postRoleIds = postRoleMap
    ? [...postRoleMap.values()].map((id) => id.trim()).filter(Boolean)
    : [];

  const plan = planLifecycleRoles({
    action: input.action,
    reserveRoleId: map.get("reserve_role_id"),
    leaveRoleId: map.get("leave_role_id"),
    beretRoleId: resolveBeretRoleId(map.get("beret_role_id"), guildRoles),
    postRoleIds,
  });

  // Страховка: снимаем только роли из нашего справочника (см. lifecycleManagedRoleIds)
  const managed = lifecycleManagedRoleIds({
    reserveRoleId: map.get("reserve_role_id"),
    leaveRoleId: map.get("leave_role_id"),
    beretRoleId: resolveBeretRoleId(map.get("beret_role_id"), guildRoles),
    postRoleIds,
  });

  const errors: string[] = [];
  let applied = 0;

  for (const roleId of plan.remove) {
    if (!roleId || !managed.has(roleId)) continue;
    const done = await safeDiscord(`снятие роли ${roleId} у ${label}`, async () => {
      await removeGuildMemberRole(resolved.guildId, discordId, roleId);
      return true;
    }, false);
    if (done) applied++;
    else errors.push(`роль ${roleId} не снята`);
  }

  for (const roleId of plan.add) {
    if (!roleId) continue;
    const done = await safeDiscord(`выдача роли ${roleId} у ${label}`, async () => {
      await addGuildMemberRole(resolved.guildId, discordId, roleId);
      return true;
    }, false);
    if (done) applied++;
    else errors.push(`роль ${roleId} не выдана`);
  }

  const summary = plan.notes.join("; ");
  if (errors.length > 0) {
    const message = `${summary}. Ошибки Discord: ${errors.join(", ")}`;
    return { ok: false, message, error: errors.join("; ") };
  }
  return { ok: true, message: `${summary} (изменено ролей: ${applied})`, error: null };
}

/**
 * Применить действие к бойцу: ШДС → БД → Discord.
 *
 * Вызывается роутом POST /api/members/[id]/action после проверок прав и
 * защиты цели. Проверка цели здесь ПОВТОРЯЕТСЯ (не доверяем вызывающему):
 * сервер — последний рубеж, и «командование корпуса не увольняется» обязано
 * выполняться даже при ошибке в гварде.
 */
export async function applyMemberAction(input: {
  action: MemberAction;
  member: MemberRow;
  /** Подпись инициатора для журнала: «Командир Скиф» */
  authorLabel: string;
  /** Причина из окна подтверждения (опциональна) */
  reason?: string;
}): Promise<LifecycleApplyResult> {
  const { action, member } = input;
  const label = member.callsign || member.name;
  const reason = String(input.reason ?? "").trim();

  // 1. Google Таблица (ШДС) — первый шаг: рассинхрон с таблицей недопустим
  let sheets: { ok: boolean; message: string } | null = null;

  if (action === MEMBER_ACTIONS.RESERVE) {
    if (member.unit) {
      const { moveToReserve } = await import("@/lib/reserve");
      const result = await moveToReserve({
        userName: member.callsign || member.name,
        unit: member.unit,
        rank: member.rank,
        steamId: member.steamId ?? "",
        discordId: member.discordId ?? "",
        post: member.post ?? "",
        roles: [],
      });
      sheets = result.ok
        ? { ok: true, message: result.message }
        : { ok: false, message: result.error };
    } else {
      // Без подразделения лист ШДС не определить: строку переносить некуда,
      // но и блокировать перевод нельзя — боец мог быть заведён без ШДС
      sheets = { ok: false, message: "подразделение не назначено — строка ШДС не переносилась" };
    }
  } else {
    // Увольнение: активный состав → «Вакант» на листе подразделения;
    // числившийся в запасе → удалить строку с листа «Запас»
    const status = normalizeMemberStatus(member.status);
    const inReserve = status === MEMBER_STATUS.RESERVE || (status === MEMBER_STATUS.DISMISSED && !member.active);

    if (inReserve) {
      const { removeReserveRow } = await import("@/lib/reserve");
      const result = await removeReserveRow({ userName: member.callsign || member.name });
      // «не найден на листе запаса» — не ошибка: боец мог не числиться в ШДС
      sheets = { ok: true, message: result.ok ? result.message : `лист «Запас»: ${result.error}` };
    } else if (member.unit) {
      const { getSheet, resolveLayout, findNameRow, clearRowToVacant, ensureColumnCount, FULL_ROW_COL_COUNT } =
        await import("@/lib/gsheets");
      try {
        const sheet = await getSheet(member.unit);
        const layout = resolveLayout(member.unit);
        await ensureColumnCount(sheet, FULL_ROW_COL_COUNT);
        await sheet.loadCells();
        const row = findNameRow(sheet, layout, member.callsign || member.name);
        if (row) {
          await clearRowToVacant(sheet, layout, row);
          sheets = { ok: true, message: `Строка ${row} листа «${member.unit}» возвращена в «Вакант»` };
        } else {
          sheets = { ok: true, message: `Боец не найден на листе «${member.unit}» — строка не менялась` };
        }
      } catch (e) {
        sheets = { ok: false, message: errorText(e) };
      }
    } else {
      sheets = { ok: true, message: "Подразделение не назначено — ШДС не менялась" };
    }
  }

  // Отказ ШДС при переводе в запас — остановка действия: строка бойца должна
  // физически уехать на лист «Запас», иначе возврат из запаса её не найдёт.
  // Для увольнения мягче: строка могла уже быть «Вакант», карточку закрываем.
  if (!sheets.ok && action === MEMBER_ACTIONS.RESERVE) {
    return {
      ok: false,
      message: `Не удалось перевести в запас: ${sheets.message}`,
      sheets,
      discord: null,
      member: null,
    };
  }

  // 2. База данных: статус, должность, подразделение, аудит
  const nextStatus = statusAfterAction(action);
  const set: Record<string, unknown> = {
    status: nextStatus,
    active: false,
    post: null,
    unit: unitAfterAction(action, member.unit),
    vacation: false,
    vacationUntil: null,
    updatedAt: new Date(),
    ...statusTrackingFields(nextStatus, member.status),
  };

  const rows = await db.update(members).set(set).where(eq(members.id, member.id)).returning();
  const updated = rows[0] ?? null;

  // Аудит-лог: инициатор, действие, причина, итоги ШДС
  try {
    await db.insert(logs).values({
      category: "edit",
      author: input.authorLabel,
      action: `${action === MEMBER_ACTIONS.RESERVE ? "перевёл в запас" : "уволил"} бойца ${member.name}`,
      details: {
        Боец: member.name,
        Действие: memberActionLabel(action),
        Причина: reason || "не указана",
        Статус: nextStatus,
        ШДС: sheets.message,
      },
      kind: "system",
      title: memberActionLabel(action),
      detail: `${member.name}: ${sheets.message}${reason ? ` (причина: ${reason})` : ""}`,
      ok: true,
    });
  } catch (e) {
    console.error("[member-lifecycle] Не удалось записать аудит-лог:", e);
  }

  // 3. Discord — «мягкий» шаг: ошибки не отменяют решение
  const discord = await applyDiscordRoles({ action, member, authorLabel: input.authorLabel });

  // Журнал итога Discord: роль даёт доступ к каналам, и штаб обязан видеть отказ
  try {
    await db.insert(logs).values({
      category: "edit",
      author: "Панель (жизненный цикл)",
      action: `роли Discord при ${memberActionLabel(action).toLowerCase()} бойца ${member.name}`,
      details: {
        Боец: member.name,
        Итог: discord.ok ? "применены" : "не изменены",
        Сообщение: discord.message,
      },
      kind: "roles",
      title: discord.ok ? "Роли Discord изменены" : "Роли Discord не изменены",
      detail: `${member.name}: ${discord.message}`,
      ok: discord.ok,
      error: discord.error,
    });
  } catch (e) {
    console.error("[member-lifecycle] Не удалось записать журнал ролей:", e);
  }

  const message = [
    action === MEMBER_ACTIONS.RESERVE
      ? `${member.name} переведён в запас`
      : `${member.name} уволен`,
    sheets.message,
    discord.ok ? `Discord: ${discord.message}` : `Discord: ${discord.message}`,
  ].join(". ");

  return { ok: true, message, sheets, discord, member: updated };
}
