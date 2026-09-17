import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, settings, logs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/api-auth";
import { CooldownLimiter, nextWarningCount, isDiscordId } from "@/lib/validation";

/**
 * Антиспам по ключу «кто выдаёт → кому выдаёт».
 *
 * Раньше лимит был глобальным (одна константа "last_warn"), поэтому один
 * командир блокировал выдачу предупреждений всем остальным на 3 секунды.
 * Теперь лимит персональный: разные офицеры не мешают друг другу.
 */
const warnLimiter = new CooldownLimiter(3000);

/** Тип предупреждения, который ожидает интерфейс: 1/2 или 2/2 */
type WarnType = 1 | 2;

export async function POST(req: NextRequest) {
  // Предупреждение с пингом в Discord — командиры и админы
  const auth = await requireRole(req, ["officer"]);
  if (!auth.ok) return auth.response;
  const authUsername = auth.user.username;

  try {
    let body;
    try { body = await req.json(); } 
    catch { return NextResponse.json({ error: "Некорректный формат данных" }, { status: 400 }); }

    const { memberId, type, norm } = body;

    if (typeof memberId !== "number" || !Number.isInteger(memberId)) return NextResponse.json({ error: "Неверный ID" }, { status: 400 });
    if (type !== 1 && type !== 2) return NextResponse.json({ error: "Тип 1 или 2" }, { status: 400 });
    if (typeof norm !== "number" || norm < 1 || norm > 168) return NextResponse.json({ error: "Некорректная норма" }, { status: 400 });

    const now = Date.now();
    const rateKey = `${authUsername || "unknown"}:${memberId}`;
    if (!warnLimiter.allow(rateKey, now)) {
      return NextResponse.json({ error: "Слишком часто" }, { status: 429 });
    }

    const fighterRecord = await db.select().from(members).where(eq(members.id, memberId));
    if (!fighterRecord || fighterRecord.length === 0) return NextResponse.json({ error: "Боец не найден" }, { status: 404 });
    
    const fighter = fighterRecord[0];

    // Счётчик только растёт: повторная выдача «1/2» не сбрасывает уже
    // накопленные предупреждения (см. nextWarningCount).
    const newWarnings = nextWarningCount(fighter.warnings, type as WarnType);
    await db.update(members).set({ warnings: newWarnings }).where(eq(members.id, memberId));

    const settingsData = await db.select().from(settings);
    const config = Object.fromEntries(settingsData.map((s) => [s.key, s.value]));

    const botToken = config["discord_token"] || process.env.DISCORD_BOT_TOKEN;
    // Строгая валидация ID канала: только цифры. Иначе значение из настроек
    // подставлялось в URL Discord API как есть и могло изменить путь запроса.
    const channelId = (config["discord_channel_id"] || process.env.DISCORD_CHANNEL_ID || "").trim();
    if (!isDiscordId(channelId)) {
      return NextResponse.json({ error: "Некорректный ID канала Discord" }, { status: 400 });
    }
    if (!botToken) return NextResponse.json({ error: "Настройте Discord" }, { status: 400 });

    const ping = fighter.discordId ? `<@${fighter.discordId}>` : fighter.name;
    // Текст сообщения строим по фактическому счётчику, чтобы он не расходился
    // с состоянием в базе (например, не писал «1/2», когда уже 2/2).
    const messageContent = newWarnings >= 2
      ? `⛔ ${ping} 2/2 предупреждение, онлайн ${fighter.hours.toFixed(1)}ч, повторно ниже нормы. Исключён! ⛔`
      : `⚠️ ${ping} 1/2 предупреждение, онлайн ${fighter.hours.toFixed(1)}ч, ниже нормы ${norm}ч. Добить онлайн, иначе исключение ⚠️`;

    const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${botToken.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageContent }),
    });

    if (!discordRes.ok) return NextResponse.json({ error: `Ошибка Discord` }, { status: 400 });

    // Пишем в журнал редактирования
    try {
      const roleRu = auth.user.role === "admin" ? "Администратор" : "Командир";
      const authorFormatted = authUsername ? `${roleRu} ${authUsername}` : roleRu;
      await db.insert(logs).values({
        category: "edit",
        author: authorFormatted,
        action: `выдал предупреждение ${newWarnings}/2 бойцу ${fighter.name}`,
        details: {
          "Боец": fighter.name,
          "Онлайн": `${fighter.hours.toFixed(1)} ч`,
          "Норма": `${norm} ч`,
          "Запрошено": `${type}/2`,
          "Стало": `${newWarnings}/2`,
        },
        kind: "system",
        title: "Предупреждение выдано",
        detail: `Бойцу ${fighter.name} выдано предупреждение ${newWarnings}/2 (запрошено ${type}/2)`,
        ok: true,
      });
    } catch (e) {
      // Журнал не критичен для ответа
    }
    return NextResponse.json({ ok: true, warnings: newWarnings });
  } catch (error) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
