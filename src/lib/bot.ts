import { Client, GatewayIntentBits, Partials } from "discord.js";

const ROLE_IDS = {
  MODERATOR: "1089254387488145550",
  FRIEND: "1084735958399852544",
  RECRUIT: "1500793747544215592",
  ATK_CORPS: "1392226832274948207",
  RANKS_CATEGORY: "1089255012460417066",
  ARTILLERY_DIV: "1084414055088922634",
  TANK_COMP: "1084414184600633345",
  PRIVATE: "1090320507288699020",
};

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
  });

  // === 1. ОБРАБОТЧИК СООБЩЕНИЙ (ЧТЕНИЕ ЗАЯВОК) ===
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.content) return;
    
    // if (message.channelId !== "ВСТАВЬТЕ_ID_КАНАЛА_СЮДА") return;

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

    // Исключение для тестирования: разрешаем делать заявку на себя Администраторам Бота и Модераторам
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

    const actionMatch = commandLine.match(/^(Выдать|Снять)\s+(.+)$/i);
    if (!actionMatch) {
      const thread = await message.startThread({ name: "Ошибка формата", autoArchiveDuration: 60 });
      await thread.send(`<@&${ROLE_IDS.MODERATOR}> <@${recipientId}> создал заявку несоответствующую форме, закончите операцию вручную.`);
      await thread.setLocked(true);
      await thread.setArchived(true);
      return;
    }

    const action = actionMatch[1].toLowerCase(); // "выдать" или "снять"
    const actionTitle = action === "выдать" ? "Выдача" : "Снятие";
    const roleName = actionMatch[2].trim();

    if (roleName.includes("Модератор") || roleName.includes(ROLE_IDS.MODERATOR)) {
      const thread = await message.startThread({ name: "Нарушение прав", autoArchiveDuration: 60 });
      await thread.send(`<@&${ROLE_IDS.MODERATOR}> <@${recipientId}> попытался запросить выдачу/снятие модераторской роли, что запрещено!`);
      await thread.setLocked(true);
      await thread.setArchived(true);
      return;
    }

    let targetRole = null;
    const isComplex = roleName === "Рядовой ТР" || roleName === "Рядовой АД";

    if (!isComplex) {
      targetRole = message.guild?.roles.cache.find(r => r.name === roleName);
      if (!targetRole) {
        const thread = await message.startThread({ name: "Роль не найдена", autoArchiveDuration: 60 });
        await thread.send(`<@&${ROLE_IDS.MODERATOR}> <@${recipientId}> создал заявку на несуществующую роль "${roleName}", закончите операцию вручную.`);
        await thread.setLocked(true);
        await thread.setArchived(true);
        return;
      }
    }

    const displayName = targetMember?.displayName || "бойца";

    const thread = await message.startThread({ 
      name: `${actionTitle} роли для ${displayName}`,
      autoArchiveDuration: 1440
    });

    const roleDisplay = isComplex ? roleName : `${targetRole?.name} (ID: ${targetRole?.id})`;

    await thread.send(`🔴 **Ожидание подтверждения операции!**\n\n**Пользователь:** <@${recipientId}>\n**Команда:** ${commandLine}\n**Экзаменатор:** <@${examinerId}>\n**Роль:** ${roleDisplay}\n\nОжидается реакция :ATK: от <@${examinerId}> на исходном сообщении.`);
    await message.react("⏳");
  });

  // === 2. ОБРАБОТЧИК РЕАКЦИЙ (ВЫДАЧА РОЛЕЙ) ===
  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const message = reaction.message;
    if (!message.content) return;
    if (!message.reactions.cache.has("⏳")) return;

    const lines = message.content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 3) return;

    const cleanLine1 = lines[0].replace(/^(\d+[\.\)]\s*|-\s*)/, '');
    const cleanLine2 = lines[1].replace(/^(\d+[\.\)]\s*|-\s*)/, '');
    const cleanLine3 = lines[2].replace(/^(\d+[\.\)]\s*|-\s*)/, '');

    const recipientMatch = cleanLine1.match(/<@!?(\d+)>/);
    const examinerMatch = cleanLine2.match(/<@!?(\d+)>/);
    const actionMatch = cleanLine3.match(/^(Выдать|Снять)\s+(.+)$/i);
    
    if (!recipientMatch || !examinerMatch || !actionMatch) return;

    const recipientId = recipientMatch[1];
    const examinerId = examinerMatch[1];
    const action = actionMatch[1].toLowerCase();
    const roleName = actionMatch[2].trim();

    const thread = message.thread;
    if (!thread) return;

    const guild = message.guild;
    if (!guild) return;

    const reactorMember = await guild.members.fetch(user.id);
    const recipientMember = await guild.members.fetch(recipientId).catch(() => null);

    if (!recipientMember) return;

    const isExaminer = user.id === examinerId;
    const isModerator = reactorMember.roles.cache.has(ROLE_IDS.MODERATOR);
    const isAtkReaction = reaction.emoji.name === "ATK";

    if (!isAtkReaction) {
      if (isExaminer) {
        await reaction.users.remove(user.id);
        await thread.send(`⚠️ <@${examinerId}>, пожалуйста, используйте реакцию :ATK: для подтверждения!`);
      }
      return;
    }

    if (!isExaminer && !isModerator) {
      await reaction.users.remove(user.id);
      await thread.send(`⚠️ <@${user.id}>, только экзаменатор может подтвердить операцию!`);
      return;
    }

    const isComplex = roleName === "Рядовой ТР" || roleName === "Рядовой АД";
    let checkRoleId = null;
    
    if (isComplex) {
      checkRoleId = ROLE_IDS.PRIVATE;
    } else {
      const targetRole = guild.roles.cache.find(r => r.name === roleName);
      if (targetRole) checkRoleId = targetRole.id;
    }

    const hasRole = checkRoleId ? recipientMember.roles.cache.has(checkRoleId) : false;

    if (action === "выдать" && hasRole) {
      await message.reactions.cache.get("⏳")?.remove();
      await message.react("❌");
      await thread.send(`❌ Пользователь <@${recipientId}> уже имеет роль ${roleName}`);
      await thread.setLocked(true);
      await thread.setArchived(true);
      return;
    }

    if (action === "снять" && !hasRole) {
      await message.reactions.cache.get("⏳")?.remove();
      await message.react("❌");
      await thread.send(`❌ У пользователя <@${recipientId}> нет роли ${roleName}`);
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
          if (roleName === "Рядовой ТР") await recipientMember.roles.add(ROLE_IDS.TANK_COMP);
          if (roleName === "Рядовой АД") await recipientMember.roles.add(ROLE_IDS.ARTILLERY_DIV);
        } else { 
          await recipientMember.roles.remove([ROLE_IDS.ATK_CORPS, ROLE_IDS.RANKS_CATEGORY, ROLE_IDS.PRIVATE]);
          if (roleName === "Рядовой ТР") await recipientMember.roles.remove(ROLE_IDS.TANK_COMP);
          if (roleName === "Рядовой АД") await recipientMember.roles.remove(ROLE_IDS.ARTILLERY_DIV);

          const hasTank = recipientMember.roles.cache.has(ROLE_IDS.TANK_COMP);
          const hasArt = recipientMember.roles.cache.has(ROLE_IDS.ARTILLERY_DIV);
          if (!hasTank && !hasArt) await recipientMember.roles.add(ROLE_IDS.FRIEND);
        }
      } else if (checkRoleId) {
        if (action === "выдать") await recipientMember.roles.add(checkRoleId);
        else await recipientMember.roles.remove(checkRoleId);
      }

      const approverTitle = isExaminer ? `экзаменатором <@${examinerId}>` : `модератором <@${user.id}>`;
      await thread.send(`<@${recipientId}> ${approverTitle} была одобрена запрашиваемая вами операция!\n\n✅ **Операция успешно выполнена!**\nРоль: ${roleName} - ${action === "выдать" ? "Выдана" : "Снята"}`);
      
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