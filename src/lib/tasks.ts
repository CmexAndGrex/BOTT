import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { cronRuns, logs, members as membersTable, processedRequests, settings as settingsTable, snapshots, weeklyStats } from "@/db/schema";
import {
  REACTIONS,
  addReaction,
  chunkText,
  mentionRole,
  sendChannelMessage,
  type DiscordEmbed,
} from "@/lib/discord";
import { RS_RED_BASE_URL, fetchRoster } from "@/lib/rsred";
import {
  getSettings,
  normHours,
  nowInTz,
  parseLines,
  resolveCookie,
} from "@/lib/settings";
import { isCommanderFighter } from "@/lib/validation";
import { isProtectedFighter, protectMemberUpdate } from "@/lib/protected-profiles";
import { getMondayInMSK } from "@/lib/week-utils";

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
  /** Цвет Embed в Discord — фирменная тройка бота, менять её нельзя */
  hex: number;
  /** Цвет интерфейса панели — из палитры deep dark темы */
  css: string;
  label: string;
};

/**
 * Цвет показателя нормы.
 *
 * hex и css намеренно разные. hex уходит в Embed Discord (tasks.ts) — это
 * фирменные цвета бота, их смена разошлась бы с остальными его сообщениями.
 * css рисует кольцо и график панели, поэтому берёт акценты сайта: изумрудный,
 * янтарный и неоново-бордовый.
 */
export function pctColor(p: number): PctColor {
  if (p >= 60)
    return { name: "green", hex: 0x3ddc84, css: "#34d399", label: "Норма выполняется" };
  if (p >= 50)
    return { name: "yellow", hex: 0xffb020, css: "#ffb020", label: "Норма на грани" };
  return { name: "red", hex: 0xff3d3d, css: "#be123c", label: "Норма провалена" };
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

  // Базовый URL берём из константы: в настройках его больше нет (см. rsred.ts)
  const base = RS_RED_BASE_URL;
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

    // Определяем понедельник текущей недели по МСК для high-water mark
    const currentMonday = getMondayInMSK();

    for (const p of roster) {
      const match =
        (p.pid && byPid.get(p.pid)) || byName.get(p.name.toLowerCase()) || null;
      if (match) {
        seenIds.add(match.id);
        // ВАЖНО: локальные поля панели (discordId, vacation, vacationUntil,
        // vacationNotified, warnings) НЕ трогаем — они имеют приоритет над
        // данными сайта. Обновляем только то, что приходит с rs-red.com.
        //
        // Защищённая карточка командования (Иванов И. А.): сайт не имеет права
        // затереть звание и должность ДЕФОЛТОМ («Рядовой», пусто, «—»). При этом
        // осмысленное значение с сайта проходит, и повышение офицера приказом не
        // блокируется: фильтр отсекает только пустые дефолты, а не изменения.
        // Приоритет у того, что уже сохранено в БД (match), — см.
        // protectMemberUpdate.
        const guarded = protectMemberUpdate(
          match,
          { rankName: p.rankName, post: p.post },
          { rank: match.rank, rankName: match.rankName, post: match.post, unit: match.unit }
        );
        await db
          .update(membersTable)
          .set({
            pid: p.pid ?? match.pid,
            handle: p.handle ?? match.handle,
            name: p.name,
            ...(guarded as { rankName?: string | null; post?: string | null }),
            minutes: p.minutes,
            hours: p.hours,
            active: true,
            leftNotified: false, // вернулся в состав — сбрасываем флаг пинга
            updatedAt: new Date(),
          })
          .where(eq(membersTable.id, match.id));
        updated++;

        // ✨ HIGH-WATER MARK: защита от обнуления rs-red.com в 00:00 воскресенья
        // При КАЖДОЙ синхронизации сохраняем максимум часов за текущую неделю
        await db
          .insert(weeklyStats)
          .values({
            memberId: match.id,
            weekStart: currentMonday,
            hours: p.hours,
            vacation: match.vacation,
          })
          .onConflictDoUpdate({
            target: [weeklyStats.memberId, weeklyStats.weekStart],
            set: {
              // Берём МАКСИМУМ из текущего значения в БД и нового значения с rs-red
              hours: sql`GREATEST(${weeklyStats.hours}, ${p.hours})`,
              vacation: match.vacation,
            },
          });
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
        if (inserted[0]) {
          seenIds.add(inserted[0].id);
          // Новому бойцу тоже создаём запись high-water mark
          await db.insert(weeklyStats).values({
            memberId: inserted[0].id,
            weekStart: currentMonday,
            hours: p.hours,
            vacation: false,
          });
        }
        added++;
      }
    }

    // Бойцы, исчезнувшие из состава, помечаются неактивными.
    // updatedAt фиксирует момент выхода — по нему считается «сутки без снятия ролей».
    //
    // Защищённые карточки командования из этого списка исключены: заместитель
    // командира корпуса может не отображаться на сайте отдельной строкой, и
    // автосписание делало его «выбывшим» — вместе с этим снимались роли и он
    // пропадал из состава панели.
    if (roster.length > 0) {
      const stale = existing.filter(
        (e) => e.active && !seenIds.has(e.id) && !isProtectedFighter(e)
      );
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

  // Определяем, какую неделю закрываем:
  // - Если сейчас понедельник (или первые минуты понедельника), закрываем ПРОШЛУЮ неделю
  // - Если воскресенье 23:55+ — закрываем ТЕКУЩУЮ неделю (она заканчивается)
  const nowMsk = nowInTz(map.get("timezone") || "Europe/Moscow");
  const isNewWeek = nowMsk.weekday === 1; // понедельник (1 = Mon по нашей нумерации)
  const closingMonday = getMondayInMSK();
  // Если мы уже на новой неделе (понедельник), закрываем прошлую
  const weekStartToClose = isNewWeek
    ? (() => {
        const d = new Date(closingMonday + "T00:00:00");
        d.setDate(d.getDate() - 7);
        return d.toISOString().slice(0, 10);
      })()
    : closingMonday;

  let newWarningsTotal = 0;
  for (const fighter of allMembers) {
    // Берём часы из уже сохранённого high-water mark в weekly_stats для закрываемой недели.
    // Это защищает от ситуации, когда rs-red.com обнулил часы в 00:00 воскресенья,
    // а задача запустилась после обнуления — максимум за неделю уже сохранён.
    const existingRecords = await db
      .select()
      .from(weeklyStats)
      .where(
        and(
          eq(weeklyStats.memberId, fighter.id),
          eq(weeklyStats.weekStart, weekStartToClose)
        )
      );
    const existingRecord = existingRecords[0];

    // Берём максимум: либо из high-water mark в БД, либо из текущих часов бойца
    const snapshotHours = existingRecord
      ? Math.max(existingRecord.hours, fighter.hours)
      : fighter.hours;

    // Финально записываем/обновляем weekly_stats с итоговым значением недели
    await db
      .insert(weeklyStats)
      .values({
        memberId: fighter.id,
        weekStart: weekStartToClose,
        hours: snapshotHours,
        vacation: fighter.vacation,
      })
      .onConflictDoUpdate({
        target: [weeklyStats.memberId, weeklyStats.weekStart],
        set: {
          hours: sql`GREATEST(${weeklyStats.hours}, ${snapshotHours})`,
          vacation: fighter.vacation,
        },
      });

    let newWarnings = fighter.warnings;
    if (!fighter.vacation) {
      // Комсостав (командиры и заместители корпуса, роты, дивизиона) не
      // наказывается автоматическими предупреждениями за нехватку часов:
      // инкремент счётчика пропускаем. Выполнение нормы по-прежнему сбрасывает
      // ранее накопленные предупреждения.
      if (snapshotHours < norm) {
        if (!isCommanderFighter(fighter)) {
          newWarnings = fighter.warnings + 1;
          if (newWarnings > fighter.warnings) newWarningsTotal++;
        }
      } else {
        newWarnings = 0;
      }
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
    detail: `Бойцов: ${allMembers.length}. Норма: ${stats.passed} (${stats.percent}%), 0 ч: ${stats.zeroHours}, новые предупреждения: ${newWarningsTotal}. Неделя: ${weekStartToClose}.`,
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

  // Маркеры обработанных заявок храним столько же, сколько cron-слоты:
  // заявки живут в Discord дольше, но 7 дней покрывает любые «догоняющие» реакции
  const removedRequests = await db
    .delete(processedRequests)
    .where(lt(processedRequests.createdAt, cronCutoff))
    .returning({ messageId: processedRequests.messageId });

  const r: TaskResult = {
    ok: true,
    title: "Автоочистка логов",
    detail: `Удалено строк журнала: ${removedLogs.length}, cron-слотов: ${removedCron.length}, маркеров заявок: ${removedRequests.length}. Хранение журнала: ${retentionDays} дн.`,
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
    await fetchRoster(cookie, RS_RED_BASE_URL, map.get("rs_subdiv_id") || "5");
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

/** ---------- Задача: контроль снятия ролей у исключённых ----------
 *
 * Боец переведён в статус `dismissed` (исключён по рапорту, в запас, отклонена
 * заявка), но роль подразделения на сервере осталась. Пока роль висит,
 * исключённый читает закрытые каналы. Снимает роли живой человек в канале
 * запросов ролей, поэтому через 24 часа после исключения комсостав получает
 * напоминание — однократно на бойца (флаг rolesAlertSentAt).
 *
 * Отличие от runLeftMembersCheck: та задача следит за бойцами, пропавшими из
 * состава ШДС (active = false после синхронизации с rs-red.com), и опирается
 * на updatedAt. Здесь источник — исключение в панели (status = dismissed) и
 * точная колонка dismissedAt: updatedAt меняет любая правка карточки, по нему
 * срок в 24 часа не отсчитать.
 *
 * Задача не бросает исключений наружу: цикл вызывается из таймера в том же
 * процессе, что и веб-сервер, поэтому 404 по одному участнику или 429 от
 * Discord не должны прерывать проверку остальных.
 */
export async function runDismissedRolesCheck(source = "schedule"): Promise<TaskResult> {
  const map = await getSettings(true);
  if (map.get("roles_monitor_enabled") !== "true") {
    return { ok: true, title: "Контроль ролей исключённых", detail: "Проверка выключена" };
  }

  const channelId = (
    map.get("roles_monitor_channel_id") ||
    map.get("left_check_channel_id") ||
    map.get("discord_channel_id") ||
    ""
  ).trim();
  const commandRoleId = (map.get("command_role_id") || "").trim();
  if (!channelId) {
    const r: TaskResult = {
      ok: false,
      title: "Контроль ролей исключённых",
      detail:
        "Не задан канал уведомлений: укажите roles_monitor_channel_id, left_check_channel_id или discord_channel_id",
      error: "NO_CONFIG",
    };
    await addLog("roles-monitor", r.title, r.detail, false, r.error ?? null);
    return r;
  }

  const {
    buildRolesAlertEmbed,
    candidateLabel,
    isAlertDue,
    leftoverClanRoles,
    pendingDivisionRoles,
    resolveAlertDelayMs,
    rolesAlertLogText,
  } = await import("@/lib/roles-monitor");

  // Срок ожидания — из настроек панели (по умолчанию 24 часа). Значение
  // нормализуется resolveAlertDelayMs: мусор в настройке не должен превращать
  // проверку в пинг сразу после исключения.
  const delayMs = resolveAlertDelayMs(map.get("roles_monitor_delay_hours"));

  // Кандидаты: исключённые, с Discord ID, без отправленного напоминания.
  // Отсечка по сроку в SQL — грубая (меньше настраиваемого срока), точное
  // решение принимает isAlertDue: те же правила, что покрыты юнит-тестами,
  // а не вторая копия условия в SQL.
  const cutoff = new Date(Date.now() - delayMs);
  let candidates: (typeof membersTable.$inferSelect)[];
  try {
    candidates = await db
      .select()
      .from(membersTable)
      .where(
        and(
          eq(membersTable.status, "dismissed"),
          isNull(membersTable.rolesAlertSentAt),
          isNotNull(membersTable.discordId),
          lt(membersTable.dismissedAt, cutoff)
        )
      );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await addLog("roles-monitor", "Контроль ролей исключённых", message, false, message);
    return { ok: false, title: "Контроль ролей исключённых", detail: message, error: message };
  }

  const now = new Date();
  const due = candidates.filter((row) =>
    isAlertDue(
      {
        id: row.id,
        name: row.name,
        callsign: row.callsign,
        discordId: row.discordId,
        status: row.status,
        dismissedAt: row.dismissedAt,
        rolesAlertSentAt: row.rolesAlertSentAt,
      },
      now,
      delayMs
    )
  );

  // Сервер разрешается ДО раннего выхода: иначе при пустом guild_id задача
  // молча отчитывалась бы «напоминаний не требуется» на пустой выборке, а с
  // первой же кандидатурой падала бы настройкой — ошибку конфигурации нужно
  // видеть сразу, а не ждать, пока в базе появится подходящий боец.
  let guildId = (map.get("guild_id") || "").trim();
  if (!guildId) {
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
      title: "Контроль ролей исключённых",
      detail:
        "Не задан guild_id и бот состоит на нескольких серверах — укажите ID сервера в настройках",
      error: "NO_GUILD",
    };
  }

  if (!due.length) {
    return {
      ok: true,
      title: "Контроль ролей исключённых",
      detail: `Проверено исключённых: ${candidates.length}. Напоминаний не требуется.`,
    };
  }

  const { getGuildMemberRoles, sendChannelMessage } = await import("@/lib/discord");

  let checked = 0;
  let alerted = 0;
  let errors = 0;

  for (const row of due) {
    const discordId = String(row.discordId || "").trim();
    if (!discordId) continue;
    checked++;

    // Каждый боец обрабатывается в своём try: ошибка одного запроса (404, 429,
    // сеть) не должна ронять проверку остальных — иначе один ушедший с сервера
    // боец блокировал бы напоминания всем, кто идёт после него в выборке.
    try {
      const memberRoles = await getGuildMemberRoles(guildId, discordId);
      const leftover = leftoverClanRoles(memberRoles);
      const hanging = pendingDivisionRoles(memberRoles);

      // Роль АТК висит — предупреждаем комсостав
      if (hanging.length > 0) {
        const candidate = {
          id: row.id,
          name: row.name,
          callsign: row.callsign,
          discordId,
          status: row.status,
          dismissedAt: row.dismissedAt,
          rolesAlertSentAt: row.rolesAlertSentAt,
        };

        await sendChannelMessage(channelId, {
          embeds: [buildRolesAlertEmbed(candidate, { leftover })],
          content: commandRoleId ? mentionRole(commandRoleId) : undefined,
          // Упоминание бойца в Embed — это только подсветка профиля, пинговать
          // исключённого нельзя: allowed_mentions выключает уведомления всем,
          // кроме роли комсостава.
          allowed_mentions: {
            parse: [],
            roles: commandRoleId ? [commandRoleId] : [],
            users: [],
          },
        });

        alerted++;
        console.log(
          `[roles-monitor] Напоминание отправлено: ${candidateLabel(candidate)} (${discordId}), ролей клана осталось ${leftover.length}`
        );
        await addLog(
          "roles-monitor",
          "Не сняты роли подразделения",
          rolesAlertLogText(candidate, leftover),
          true
        );
      } else if (memberRoles === null) {
        // Участника нет на сервере: роли ушли вместе с ним — предупреждать не о
        // чем, но и возвращаться к бойцу незачем.
        console.log(
          `[roles-monitor] ${discordId}: участник не найден на сервере — роли неактуальны`
        );
      } else {
        console.log(`[roles-monitor] ${discordId}: роли подразделения уже сняты`);
      }

      // Флаг ставится и при снятых ролях: иначе задача вечно возвращалась бы к
      // одному и тому же бойцу на каждом цикле планировщика.
      await db
        .update(membersTable)
        .set({ rolesAlertSentAt: new Date() })
        .where(eq(membersTable.id, row.id));
    } catch (e) {
      errors++;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[roles-monitor] Ошибка проверки ${discordId}:`, message);
      await addLog(
        "roles-monitor",
        "Ошибка проверки ролей исключённого",
        `Боец: ${row.name} (Discord ${discordId})`,
        false,
        message
      );
    }
  }

  const detail =
    `Проверено: ${checked}, напоминаний отправлено: ${alerted}` +
    (errors ? `, ошибок: ${errors}` : "");
  const result: TaskResult = {
    ok: errors === 0,
    title: "Контроль ролей исключённых",
    detail,
    error: errors ? `ERRORS:${errors}` : undefined,
  };
  if (alerted > 0 || errors > 0) {
    await addLog("roles-monitor", result.title, detail, errors === 0, errors ? detail : null);
  }
  return result;
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

  // Канал пинга: отдельный (left_check_channel_id), иначе основной канал пингов
  const channelId = (
    map.get("left_check_channel_id") ||
    map.get("discord_channel_id") ||
    ""
  ).trim();
  const commandRoleId = (map.get("command_role_id") || "").trim();
  if (!channelId) {
    return {
      ok: false,
      title: "Контроль вышедших",
      detail:
        "Не задан канал пинга: укажите left_check_channel_id или discord_channel_id в настройках",
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

