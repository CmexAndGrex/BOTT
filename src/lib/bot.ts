import { Client, GatewayIntentBits, Partials } from "discord.js";
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";

const ROLE_IDS = {
  MODERATOR: "1089254387488145550",
  FRIEND: "1084735958399852544",
  RECRUIT: "1500793747544215592",
  ATK_CORPS: "1392226832274948207",
  RANKS_CATEGORY: "1089255012460417066",
  ARTILLERY_DIV: "1084414055088922634",
  TANK_COMP: "1084414184600633345",
  PRIVATE: "1090320507288699020",
  
  // 1. Впишите ID роли "Отпуск" ниже:
  LEAVE_ROLE: "1166476218791645256", 
};

// 2. Впишите ID канала "#запрос-в-отпуск" ниже:
const LEAVE_CHANNEL_ID = "1085141850966458519"; 

// 3. Впишите ID канала "#запрос-роли" ниже:
const ROLE_REQUEST_CHANNEL_ID = "1090516508725215253";

export function initBot() {
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

  client.once("ready", () => {
    console.log(`🤖 Бот-слушатель АТК успешно запущен как ${client.user?.tag}`);

    // === ФОНОВАЯ ПРОВЕРКА ОТПУСКОВ (РАЗ В МИНУТУ) ===
    setInterval(async () => {
      try {
        const activeLeaves = await db.select().from(members)
          .where(and(eq(members.vacation, true), isNotNull(members.vacationUntil)));
        
        if (activeLeaves.length === 0) return;

        const nowMs = Date.now();
        const twelveHoursMs = 12 * 60 * 60 * 1000;
        const guild = client.guilds.cache.first(); 
        if (!guild) return;
        const leaveChannel = guild.channels.cache.get(LEAVE_CHANNEL_ID);

        for (const u of activeLeaves) {
          if (!u.discordId || !u.vacationUntil) continue; 
          
          const untilMs = u.vacationUntil.getTime();
          const member = await guild.members.fetch(u.discordId).catch(() => null);

          if (nowMs >= untilMs) {
            await db.update(members).set({ vacation: false, vacationUntil: null, vacationNotified: false }).where(eq(members.id, u.id));
            if (member) await member.roles.remove(ROLE_IDS.LEAVE_ROLE).catch(() => {});
            
            if (leaveChannel && leaveChannel.isTextBased()) { 
              await leaveChannel.send(`👋 <@${u.discordId}>, твой отпуск подошел к концу. Роль автоматически снята, ждем в строю!`);
            }
          } 
          else if (untilMs - nowMs <= twelveHoursMs && !u.vacationNotified) {
            await db.update(members).set({ vacationNotified: true }).where(eq(members.id, u.id));
            if (leaveChannel && leaveChannel.isTextBased()) {
              await leaveChannel.send(`⚠️ <@${u.discordId}>, твой отпуск заканчивается **завтра**! Если нет возможности вернуться, запроси продление.`);
            }
          }
        }
      } catch (e) {
        console.error("Ошибка проверки отпусков:", e);
      }
    }, 60 * 1000);
  });

  // === 1. ОБРАБОТЧИК СООБЩЕНИЙ ===
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.content) return;
    
    // Блокировка: бот читает заявки только в канале #запрос-роли
    if (message.channelId !== ROLE_REQUEST_CHANNEL_ID) return;

    const lines = message.content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 3) return;

    const cleanLine1 = lines[0].replace(/^(\d+[\.\)]\s*|-\s*)/, '');
    const cleanLine2 = lines[1].replace(/^(\d+[\.\)]\s*|-\s*)/, '');
    const cleanLine3 = lines[2].replace(/^(\d+[\.\)]\s*|-\s*)/, '');

    const recipientMatch = cleanLine1.match(/<@!?(\d+)>/);
    const examinerMatch = cleanLine2.match(/<@!?(\d+)>/);
    if (!recipientMatch || !examinerMatch) return;

    const recipientId = recipientMatch[1];
    const examinerId = examinerMatch[1];
    const commandLine = cleanLine3;

    const targetMember = message.guild?.members.cache.get(recipientId);

    if (recipientId === examinerId) {
      const isBotAdmin = targetMember?.roles.cache.some(r => r.name === "Администратор Бота") || targetMember?.roles.cache.has(ROLE_IDS.MODERATOR);
      
      if (!isBotAdmin) {
        const thread = await message.startThread({ name: "Ошибка заявки", autoArchiveDuration: 60 });
        await thread.send(`❌ Ошибка: получатель роли и экзаменатор не могут быть одним и тем же пользователем!`);
        await message.react("❌");
        await thread.setLocked(true);
        await thread.setArchived(true);
        return;
      }
    }

    const actionMatch = commandLine.match(/^(Выдать|Снять)\s+(?:роль\s+)?(.+)$/i);
    if (!actionMatch) {
      const thread = await message.startThread({ name: "Ошибка формата", autoArchiveDuration: 60 });
      await thread.send(`<@&${ROLE_IDS.MODERATOR}> <@${recipientId}> создал заявку несоответствующую форме, закончите операцию вручную.`);
      await thread.setLocked(true);
      await thread.setArchived(true);
      return;
    }

    const action = actionMatch[1].toLowerCase(); 
    const actionTitle = action === "выдать" ? "Выдача" : "Снятие";
    const roleNameInput = actionMatch[2].trim();
    const normalizedRoleName = roleNameInput.toLowerCase();

    // === БРОНЯ: ЗАПРЕТ ВЫДАЧИ СИСТЕМНЫХ РОЛЕЙ ===
    if (
      normalizedRoleName.includes("модератор") || 
      normalizedRoleName.includes("администратор") || 
      roleNameInput.includes(ROLE_IDS.MODERATOR)
    ) {
      const thread = await message.startThread({ name: "Нарушение прав", autoArchiveDuration: 60 });
      await thread.send(`<@&${ROLE_IDS.MODERATOR}> <@${recipientId}> попытался запросить выдачу/снятие системной роли, что запрещено!`);
      await thread.setLocked(true);
      await thread.setArchived(true);
      return;
    }
    // ============================================

    let targetRole = null;
    let displayRoleName = roleNameInput;
    const isComplex = normalizedRoleName === "рядовой тр" || normalizedRoleName === "рядовой ад";

    if (!isComplex) {
      targetRole = message.guild?.roles.cache.find(r => r.name.toLowerCase() === normalizedRoleName);
      if (!targetRole) {
        const thread = await message.startThread({ name: "Роль не найдена", autoArchiveDuration: 60 });
        await thread.send(`<@&${ROLE_IDS.MODERATOR}> <@${recipientId}> создал заявку на несуществующую роль "${roleNameInput}", закончите операцию вручную.`);
        await thread.setLocked(true);
        await thread.setArchived(true);
        return;
      }
      displayRoleName = targetRole.name;
    } else {
      displayRoleName = normalizedRoleName === "рядовой тр" ? "Рядовой ТР" : "Рядовой АД";
    }

    const displayName = targetMember?.displayName || "бойца";

    const thread = await message.startThread({ 
      name: `${actionTitle} роли для ${displayName}`,
      autoArchiveDuration: 1440
    });

    const roleDisplay = isComplex ? displayRoleName : `${displayRoleName} (ID: ${targetRole?.id})`;

    await thread.send(`🔴 **Ожидание подтверждения операции!**\n\n**Пользователь:** <@${recipientId}>\n**Команда:** ${commandLine}\n**Экзаменатор:** <@${examinerId}>\n**Роль:** ${roleDisplay}\n\nОжидается реакция :ATK: от <@${examinerId}> для подтверждения или ❌ для отмены.`);
    await message.react("⏳");
  });

  // === 2. ОБРАБОТЧИК РЕАКЦИЙ ===
  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const message = reaction.message;
    const guild = message.guild;
    if (!guild) return;

    // --- ЛОГИКА ОТПУСКОВ ---
    if (message.channelId === LEAVE_CHANNEL_ID && reaction.emoji.name === "✅") {
      console.log(`[Отпуск] Получена реакция от ${user.tag} в сообщении ${message.id}`);
      
      const reactorMember = await guild.members.fetch(user.id);
      const isMod = reactorMember.roles.cache.has(ROLE_IDS.MODERATOR) || reactorMember.roles.cache.some(r => r.name === "Администратор Бота");
      
      if (!isMod) {
        console.log(`[Отпуск] Отмена: у ${user.tag} нет нужных прав.`);
        return;
      }

      const mentionMatch = message.content?.match(/<@!?(\d+)>/);
      if (!mentionMatch) {
        console.log(`[Отпуск] Отмена: в тексте не найден пинг бойца.`);
        return;
      }
      
      const targetId = mentionMatch[1];
      const targetMember = await guild.members.fetch(targetId).catch(() => null);
      if (!targetMember) return;

      const content = (message.content || "").toLowerCase(); 
      const isRevoke = content.includes("снять");
      
      let thread = message.thread;

      if (isRevoke) {
        await targetMember.roles.remove(ROLE_IDS.LEAVE_ROLE).catch(console.error);
        await db.update(members).set({ vacation: false, vacationUntil: null, vacationNotified: false }).where(eq(members.discordId, targetMember.id));
        
        if (!thread) thread = await message.startThread({ name: "Отпуск снят", autoArchiveDuration: 60 });
        await thread.send(`Отпуск досрочно снят у <@${targetMember.id}> модератором <@${user.id}>. База синхронизирована.`);
        return;
      } else {
        let leaveUntilDate = null;
        const dateMatch = (message.content || "").match(/\d{2}\.\d{2}\.\d{4}\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/);
        if (dateMatch) {
          leaveUntilDate = new Date(`${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}T00:01:00+03:00`);
        }

        await targetMember.roles.add(ROLE_IDS.LEAVE_ROLE).catch(console.error);
        await db.update(members).set({ vacation: true, vacationUntil: leaveUntilDate, vacationNotified: false }).where(eq(members.discordId, targetMember.id));
        
        if (!thread) thread = await message.startThread({ name: "Отпуск одобрен", autoArchiveDuration: 60 });
        let reply = `Отпуск одобрен для <@${targetMember.id}> модератором <@${user.id}>. Роль выдана.`;
        
        if (leaveUntilDate && dateMatch) { 
          reply += `\n📅 Дата автоматического возвращения: **${dateMatch[1]}.${dateMatch[2]}.${dateMatch[3]}** в 00:01 МСК`;
        }
        await thread.send(reply);
        return;
      }
    }
    // --- КОНЕЦ ЛОГИКИ ОТПУСКОВ ---

    if (!message.content) return;
    if (!message.reactions.cache.has("⏳")) return;
    
    if (message.channelId !== ROLE_REQUEST_CHANNEL_ID) return;

    const lines = message.content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 3) return;

    const cleanLine1 = lines[0].replace(/^(\d+[\.\)]\s*|-\s*)/, '');
    const cleanLine2 = lines[1].replace(/^(\d+[\.\)]\s*|-\s*)/, '');
    const cleanLine3 = lines[2].replace(/^(\d+[\.\)]\s*|-\s*)/, '');

    const recipientMatch = cleanLine1.match(/<@!?(\d+)>/);
    const examinerMatch = cleanLine2.match(/<@!?(\d+)>/);
    const actionMatch = cleanLine3.match(/^(Выдать|Снять)\s+(?:роль\s+)?(.+)$/i);
    
    if (!recipientMatch || !examinerMatch || !actionMatch) return;

    const recipientId = recipientMatch[1];
    const examinerId = examinerMatch[1];
    const action = actionMatch[1].toLowerCase();
    const roleNameInput = actionMatch[2].trim();
    const normalizedRoleName = roleNameInput.toLowerCase();

    const thread = message.thread;
    if (!thread) return;

    const reactorMember = await guild.members.fetch(user.id);
    const recipientMember = await guild.members.fetch(recipientId).catch(() => null);

    if (!recipientMember) return;

    const isExaminer = user.id === examinerId;
    const isModerator = reactorMember.roles.cache.has(ROLE_IDS.MODERATOR);
    const isAtkReaction = reaction.emoji.name === "ATK";
    const isCancelReaction = reaction.emoji.name === "❌";

    if (!isAtkReaction && !isCancelReaction) {
      if (isExaminer) {
        await reaction.users.remove(user.id);
        await thread.send(`⚠️ <@${examinerId}>, пожалуйста, используйте реакцию :ATK: для подтверждения или ❌ для отмены!`);
      }
      return;
    }

    if (!isExaminer && !isModerator) {
      await reaction.users.remove(user.id);
      await thread.send(`⚠️ <@${user.id}>, только экзаменатор может управлять этой операцией!`);
      return;
    }

    if (isCancelReaction) {
      await message.reactions.cache.get("⏳")?.remove();
      await message.react("❌");
      await thread.send(`🛑 Операция была **отменена** экзаменатором <@${user.id}>.`);
      await thread.setLocked(true);
      await thread.setArchived(true);
      return;
    }

    const isComplex = normalizedRoleName === "рядовой тр" || normalizedRoleName === "рядовой ад";
    let checkRoleId = null;
    let displayRoleName = roleNameInput;
    
    if (isComplex) {
      checkRoleId = ROLE_IDS.PRIVATE;
      displayRoleName = normalizedRoleName === "рядовой тр" ? "Рядовой ТР" : "Рядовой АД";
    } else {
      const targetRole = guild.roles.cache.find(r => r.name.toLowerCase() === normalizedRoleName);
      if (targetRole) {
        checkRoleId = targetRole.id;
        displayRoleName = targetRole.name;
      }
    }

    const hasRole = checkRoleId ? recipientMember.roles.cache.has(checkRoleId) : false;

    if (action === "выдать" && hasRole) {
      await message.reactions.cache.get("⏳")?.remove();
      await message.react("❌");
      await thread.send(`❌ Пользователь <@${recipientId}> уже имеет роль ${displayRoleName}`);
      await thread.setLocked(true);
      await thread.setArchived(true);
      return;
    }

    if (action === "снять" && !hasRole) {
      await message.reactions.cache.get("⏳")?.remove();
      await message.react("❌");
      await thread.send(`❌ У пользователя <@${recipientId}> нет роли ${displayRoleName}`);
      await thread.setLocked(true);
      await thread.setArchived(true);
      return;
    }

    try {
      if (isComplex) {
        if (action === "выдать") {
          if (recipientMember.roles.cache.has(ROLE_IDS.FRIEND)) await recipientMember.roles.remove(ROLE_IDS.FRIEND);
          if (recipientMember.roles.cache.has(ROLE_IDS.RECRUIT)) await recipientMember.roles.remove(ROLE_IDS.RECRUIT);
          
          await recipientMember.roles.add([ROLE_IDS.ATK_CORPS, ROLE_IDS.RANKS_CATEGORY, ROLE_IDS.PRIVATE]);
          if (normalizedRoleName === "рядовой тр") await recipientMember.roles.add(ROLE_IDS.TANK_COMP);
          if (normalizedRoleName === "рядовой ад") await recipientMember.roles.add(ROLE_IDS.ARTILLERY_DIV);
        } else { 
          await recipientMember.roles.remove([ROLE_IDS.ATK_CORPS, ROLE_IDS.RANKS_CATEGORY, ROLE_IDS.PRIVATE]);
          if (normalizedRoleName === "рядовой тр") await recipientMember.roles.remove(ROLE_IDS.TANK_COMP);
          if (normalizedRoleName === "рядовой ад") await recipientMember.roles.remove(ROLE_IDS.ARTILLERY_DIV);

          const hasTank = recipientMember.roles.cache.has(ROLE_IDS.TANK_COMP);
          const hasArt = recipientMember.roles.cache.has(ROLE_IDS.ARTILLERY_DIV);
          if (!hasTank && !hasArt) await recipientMember.roles.add(ROLE_IDS.FRIEND);
        }
      } else if (checkRoleId) {
        if (action === "выдать") await recipientMember.roles.add(checkRoleId);
        else await recipientMember.roles.remove(checkRoleId);
      }

      const approverTitle = isExaminer ? `экзаменатором <@${examinerId}>` : `модератором <@${user.id}>`;
      await thread.send(`<@${recipientId}> ${approverTitle} была одобрена запрашиваемая вами операция!\n\n✅ **Операция успешно выполнена!**\nРоль: ${displayRoleName} - ${action === "выдать" ? "Выдана" : "Снята"}`);
      
      await message.reactions.cache.get("⏳")?.remove();
      await message.react("✅");
      
      await thread.setLocked(true);
      await thread.setArchived(true);

    } catch (error) {
      console.error(error);
      await message.reactions.cache.get("⏳")?.remove();
      await message.react("❌");
      await thread.send(`❌ Произошла системная ошибка при попытке изменить роли. Проверьте иерархию прав бота.`);
      await thread.setLocked(true);
      await thread.setArchived(true);
    }
  });

  // === АВТОВЫДАЧА РОЛЕЙ НОВИЧКАМ ===
  client.on("guildMemberAdd", async (member) => {
    try {
      await member.roles.add(ROLE_IDS.FRIEND);
      console.log(`[Автороль] Роль "Друг АТК" выдана новичку: ${member.user.tag}`);
    } catch (error) {
      console.error(`[Автороль] Ошибка выдачи роли для ${member.user.tag}:`, error);
    }
  });

  // === 3. ЗАПУСК БОТА ===
  import("@/lib/settings").then(async ({ getSettings, resolveToken }) => {
    const token = resolveToken(await getSettings()) || process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      console.error("❌ ОШИБКА БОТА: Токен не найден ни в настройках панели, ни в файле .env!");
      return;
    }
    client.login(token).catch(err => console.error("❌ Ошибка авторизации в Discord:", err));
  }).catch(err => {
    console.error("❌ Ошибка загрузки настроек БД для бота, пробуем запустить из .env...");
    if (process.env.DISCORD_BOT_TOKEN) {
      client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);
    }
  });
}