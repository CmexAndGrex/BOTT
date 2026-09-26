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
import { jwtVerify, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, users } from "@/db/schema";
import { getJwtSecret } from "@/lib/auth";
import { isPanelStaffRole, normalizeDiscordSnowflake, type PanelStaffRole } from "@/lib/validation";

export type AuthRole = PanelStaffRole | "guest";

export type AuthUser = {
  role: AuthRole;
  username: string | null;
};

/** Cookie сессии панели (сессия бойца — member_token, они не пересекаются) */
export const PANEL_COOKIE = "auth_token";

/**
 * Срок жизни сессии панели: короче суток, отзыв — через users.token_version.
 * Значение живёт здесь, потому что сессию выпускают два входа: по логину с
 * паролем (/api/auth) и по Discord (callback) — копия в двух местах разошлась бы.
 */
export const PANEL_SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * Назначение токена панели. Сверяется при чтении сессии, чтобы токен другого
 * вида нельзя было предъявить как сессию панели. Токены, выданные до появления
 * поля, принимаются (purpose отсутствует) — иначе обновление версии разом
 * разлогинило бы всех, а срок их жизни и так ограничен 12 часами.
 */
export const PANEL_TOKEN_PURPOSE = "panel_session";

/** Сравнение секретов без утечки по времени */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/**
 * Определяет, надо ли ставить флаг Secure на cookie сессии — по фактической
 * схеме запроса. Раньше флаг снимался для любого URL, содержащего подстроку
 * "localhost" (например evil-localhost.example), из-за чего cookie могла
 * уйти по открытому HTTP.
 *
 * Живёт здесь, а не в роуте входа: этим же правилом пользуются роуты входа
 * бойца (member-auth.ts), и копия правила в двух местах разошлась бы.
 */
export function isSecureRequest(req: NextRequest): boolean {
  const proto =
    (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim() ||
    req.nextUrl.protocol.replace(":", "");
  if (proto !== "https") return false;
  // Локальная проверка production-сборки по https://localhost без домена
  const host = (req.headers.get("host") || req.nextUrl.host).split(":")[0].toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
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
  const token = req.cookies.get(PANEL_COOKIE)?.value;
  if (!token) return null;

  let payload: { role?: unknown; username?: unknown; tokenVersion?: unknown; purpose?: unknown };
  try {
    const verified = await jwtVerify(token, getJwtSecret());
    payload = verified.payload as typeof payload;
  } catch {
    return null;
  }

  // Токен другого назначения (сессия бойца) сессией панели не является
  if (payload.purpose !== undefined && payload.purpose !== PANEL_TOKEN_PURPOSE) return null;

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
  return { role: isPanelStaffRole(dbUser.role) ? dbUser.role : "guest", username };
}

/* ------------------------------------------------------------------ */
/* Сессия панели: выпуск и cookie                                      */
/* ------------------------------------------------------------------ */

/** Учётная запись панели, пригодная для выдачи сессии */
export type PanelAccount = {
  id: number;
  username: string;
  /** Роль как она лежит в БД: пригодность проверяется isPanelStaffRole у входа */
  role: string;
  tokenVersion: number;
};

/**
 * Подписывает токен сессии панели.
 *
 * Роль и tokenVersion кладутся в payload, но права при каждом запросе всё
 * равно берутся из БД (см. getAuthUser): payload нужен только middleware,
 * который не ходит в базу. tokenVersion в токене — то, по чему отзываются
 * сессии без хранения их списка.
 */
export async function issuePanelToken(account: PanelAccount): Promise<string> {
  return new SignJWT({
    purpose: PANEL_TOKEN_PURPOSE,
    userId: account.id,
    username: account.username,
    role: account.role,
    tokenVersion: account.tokenVersion,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${PANEL_SESSION_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

/**
 * Ставит cookie сессии панели. Флаг Secure вычисляется по фактической схеме
 * запроса (isSecureRequest): в dev на http://localhost он снят, иначе cookie
 * не сохранилась бы вовсе.
 */
export function setPanelCookie(
  response: NextResponse,
  token: string,
  req: NextRequest
): NextResponse {
  response.cookies.set({
    name: PANEL_COOKIE,
    value: token,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: isSecureRequest(req),
    maxAge: PANEL_SESSION_TTL_SECONDS,
  });
  return response;
}

/**
 * Учётная запись панели по Discord ID.
 *
 * Возвращает запись с любой ролью: вызывающий сам решает, давать ли доступ
 * (isPanelStaffRole). Отличие «аккаунт есть, но прав нет» от «аккаунта нет» —
 * это разные ветки входа, и различать их должен роут, а не этот помощник.
 * Здесь подмены роли нет: понижение прав в БД должно действовать немедленно.
 */
export async function findPanelUserByDiscordId(rawId: unknown): Promise<PanelAccount | null> {
  const discordId = normalizeDiscordSnowflake(rawId);
  if (!discordId) return null;

  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      tokenVersion: users.tokenVersion,
    })
    .from(users)
    .where(eq(users.discordId, discordId));

  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    tokenVersion: row.tokenVersion,
  };
}

/** Запись входа в журнал: способ входа виден штабу при разборе инцидентов */
export async function logPanelLogin(
  username: string,
  action: string,
  details: Record<string, string>
): Promise<void> {
  try {
    await db.insert(logs).values({
      category: "login",
      author: username,
      action,
      details,
      kind: "auth",
      title: "Авторизация",
      detail: action,
      ok: true,
    });
  } catch {
    // Журнал не должен мешать входу: сессия уже выдана
  }
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