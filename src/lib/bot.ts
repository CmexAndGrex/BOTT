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
import { applyShdsRequest, parseRequestText, SHDS_ACTIONS, type ParsedRequest } from "@/lib/gsheets";
import { applyRoleCommand, parseRoleCommand, parseRoleRequest, COMMON_ROLE_IDS } from "@/lib/roles";
import { moveToReserve, returnFromReserve } from "@/lib/reserve";

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
  commandRoleId: string;
  leaveRoleId: string;
  reserveRoleId: string;
};

/** Значения по умолчанию — используются, если настройка в базе пустая */
const BOT_DEFAULTS = {
  moderatorRoleId: "1089254387488145550",
  commandRoleId: "1392552505162072264",
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
    commandRoleId:
      (map.get("command_role_id") || "").trim() || BOT_DEFAULTS.commandRoleId,
    leaveRoleId: (map.get("leave_role_id") || "").trim() || BOT_DEFAULTS.leaveRoleId,
    reserveRoleId: (map.get("reserve_role_id") || "").trim(),
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
            "Экзаменатор": roleReq.examinerId ? `<@${roleReq.examinerId}>` : "— (заявка из формы)",
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
    const guild = client.guilds.cache.first();
    if (!guild) return;
    const leaveChannel = cfg.vacationChannelId
      ? guild.channels.cache.get(cfg.vacationChannelId)
      : undefined;

    // Напоминание за день до конца отпуска — строго в 12:00 МСК (или позже
    // в тот же день, если бот перезапускался): час в Европе/Москве >= 12.
    const mskHour = parseInt(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
      10
    );
    const oneDayMs = 24 * 60 * 60 * 1000;

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
      } else if (
        untilMs - nowMs <= oneDayMs &&
        Number.isFinite(mskHour) &&
        mskHour >= 12 &&
        !u.vacationNotified
      ) {
        await db.update(members).set({ vacationNotified: true }).where(eq(members.id, u.id));
        if (leaveChannel && leaveChannel.isTextBased()) {
          await leaveChannel.send(
            `⚠️ <@${u.discordId}>, твой отпуск заканчивается **завтра**! Не забудь зайти в игру. Если нет возможности вернуться — запроси продление через форму.`
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
            `[bot] Запрос ролей: <@${roleReq.recipientId}> ← ${targets}${roleReq.examinerId ? ` (экзаменатор <@${roleReq.examinerId}>)` : ""}`
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

        // «Убрать из таблицы» (удаление бойца) — одобряет ТОЛЬКО Командирский состав
        if (req.shdsAction === SHDS_ACTIONS.REMOVE) {
          const hasCommand =
            !!reactor &&
            !!config.commandRoleId &&
            reactor.roles.cache.has(config.commandRoleId);
          if (!hasCommand) {
            await reaction.users.remove(user.id).catch(() => {});
            const warnThread = await ensureThread(message, "Недостаточно прав");
            if (warnThread) {
              await warnThread.send(
                `⚠️ <@${user.id}>, удалить бойца из ШДС может только **Командирский состав**. Реакция снята.`
              );
            }
            return;
          }
        } else {
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
        }

        const reactorMention = `<@${user.id}>`;
        const kindLabel = req.isVacation
          ? "Заявка на отпуск"
          : isReserveRequest(req)
            ? `Заявка «${req.shdsAction}»`
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
          // Отпуск: выдача или снятие статуса + роль «Отпуск» + БД
          const did = await resolveDiscordId(req);
          const target = did
            ? await guild.members.fetch(did).catch(() => null)
            : null;

          const untilDate = req.vacationRemove ? null : parseVacationUntil(req.vacationDates);
          if (target && config.leaveRoleId) {
            if (req.vacationRemove) {
              await target.roles.remove(config.leaveRoleId).catch((e) =>
                console.error("[bot] Не удалось снять роль «Отпуск»:", e)
              );
            } else {
              await target.roles.add(config.leaveRoleId).catch((e) =>
                console.error("[bot] Не удалось выдать роль «Отпуск»:", e)
              );
            }
          }

          try {
            const [memberRow] = did
              ? await db
                  .select()
                  .from(members)
                  .where(eq(members.discordId, did))
              : [];
            const matchRow =
              memberRow ??
              (req.userName
                ? (await db
                    .select()
                    .from(members)
                    .where(eq(members.name, req.userName)))[0]
                : undefined);
            if (matchRow) {
              await db
                .update(members)
                .set(
                  req.vacationRemove
                    ? {
                        vacation: false,
                        vacationUntil: null,
                        vacationNotified: false,
                        updatedAt: new Date(),
                      }
                    : {
                        vacation: true,
                        vacationUntil: untilDate,
                        vacationNotified: false,
                        updatedAt: new Date(),
                      }
                )
                .where(eq(members.id, matchRow.id));
            }
          } catch (e) {
            console.error("[bot] Ошибка синхронизации отпуска с БД:", e);
          }

          if (target) {
            await target
              .send(
                req.vacationRemove
                  ? `✅ Ваша заявка на **снятие отпуска** была одобрена. Роль снята, статус в БД обновлён. Ждём в строю!`
                  : `✅ Ваша заявка на отпуск была **одобрена**!${untilDate ? ` Ориентировочная дата возвращения: ${formatDate(untilDate)}.` : ""}`
              )
              .catch(() => console.log("[bot] Не удалось отправить ЛС (закрыты DM)"));
          }
          outcome = target
            ? req.vacationRemove
              ? "отпуск снят: роль убрана, БД синхронизирована, ЛС отправлено"
              : "роль выдана, БД синхронизирована, ЛС отправлено"
            : "участник Discord не найден — роль не изменена";
        } else if (isReserveRequest(req)) {
          // Запас: работа с Google Таблицей + роли Discord
          const reserveResult = await applyReserveRequest(req, guild, config);
          outcome = reserveResult.ok
            ? reserveResult.message
            : `ошибка: ${reserveResult.error}`;
        } else {
          // ШДС: выполняем сценарий в Google Таблице
          const result = await applyShdsRequest(req);
          outcome = result.ok ? result.message : `ошибка: ${result.error}`;

          // «Убрать из таблицы»: снимаем ВСЕ роли бойца и выдаём «Друг АТК»
          if (result.ok && req.shdsAction === SHDS_ACTIONS.REMOVE) {
            try {
              const remDid = await resolveDiscordId(req);
              const target = remDid
                ? await guild.members.fetch(remDid).catch(() => null)
                : null;
              if (target) {
                const removable = [...target.roles.cache.keys()].filter(
                  (id) =>
                    id !== guild.roles.everyone.id &&
                    id !== COMMON_ROLE_IDS.FRIEND &&
                    !target.roles.cache.get(id)?.managed // ботовые/интеграционные роли не трогаем
                );
                if (removable.length) {
                  await target.roles.remove(removable).catch((e) =>
                    console.error("[bot] Не удалось снять роли при удалении:", e)
                  );
                }
                await target.roles.add(COMMON_ROLE_IDS.FRIEND).catch((e) =>
                  console.error("[bot] Не удалось выдать «Друг АТК»:", e)
                );
                outcome += `. Роли: снято ${removable.length}, выдана «Друг АТК»`;
              } else {
                outcome += ". Роли не изменены: участник Discord не найден";
              }
            } catch (e) {
              console.error("[bot] Ошибка снятия ролей при удалении из ШДС:", e);
              outcome += `. Роли: ошибка (${e instanceof Error ? e.message : e})`;
            }
          }

          // «Добавление в ШДС»: роли выдаются АВТОМАТИЧЕСКИ из данных
          // заявки — направление (ТР/АД) + звание + общие роли (корпус,
          // категория «Звания», снятие «Новобранца»/«Друга АТК»).
          // Дополнительно учитываются «Роли выдать/снять», если боец их выбрал.
          if (result.ok && req.shdsAction === SHDS_ACTIONS.ADD) {
            try {
              const addDid = await resolveDiscordId(req);
              const target = addDid
                ? await guild.members.fetch(addDid).catch(() => null)
                : null;
              if (target) {
                // Направление: «Танковая рота» → ТР, «Артиллерийский дивизион» → АД
                const subdiv = /танк/i.test(req.unit)
                  ? "ТР"
                  : /арт|дивизион/i.test(req.unit)
                    ? "АД"
                    : "";
                const rank = req.rank.trim();
                // Если звание уже с суффиксом («Рядовой ТР») — не дублируем
                const rankHasSuffix = /(ТР|АД)$/i.test(rank);

                const parts: string[] = [];
                if (rank && subdiv && !rankHasSuffix) {
                  parts.push(`Выдать ${rank} ${subdiv}`); // составное звание: направление + звание + общие роли
                } else if (rank) {
                  parts.push(`Выдать ${rank}`);
                } else {
                  parts.push("Выдать Новобранец"); // звание не указано — минимум для новичка
                }
                if (req.rolesGive) parts.push(`Выдать ${req.rolesGive}`);
                if (req.rolesRemove) parts.push(`Снять ${req.rolesRemove}`);

                const roleResult = await applyRoleCommand(guild, target, parseRoleCommand(parts.join(", ")));
                outcome += roleResult.ok
                  ? `. Роли: ${roleResult.message}`
                  : `. Роли НЕ изменены: ${roleResult.message}`;
              } else {
                outcome += ". Роли не изменены: участник Discord не найден";
              }
            } catch (e) {
              console.error("[bot] Ошибка выдачи ролей при добавлении в ШДС:", e);
              outcome += `. Роли: ошибка (${e instanceof Error ? e.message : e})`;
            }
          }
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
 * Discord ID бойца: из заявки либо из БД панели по имени
 * (форма может не содержать ID — например, боец выбрал себя из списка).
 */
async function resolveDiscordId(req: ParsedRequest): Promise<string> {
  if (req.discordId) return req.discordId;
  if (!req.userName) return "";
  try {
    const rows = await db
      .select({ discordId: members.discordId })
      .from(members)
      .where(eq(members.name, req.userName));
    return rows.find((r) => r.discordId)?.discordId || "";
  } catch {
    return "";
  }
}

/**
 * Разбор «Даты отпуска» вида «с 10.11.2023 по 20.11.2023»
 * (или просто «20.11.2023», «10.11»). Возвращает дату окончания или null.
 */
export function parseVacationUntil(raw: string): Date | null {
  if (!raw) return null;
  const range = raw.match(/(\d{2})\.(\d{2})\.(\d{4})\s*(?:-|по|–)\s*(\d{2})\.(\d{2})\.(\d{4})/i);
  const single = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const short = raw.match(/(?:^|[^\d.])(\d{1,2})\.(\d{2})(?:[^\d.]|$)/);
  const pick = (d: RegExpMatchArray, offset = 0) =>
    new Date(
      `${d[3 + offset]}-${d[2 + offset]}-${d[1 + offset]}T00:01:00+03:00`
    );
  try {
    if (range) return pick(range, 3);
    if (single) return pick(single);
    if (short) {
      // «10.11» без года — ближайший такой день (этот год или следующий)
      const now = new Date();
      const year = now.getFullYear();
      const thisYear = new Date(`${year}-${short[2]}-${short[1].padStart(2, "0")}T00:01:00+03:00`);
      if (thisYear.getTime() >= Date.now() - 24 * 3600 * 1000) return thisYear;
      return new Date(`${year + 1}-${short[2]}-${short[1].padStart(2, "0")}T00:01:00+03:00`);
    }
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

/** Признак заявки на запас (уйти / вернуться) */
function isReserveRequest(req: ParsedRequest): boolean {
  if (req.shdsAction === "Уход в запас" || req.shdsAction === "Возврат из запаса") return true;
  const action = (req.shdsAction || "").toLowerCase();
  return action.includes("запас");
}

/** Обработка одобренной заявки на запас: таблица + роли Discord */
async function applyReserveRequest(
  req: ParsedRequest,
  guild: NonNullable<Message["guild"]>,
  config: BotConfig
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const isGoing = req.shdsAction !== SHDS_ACTIONS.RESERVE_BACK;
  const did = await resolveDiscordId(req);
  const target = did
    ? await guild.members.fetch(did).catch(() => null)
    : null;

  try {
    if (isGoing) {
      // Уходим в запас: собираем роли для сохранения, затем меняем
      const rolesToSave = target
        ? [...target.roles.cache.keys()].filter((id) => id !== guild.roles.everyone.id)
        : [];

      const result = await moveToReserve({
        userName: req.userName,
        unit: req.unit,
        rank: req.rank,
        steamId: req.steamId,
        discordId: req.discordId,
        post: req.должность,
        roles: rolesToSave,
      });

      if (!result.ok) return { ok: false, error: result.error };

      // Снимаем все роли клана и выдаём «Запас»
      if (target) {
        const removable = [...target.roles.cache.keys()].filter(
          (id) => id !== guild.roles.everyone.id && id !== config.reserveRoleId
        );
        if (removable.length) await target.roles.remove(removable).catch(() => {});
        if (config.reserveRoleId) await target.roles.add(config.reserveRoleId).catch(() => {});
      }
      return { ok: true, message: result.message };
    } else {
      // Возвращаемся из запаса
      const result = await returnFromReserve({
        userName: req.userName,
        unit: req.unit,
        rank: req.rank,
        steamId: req.steamId,
        discordId: req.discordId,
        post: req.должность,
      });

      if (!result.ok) return { ok: false, error: result.error };

      // Снимаем «Запас» и восстанавливаем сохранённые роли
      if (target) {
        if (config.reserveRoleId) await target.roles.remove(config.reserveRoleId).catch(() => {});
        if (result.roles?.length) {
          const validRoles = result.roles.filter((id) => guild.roles.cache.has(id));
          if (validRoles.length) await target.roles.add(validRoles).catch(() => {});
        }
      }
      return { ok: true, message: result.message };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

