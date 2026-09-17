import { NextRequest } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * Health-check.
 *
 * Публично отвечаем только минимальным `{ ok }`: раньше роут был анонимным и
 * пробником БД, то есть любой мог узнать состояние инфраструктуры (и
 * использовать это для разведки — «БД лежит», «БД доступна»). Детальную
 * диагностику отдаём только администратору панели.
 *
 * Важно: при недоступной БД по-прежнему возвращаем 500 — на это опираются
 * внешние проверки и команда `curl` из DEPLOYMENT.md.
 */
export async function GET(req: NextRequest) {
  try {
    await db.execute(sql`select 1`);
  } catch {
    // Наружу — только статус, без текста ошибки драйвера/хоста
    return Response.json({ ok: false }, { status: 500 });
  }

  const user = await getAuthUser(req);
  if (user?.role !== "admin") {
    return Response.json({ ok: true });
  }

  // Диагностика для администратора: без раскрытия строки подключения и хостов
  return Response.json({
    ok: true,
    database: "reachable",
    uptimeSec: Math.round(process.uptime()),
    nodeEnv: process.env.NODE_ENV || "unknown",
    checkedAt: new Date().toISOString(),
  });
}

