/**
 * Единые проверки для API-роутов.
 *
 * Зачем: до этого часть роутов полагалась только на middleware, а cron-роуты
 * сравнивали секрет обычным `===`. Пустой CRON_SECRET при этом полностью
 * отключал защиту (запрос `?key=` совпадал с пустой строкой). Здесь собраны
 * безопасные примитивы: чтение пользователя из cookie и проверка CRON_SECRET
 * без утечки по времени.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getJwtSecret } from "@/lib/auth";

export type AuthRole = "admin" | "officer" | "guest";

export type AuthUser = {
  role: AuthRole;
  username: string | null;
};

/** Сравнение секретов без утечки по времени */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/**
 * Пользователь из cookie auth_token.
 * null — токена нет, он просрочен, подделан, отозван или секрет не задан.
 *
 * Помимо подписи сверяем tokenVersion с БД: удаление аккаунта или смена
 * версии токена сразу инвалидируют ранее выданные сессии (иначе токен
 * жил бы все 7 суток, даже если пользователя уже удалили).
 */
export async function getAuthUser(req: NextRequest): Promise<AuthUser | null> {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return null;

  let payload: { role?: unknown; username?: unknown; tokenVersion?: unknown };
  try {
    const verified = await jwtVerify(token, getJwtSecret());
    payload = verified.payload as typeof payload;
  } catch {
    return null;
  }

  const username = typeof payload.username === "string" ? payload.username : null;
  if (!username) return null;

  const [dbUser] = await db
    .select({ role: users.role, tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.username, username));

  // Аккаунт удалён — сессия недействительна
  if (!dbUser) return null;

  const tokenVersion =
    typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0;
  // Версия не совпала — токен отозван (смена пароля/принудительный выход)
  if (tokenVersion !== dbUser.tokenVersion) return null;

  // Роль берём из БД: понижение прав действует немедленно
  const role: AuthRole = dbUser.role === "admin" || dbUser.role === "officer" ? dbUser.role : "guest";
  return { role, username };
}

/**
 * Отзывает все выданные пользователю токены: увеличение tokenVersion
 * делает недействительными все JWT, выписанные до этого момента.
 */
export async function revokeUserTokens(username: string): Promise<void> {
  const [current] = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.username, username));
  if (!current) return;
  await db
    .update(users)
    .set({ tokenVersion: current.tokenVersion + 1 })
    .where(eq(users.username, username));
}

/** Пользователь с одной из перечисленных ролей (админ — всегда допускается) */
export async function getAuthUserWithRole(
  req: NextRequest,
  allowed: AuthRole[]
): Promise<AuthUser | null> {
  const user = await getAuthUser(req);
  if (!user) return null;
  if (user.role === "admin" || allowed.includes(user.role)) return user;
  return null;
}

export type AuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; response: NextResponse };

/**
 * Обязательная авторизация: любой вошедший (admin/officer).
 * Возвращает готовый ответ 401, если токена нет или он недействителен.
 */
export async function requireAuth(req: NextRequest): Promise<AuthResult> {
  const user = await getAuthUser(req);
  if (!user || user.role === "guest") {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Нет доступа: авторизуйтесь" },
        { status: 401 }
      ),
    };
  }
  return { ok: true, user };
}

/**
 * Обязательная авторизация с ролью. Админ проходит всегда.
 * Используется внутри роутов — не вместо middleware, а дополнительно к нему,
 * чтобы обход middleware (см. advisory по Next.js) не открывал доступ.
 */
export async function requireRole(
  req: NextRequest,
  allowed: AuthRole[]
): Promise<AuthResult> {
  const user = await getAuthUser(req);
  if (!user || user.role === "guest") {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Нет доступа: авторизуйтесь" },
        { status: 401 }
      ),
    };
  }
  if (user.role !== "admin" && !allowed.includes(user.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Недостаточно прав" },
        { status: 403 }
      ),
    };
  }
  return { ok: true, user };
}

export type CronAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * Проверка секрета для внешних расписаний (cron).
 *
 * Секрет принимается в заголовке `X-Cron-Secret` или (для обратной
 * совместимости с уже настроенными триггерами) в параметре `?key=`.
 * Пустой/пробельный CRON_SECRET считается ошибкой конфигурации: иначе
 * сравнение с пустой строкой пропускало бы всех.
 */
export function authorizeCron(req: NextRequest): CronAuthResult {
  const expected = (process.env.CRON_SECRET || "").trim();
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "CRON_SECRET не задан на сервере" },
        { status: 503 }
      ),
    };
  }

  const provided = (
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("key") ||
    ""
  ).trim();

  if (!provided || !safeEqual(provided, expected)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Доступ запрещен" }, { status: 403 }),
    };
  }

  return { ok: true };
}