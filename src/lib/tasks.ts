import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { cronRuns, logs, members as membersTable, snapshots, weeklyStats } from "@/db/schema";
import {
  REACTIONS,
  addReaction,
  chunkText,
  mentionRole,
  sendChannelMessage,
  type DiscordEmbed,
} from "@/lib/discord";
import { fetchRoster } from "@/lib/rsred";
import {
  getSettings,
  normHours,
  nowInTz,
  parseLines,
  resolveCookie,
} from "@/lib/settings";

export type TaskResult = {
  ok: boolean;
  title: string;
  detail: string;
  error?: string;
};

async function addLog(
  kind: string,
  title: string,
  detail: string,
  ok = true,
  error: string | null = null
) {
  await db.insert(logs).values({ kind, title, detail, ok, error });
}

/** ---------- Статистика ---------- */

export type DivisionStats = {
  total: number;
  zeroHours: number;
  passed: number;
  failed: number;
  onVacation: number;
  percent: number;
};

export type PctColor = {
  name: "green" | "yellow" | "red";
  hex: number;
  css: string;
  label: string;
};

export function pctColor(p: number): PctColor {
  if (p >= 60)
    return { name: "green", hex: 0x3ddc84, css: "#3ddc84", label: "Норма выполняется" };
  if (p >= 50)
    return { name: "yellow", hex: 0xffb020, css: "#ffb020", label: "Норма на грани" };
  return { name: "red", hex: 0xff3d3d, css: "#ff3d3d", label: "Норма провалена" };
}

export function computeStats(
  rows: { hours: number; vacation: boolean }[],
  norm: number
): DivisionStats {
  const active = rows;
  const total = active.length;
  const onVacation = active.filter((m) => m.vacation).length;
  const zeroHours = active.filter((m) => Math.floor(m.hours) === 0).length;
  const passed = active.filter((m) => Math.floor(m.hours) >= norm).length;
  const failed = active.filter(
    (m) => !m.vacation && Math.floor(m.hours) < norm
  ).length;
  const percent = total > 0 ? Math.round((passed / total) * 1000) / 10 : 0;
  return { total, zeroHours, passed, failed, onVacation, percent };
}

async function takeSnapshot(stats: DivisionStats, source: string) {
  await db.insert(snapshots).values({
    total: stats.total,
    zeroHours: stats.zeroHours,
    passed: stats.passed,
    failed: stats.failed,
    onVacation: stats.onVacation,
    percent: stats.percent,
    source,
  });
}

/** ---------- Синхронизация состава с rs-red.com ---------- */

export async function syncRoster(source = "manual"): Promise<
  TaskResult & { membersCount: number }
> {
  const map = await getSettings(true);
  const cookie = resolveCookie(map);
  if (!cookie) {
    const r: TaskResult = {
      ok: false,
      title: "Синхронизация невозможна",
      detail: "Не задана cookie сайта rs-red.com.",
      error: "NO_COOKIE",
    };
    await addLog("sync", r.title, r.detail, false, r.error ?? null);
    return { ...r, membersCount: 0 };
  }

  const base = map.get("rs_base_url") || "https://rs-red.com";
  const subdivId = map.get("rs_subdiv_id") || "5";

  try {
    const { members: roster } = await fetchRoster(cookie, base, subdivId);
    const existing = await db.select().from(membersTable);
    const byPid = new Map(existing.filter((e) => e.pid).map((e) => [e.pid as string, e]));
    // По имени сопоставляем только ОДИН уникальный кандидат: если в БД две
    // строки с одним именем (дубль после прошлых сбоев), берём первую — иначе
    // «лишняя» строка деактивировалась бы и локальные правки терялись.
    const byName = new Map<string, typeof existing[number]>();
    for (const e of existing) {
      const key = e.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, e);
    }
    const seenIds = new Set<number>();

    let added = 0;
    let updated = 0;

    for (const p of roster) {
      const match =
        (p.pid && byPid.get(p.pid)) || byName.get(p.name.toLowerCase()) || null;
      if (match) {
        seenIds.add(match.id);
        // ВАЖНО: локальные поля панели (discordId, vacation, vacationUntil,
        // vacationNotified, warnings) НЕ трогаем — они имеют приоритет над
        // данными сайта. Обновляем только то, что приходит с rs-red.com.
        await db
          .update(membersTable)
          .set({
            pid: p.pid ?? match.pid,
            handle: p.handle ?? match.handle,
            name: p.name,
            rankName: p.rankName ?? match.rankName,
            post: p.post ?? match.post,
            minutes: p.minutes,
            hours: p.hours,
            active: true,
            leftNotified: false, // вернулся в состав — сбрасываем флаг пинга
            updatedAt: new Date(),
          })
          .where(eq(membersTable.id, match.id));
        updated++;
      } else {
        const inserted = await db
          .insert(membersTable)
          .values({
            pid: p.pid,
            handle: p.handle,
            name: p.name,
            rankName: p.rankName,
            post: p.post,
            minutes: p.minutes,
            hours: p.hours,
            active: true,
            updatedAt: new Date(),
          })
          .returning({ id: membersTable.id });
        if (inserted[0]) seenIds.add(inserted[0].id);
        added++;
      }
    }

    // Бойцы, исчезнувшие из состава, помечаются неактивными.
    // updatedAt фиксирует момент выхода — по нему считается «сутки без снятия ролей».
    if (roster.length > 0) {
      const stale = existing.filter((e) => e.active && !seenIds.has(e.id));
      for (const s of stale) {
        await db
          .update(membersTable)
          .set({ active: false, updatedAt: new Date() })
          .where(eq(membersTable.id, s.id));
      }
    }

    const r: TaskResult = {
      ok: true,
      title: "Состав синхронизирован",
      detail: `Бойцов: ${roster.length}. Новых: ${added}, обновлено: ${updated}.`,
    };
    await addLog("sync", r.title, r.detail, true);
    return { ...r, membersCount: roster.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Неизвестная ошибка";
    await addLog(
      "sync",
      "Ошибка синхронизации состава",
      `Источник: ${source}`,
      false,
      message
    );
    return {
      ok: false,
      title: "Ошибка синхронизации",
      detail: message,
      error: message,
      membersCount: 0,
    };
  }
}

/** ---------- Задача 1: ежедневный пинг на операцию ---------- */

function pick<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function runOperationPing(source = "schedule"): Promise<TaskResult> {
  const map = await getSettings(true);
  const channelId = (map.get("discord_channel_id") || "").trim();
  const roleId = (map.get("discord_role_id") || "").trim();

  if (!channelId) {
    const r: TaskResult = {
      ok: false,
      title: "Пинг на операцию не отправлен",
      detail: "Не указан ID канала Discord в настройках.",
      error: "NO_CHANNEL",
    };
    await addLog("operation", r.title, r.detail, false, r.error ?? null);
    return r;
  }

  const texts = parseLines(map.get("op_texts") || "");
  const gifs = parseLines(map.get("op_gifs") || "");
  const text =
    pick(texts) ||
    "Бойцы, на операцию! Отметьтесь реакцией под сообщением.";
  const gif = pick(gifs);
  const tz = map.get("timezone") || "Europe/Moscow";
  const now = nowInTz(tz);

  const embed: DiscordEmbed = {
    title: "СБОР НА ОПЕРАЦИЮ",
    description: text,
    color: 0xff3d3d,
    footer: {
      text: `Отметься реакцией: ✅ буду • ❌ не буду • ⏰ опоздаю • ❓ под вопросом`,
    },
    timestamp: new Date().toISOString(),
  };
  if (gif) embed.image = { url: gif };

  try {
    const msg = await sendChannelMessage(channelId, {
      content: roleId ? mentionRole(roleId) : undefined,
      embeds: [embed],
      allowed_mentions: roleId ? { parse: [], roles: [roleId] } : undefined,
    });

    for (const r of REACTIONS) {
      try {
        await addReaction(channelId, msg.id, r.emoji);
      } catch {
        /* реакция не критична */
      }
    }

    const r: TaskResult = {
      ok: true,
      title: "Пинг на операцию отправлен",
      detail: `Канал ${channelId}, роль ${roleId || "—"}, ${now.label} (${tz}).${source === "manual" ? " Запуск вручную." : ""}`,
    };
    await addLog("operation", r.title, r.detail, true);
    return r;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Неизвестная ошибка";
    const r: TaskResult = {
      ok: false,
      title: "Ошибка отправки пинга",
      detail: now.label,
      error: message,
    };
    await addLog("operation", r.title, r.detail, false, message);
    return r;
  }
}

/** ---------- Задача 2: еженедельная проверка онлайна ---------- */

export async function runWeeklyCheck(source = "schedule"): Promise<TaskResult> {
  const map = await getSettings(true);
  const channelId = (map.get("discord_channel_id") || "").trim();
  const norm = normHours(map);
  const tz = map.get("timezone") || "Europe/Moscow";
  const now = nowInTz(tz);

  // 1. Свежие данные с сайта
  const sync = await syncRoster("weekly");
  if (!sync.ok) {
    const r: TaskResult = {
      ok: false,
      title: "Проверка онлайна не выполнена",
      detail: sync.detail,
      error: sync.error,
    };
    await addLog("weekly", r.title, r.detail, false, sync.error ?? null);
    return r;
  }

  const rows = await db
    .select()
    .from(membersTable)
    .where(eq(membersTable.active, true));

  const stats = computeStats(rows, norm);
  await takeSnapshot(stats, source);

  const color = pctColor(stats.percent);
  const debtors = rows
    .filter((m) => !m.vacation && Math.floor(m.hours) < norm)
    .sort((a, b) => a.hours - b.hours);
  const vacationers = rows.filter((m) => m.vacation);

  const pingables = debtors.filter((m) => !!m.discordId);
  const unmapped = debtors.filter((m) => !m.discordId);

  // 2. Статистика в embed
  // Формируем красивый список для внутренности блока (со званием)
  const namesLine = debtors
    .map((m) => {
      const rank = m.rankName ? `${m.rankName} ` : "";
      return `• ${rank}**${m.name}** — ${Math.floor(m.hours)} ч.`;
    })
    .join("\n");

  const embed: DiscordEmbed = {
    title: "📊 ПРОВЕРКА ОНЛАЙНА • ТАНКОВЫЕ ВОЙСКА",
    color: color.hex,
    timestamp: new Date().toISOString(),
    fields: [
      { name: "👥 Всего бойцов", value: String(stats.total), inline: true },
      { name: "🛑 С 0 часов", value: String(stats.zeroHours), inline: true },
      {
        name: `✅ Норма ≥ ${norm} ч`,
        value: String(stats.passed),
        inline: true,
      },
      {
        name: "📈 Выполнение",
        value: `${stats.percent}% — ${color.label}`,
        inline: true,
      },
      { name: "🌴 В отпуске", value: String(stats.onVacation), inline: true },
      { name: "⚠️ Должников", value: String(debtors.length), inline: true },
      {
        name: `📋 Не выполнили норму (< ${norm} ч)`,
        value: namesLine ? namesLine.slice(0, 1000) : "Должников нет — все молодцы!",
        inline: false,
      },
    ],
    footer: {
      text: `Данные rs-red.com • ${now.label} (${tz}) • отпускники не пингуются`,
    },
  };

  if (!channelId) {
    const r: TaskResult = {
      ok: false,
      title: "Статистика собрана, но не отправлена",
      detail: `Всего ${stats.total}, норму выполнили ${stats.passed}. Укажите ID канала в настройках.`,
      error: "NO_CHANNEL",
    };
    await addLog("weekly", r.title, r.detail, false, r.error ?? null);
    return r;
  }

  try {
    // 3. Формируем список упоминаний для реального звукового пуша
    let content: string | undefined = undefined;
    let allowedMentions: { parse?: string[]; users?: string[] } | undefined = undefined;

    if (pingables.length > 0) {
      const mentions = pingables.map((m) => `<@${m.discordId}>`);
      content = `🔔 **Внимание, невыполнение нормы:** ${mentions.join(", ")}`;
      allowedMentions = {
        parse: [],
        users: pingables.map((m) => m.discordId as string),
      };
    }

    // Отправляем строго ОДНИМ запросом
    await sendChannelMessage(channelId, {
      content,
      embeds: [embed],
      allowed_mentions: allowedMentions,
    });

    const detail =
      `Всего: ${stats.total}, 0 ч: ${stats.zeroHours}, норма: ${stats.passed} (${stats.percent}%). ` +
      `Запинговано: ${pingables.length} из ${debtors.length} должников.` +
      (unmapped.length > 0
        ? ` Без Discord ID: ${unmapped.map((m) => m.name).join(", ")}.`
        : "") +
      (vacationers.length > 0
        ? ` Отпуск: ${vacationers.map((m) => m.name).join(", ")}.`
        : "");

    const r: TaskResult = {
      ok: true,
      title: "Проверка онлайна выполнена",
      detail,
    };
    await addLog("weekly", r.title, r.detail, true);
    return r;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Неизвестная ошибка";
    const r: TaskResult = {
      ok: false,
      title: "Ошибка отправки проверки",
      detail: `Статистика собрана (${stats.passed}/${stats.total}), но сообщение не ушло.`,
      error: message,
    };
    await addLog("weekly", r.title, r.detail, false, message);
    return r;
  }
}

/** ---------- Задача 3: ежедневный снимок статистики для графика ---------- */

export async function runDailySnapshot(source = "schedule"): Promise<TaskResult> {
  const map = await getSettings(true);
  const norm = normHours(map);
  const rows = await db
    .select()
    .from(membersTable)
    .where(eq(membersTable.active, true));
  const stats = computeStats(rows, norm);
  await takeSnapshot(stats, source === "schedule" ? "daily" : source);

  const r: TaskResult = {
    ok: true,
    title: "Снимок статистики создан",
    detail: `Всего: ${stats.total}, норма: ${stats.passed} (${stats.percent}%), 0 ч: ${stats.zeroHours}, отпуск: ${stats.onVacation}.`,
  };
  await addLog("system", r.title, r.detail, true);
  return r;
}

/** ---------- Недельный персональный срез (weekly_stats + предупреждения) ---------- */
// Раньше это делал только внешний cron через /api/weekly-snapshot — теперь задача
// встроена в планировщик, чтобы crontab можно было удалить полностью.

export async function runWeeklyRecord(source = "schedule"): Promise<TaskResult> {
  const map = await getSettings(true);
  const norm = normHours(map);
  const allMembers = await db
    .select()
    .from(membersTable)
    .where(eq(membersTable.active, true));

  let newWarningsTotal = 0;
  for (const fighter of allMembers) {
    await db.insert(weeklyStats).values({
      memberId: fighter.id,
      hours: fighter.hours,
      vacation: fighter.vacation,
    });

    let newWarnings = fighter.warnings;
    if (!fighter.vacation) {
      newWarnings = fighter.hours < norm ? fighter.warnings + 1 : 0;
      if (newWarnings > fighter.warnings) newWarningsTotal++;
    }
    if (newWarnings > 2) newWarnings = 2;

    await db
      .update(membersTable)
      .set({ warnings: newWarnings })
      .where(eq(membersTable.id, fighter.id));
  }

  // Дополнительная точка графика, как это делал недельный cron
  const stats = computeStats(allMembers, norm);
  await db.insert(snapshots).values({
    total: stats.total,
    zeroHours: stats.zeroHours,
    passed: stats.passed,
    failed: stats.failed,
    onVacation: stats.onVacation,
    percent: stats.percent,
    source: source === "schedule" ? "weekly-planner" : source,
  });

  const r: TaskResult = {
    ok: true,
    title: "Недельный срез составлен",
    detail: `Бойцов: ${allMembers.length}. Норма: ${stats.passed} (${stats.percent}%), 0 ч: ${stats.zeroHours}, новые предупреждения: ${newWarningsTotal}.`,
  };
  await addLog("weekly", r.title, r.detail, true);
  return r;
}

/** Автоочистка журнала и cron-слотов по срокам хранения (default: 30 дней) */
export async function runCleanup(): Promise<TaskResult> {
  const map = await getSettings();
  const retentionDays = Math.max(
    1,
    parseInt(map.get("logs_retention_days") || "30", 10) || 30
  );
  const logsCutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const cronCutoff = new Date(Date.now() - 7 * 86_400_000);

  const removedLogs = await db
    .delete(logs)
    .where(lt(logs.createdAt, logsCutoff))
    .returning({ id: logs.id });
  const removedCron = await db
    .delete(cronRuns)
    .where(lt(cronRuns.createdAt, cronCutoff))
    .returning({ key: cronRuns.key });

  const r: TaskResult = {
    ok: true,
    title: "Автоочистка логов",
    detail: `Удалено строк журнала: ${removedLogs.length}, cron-слотов: ${removedCron.length}. Хранение журнала: ${retentionDays} дн.`,
  };
  await addLog("system", r.title, r.detail, true);
  return r;
}

/** Лёгкая проверка связи с сайтом для статуса панели */
export async function checkSite(): Promise<{ ok: boolean; error?: string }> {
  const map = await getSettings();
  const cookie = resolveCookie(map);
  if (!cookie) return { ok: false, error: "Cookie не задана" };
  try {
    await fetchRoster(cookie, map.get("rs_base_url") || "", map.get("rs_subdiv_id") || "5");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Ошибка" };
  }
}



/** ---------- Задача: опрос Google-формы заявок ---------- */
export async function runGoogleFormPoll(source = "schedule"): Promise<TaskResult> {
  try {
    const { pollGoogleForm } = await import("@/lib/forms");
    const r = await pollGoogleForm();
    return {
      ok: r.ok,
      title: "Опрос Google-формы",
      detail: r.detail,
      error: r.ok ? undefined : r.detail,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, title: "Опрос Google-формы", detail: message, error: message };
  }
}

/** ---------- Задача: контроль вышедших из подразделения ----------
 *
 * Боец пропал из состава rs-red.com (active=false после синхронизации) и
 * с него НЕ сняли роли клана в Discord в течение суток → пинг
 * «Командирскому составу» в указанный канал. Пинг однократный (флаг
 * leftNotified), сбрасывается при возвращении бойца в состав.
 */
export async function runLeftMembersCheck(source = "schedule"): Promise<TaskResult> {
  const map = await getSettings(true);
  if (map.get("left_members_check") !== "true") {
    return { ok: true, title: "Контроль вышедших", detail: "Проверка выключена" };
  }

  const channelId = (map.get("left_check_channel_id") || "").trim();
  const commandRoleId = (map.get("command_role_id") || "").trim();
  if (!channelId || !commandRoleId) {
    return {
      ok: false,
      title: "Контроль вышедших",
      detail: "Не задан канал пинга (left_check_channel_id) или роль Командирского состава",
      error: "NO_CONFIG",
    };
  }

  let guildId = (map.get("guild_id") || "").trim();

  // Кандидаты: неактивные, с Discord ID, без отправленного пинга,
  // пропавшие из состава больше суток назад
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const candidates = await db
    .select()
    .from(membersTable)
    .where(
      and(
        eq(membersTable.active, false),
        eq(membersTable.leftNotified, false),
        lt(membersTable.updatedAt, cutoff),
        isNotNull(membersTable.discordId)
      )
    );

  if (!guildId) {
    // Автоопределение сервера: берём единственный сервер бота
    try {
      const { getBotGuildIds } = await import("@/lib/discord");
      const ids = await getBotGuildIds();
      if (ids.length === 1) guildId = ids[0];
    } catch {
      /* оставим пустым — задача отчитается ниже */
    }
  }
  if (!guildId) {
    return {
      ok: false,
      title: "Контроль вышедших",
      detail: "Не задан guild_id и бот состоит на нескольких серверах — укажите ID сервера в настройках",
      error: "NO_GUILD",
    };
  }

  const { getGuildMemberRoles, sendChannelMessage } = await import("@/lib/discord");
  const { CLAN_ROLE_IDS } = await import("@/lib/roles");

  const notStripped: string[] = [];
  for (const m of candidates) {
    if (!m.discordId) continue;
    const roles = await getGuildMemberRoles(guildId, m.discordId);
    if (roles === null) continue; // участник не найден на сервере — роли уже неактуальны
    if (roles.some((id) => CLAN_ROLE_IDS.has(id))) notStripped.push(m.name);
    // Пингуем только один раз — даже если роли снимут позже
    await db
      .update(membersTable)
      .set({ leftNotified: true })
      .where(eq(membersTable.id, m.id));
  }

  if (!notStripped.length) {
    return {
      ok: true,
      title: "Контроль вышедших",
      detail: `Проверено бойцов: ${candidates.length}. Все роли сняты — пинг не требуется.`,
    };
  }

  try {
    await sendChannelMessage(channelId, {
      content:
        `⚠️ <@&${commandRoleId}> Контроль состава!\n` +
        `Бойцы вышли из подразделения более суток назад, но роли клана с них НЕ сняты:\n` +
        notStripped.map((n) => `• ${n}`).join("\n") +
        `\nПроверьте: возможно, кто-то вышел без уведомления командира.`,
      allowed_mentions: { parse: [], roles: [commandRoleId] },
    });
    const r: TaskResult = {
      ok: true,
      title: "Контроль вышедших: пинг отправлен",
      detail: `Роли не сняты у ${notStripped.length}: ${notStripped.join(", ")}. Пинг Командирскому составу отправлен.`,
    };
    await addLog("system", r.title, r.detail, true);
    return r;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await addLog("system", "Контроль вышедших: ошибка пинга", message, false, message);
    return { ok: false, title: "Контроль вышедших", detail: message, error: message };
  }
}

