/**
 * Роль Discord «Отпуск»: правила и применение.
 *
 * Отпуск — единственное состояние службы, которое видно на сервере ролью, и
 * раньше эту роль выдавали и снимали в четырёх независимых местах (кнопка в
 * панели, рапорт, обработчик реакции бота, шедулер окончания отпуска). Каждое
 * место делало это по-своему: часть — через discord.js, часть — через REST,
 * часть — с `.catch(() => {})`, то есть молча. Итог был предсказуем: роль
 * «Отпуск» оставалась на вернувшемся из отпуска бойце, а причина нигде не
 * фиксировалась.
 *
 * Здесь одно правило на все точки входа:
 *   1. плановая часть — ЧИСТАЯ функция (planVacationRole): нужна ли выдача,
 *      снятие или ничего. Проверяется тестами без сети и без БД;
 *   2. применение — runVacationRole с внедряемыми зависимостями: тест
 *      подставляет подставные addRole/removeRole, боевой код — REST Discord;
 *   3. ошибка Discord НИКОГДА не бросается наружу: отпуск уже записан в базу,
 *      и отказ внешнего сервиса не должен отменять решение штаба. Вместо
 *      исключения возвращается точный текст ошибки Discord API (нет прав,
 *      роль выше роли бота, участник вышел с сервера) и пишется журнал.
 */
import { db } from "@/db";
import { logs } from "@/db/schema";
import { addGuildMemberRole, getBotGuildIds, removeGuildMemberRole } from "@/lib/discord";
import type { DiscordApiError } from "@/lib/discord-queue";
import { isSnowflake } from "@/lib/roles-monitor";
import { getSettings } from "@/lib/settings";

/** Ключ настройки с ID роли «Отпуск» (тот же, что читает бот) */
export const LEAVE_ROLE_SETTING = "leave_role_id";

/** Что нужно сделать с ролью */
export type VacationRoleAction = "add" | "remove" | "skip";

/**
 * План работы с ролью.
 *
 * `reason` — человекочитаемая причина, почему роль не трогается. Она попадает
 * в ответ панели и в консоль: «не задана роль «Отпуск»» чинится настройкой, а
 * «не указан Discord ID» — привязкой аккаунта, и путать эти два случая нельзя.
 */
export type VacationRolePlan = {
  action: VacationRoleAction;
  roleId: string;
  reason: string;
};

/**
 * Решает, что делать с ролью «Отпуск».
 *
 * Порядок проверок важен и повторяет порядок данных: без ID роли говорить
 * нечего; без Discord ID роль некому выдать; уже в отпуске и роль нужна —
 * лишний запрос к Discord не отправляем (сверка идёт по всему составу, и
 * «на всякий случай выдать» превратилось бы в сотни запросов).
 */
export function planVacationRole(input: {
  /** Значение настройки leave_role_id (как есть, из карточки настроек) */
  leaveRoleId: string | null | undefined;
  /** Discord ID бойца: плейсхолдеры («manual», «:id») считаются отсутствием */
  discordId: string | null | undefined;
  /** Желаемое состояние: true — в отпуске, роль нужна */
  vacation: boolean;
}): VacationRolePlan {
  const roleId = String(input.leaveRoleId ?? "").trim();

  if (!roleId) {
    return {
      action: "skip",
      roleId: "",
      reason: "не задана роль «Отпуск» (Настройки → Discord → leave_role_id)",
    };
  }
  if (!/^\d{5,25}$/.test(roleId)) {
    return {
      action: "skip",
      roleId: "",
      reason: `ID роли «Отпуск» задан неверно («${roleId}»): ожидается числовой ID`,
    };
  }
  if (!isSnowflake(input.discordId)) {
    return {
      action: "skip",
      roleId,
      reason: "не указан Discord ID — роль «Отпуск» в Discord не изменена",
    };
  }

  return {
    action: input.vacation ? "add" : "remove",
    roleId,
    reason: input.vacation ? "выдать роль «Отпуск»" : "снять роль «Отпуск»",
  };
}

/** Итог применения роли — для ответа панели и журнала */
export type VacationRoleOutcome = {
  /** Что сделано (или что делать было нечего) */
  action: VacationRoleAction;
  /** Изменение применилось: skip тоже считается успехом, если причина не ошибка */
  ok: boolean;
  /** Текст итога для интерфейса, журнала и Discord */
  message: string;
  /** Точная ошибка Discord API (или причина пропуска), если применимо */
  error?: string;
};

/** Внешние зависимости: в тестах подменяются, в бою — настоящие */
export type VacationRoleDeps = {
  loadSettings: () => Promise<Map<string, string>>;
  /** Список серверов бота: нужен, когда guild_id не задан в настройках */
  getBotGuildIds?: () => Promise<string[]>;
  addRole: (guildId: string, discordId: string, roleId: string) => Promise<void>;
  removeRole: (guildId: string, discordId: string, roleId: string) => Promise<void>;
  saveLog?: (row: VacationRoleLogRow) => Promise<void>;
  log?: (message: string) => void;
};

/** Строка журнала bot_logs о роли «Отпуск» */
export type VacationRoleLogRow = {
  category: string;
  author: string;
  action: string;
  details: Record<string, string>;
  kind: string;
  title: string;
  detail: string;
  ok: boolean;
  error: string | null;
};

/**
 * Сервер, к которому применяются роли.
 *
 * Правило то же, что в review.ts и role-sync.ts: сначала `guild_id` из
 * настроек, иначе — только если сервер у бота единственный. При нескольких
 * серверах угадывать нельзя: роль уехала бы не туда, а боец остался бы без
 * роли «Отпуск» и без объяснения почему.
 */
export async function resolveVacationGuildId(
  configured: string | null | undefined,
  getBotGuildIdsImpl?: () => Promise<string[]>
): Promise<{ guildId: string; error?: string }> {
  const explicit = String(configured ?? "").trim();
  if (explicit) return { guildId: explicit };

  try {
    const ids = getBotGuildIdsImpl
      ? await getBotGuildIdsImpl()
      : await getBotGuildIds();
    if (ids.length === 1) return { guildId: ids[0] };
    return {
      guildId: "",
      error:
        ids.length === 0
          ? "бот не состоит ни на одном сервере — роль «Отпуск» не изменена"
          : "не задан guild_id, а бот состоит на нескольких серверах — роль «Отпуск» не изменена",
    };
  } catch (e) {
    return {
      guildId: "",
      error: `не удалось получить список серверов бота: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

/** Текст ошибки Discord: сообщение DiscordApiError уже содержит статус и причину */
function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const apiError = error as DiscordApiError;
    const parts = [String(apiError.message)];
    // Код Discord (50013 — нет прав, 50028 — неизвестная роль) помогает
    // администратору найти причину без чтения логов сервера
    if (typeof apiError.code === "number") parts.push(`код ${apiError.code}`);
    if (typeof apiError.status === "number") parts.push(`HTTP ${apiError.status}`);
    return parts.join(", ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Применяет роль «Отпуск»: выдаёт при уходе в отпуск, снимает при возвращении.
 *
 * Функция НИКОГДА не бросает. Даже если упало чтение настроек или Discord
 * ответил отказом, вызывающий код получает отчёт, а решение штаба (отпуск уже
 * записан в PostgreSQL) остаётся в силе.
 */
export async function runVacationRole(
  deps: VacationRoleDeps,
  input: {
    discordId: string | null | undefined;
    /** true — боец уходит в отпуск, false — возвращается */
    vacation: boolean;
    /** Позывной/ФИО для журнала и текста итога */
    memberName?: string | null;
    /** Источник изменения: «панель», «рапорт», «бот», «шедулер» */
    source: string;
    /** Только посчитать, не менять (кнопка «проверить» и тесты) */
    dryRun?: boolean;
  }
): Promise<VacationRoleOutcome> {
  const label = String(input.memberName ?? "").trim() || "боец";
  const discordId = String(input.discordId ?? "").trim();

  let map: Map<string, string>;
  try {
    map = await deps.loadSettings();
  } catch (e) {
    const message = `настройки недоступны: ${errorText(e)}`;
    deps.log?.(`[vacation-role] ${label}: ${message}`);
    return { action: "skip", ok: false, message, error: message };
  }

  const plan = planVacationRole({
    leaveRoleId: map.get(LEAVE_ROLE_SETTING),
    discordId,
    vacation: input.vacation,
  });

  if (plan.action === "skip") {
    deps.log?.(`[vacation-role] ${label}: пропуск — ${plan.reason}`);
    return {
      action: "skip",
      // Пропуск по настройке — не ошибка цикла: роль просто не настроена.
      // Но панели честнее показать предупреждение, поэтому причина в error.
      ok: false,
      message: plan.reason,
      error: plan.reason,
    };
  }

  const resolved = await resolveVacationGuildId(map.get("guild_id"), deps.getBotGuildIds);
  if (!resolved.guildId) {
    const message = resolved.error || "не удалось определить сервер Discord";
    deps.log?.(`[vacation-role] ${label}: ${message}`);
    return { action: plan.action, ok: false, message, error: message };
  }

  if (input.dryRun) {
    return {
      action: plan.action,
      ok: true,
      message: `проверка без изменений: ${plan.reason}`,
    };
  }

  try {
    if (plan.action === "add") {
      await deps.addRole(resolved.guildId, discordId, plan.roleId);
    } else {
      await deps.removeRole(resolved.guildId, discordId, plan.roleId);
    }
  } catch (e) {
    const message = errorText(e);
    // Точный текст Discord API — единственное, по чему разбирают инцидент
    // «почему роль не выдалась»: нет прав у бота, роль выше роли бота,
    // участник вышел с сервера, неверный ID роли.
    deps.log?.(`[vacation-role] ${label}: Discord отказал — ${message}`);
    await safeSaveLog(deps, {
      category: "edit",
      author: "Панель (роль «Отпуск»)",
      action: `не удалось ${plan.action === "add" ? "выдать" : "снять"} роль «Отпуск» бойцу ${label}`,
      details: {
        Боец: label,
        Источник: input.source,
        "ID роли": plan.roleId,
        Итог: "ошибка Discord",
      },
      kind: "roles",
      title: "Роль «Отпуск» не изменена",
      detail: `${label}: ${message}`,
      ok: false,
      error: message,
    });
    return {
      action: plan.action,
      ok: false,
      message:
        plan.action === "add"
          ? `роль «Отпуск» не выдана: ${message}`
          : `роль «Отпуск» не снята: ${message}`,
      error: message,
    };
  }

  const success =
    plan.action === "add"
      ? "роль «Отпуск» выдана"
      : "роль «Отпуск» снята";
  deps.log?.(`[vacation-role] ${label}: ${success} (источник: ${input.source})`);

  // Аудит: роль даёт и снимает доступ к закрытым каналам, поэтому успех тоже
  // фиксируется. Oшибки Discord при этом видны отдельной записью выше.
  await safeSaveLog(deps, {
    category: "edit",
    author: "Панель (роль «Отпуск»)",
    action: `${plan.action === "add" ? "выдал" : "снял"} роль «Отпуск» бойцу ${label}`,
    details: {
      Боец: label,
      Источник: input.source,
      "ID роли": plan.roleId,
      Итог: success,
    },
    kind: "roles",
    title: plan.action === "add" ? "Выдана роль «Отпуск»" : "Снята роль «Отпуск»",
    detail: `${label}: ${success}`,
    ok: true,
    error: null,
  });

  return { action: plan.action, ok: true, message: success };
}

/** Журнал — «мягкий» шаг: его сбой не отменяет уже применённое изменение роли */
async function safeSaveLog(
  deps: VacationRoleDeps,
  row: VacationRoleLogRow
): Promise<void> {
  if (!deps.saveLog) return;
  try {
    await deps.saveLog(row);
  } catch (e) {
    deps.log?.(
      `[vacation-role] журнал недоступен: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Боевые зависимости: PostgreSQL, REST Discord и журнал панели.
 *
 * Вынесено отдельной функцией, чтобы тест не мог случайно сходить в сеть:
 * правила проверяются на runVacationRole с подставными зависимостями.
 */
export function productionVacationRoleDeps(): VacationRoleDeps {
  return {
    loadSettings: () => getSettings(true),
    getBotGuildIds: () => getBotGuildIds(),
    addRole: (guildId, discordId, roleId) =>
      addGuildMemberRole(guildId, discordId, roleId),
    removeRole: (guildId, discordId, roleId) =>
      removeGuildMemberRole(guildId, discordId, roleId),
    saveLog: async (row) => {
      await db.insert(logs).values(row);
    },
    log: (message) => console.log(message),
  };
}

/**
 * Боевая точка входа для роутов панели.
 *
 * Ошибки не бросает никогда: решение штаба (отпуск в базе) уже принято, и
 * роут обязан вернуть его результат даже при отказе Discord.
 */
export async function applyVacationRole(input: {
  discordId: string | null | undefined;
  vacation: boolean;
  memberName?: string | null;
  source: string;
}): Promise<VacationRoleOutcome> {
  try {
    return await runVacationRole(productionVacationRoleDeps(), input);
  } catch (e) {
    // Страховка на случай ошибки вне самого применения (например, недоступен
    // модуль БД): панель должна получить отчёт, а не 500.
    const message = e instanceof Error ? e.message : String(e);
    console.error("[vacation-role] сбой применения роли:", message);
    return {
      action: "skip",
      ok: false,
      message: `роль «Отпуск» не изменена: ${message}`,
      error: message,
    };
  }
}
