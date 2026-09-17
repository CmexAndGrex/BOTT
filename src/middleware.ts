import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { getJwtSecret } from "@/lib/auth";

const SECRET = getJwtSecret();

const protectedPaths = [
  "/settings", "/logs", "/users",
  "/api/actions", "/api/sync", "/api/logs",
  "/api/extension.zip", "/api/users"
];

/**
 * Роуты, которые аутентифицируются cookie сессии. Для них проверяем
 * источник запроса (защита от CSRF). `/api/cookie` здесь НЕТ: расширение
 * ходит туда с ключом синхронизации, а не с cookie, поэтому CSRF к нему
 * неприменим и проверка не должна ломать синхронизацию.
 */
const cookieAuthApiPaths = [
  "/api/settings", "/api/adduser", "/api/deluser", "/api/warn",
  "/api/actions", "/api/sync", "/api/members", "/api/docs",
  "/api/logout", "/api/weekly-snapshot", "/api/users",
];

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Отсекаем межсайтовые запросы к cookie-авторизованным роутам.
 *
 * Блокируем только при явных признаках чужого источника, чтобы не ломать
 * легитимные same-origin вызовы и не-браузерных клиентов:
 *   - `Sec-Fetch-Site: cross-site` — современные браузеры помечают так сами;
 *   - `Origin` с чужим хостом — подстраховка для старых браузеров.
 */
function isCrossSite(req: NextRequest): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site" && fetchSite !== "none") {
    return true;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      // Сравниваем с фактическим Host и с X-Forwarded-Host: за обратным прокси
      // Host может быть переписан на внутренний, а реальный домен придёт в
      // X-Forwarded-Host. Браузер эти заголовки подделать не может.
      const candidates = [
        (req.headers.get("host") || "").split(",")[0].trim(),
        (req.headers.get("x-forwarded-host") || "").split(",")[0].trim(),
        req.nextUrl.host,
      ].filter(Boolean);

      if (originHost && candidates.length > 0 && !candidates.includes(originHost)) {
        return true;
      }
    } catch {
      return true; // нечитаемый Origin — считаем подозрительным
    }
  }
  return false;
}

/** Nonce для CSP: inline-скрипты Next.js получают его автоматически */
function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. CSRF: небезопасные методы к cookie-авторизованным API с чужого сайта
  if (UNSAFE_METHODS.has(req.method) && cookieAuthApiPaths.some((p) => pathname.startsWith(p))) {
    if (isCrossSite(req)) {
      return NextResponse.json(
        { ok: false, error: "Запрос с чужого источника отклонён" },
        { status: 403 }
      );
    }
  }

  // 2. CSP с nonce: Next.js подставит nonce в свои inline-скрипты.
  //    Отключается переменной DISABLE_CSP=true, если что-то поедет на стенде.
  const nonce = makeNonce();
  const cspEnabled = (process.env.DISABLE_CSP || "").trim() !== "true";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const isApi = pathname.startsWith("/api/");
  const isProtected = protectedPaths.some((p) => pathname.startsWith(p));

  const withCsp = (res: NextResponse) => {
    if (cspEnabled && !isApi) res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  if (!isProtected) return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));

  const token = req.cookies.get("auth_token")?.value;
  if (!token) {
    if (isApi) return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    const verified = await jwtVerify(token, SECRET);
    const role = (verified.payload as { role?: unknown }).role;

    const isAdminArea =
      pathname.startsWith("/settings") ||
      pathname.startsWith("/users") ||
      pathname.startsWith("/api/extension.zip");

    if (isAdminArea && role !== "admin") {
      if (isApi) {
        return NextResponse.json({ error: "Только для администратора" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/", req.url));
    }
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
  } catch {
    if (isApi) return NextResponse.json({ error: "Сессия устарела" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }
}
