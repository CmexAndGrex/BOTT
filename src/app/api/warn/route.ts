import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, settings } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { memberId, type, norm } = body;

    // 1. Находим бойца
    const fighterRecord = await db.select().from(members).where(eq(members.id, memberId));
    if (!fighterRecord || fighterRecord.length === 0) {
      return NextResponse.json({ error: "Боец не найден" }, { status: 404 });
    }
    const fighter = fighterRecord[0];

    // 2. Обновляем ТОЛЬКО счетчик предупреждений (бойца не исключаем, ждем синхронизации с сайтом)
    const newWarnings = type === 1 ? 1 : 2;

    await db.update(members)
      .set({ warnings: newWarnings })
      .where(eq(members.id, memberId));

    // 3. ДОСТАЕМ НАСТРОЙКИ ИЗ ПАНЕЛИ
    const settingsData = await db.select().from(settings);
    const config = Object.fromEntries(settingsData.map((s) => [s.key, s.value]));

    // Расширенный поиск ключей (на случай, если в базе они названы иначе)
    const botToken = config["discord_bot_token"] || config["discordToken"] || config["discord_token"] || process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
    const channelId = config["discord_ping_channel"] || config["discord_channel_id"] || config["discordChannel"] || config["discord_channel"] || process.env.DISCORD_CHANNEL_ID;

    if (!botToken || !channelId) {
      return NextResponse.json({ error: "Токен или ID канала пусты. Проверьте настройки!" }, { status: 400 });
    }

    // 4. Формируем сообщение
    const ping = fighter.discordId ? `<@${fighter.discordId}>` : fighter.name;
    let messageContent = "";

    if (type === 1) {
      messageContent = `⚠️ ${ping} 1/2 предупреждение, онлайн за прошлую неделю ${fighter.hours.toFixed(1)} часов, ниже нормы ${norm}ч. Добить онлайн на новой недели, иначе исключение ⚠️`;
    } else {
      messageContent = `⛔ ${ping} 2/2 предупреждение, онлайн за эту неделю ${fighter.hours.toFixed(1)} часов, повторно ниже нормы. Исключён! ⛔`;
    }

    // 5. Отправляем в Discord
    const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId.trim()}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bot ${botToken.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: messageContent }),
    });

    // Если Discord ругается, отправляем точную причину на экран
    if (!discordRes.ok) {
      const errText = await discordRes.text();
      console.error("Ошибка Discord API:", errText);
      return NextResponse.json({ error: `Discord ответил отказом: ${errText}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true });

  } catch (error) {
    console.error("Ошибка выдачи предупреждения:", error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}