import { getSettings, resolveToken } from "@/lib/settings";
import { assertDiscordId } from "@/lib/validation";

const DISCORD_API = "https://discord.com/api/v10";

export type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  image?: { url: string };
  footer?: { text: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
};

/**
 * Кнопка сообщения (Discord message component type 2).
 * custom_id разбирается ботом через parseReviewCustomId() — см. reports.ts.
 */
export type DiscordButton = {
  custom_id: string;
  label: string;
  /** 1 primary, 2 secondary, 3 success, 4 danger */
  style: 1 | 2 | 3 | 4;
  disabled?: boolean;
};

/** Ряд кнопок (component type 1) */
export type DiscordActionRow = { type: 1; components: DiscordButton[] };

/** Строит ряд кнопок «Одобрить / Отклонить» для сообщения-заявки */
export function reviewActionRow(
  approveId: string,
  rejectId: string,
  disabled = false
): DiscordActionRow[] {
  return [
    {
      type: 1,
      components: [
        { custom_id: approveId, label: "✅ Одобрить", style: 3, disabled },
        { custom_id: rejectId, label: "❌ Отклонить", style: 4, disabled },
      ],
    },
  ];
}

async function botToken(): Promise<string> {
  const t = resolveToken(await getSettings());
  if (!t) {
    throw new Error(
      "Не задан токен бота. Добавьте его в настройках панели или через переменную DISCORD_BOT_TOKEN."
    );
  }
  return t;
}

async function discordRequest<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${await botToken()}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let hint = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      if (parsed?.message) hint = parsed.message;
    } catch {
      /* noop */
    }
    throw new Error(`Discord API (${res.status}): ${hint}`);
  }
  return (await res.json().catch(() => null)) as T;
}

export type BotUser = {
  id: string;
  username: string;
  discriminator: string;
  bot?: boolean;
};

export async function getBotUser(): Promise<BotUser> {
  return discordRequest<BotUser>("/users/@me");
}

export type ChannelMessage = { id: string; channel_id: string };

export async function sendChannelMessage(
  channelId: string,
  payload: {
    content?: string;
    embeds?: DiscordEmbed[];
    /** Кнопки под Embed: заявки и рапорты решаются интерактивно */
    components?: DiscordActionRow[];
    allowed_mentions?: {
      parse?: string[];
      roles?: string[];
      users?: string[];
    };
  }
): Promise<ChannelMessage> {
  const id = assertDiscordId(channelId, "ID канала Discord");
  return discordRequest<ChannelMessage>(
    `/channels/${id}/messages`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

/**
 * Редактирование уже отправленного сообщения.
 *
 * Используется при решении по заявке/рапорту: «перекрашиваем» Embed в
 * зелёный/красный и отключаем кнопки прямо в канале, чтобы второй офицер
 * не нажал их повторно. Компоненты передаются ВСЕГДА (пустой массив =
 * кнопки снимаются): без этого поля Discord оставил бы старые активные кнопки.
 */
export async function editChannelMessage(
  channelId: string,
  messageId: string,
  payload: {
    content?: string;
    embeds?: DiscordEmbed[];
    components?: DiscordActionRow[];
  }
): Promise<void> {
  const ch = assertDiscordId(channelId, "ID канала Discord");
  const msg = assertDiscordId(messageId, "ID сообщения Discord");
  await discordRequest(`/channels/${ch}/messages/${msg}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export type DmResult = { ok: true } | { ok: false; error: string };

/**
 * Личное сообщение пользователю.
 *
 * Ошибку не бросаем наружу, а возвращаем результатом: у рекрута настройки
 * приватности Discord часто закрывают ЛС от участников сервера, и падение
 * отправки не должно отменять уже принятое решение по заявке (боец создан,
 * роль выдана — штаб лишь увидит пометку «ЛС не доставлено» и продиктует
 * пароль сам).
 */
export async function sendDirectMessage(
  userId: string,
  payload: { content?: string; embeds?: DiscordEmbed[] }
): Promise<DmResult> {
  try {
    const uid = assertDiscordId(userId, "ID пользователя Discord");
    // Канал ЛС открывается отдельным запросом: его ID нужен для отправки
    const channel = await discordRequest<{ id: string }>(`/users/@me/channels`, {
      method: "POST",
      body: JSON.stringify({ recipient_id: uid }),
    });
    const channelId = assertDiscordId(String(channel?.id ?? ""), "ID канала ЛС");
    await discordRequest(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        // Упоминать бота в ЛС нельзя: payload приходит с @username бойца,
        // и без запрета упоминаний Discord подсветил бы чужой аккаунт
        allowed_mentions: { parse: [], users: [], roles: [] },
      }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function addReaction(
  channelId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  const ch = assertDiscordId(channelId, "ID канала Discord");
  const msg = assertDiscordId(messageId, "ID сообщения Discord");
  await discordRequest(
    `/channels/${ch}/messages/${msg}/reactions/${encodeURIComponent(emoji)}/@me`,
    { method: "PUT" }
  );
}

/** Роли участника гильдии через REST (null — если участник не найден/ошибка) */
export async function getGuildMemberRoles(
  guildId: string,
  userId: string
): Promise<string[] | null> {
  try {
    const g = assertDiscordId(guildId, "ID сервера Discord");
    const u = assertDiscordId(userId, "ID пользователя Discord");
    const member = await discordRequest<{ roles?: string[] }>(
      `/guilds/${g}/members/${u}`
    );
    return Array.isArray(member?.roles) ? member.roles : null;
  } catch {
    return null;
  }
}

/**
 * Выдать роль участнику (REST).
 *
 * Через REST, а не через кэш гильдии: решения по заявкам принимаются и из
 * веб-панели, где шлюзового клиента Discord нет вовсе.
 */
export async function addGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string
): Promise<void> {
  const g = assertDiscordId(guildId, "ID сервера Discord");
  const u = assertDiscordId(userId, "ID пользователя Discord");
  const r = assertDiscordId(roleId, "ID роли Discord");
  await discordRequest(`/guilds/${g}/members/${u}/roles/${r}`, { method: "PUT" });
}

/** Снять роль с участника (REST). Отсутствие роли у участника — не ошибка */
export async function removeGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string
): Promise<void> {
  const g = assertDiscordId(guildId, "ID сервера Discord");
  const u = assertDiscordId(userId, "ID пользователя Discord");
  const r = assertDiscordId(roleId, "ID роли Discord");
  await discordRequest(`/guilds/${g}/members/${u}/roles/${r}`, { method: "DELETE" });
}

/**
 * ID роли @everyone сервера: её снимать/выдавать нельзя, и она исключается из
 * списков управления ролями (в REST-ответе участника она приходит как его ID).
 */
export async function getGuildEveryoneRoleId(guildId: string): Promise<string | null> {
  try {
    const g = assertDiscordId(guildId, "ID сервера Discord");
    const guild = await discordRequest<{ id: string }>(`/guilds/${g}`);
    // @everyone — роль с тем же ID, что и сервер
    return guild?.id ?? null;
  } catch {
    return null;
  }
}

/** Отправка сообщения в ЛС участника (закрытые ЛС — не ошибка, см. sendDirectMessage) */
export async function notifyUser(userId: string, content: string): Promise<DmResult> {
  return sendDirectMessage(userId, { content });
}

/** Серверы, на которых состоит бот (для автоопределения guild_id) */
export async function getBotGuildIds(): Promise<string[]> {
  const guilds = await discordRequest<{ id: string }[]>("/users/@me/guilds");
  return Array.isArray(guilds) ? guilds.map((g) => g.id) : [];
}

export const mentionRole = (id: string) => `<@&${id}>`;
export const mentionUser = (id: string) => `<@${id}>`;

export const REACTIONS = [
  { emoji: "✅", label: "Буду на операции" },
  { emoji: "❌", label: "Не буду" },
  { emoji: "⏰", label: "Опоздаю" },
  { emoji: "❓", label: "Под вопросом" },
] as const;

/** Разбивает строку на куски, не превышающие лимит Discord (2000 симв.) */
export function chunkText(items: string[], limit = 1700): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const item of items) {
    const piece = current ? `${current} ${item}` : item;
    if (piece.length > limit) {
      if (current) chunks.push(current);
      current = item;
    } else {
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

