import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getSettings } from "@/lib/settings";

/** Сравнение секретов без утечки по времени */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Возвращает список ролей сервера Discord для подстановки в Google-форму.
 * Используется Google Apps Script (см. FORMS_SETUP.md, п. 4).
 * Параметры:
 *   ?key=<CRON_SECRET>  — авторизация по ключу (для скрипта)
 *   ?guild=<guild_id>   — ID сервера (если не задан в настройках guild_id)
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const key = url.searchParams.get("key");
    const cronSecret = process.env.CRON_SECRET || "";

    // Авторизация: либо по ключу (для скрипта), либо по cookie админа
    let authorized = false;
    if (key && cronSecret && safeEqual(key, cronSecret)) {
      authorized = true;
    } else {
      const token = req.cookies.get("auth_token")?.value;
      if (token) {
        try {
          const { jwtVerify } = await import("jose");
          const { getJwtSecret } = await import("@/lib/auth");
          const verified = await jwtVerify(token, getJwtSecret());
          authorized = (verified.payload as any).role === "admin";
        } catch {
          authorized = false;
        }
      }
    }

    if (!authorized) {
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
    }

    const map = await getSettings();
    // Валидация: guild_id — только цифры (защита от подделки пути Discord API)
    const guildId = (url.searchParams.get("guild") || map.get("guild_id") || "").replace(/[^\d]/g, "");
    if (!guildId) {
      return NextResponse.json({ error: "Не задан guild_id" }, { status: 400 });
    }

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