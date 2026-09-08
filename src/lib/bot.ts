/**
 * Discord-бот АТК (V1.7).
 *
 * Новая логика по ТЗ:
 *  1. Бот слушает каналы заявок (ШДС и отпуск) — ID берутся из настроек панели.
 *  2. Входящие вебхук-заявки парсятся по заголовкам «Подразделение»,
 *     «Редакция ШДС» / «Тип заявки», «Имя пользователя» и т.д.
 *  3. Реакции бот не ставит — ждёт ручного подтверждения от пользователя
 *     с ролью, упомянутой (пингованной) в заявке, или от модератора.
 *  4. ❌  → [ОТКАЗАНО] (+ DM для отпуска), :ATK:/🟢 → [ОДОБРЕНО И ВНЕСЕНО] /
 *     [ОДОБРЕНО]; для ШДС запускается алгоритм Google Таблицы (gsheets.ts).
 *  5. По реакции создаётся ветка (thread), куда пишется пинг того,
 *     кто подтвердил/отказал.
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
} from "discord.js";
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { applyShdsRequest, parseRequestText, type ParsedRequest } from "@/lib/gsheets";
import {
  applyRoleCommand,
  parseRoleRequest,
} from "@/lib/roles";

declare global {
  var __redopsBotClient: Client | undefined;
}

/* ------------------------------------------------------------------ */
/* Загрузка конфигурации бота из настроек панели                        */
/* ------------------------------------------------------------------ */

type BotConfig = {
  token: string;
  shdsChannelId: string;
  vacationChannelId: string;
  rolesChannelId: string;
  moderatorRoleId: string;
  leaveRoleId: string;
};

/** Значения по умолчанию — используются, если настройка в базе пустая */
const BOT_DEFAULTS = {
  moderatorRoleId: "1089254387488145550",
  leaveRoleId: "1166476218791645256",
};

async function loadBotConfig(): Promise<BotConfig> {
  const map = await getSettings();
  return {
    token:
      (map.get("discord_token") || "").trim() ||
      (process.env.DISCORD_BOT_TOKEN || "").trim(),
    shdsChannelId: (map.get("shds_channel_id") || "").trim(),
    vacationChannelId: (map.get("vacation_channel_id") || "").trim(),
    rolesChannelId: (map.get("roles_channel_id") || "").trim(),
    moderatorRoleId:
      (map.get("moderator_role_id") || "").trim() || BOT_DEFAULTS.moderatorRoleId,
    leaveRoleId: (map.get("leave_role_id") || "").trim() || BOT_DEFAULTS.leaveRoleId,
  };
}

/* ------------------------------------------------------------------ */
/* Кэш разобранных заявок (messageId → заявка)                          */
/* ------------------------------------------------------------------ */

/** Заявки в памяти: перечитываются из текста сообщения при необходимости */
const requestCache = new Map<string, ParsedRequest>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheRequest(messageId: string, req: ParsedRequest) {
  requestCache.set(messageId, req);
  // Ленивая чистка, чтобы карта не росла бесконечно
  if (requestCache.size > 500) {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [key] of requestCache) {
      const stamp = Number(key.split(":")[0]);
      if (Number.isFinite(stamp) && stamp < cutoff) requestCache.delete(key);
    }
  }
}

function getCachedRequest(messageId: string): ParsedRequest | null {
  return requestCache.get(messageId) || null;
}

/* ------------------------------------------------------------------ */
/* Помощники                                                           */
/* ------------------------------------------------------------------ */

/** Признак одобрения: зелёный круг, кастомный :ATK: или ✅ */
function isApproveEmoji(name: string): boolean {
  return name === "🟢" || name === "ATK" || name === "✅";
}

/** Реакция отказа */
function isDenyEmoji(name: string): boolean {
  return name === "❌";
}

/** Добавить префикс к сообщению заявки (защита от повторов) */
async function prefixMessage(message: Message, prefix: string): Promise<void> {
  const content = message.content || "";
  if (content.startsWith("[")) return; // уже обработано
  try {
    await message.edit(`${prefix} ${content}`);
  } catch (e) {
    console.error("[bot] Не удалось изменить сообщение заявки:", e);
  }
}

/** Найти или создать ветку под сообщением заявки */
async function ensureThread(message: Message, name: string) {
  try {
    if (message.thread) return message.thread;
    return await message.startThread({
      name: name.slice(0, 100),
      autoArchiveDuration: 1440,
    });
  } catch (e) {
    console.error("[bot] Не удалось создать ветку:", e);
    return null;
  }
}

/** Роли, упомянутые (пингованные) в тексте заявки */
function mentionedRoleIds(content: string): string[] {
  const ids = new Set<string>();
  for (const m of content.matchAll(/<@&(\d+)>/g)) ids.add(m[1]);
  return [...ids];
}

/**
 * Проверка прав реагирующего: у него должна быть роль, упомянутая в заявке,
 * либо роль модератора. Возвращает true, если реакция допустима.
 */
async function reactorIsAllowed(
  memberRoles: Set<string> | null,
  moderatorRoleId: string,
  content: string
): Promise<boolean> {
  if (!memberRoles) return false;
  if (moderatorRoleId && memberRoles.has(moderatorRoleId)) return true;
  const pinged = mentionedRoleIds(content);
  return pinged.some((id) => memberRoles.has(id));
}

/** Парсинг заявки из сообщения (с кэшем) */
function parseMessageRequest(message: Message): ParsedRequest | null {
  const cached = getCachedRequest(message.id);
  if (cached) return cached;
  if (!message.content) return null;
  const parsed = parseRequestText(message.content);
  if (parsed) cacheRequest(message.id, parsed);
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Обработка реакций в канале запросов ролей                            */
/* ------------------------------------------------------------------ */

type RolesReactionCtx = {
  guild: NonNullable<Message["guild"]>;
  message: Message;
  reaction: MessageReaction | PartialMessageReaction;
  user: User | PartialUser;
  deny: boolean;
  config: BotConfig;
};

/**
 * Одобрение (✅/🟢/:ATK:) или отказ (❌) запроса на выдачу/снятие ролей.
 * Разрешено: экзаменатору, указанному во второй строке, или модератору.
 */
async function handleRolesReaction({
  guild,
  message,
  reaction,
  user,
  deny,
  config,
}: RolesReactionCtx) {
  try {
    // Заявка на роли по тексту (2 строки: получатель, экзаменатор, команда)
    const roleReq = message.content ? parseRoleRequest(message.content) : null;
    if (!roleReq) return;

    // Уже обработано ранее (префикс стоит) — не срабатываем повторно
    if ((message.content || "").startsWith("[")) return;

    // Проверка прав реагирующего: это экзаменатор или модератор
    const reactor = await guild.members.fetch(user.id).catch(() => null);
    const isModerator =
      config.moderatorRoleId &&
      !!reactor &&
      reactor.roles.cache.has(config.moderatorRoleId);
    const isExaminer = reactor && reactor.id === roleReq.examinerId;

    if (!(isExaminer || isModerator)) {
      await reaction.users.remove(user.id).catch(() => {});
      const warnThread = await ensureThread(message, "Недостаточно прав");
      if (warnThread) {
        await warnThread.send(
          `⚠️ <@${user.id}>, подтвердить запрос ролей может только упомянутый экзаменатор или модератор. Реакция снята.`
        );
      }
      return;
    }

    const recipientMember = await guild.members
      .fetch(roleReq.recipientId)
      .catch(() => null);

    if (deny) {
      await prefixMessage(message, "[ОТКАЗАНО]");
      const thread = await ensureThread(message, "Отказ: запрос ролей");
      if (thread) {
        await thread.send(
          `🛑 Запрос ролей для <@${roleReq.recipientId}> — **ОТКАЗАНО**. Решение принял <@${user.id}>.`
        );
      }
      console.log(`[bot] Отказ запроса ролей: ${roleReq.line} (${user.tag})`);
      return;
    }

    if (!recipientMember) {
      await prefixMessage(message, "[Ошибка]");
      const thread = await ensureThread(message, "Ошибка: получатель не найден");
      if (thread) {
        await thread.send(
          `❌ Не удалось найти участника <@${roleReq.recipientId}> на сервере — роли не изменены.`
        );
      }
      return;
    }

    const result = await applyRoleCommand(guild, recipientMember, roleReq.ops);

    if (result.ok) {
      await prefixMessage(message, "[Роли обновлены]");
      const thread = await ensureThread(message, "Роли обновлены");
      if (thread) {
        await thread.send(
          `✅ Запрос ролей для <@${roleReq.recipientId}> — **ВЫПОЛНЕН**.\nИзменено: ${result.message}.\nРешение принял <@${user.id}>.`
        );
      }
      console.log(
        `[bot] Роли обновлены: <@${roleReq.recipientId}> ← ${result.message} (${user.tag})`
      );

      // Запись в журнал панели
      try {
        const { db: dbMod } = await import("@/db");
        const { logs } = await import("@/db/schema");
        await dbMod.insert(logs).values({
          category: "edit",
          author: user.tag || "Discord-бот",
          action: `выдал/снял роли бойцу ${recipientMember.displayName || roleReq.recipientId}`,
          details: {
            "Получатель": `<@${roleReq.recipientId}>`,
            "Экзаменатор": `<@${roleReq.examinerId}>`,
            "Операции": roleReq.ops.map((o) => `${o.action} ${o.name}`).join(", "),
            "Итог": result.message,
          },
          kind: "roles",
          title: "Запрос ролей выполнен",
          detail: result.message,
          ok: true,
        });
      } catch (e) {
        console.error("[bot] Не удалось записать журнал ролей:", e);
      }
    } else {
      await prefixMessage(message, "[Ошибка]");
      const thread = await ensureThread(message, "Ошибка: роли");
      if (thread) {
        await thread.send(
          `❌ Запрос ролей для <@${roleReq.recipientId}> — **НЕ ВЫПОЛНЕН**.\n<@${user.id}>, причина: ${result.message}`
        );
      }
    }
  } catch (e) {
    console.error("[bot] Ошибка обработки реакции ролей:", e);
  }
}

/* ------------------------------------------------------------------ */
/* Фоновая проверка отпусков (раз в минуту)                             */
/* ------------------------------------------------------------------ */

async function checkVacations(client: Client, config?: BotConfig) {
  try {
    // Конфиг читаем при каждом тике — правки из панели применяются сразу
    const cfg = config ?? (await loadBotConfig());
    const activeLeaves = await db
      .select()
      .from(members)
      .where(and(eq(members.vacation, true), isNotNull(members.vacationUntil)));

    if (activeLeaves.length === 0) return;

    const nowMs = Date.now();
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const guild = client.guilds.cache.first();
    if (!guild) return;
    const leaveChannel = cfg.vacationChannelId
      ? guild.channels.cache.get(cfg.vacationChannelId)
      : undefined;

    for (const u of activeLeaves) {
      if (!u.discordId || !u.vacationUntil) continue;

      const untilMs = u.vacationUntil.getTime();
      const member = await guild.members.fetch(u.discordId).catch(() => null);

      if (nowMs >= untilMs) {
        await db
          .update(members)
          .set({ vacation: false, vacationUntil: null, vacationNotified: false })
          .where(eq(members.id, u.id));
        if (member && cfg.leaveRoleId) {
          await member.roles.remove(cfg.leaveRoleId).catch(() => {});
        }

        if (leaveChannel && leaveChannel.isTextBased()) {
          await leaveChannel.send(
            `👋 <@${u.discordId}>, твой отпуск подошел к концу. Роль автоматически снята, ждем в строю!`
          );
        }
      } else if (untilMs - nowMs <= twelveHoursMs && !u.vacationNotified) {
        await db.update(members).set({ vacationNotified: true }).where(eq(members.id, u.id));
        if (leaveChannel && leaveChannel.isTextBased()) {
          await leaveChannel.send(
            `⚠️ <@${u.discordId}>, твой отпуск заканчивается **завтра**! Если нет возможности вернуться, запроси продление.`
          );
        }
      }
    }
  } catch (e) {
    console.error("[bot] Ошибка проверки отпусков:", e);
  }
}

/* ------------------------------------------------------------------ */
/* Инициализация бота                                                  */
/* ------------------------------------------------------------------ */

export function initBot() {
  if (globalThis.__redopsBotClient) return; // защита от повторного запуска

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  globalThis.__redopsBotClient = client;

  client.once("ready", () => {
    console.log(`🤖 Бот-слушатель АТК (ШДС/отпуск) запущен как ${client.user?.tag}`);
    void (async () => {
      const config = await loadBotConfig();
      // Фоновая проверка отпусков — раз в минуту
      setInterval(() => checkVacations(client, config), 60 * 1000);
    })();
  });

  /* -------------------------------------------------------------- */
  /* 1. Приём заявок (ШДС/отпуск) и команд на роли                  */
  /* -------------------------------------------------------------- */
  client.on("messageCreate", async (message: Message) => {
    try {
      if (message.author.bot && !message.webhookId) return; // чужие боты — мимо, вебхуки пропускаем
      if (!message.content) return;

      const config = await loadBotConfig();
      const isRolesChannel =
        config.rolesChannelId && message.channelId === config.rolesChannelId;
      const isShdsChannel = config.shdsChannelId && message.channelId === config.shdsChannelId;
      const isVacChannel =
        config.vacationChannelId && message.channelId === config.vacationChannelId;

      // Канал запросов ролей: «@боец / @экзаменатор / Выдать …, Снять …»
      if (isRolesChannel) {
        const roleReq = parseRoleRequest(message.content);
        if (roleReq) {
          const targets = roleReq.ops
            .map((o) => `${o.action === "give" ? "выдать" : "снять"} ${o.name}`)
            .join(", ");
          console.log(
            `[bot] Запрос ролей: <@${roleReq.recipientId}> ← ${targets} (экзаменатор <@${roleReq.examinerId}>)`
          );
        }
        return;
      }

      if (!isShdsChannel && !isVacChannel) return;

      // По ТЗ бот НЕ ставит реакции сам — только парсит заявку и запоминает её
      const parsed = parseMessageRequest(message);
      if (!parsed) return; // не похоже на заявку — игнорируем

      const kind = parsed.isVacation
        ? `Отпуск${parsed.vacationDates ? ` (${parsed.vacationDates})` : ""}`
        : parsed.shdsAction || "Редакция ШДС";
      console.log(`[bot] Принята заявка: ${kind} · ${parsed.unit} · ${parsed.userName}`);
    } catch (e) {
      console.error("[bot] Ошибка обработки сообщения:", e);
    }
  });

  /* -------------------------------------------------------------- */
  /* 2. Обработка реакций (одобрение / отказ)                        */
  /* -------------------------------------------------------------- */
  client.on(
    "messageReactionAdd",
    async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser
    ) => {
      try {
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();

        const message = reaction.message as Message;
        const guild = message.guild;
        if (!guild) return;

        const config = await loadBotConfig();
        const isRolesChannel =
          config.rolesChannelId && message.channelId === config.rolesChannelId;
        const isShdsChannel = config.shdsChannelId && message.channelId === config.shdsChannelId;
        const isVacChannel =
          config.vacationChannelId && message.channelId === config.vacationChannelId;

        const emojiName = reaction.emoji.name || "";
        const approve = isApproveEmoji(emojiName);
        const deny = isDenyEmoji(emojiName);
        if (!approve && !deny) return;

        // ======= Канал запросов ролей =======
        if (isRolesChannel) {
          await handleRolesReaction({ guild, message, reaction, user, deny, config });
          return;
        }

        if (!isShdsChannel && !isVacChannel) return;

        // Заявка определяется по тексту (или кэшу) — иначе это не заявка
        const req = parseMessageRequest(message);
        if (!req) return;

        // Уже обработано ранее (префикс стоит) — не срабатываем повторно
        if ((message.content || "").startsWith("[")) return;

        // Проверка прав реагирующего
        const reactor = await guild.members.fetch(user.id).catch(() => null);
        const allowed = await reactorIsAllowed(
          reactor ? new Set(reactor.roles.cache.keys()) : null,
          config.moderatorRoleId,
          message.content || ""
        );
        if (!allowed) {
          await reaction.users.remove(user.id).catch(() => {});
          const warnThread = await ensureThread(message, "Недостаточно прав");
          if (warnThread) {
            await warnThread.send(
              `⚠️ <@${user.id}>, у вас нет роли, упомянутой в заявке — реакция снята.`
            );
          }
          return;
        }

        const reactorMention = `<@${user.id}>`;
        const kindLabel = req.isVacation
          ? "Заявка на отпуск"
          : `Заявка «${req.shdsAction}»`;

        /* ---------- ОТКАЗ ---------- */
        if (deny) {
          await prefixMessage(message, "[ОТКАЗАНО]");

          // Заявка на отпуск — уведомляем бойца в ЛС
          if (req.isVacation && req.discordId) {
            const target = await guild.members.fetch(req.discordId).catch(() => null);
            if (target) {
              await target
                .send(`❌ Ваша заявка на отпуск была **отклонена**.${req.reason ? ` Причина: ${req.reason}.` : ""}`)
                .catch(() => console.log("[bot] Не удалось отправить ЛС (закрыты DM)"));
            }
          }

          const thread = await ensureThread(message, `Отказ: ${req.userName}`);
          if (thread) {
            await thread.send(`🛑 ${kindLabel} для **${req.userName}** — **ОТКАЗАНО**. Решение принял ${reactorMention}.`);
          }
          console.log(`[bot] Отказ: ${req.userName} (${user.tag})`);
          return;
        }

        /* ---------- ОДОБРЕНИЕ ---------- */
        await prefixMessage(
          message,
          req.isVacation ? "[ОДОБРЕНО]" : "[ОДОБРЕНО И ВНЕСЕНО]"
        );

        let outcome = "";
        if (req.isVacation) {
          // Отпуск: выдаём роль, синхронизируем БД, уведомляем в ЛС
          const target = req.discordId
            ? await guild.members.fetch(req.discordId).catch(() => null)
            : null;

          const untilDate = parseVacationUntil(req.vacationDates);
          if (target && config.leaveRoleId) {
            await target.roles.add(config.leaveRoleId).catch((e) =>
              console.error("[bot] Не удалось выдать роль «Отпуск»:", e)
            );
          }

          try {
            const [memberRow] = await db
              .select()
              .from(members)
              .where(eq(members.discordId, req.discordId));
            if (memberRow) {
              await db
                .update(members)
                .set({
                  vacation: true,
                  vacationUntil: untilDate,
                  vacationNotified: false,
                  updatedAt: new Date(),
                })
                .where(eq(members.id, memberRow.id));
            }
          } catch (e) {
            console.error("[bot] Ошибка синхронизации отпуска с БД:", e);
          }

          if (target) {
            await target
              .send(`✅ Ваша заявка на отпуск была **одобрена**!${untilDate ? ` Ориентировочная дата возвращения: ${formatDate(untilDate)}.` : ""}`)
              .catch(() => console.log("[bot] Не удалось отправить ЛС (закрыты DM)"));
          }
          outcome = target
            ? "роль выдана, БД синхронизирована, ЛС отправлено"
            : "участник Discord не найден — роль не выдана";
        } else {
          // ШДС: выполняем сценарий в Google Таблице
          const result = await applyShdsRequest(req);
          outcome = result.ok ? result.message : `ошибка: ${result.error}`;
        }

        const thread = await ensureThread(message, `Одобрено: ${req.userName}`);
        if (thread) {
          await thread.send(
            `✅ ${kindLabel} для **${req.userName}** — **${req.isVacation ? "ОДОБРЕНО" : "ОДОБРЕНО И ВНЕСЕНО"}**.\nРешил: ${reactorMention}.\nИтог: ${outcome}`
          );
        }
        console.log(`[bot] Одобрено: ${req.userName} (${user.tag}) — ${outcome}`);
      } catch (e) {
        console.error("[bot] Ошибка обработки реакции:", e);
      }
    }
  );

  /* -------------------------------------------------------------- */
  /* 3. Запуск бота                                                  */
  /* -------------------------------------------------------------- */
  getSettings()
    .then((map) => {
      const token =
        (map.get("discord_token") || "").trim() ||
        (process.env.DISCORD_BOT_TOKEN || "").trim();
      if (!token) {
        console.error(
          "❌ ОШИБКА БОТА: токен не найден. Укажите его в настройках панели (discord_token) или в переменной DISCORD_BOT_TOKEN."
        );
        return;
      }
      return client.login(token);
    })
    .catch((err) =>
      console.error("❌ Ошибка запуска бота (настройки/авторизация):", err)
    );
}

/* ------------------------------------------------------------------ */
/* Помощники для дат отпуска                                           */
/* ------------------------------------------------------------------ */

/**
 * Разбор «Даты отпуска» вида «с 10.11.2023 по 20.11.2023»
 * (или просто «20.11.2023»). Возвращает дату окончания или null.
 */
export function parseVacationUntil(raw: string): Date | null {
  if (!raw) return null;
  const range = raw.match(/(\d{2})\.(\d{2})\.(\d{4})\s*(?:-|по|–)\s*(\d{2})\.(\d{2})\.(\d{4})/i);
  const single = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const pick = (d: RegExpMatchArray, offset = 0) =>
    new Date(
      `${d[3 + offset]}-${d[2 + offset]}-${d[1 + offset]}T00:01:00+03:00`
    );
  try {
    if (range) return pick(range, 3);
    if (single) return pick(single);
  } catch {
    return null;
  }
  return null;
}

/** Красивый формат даты для сообщений */
export function formatDate(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

