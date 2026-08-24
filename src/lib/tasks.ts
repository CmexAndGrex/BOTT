import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, members as membersTable, snapshots } from "@/db/schema";
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
    const byName = new Map(existing.map((e) => [e.name.toLowerCase(), e]));
    const seenIds = new Set<number>();

    let added = 0;
    let updated = 0;

    for (const p of roster) {
      const match =
        (p.pid && byPid.get(p.pid)) || byName.get(p.name.toLowerCase()) || null;
      if (match) {
        seenIds.add(match.id);
        await db
          .update(membersTable)
          .set({
            pid: p.pid ?? match.pid,
            handle: p.handle ?? match.handle,
            name: p.name,
            rankName: p.rankName,
            post: p.post,
            minutes: p.minutes,
            hours: p.hours,
            active: true,
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

    // Бойцы, исчезнувшие из состава, помечаются неактивными
    if (roster.length > 0) {
      const stale = existing.filter((e) => e.active && !seenIds.has(e.id));
      for (const s of stale) {
        await db
          .update(membersTable)
          .set({ active: false })
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


