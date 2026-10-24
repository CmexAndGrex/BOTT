import { getSettings, resolveToken } from "@/lib/settings";
import { assertDiscordId } from "@/lib/validation";
import {
  DiscordApiError,
  discordQueue,
  parseRetryAfterMs,
} from "@/lib/discord-queue";

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
  /**
   * Тип компонента. Discord ОБЯЗАТЕЛЬНО требует `2` у кнопки: без него
   * сервер отвечает 400 Invalid Form Body (50035) и сообщение не уходит.
   * Поле необязательное в типе только ради совместимости с давно созданными
   * объектами — при отправке оно проставляется автоматически.
   */
  type?: 2;
  custom_id: string;
  label: string;
  /** 1 primary, 2 secondary, 3 success, 4 danger — только ЧИСЛА, не строки */
  style: 1 | 2 | 3 | 4;
  disabled?: boolean;
};

/** Ряд кнопок (component type 1) */
export type DiscordActionRow = { type: 1; components: DiscordButton[] };

/**
 * Числовые стили кнопок Discord.
 *
 * Строковые значения («SUCCESS», «DANGER») в теле запроса приводят к
 * 400 Invalid Form Body: Discord ожидает целое число, а не имя константы.
 */
export const BUTTON_STYLE = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
} as const;

/**
 * Санитация Embed перед отправкой.
 *
 * Discord отклоняет сообщение с 400, если в `fields` попадает пустое значение:
 * `value` не может быть пустой строкой (а также null/undefined), `name` — тоже.
 * Рапорты без подразделения и без комментария как раз давали такие поля.
 * Заголовок и описание пустой строкой приравниваются к отсутствию текста и
 * передаются как undefined: `""` в этих полях тоже невалидно.
 */
export function sanitizeEmbed(embed: DiscordEmbed): DiscordEmbed {
  const title = String(embed.title ?? "").trim();
  const description = String(embed.description ?? "").trim();
  const footerText = String(embed.footer?.text ?? "").trim();

  const fields = (embed.fields ?? [])
    .filter((f) => f && String(f.name ?? "").trim().length > 0)
    .map((f) => ({
      name: String(f.name).trim().slice(0, 256),
      // Пустое значение заменяем прочерком: 400 «value: This field is required»
      value: String(f.value ?? "").trim().slice(0, 1024) || "—",
      inline: Boolean(f.inline),
    }));

  return {
    ...(title ? { title: title.slice(0, 256) } : {}),
    ...(description ? { description: description.slice(0, 4096) } : {}),
    ...(Number.isFinite(embed.color) ? { color: embed.color } : {}),
    ...(embed.image?.url ? { image: embed.image } : {}),
    ...(footerText ? { footer: { text: footerText.slice(0, 2048) } } : {}),
    // Пустой массив полей Discord тоже считает ошибкой формы — просто не передаём
    ...(fields.length ? { fields } : {}),
    ...(embed.timestamp ? { timestamp: embed.timestamp } : {}),
  };
}

/**
 * Санитация компонентов сообщения.
 *
 * Гарантирует то, что Discord проверяет при разборе формы: каждая кнопка имеет
 * `type: 2` и числовой `style`, а сама кнопка лежит внутри ActionRow (`type: 1`).
 * Одиночная кнопка на верхнем уровне — тоже 400 Invalid Form Body.
 */
export function sanitizeComponents(
  components: DiscordActionRow[] | undefined
): DiscordActionRow[] | undefined {
  if (!components?.length) return undefined;

  const rows = components
    .filter((row) => row && Array.isArray(row.components))
    .map((row) => ({
      type: 1 as const,
      components: row.components
        .filter((button) => button && String(button.custom_id ?? "").trim())
        .map((button) => ({
          type: 2 as const,
          custom_id: String(button.custom_id).trim().slice(0, 100),
          label: String(button.label ?? "").trim().slice(0, 80) || "Действие",
          style: (
            typeof button.style === "number" && button.style >= 1 && button.style <= 4
              ? button.style
              : BUTTON_STYLE.SECONDARY
          ) as 1 | 2 | 3 | 4,
          ...(button.disabled ? { disabled: true } : {}),
        })),
    }))
    .filter((row) => row.components.length > 0);

  return rows.length ? rows : undefined;
}

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
        {
          type: 2,
          custom_id: approveId,
          label: "✅ Одобрить",
          style: BUTTON_STYLE.SUCCESS,
          disabled,
        },
        {
          type: 2,
          custom_id: rejectId,
          label: "❌ Отклонить",
          style: BUTTON_STYLE.DANGER,
          disabled,
        },
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
  // Лимиты очереди (параллелизм, пауза, число попыток) зафиксированы в коде —
  // см. DEFAULT_QUEUE_OPTIONS в src/lib/discord-queue.ts. Из настроек панели эти
  // поля убраны: слишком легко было получить 429 по кругу или «зависшую» сверку.
  //
  // Каждый запрос проходит через общую очередь: она держит лимит запросов к
  // Discord, а при 429 сама выдерживает Retry-After и повторяет попытку.
  return discordQueue().run(labelForPath(path), () => sendRequest<T>(path, init));
}

/**
 * Метка маршрута для логов и диагностики.
 *
 * ID из пути вырезаются: по журналу не должно быть видно, кого именно правит
 * бот, но должно быть видно, что это за операция (иначе разбор инцидента
 * «почему упали выдачи ролей» невозможен).
 */
function labelForPath(path: string): string {
  return path.replace(/\d{5,}/g, ":id");
}

/** Одна попытка HTTP-запроса к Discord без повторов и без очереди */
async function sendRequest<T>(path: string, init: RequestInit): Promise<T> {
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
    let code: number | null = null;
    let bodyRetryAfter: unknown = null;
    let rawError: unknown = null;
    try {
      const parsed = JSON.parse(body);
      rawError = parsed;
      if (parsed?.message) hint = parsed.message;
      if (typeof parsed?.code === "number") code = parsed.code;
      bodyRetryAfter = parsed?.retry_after;
    } catch {
      /* тело не JSON — покажем как есть */
      rawError = body;
    }

    // 429: Discord прямо говорит, сколько ждать. Отдаём значение в ошибку —
    // очередь выдержит паузу и повторит запрос, а не упадёт с «REST error».
    const retryAfterMs =
      res.status === 429
        ? parseRetryAfterMs(res.headers.get("retry-after"), bodyRetryAfter)
        : null;

    const error = new DiscordApiError(`Discord API (${res.status}): ${hint}`, {
      status: res.status,
      code,
      retryAfterMs,
      path: labelForPath(path),
      rawError,
    });

    // 400/50035 — ошибка формы запроса: Discord кладёт в тело точный путь до
    // проблемного поля (`embeds.0.fields.2.value`). Без этого в журнале видно
    // только «Invalid Form Body», и причину приходится угадывать.
    if (res.status === 400) {
      console.error("[DISCORD_400_DETAIL]", JSON.stringify(rawError, null, 2));
    }

    throw error;
  }

  if (res.status === 204) return null as T;
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

/**
 * Нормализация тела сообщения перед отправкой в Discord.
 *
 * Единая точка, потому что и создание, и правка сообщения обязаны отправлять
 * одинаково валидную форму: очищенные Embed-поля и кнопки с числовыми стилями
 * внутри ActionRow. Иначе 400 Invalid Form Body возвращался бы то из рапорта,
 * то из очереди модерации, и правку пришлось бы искать в двух местах.
 */
function normalizeMessagePayload(payload: {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  allowed_mentions?: { parse?: string[]; roles?: string[]; users?: string[] };
}): Record<string, unknown> {
  const content = String(payload.content ?? "").trim();

  return {
    // Пустой content допустим только при наличии Embed/компонентов; если он
    // пуст — просто не передаём поле, чтобы не слать "" в Discord
    ...(content ? { content: content.slice(0, 2000) } : {}),
    // Массив передан — значит вызывающий управляет полем явно. Пустой массив
    // при PATCH снимает Embed/кнопки, поэтому «схлопывать» его в undefined
    // нельзя: старые компоненты остались бы на сообщении.
    ...(Array.isArray(payload.embeds) ? { embeds: payload.embeds.map(sanitizeEmbed) } : {}),
    ...(Array.isArray(payload.components)
      ? { components: sanitizeComponents(payload.components) ?? [] }
      : {}),
    ...(payload.allowed_mentions ? { allowed_mentions: payload.allowed_mentions } : {}),
  };
}

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
    { method: "POST", body: JSON.stringify(normalizeMessagePayload(payload)) }
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
    body: JSON.stringify(normalizeMessagePayload(payload)),
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

/**
 * Роли сервера: id, имя и признак managed (роль бота/интеграции).
 *
 * Нужны сверке ролей: `managed` решает, можно ли вообще трогать роль, а имя —
 * то, по чему администратор ищет запись в журнале. Кэша здесь нет намеренно:
 * состав ролей меняется редко, но именно поэтому «устаревший кэш» и приводил бы
 * к попыткам выдать удалённую роль. Один запрос на цикл сверки — приемлемая цена.
 */
export async function getGuildRoles(
  guildId: string
): Promise<{ id: string; name: string; managed: boolean }[]> {
  const g = assertDiscordId(guildId, "ID сервера Discord");
  const roles = await discordRequest<{ id?: string; name?: string; managed?: boolean }[]>(
    `/guilds/${g}/roles`
  );
  if (!Array.isArray(roles)) return [];
  return roles
    .filter((r): r is { id: string; name: string; managed?: boolean } =>
      Boolean(r?.id && r?.name)
    )
    .map((r) => ({ id: r.id, name: r.name, managed: r.managed === true }));
}

/**
 * Роли участника гильдии через REST (null — если участник не найден/ошибка) */
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

