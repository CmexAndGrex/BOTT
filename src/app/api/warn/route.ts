import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");
const discordRateLimit = new Map<string, number>();

export async function POST(req: NextRequest) {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  
  try { await jwtVerify(token, SECRET); } 
  catch (err) { return NextResponse.json({ error: "Сессия устарела" }, { status: 403 }); }

  try {
    let body;
    try { body = await req.json(); } 
    catch { return NextResponse.json({ error: "Некорректный формат данных" }, { status: 400 }); }

    const { memberId, type, norm } = body;

    if (typeof memberId !== "number" || !Number.isFinite(memberId)) return NextResponse.json({ error: "Неверный ID" }, { status: 400 });
    if (type !== 1 && type !== 2) return NextResponse.json({ error: "Тип 1 или 2" }, { status: 400 });
    if (typeof norm !== "number" || norm < 1 || norm > 168) return NextResponse.json({ error: "Некорректная норма" }, { status: 400 });

    const now = Date.now();
    const lastWarningTime = discordRateLimit.get("last_warn") || 0;
    if (now - lastWarningTime < 3000) return NextResponse.json({ error: "Слишком часто" }, { status: 429 });
    discordRateLimit.set("last_warn", now);

    const fighterRecord = await db.select().from(members).where(eq(members.id, memberId));
    if (!fighterRecord || fighterRecord.length === 0) return NextResponse.json({ error: "Боец не найден" }, { status: 404 });
    
    const fighter = fighterRecord[0];
    const newWarnings = type === 1 ? 1 : 2;
    await db.update(members).set({ warnings: newWarnings }).where(eq(members.id, memberId));

    const settingsData = await db.select().from(settings);
    const config = Object.fromEntries(settingsData.map((s) => [s.key, s.value]));

    const botToken = config["discord_bot_token"] || process.env.DISCORD_BOT_TOKEN;
    const channelId = config["discord_channel_id"] || process.env.DISCORD_CHANNEL_ID;

    if (!botToken || !channelId) return NextResponse.json({ error: "Настройте Discord" }, { status: 400 });

    const ping = fighter.discordId ? `<@${fighter.discordId}>` : fighter.name;
    const messageContent = type === 1 
      ? `⚠️ ${ping} 1/2 предупреждение, онлайн ${fighter.hours.toFixed(1)}ч, ниже нормы ${norm}ч. Добить онлайн, иначе исключение ⚠️`
      : `⛔ ${ping} 2/2 предупреждение, онлайн ${fighter.hours.toFixed(1)}ч, повторно ниже нормы. Исключён! ⛔`;

    const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId.trim()}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${botToken.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageContent }),
    });

    if (!discordRes.ok) return NextResponse.json({ error: `Ошибка Discord` }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}