/**
 * Гибридная сессия бойца: вход через Discord OAuth2 или по позывному/паролю.
 *
 * Почему не NextAuth: панель уже работает на собственной проверенной схеме —
 * JWT (jose) в httpOnly-cookie, версия токена в БД (token_version), единые
 * гварды requireAuth/requireRole и CSRF-защита в middleware. Второй, внешний
 * стек авторизации дал бы две несвязанные сессии на один продукт: отзыв
 * токена и смену пароля пришлось бы реализовывать дважды. Поэтому вход
 * бойца выпускает ТОТ ЖЕ тип токена — но в отдельной cookie `member_token`,
 * чтобы сессия бойца не пересекалась с сессией администратора панели.
 *
 * Здесь — серверная часть: выпуск/проверка сессии и клиент Discord OAuth2
 * (authorize → token → users/@me). Чистые правила лежат в recruits.ts.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberSessions, members } from "@/db/schema";
import { getJwtSecret } from "@/lib/auth";
import { getAuthUser, isSecureRequest } from "@/lib/api-auth";
import {
  hasProfileAccess,
  isStaffRole,
  MANUAL_DISCORD_ID,
  type MemberRole,
  type MemberStatus,
} from "@/lib/recruits";

/* ------------------------------------------------------------------ */
/* Константы                                                           */
/* ------------------------------------------------------------------ */

/** Cookie сессии бойца (сессия панели — auth_token, они не пересекаются) */
export const MEMBER_COOKIE = "member_token";

/** Cookie подписанного state: привязывает OAuth-продолжение к этому браузеру */
export const MEMBER_OAUTH_STATE_COOKIE = "member_oauth_state";
/** Id бойца, начавшего привязку Discord (проверяется в callback) */
export const MEMBER_OAUTH_LINK_COOKIE = "member_oauth_link";
/** Контакт Discord из входа: id|ник|аватар, для предзаполнения формы рапорта */
export const MEMBER_OAUTH_PENDING_COOKIE = "member_oauth_pending";

/** Срок жизни сессии бойца */
export const MEMBER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Время на прохождение OAuth-редиректа (успеть ввести пароль Discord) */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Назначение токена: защищает от подстановки токена другого вида */
const MEMBER_PURPOSE = "member_session";
const OAUTH_STATE_PURPOSE = "discord_oauth_state";

/** Способ входа — пишется в журнал входов */
export type MemberLoginKind = "discord" | "password";

/* ------------------------------------------------------------------ */
/* Сессия                                                              */
/* ------------------------------------------------------------------ */

/** Данные сессии для интерфейса (наличие пароля и Discord — флагами) */
export type SessionMember = {
  id: number;
  callsign: string;
  discordId: string | null;
  rank: string;
  unit: string | null;
  status: MemberStatus;
  role: MemberRole;
  avatarUrl: string | null;
  hasPassword: boolean;
  hasDiscord: boolean;
  createdAt: Date;
};

type MemberTokenPayload = {
  memberId?: unknown;
  callsign?: unknown;
  role?: unknown;
  tokenVersion?: unknown;
  kind?: unknown;
  purpose?: unknown;
};

/**
 * Выпускает сессию бойцу: подписывает JWT и записывает вход в журнал.
 * Возвращает параметры cookie, а ставит её вызывающий роут — так флаг Secure
 * вычисляется по фактической схеме запроса (как в /api/auth).
 */
export async function issueMemberSession(
  member: {
    id: number;
    callsign: string;
    role: MemberRole;
    memberTokenVersion: number;
  },
  kind: MemberLoginKind,
  meta: { ip: string }
): Promise<{ token: string; maxAge: number; expiresAt: Date }> {
  const jti = `${member.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const expiresAt = new Date(Date.now() + MEMBER_SESSION_TTL_SECONDS * 1000);

  const token = await new SignJWT({
    purpose: MEMBER_PURPOSE,
    memberId: member.id,
    callsign: member.callsign,
    role: member.role,
    // Сверяется на каждом запросе: смена пароля, отклонение рапорта или
    // отвязка Discord обрывают уже выданные сессии одним UPDATE.
    tokenVersion: member.memberTokenVersion,
    kind,
    jti,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${MEMBER_SESSION_TTL_SECONDS}s`)
    .sign(getJwtSecret());

  // Журнал входов не должен ломать сам вход: он уже состоялся, запись — учёт
  try {
    await db.insert(memberSessions).values({
      id: jti,
      memberId: member.id,
      kind,
      ip: meta.ip.slice(0, 100),
      expiresAt,
    });
  } catch (e) {
    console.error("[member-auth] Не удалось записать журнал входов:", e);
  }

  return { token, maxAge: MEMBER_SESSION_TTL_SECONDS, expiresAt };
}

/** Проверяет подпись токена бойца и возвращает его полезную нагрузку */
async function verifyMemberToken(token: string): Promise<MemberTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    const data = payload as MemberTokenPayload;
    if (data.purpose !== MEMBER_PURPOSE) return null;
    return data;
  } catch {
    return null;
  }
}
/**
 * Текущий боец по cookie. null — токена нет, он просрочен, подделан, отозван
 * или боец удалён/отклонён.
 *
 * Роль и статус читаются из БД, а не из токена: понижение прав, одобрение
 * рапорта и исключение действуют немедленно, без перевыпуска cookie. Токены,
 * выданные до смены пароля, отсекаются по memberTokenVersion.
 */
export async function getSessionMember(req: NextRequest): Promise<SessionMember | null> {
  const token = req.cookies.get(MEMBER_COOKIE)?.value;
  if (!token) return null;

  const payload = await verifyMemberToken(token);
  if (!payload || typeof payload.memberId !== "number") return null;

  const [row] = await db
    .select({
      id: members.id,
      callsign: members.callsign,
      discordId: members.discordId,
      rank: members.rank,
      unit: members.unit,
      status: members.status,
      role: members.role,
      avatarUrl: members.avatarUrl,
      passwordHash: members.passwordHash,
      memberTokenVersion: members.memberTokenVersion,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(eq(members.id, payload.memberId));

  if (!row) return null;

  const tokenVersion = typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0;
  if (tokenVersion !== row.memberTokenVersion) return null;
  // Сессии непринятого рапорта и исключённого бойца недействительны
  if (row.status === "dismissed" || row.status === "pending") return null;

  return {
    id: row.id,
    callsign: row.callsign || "",
    discordId: row.discordId,
    rank: row.rank,
    unit: row.unit,
    status: row.status,
    role: row.role,
    avatarUrl: row.avatarUrl,
    hasPassword: !!row.passwordHash,
    hasDiscord: !!row.discordId && row.discordId !== MANUAL_DISCORD_ID,
    createdAt: row.createdAt,
  };
}
/* ------------------------------------------------------------------ */
/* Гварды                                                              */
/* ------------------------------------------------------------------ */

export type MemberAuthResult =
  | { ok: true; member: SessionMember }
  | { ok: false; response: NextResponse };

/** Обязательная сессия бойца: для роутов кабинета */
export async function requireMember(req: NextRequest): Promise<MemberAuthResult> {
  const member = await getSessionMember(req);
  if (!member) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Нет доступа: войдите в личный кабинет" },
        { status: 401 }
      ),
    };
  }
  return { ok: true, member };
}

/** Сессия бойца со статусом «в строю» или «в отпуске»: только для /profile */
export async function requireActiveMember(req: NextRequest): Promise<MemberAuthResult> {
  const result = await requireMember(req);
  if (!result.ok) return result;
  if (!hasProfileAccess(result.member.status)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Личный кабинет доступен бойцам, зачисленным в подразделение" },
        { status: 403 }
      ),
    };
  }
  return result;
}

/**
 * Доступ к модерации рапортов.
 *
 * Допускаются роль officer/admin у бойца ИЛИ действующая сессия панели: у
 * администратора, который ведёт бота и статистику, рапорта может не быть
 * вовсе, и требовать от него регистрацию — абсурдно. Так доступ не
 * расширяется: обе ветки означают «командир или администратор».
 */
export async function requireStaff(req: NextRequest): Promise<MemberAuthResult> {
  const member = await getSessionMember(req);
  if (
    member &&
    isStaffRole(member.role) &&
    member.status !== "dismissed" &&
    member.status !== "pending"
  ) {
    return { ok: true, member };
  }

  const admin = await getAuthUser(req);
  if (admin && (admin.role === "admin" || admin.role === "officer")) {
    return {
      ok: true,
      member: {
        id: 0,
        callsign: admin.username || "",
        discordId: null,
        rank: "",
        unit: null,
        status: "active",
        role: admin.role,
        avatarUrl: null,
        hasPassword: true,
        hasDiscord: false,
        createdAt: new Date(0),
      },
    };
  }

  return {
    ok: false,
    response: NextResponse.json(
      { ok: false, error: "Недостаточно прав: раздел доступен командирам и администраторам" },
      { status: 403 }
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Discord OAuth2 (authorize → token → users/@me)                      */
/* ------------------------------------------------------------------ */

/** Права приложения: identify — профиль бойца, guilds — список его серверов */
export const DISCORD_OAUTH_SCOPES = "identify guilds";

/** Профиль бойца из Discord API */
export type DiscordProfile = {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
};

/**
 * Настроен ли вход через Discord.
 *
 * Принимаем оба написания переменных: в .env проекта исторически есть
 * DISCROD_CLIENT_ID (опечатка), и без второго варианта вход молча считался бы
 * ненастроенным при полностью заполненном окружении.
 */
export function discordOAuthConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.DISCORD_CLIENT_ID || process.env.DISCROD_CLIENT_ID || "").trim();
  const clientSecret = (
    process.env.DISCORD_CLIENT_SECRET ||
    process.env.DISCROD_CLIENT_SECRET ||
    ""
  ).trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Ссылка на согласие в Discord; state привязан к браузеру отдельной cookie */
export function discordAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DISCORD_OAUTH_SCOPES,
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Назначение OAuth-продолжения: обычный вход или привязка Discord к аккаунту */
export type OAuthIntent = "login" | "link";

/** Подписанный state: значение в cookie и в URL совпадают, подделка отсекается подписью */
export async function createOAuthState(intent: OAuthIntent): Promise<string> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new SignJWT({ purpose: OAUTH_STATE_PURPOSE, intent, nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${OAUTH_STATE_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export type OAuthStateCheck = { ok: false } | { ok: true; intent: OAuthIntent };

/**
 * Проверяет, что OAuth-продолжение начато именно этим браузером.
 * Возвращает намерение из подписанного state — оно не может быть подменено
 * клиентом: привязка Discord к аккаунту (link) отличается от входа (login).
 */
export async function verifyOAuthState(
  state: string | null,
  cookieValue: string | null | undefined
): Promise<OAuthStateCheck> {
  if (!state || !cookieValue) return { ok: false };
  // Первый барьер — быстрый: cookie должна совпадать с параметром запроса
  if (state !== cookieValue) return { ok: false };
  try {
    const { payload } = await jwtVerify(state, getJwtSecret());
    const data = payload as { purpose?: unknown; intent?: unknown };
    if (data.purpose !== OAUTH_STATE_PURPOSE) return { ok: false };
    return { ok: true, intent: data.intent === "link" ? "link" : "login" };
  } catch {
    return { ok: false };
  }
}
/**
 * Обмен кода авторизации на токен и загрузка профиля Discord.
 * Ошибки не пробрасываются наружу: роут показывает пользователю сообщение.
 */
export async function exchangeDiscordCode(
  code: string,
  redirectUri: string
): Promise<{ ok: true; profile: DiscordProfile } | { ok: false; error: string }> {
  const config = discordOAuthConfig();
  if (!config) return { ok: false, error: "Вход через Discord не настроен на сервере" };

  try {
    const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
      cache: "no-store",
    });
    if (!tokenRes.ok) {
      return { ok: false, error: `Discord отклонил код авторизации (${tokenRes.status})` };
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      return { ok: false, error: "Discord не вернул токен доступа" };
    }

    const userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      cache: "no-store",
    });
    if (!userRes.ok) {
      return { ok: false, error: `Не удалось получить профиль Discord (${userRes.status})` };
    }
    const user = (await userRes.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    };
    if (!user.id) return { ok: false, error: "Discord вернул профиль без идентификатора" };

    return {
      ok: true,
      profile: {
        id: user.id,
        username: user.username || "",
        globalName: user.global_name || null,
        // Аватар приходит хешем: без него Discord отдаёт букву-заглушку
        avatarUrl: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
          : null,
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Сбой связи с Discord: ${reason}` };
  }
}

/* ------------------------------------------------------------------ */
/* Хелперы для роутов                                                  */
/* ------------------------------------------------------------------ */

/** IP клиента для журнала входов и ограничителя попыток */
export function requestIp(req: NextRequest): string {
  return (
    (req.headers.get("x-real-ip") || "").trim() ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown_ip"
  );
}

/** Ставит cookie сессии бойца с корректным флагом Secure */
export function setMemberCookie(
  response: NextResponse,
  session: { token: string; maxAge: number },
  req: NextRequest
): NextResponse {
  response.cookies.set({
    name: MEMBER_COOKIE,
    value: session.token,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    // Флаг Secure — по фактической схеме запроса: в dev на http://localhost
    // он снят, иначе cookie не сохранилась бы вовсе.
    secure: isSecureRequest(req),
    maxAge: session.maxAge,
  });
  return response;
}

/** Снимает cookie сессии бойца (выход из кабинета) */
export function clearMemberCookie(response: NextResponse): NextResponse {
  response.cookies.delete(MEMBER_COOKIE);
  return response;
}

/**
 * Адрес возврата после согласия в Discord.
 *
 * Считается от фактического адреса запроса, поэтому работает и локально, и за
 * прокси, без отдельной переменной. DISCORD_REDIRECT_URI нужен только когда
 * внешний адрес отличается от того, что видит приложение (например, прокси не
 * пробрасывает X-Forwarded-Host) — этот адрес должен быть зарегистрирован в
 * Discord Developer Portal → OAuth2 → Redirects.
 */
export function discordRedirectUri(req: NextRequest): string {
  const explicit = (process.env.DISCORD_REDIRECT_URI || "").trim();
  if (explicit) return explicit;

  const proto =
    (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim() ||
    req.nextUrl.protocol.replace(":", "");
  const host =
    (req.headers.get("x-forwarded-host") || "").split(",")[0].trim() ||
    req.headers.get("host") ||
    req.nextUrl.host;
  return `${proto}://${host}/api/auth/discord/callback`;
}
/* ------------------------------------------------------------------ */
/* Контакт Discord для формы рапорта                                   */
/* ------------------------------------------------------------------ */

/**
 * Упаковка контакта Discord в cookie: id|ник|аватар.
 *
 * Cookie httpOnly и ставится только нашим сервером из ответа Discord, поэтому
 * кандидат не может подменить в ней Discord ID и подать рапорт с чужим
 * аккаунтом — а именно это позволило бы увести чужую учётную запись себе.
 */
export function packDiscordProfile(profile: DiscordProfile): string {
  const name = (profile.globalName || profile.username || "").replace(/[|\r\n]/g, " ");
  return [profile.id, name, profile.avatarUrl || ""].join("|");
}

/** Разбор контакта Discord из cookie. null — значения нет или оно испорчено */
export function unpackDiscordProfile(raw: string | null | undefined): DiscordProfile | null {
  if (!raw) return null;
  const [id, name = "", avatar = ""] = raw.split("|");
  if (!/^\d{5,25}$/.test(id || "")) return null;
  return { id, username: name, globalName: name || null, avatarUrl: avatar || null };
}