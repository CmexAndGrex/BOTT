import { getSettings, resolveToken } from "@/lib/settings";

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
    allowed_mentions?: {
      parse?: string[];
      roles?: string[];
      users?: string[];
    };
  }
): Promise<ChannelMessage> {
  return discordRequest<ChannelMessage>(
    `/channels/${channelId}/messages`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export async function addReaction(
  channelId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  await discordRequest(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    { method: "PUT" }
  );
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
