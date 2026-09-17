import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { authorizeCron, getAuthUser } from "@/lib/api-auth";
import { isDiscordId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Возвращает список ролей сервера Discord для подстановки в Google-форму.
 * Используется Google Apps Script (см. FORMS_SETUP.md, п. 4).
 * Авторизация:
 *   заголовок X-Cron-Secret: <CRON_SECRET> — для скрипта (рекомендуется)
 *   либо cookie администратора панели
 * Параметры:
 *   ?guild=<guild_id>   — ID сервера (если не задан в настройках guild_id)
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);

    // Секрет принимается заголовком (устаревший ?key= поддерживается хелпером),
    // иначе — обычная сессия администратора панели.
    let authorized = authorizeCron(req).ok;
    if (!authorized) {
      const user = await getAuthUser(req);
      authorized = user?.role === "admin";
    }

    if (!authorized) {
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
    }

    const map = await getSettings();
    // Строгая валидация: guild_id — числовой ID (защита от подделки пути
    // Discord API). Раньше нецифровые символы просто вырезались, из-за чего
    // «мусорное» значение молча превращалось в другой ID.
    const rawGuildId = (url.searchParams.get("guild") || map.get("guild_id") || "").trim();
    if (!isDiscordId(rawGuildId)) {
      return NextResponse.json(
        { error: "Не задан или некорректен guild_id (ожидается числовой ID)" },
        { status: 400 }
      );
    }
    const guildId = rawGuildId;

    // Загружаем роли через Discord REST API
    const token = map.get("discord_token") || process.env.DISCORD_BOT_TOKEN || "";
    if (!token) {
      return NextResponse.json({ error: "Не задан токен бота" }, { status: 400 });
    }

    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Discord API ответил кодом ${res.status}` },
        { status: 502 }
      );
    }

    const roles = (await res.json()) as Array<{ id: string; name: string }>;
    // Фильтруем @everyone и сортируем по имени
    const filtered = roles
      .filter((r) => r.name !== "@everyone")
      .map((r) => r.name)
      .sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ roles: filtered });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Ошибка сервера" },
      { status: 500 }
    );
  }
}