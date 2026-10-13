import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, settings, logs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireStaff } from "@/lib/member-auth";
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
  // Предупреждение с пингом в Discord — командиры и админы.
  //
  // requireStaff, а не requireRole(["officer"]): допускается как сессия панели,
  // так и сессия кабинета с правами штаба (роль officer/admin или должность
  // командира подразделения). Иначе командир, работающий из кабинета
  // (member_token), получал 401 — при том, что интерфейс ему кнопку показывал.
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;
  const operator = auth.member;

  try {
    let body;
    try { body = await req.json(); } 
    catch { return NextResponse.json({ error: "Некорректный формат данных" }, { status: 400 }); }

    const { memberId, type, norm } = body;

    if (typeof memberId !== "number" || !Number.isInteger(memberId)) return NextResponse.json({ error: "Неверный ID" }, { status: 400 });
    if (type !== 1 && type !== 2) return NextResponse.json({ error: "Тип 1 или 2" }, { status: 400 });
    if (typeof norm !== "number" || norm < 1 || norm > 168) return NextResponse.json({ error: "Некорректная норма" }, { status: 400 });

    const now = Date.now();
    const rateKey = `${operator.id || operator.callsign || "unknown"}:${memberId}`;
    if (!warnLimiter.allow(rateKey, now)) {
      return NextResponse.json({ error: "Слишком часто" }, { status: 429 });
    }

    const fighterRecord = await db.select().from(members).where(eq(members.id, memberId));
    if (!fighterRecord || fighterRecord.length === 0) return NextResponse.json({ error: "Боец не найден" }, { status: 404 });
    
    const fighter = fighterRecord[0];

    /**
     * Проверка принадлежности к подразделению (IDOR).
     *
     * Если у инициатора задано подразделение, он не может выдавать выговоры
     * бойцам чужого подразделения — иначе командир роты наказывал бы бойцов
     * дивизиона по прямому знанию чужого memberId. Администраторы не
     * ограничены: их надзор общий, и подразделение у них может быть не задано.
     */
    if (
      operator.role !== "admin" &&
      operator.unit &&
      fighter.unit &&
      fighter.unit !== operator.unit
    ) {
      return NextResponse.json({ error: "Боец другого подразделения" }, { status: 403 });
    }

    // Счётчик только растёт: повторная выдача «1/2» не сбрасывает уже
    // накопленные предупреждения (см. nextWarningCount).
    const newWarnings = nextWarningCount(fighter.warnings, type as WarnType);

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

    // Сначала доставляем сообщение в Discord и только при успешной доставке
    // меняем счётчик в базе. Иначе при отказе Discord (400/404/сеть) счётчик
    // рос бы «в никуда», и боец получал исключение 2/2, не получив самого
    // предупреждения ни в канале, ни в личных сообщениях.
    const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${botToken.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageContent }),
    });

    if (!discordRes.ok) return NextResponse.json({ error: `Ошибка Discord` }, { status: 400 });

    await db.update(members).set({ warnings: newWarnings }).where(eq(members.id, memberId));

    // Пишем в журнал редактирования
    try {
      const roleRu = operator.role === "admin" ? "Администратор" : "Командир";
      const authorFormatted = operator.callsign ? `${roleRu} ${operator.callsign}` : roleRu;
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
    } catch {
      // Журнал не критичен для ответа
    }
    return NextResponse.json({ ok: true, warnings: newWarnings });
  } catch (error) {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
