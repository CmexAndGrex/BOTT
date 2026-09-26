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
  // Кабинет бойца: cookie member_token, запросы с чужого сайта недопустимы
  // (иначе возможна CSRF-смена пароля и отвязка Discord)
  "/api/member/profile", "/api/member/discord", "/api/admin/recruits", "/api/auth/member-logout",
  // Рапорты и решения штаба из панели: cookie-авторизация, значит нужна
  // CSRF-проверка (иначе чужой сайт мог бы отправить рапорт за бойца)
  "/api/member/reports", "/api/admin/reports",
  // Шаблоны выкладок: создание, правка и архив — cookie-авторизация
  "/api/admin/armory",
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

/** Проверка подписи cookie сессии бойца (без обращения к БД — только токен) */
async function memberClaims(token: string): Promise<{ role: string } | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    const data = payload as { purpose?: unknown; role?: unknown };
    if (data.purpose !== "member_session") return null;
    return { role: typeof data.role === "string" ? data.role : "recruit" };
  } catch {
    return null;
  }
}

/**
 * Роль из cookie сессии панели.
 *
 * Проверяется назначение токена: у сессии бойца тоже есть поле role, и без
 * такой сверки боец с ролью officer в учётной записи читался бы как сотрудник
 * панели. Токены, выданные до появления поля purpose, принимаются — иначе
 * обновление версии разлогинило бы всех разом, а срок их жизни и так 12 часов.
 *
 * Отличие от getAuthUser(): здесь нет обращения к БД. Middleware лишь не
 * пускает заведомо чужих, полная проверка (роль из БД, token_version)
 * выполняется в самих роутах.
 */
async function panelRole(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    const data = payload as { purpose?: unknown; role?: unknown };
    if (data.purpose !== undefined && data.purpose !== "panel_session") return null;
    return typeof data.role === "string" ? data.role : null;
  } catch {
    return null;
  }
}

/**
 * Страницы и роуты, которые без сессии бойца бессмысленны.
 * `/api/member/session` здесь СОЗНАТЕЛЬНО нет: он отвечает «гость» и нужен
 * страницам входа и рапорта — отказ 403 заставлял бы их обрабатывать ошибку
 * вместо нормального состояния.
 */
const memberPaths = [
  "/profile",
  "/api/member/profile",
  "/api/member/discord",
  // Рапорты бойца: подача и список — только из кабинета (сессия member_token)
  "/reports",
  "/api/member/reports",
];

/** Разделы модерации: командир или администратор (панель либо боец с ролью) */
const staffPaths = [
  "/admin/recruits",
  "/api/admin/recruits",
  "/admin/reports",
  "/api/admin/reports",
  // Правка шаблонов выкладок — только штаб (роут продублирует проверку)
  "/api/admin/armory",
];

/**
 * Разделы, куда пускаем любую действующую сессию: и кабинет бойца, и панель.
 *
 * «Арсенал» нужен всем, а не только бойцам: у администратора, который ведёт бота и
 * правит выкладки, рапорта может не быть вовсе, и требовать от него вход в кабинет
 * — абсурдно. Роль здесь не проверяется: право на просмотр есть и у панели, и у
 * бойца (см. canViewArmory), а полная проверка выполняется в роуте и странице.
 */
const anySessionPaths = ["/armory", "/api/armory"];

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

  // 2. CSP. Отключается переменной DISABLE_CSP=true, если что-то поедет на стенде.
  const nonce = makeNonce();
  const cspEnabled = (process.env.DISABLE_CSP || "").trim() !== "true";

  /**
   * script-src.
   *
   * `'strict-dynamic'` убран совсем: по CSP3 он заставляет браузер ИГНОРИРОВАТЬ
   * хосты (`'self'`) и `'unsafe-inline'`, оставляя единственным разрешённым
   * источником скрипт с nonce. Next.js добавляет nonce в свои инлайн-скрипты
   * только при динамическом рендере, а страницы панели пререндерены статически:
   * в собранном .next/server/app/login.html нет ни одного nonce, поэтому при
   * `'strict-dynamic'` скрипты гидратации блокировались.
   *
   * nonce в script-src не подставляем по той же причине: по CSP3 наличие nonce
   * отменяет действие `'unsafe-inline'`, и на статически отданной странице
   * (nonce в разметку не попадает) инлайн-скрипты Next.js снова окажутся
   * заблокированы. `'unsafe-inline'` закрывает и инлайн-скрипты гидратации,
   * и инлайн-бандлы dev-сборки; `'unsafe-eval'` нужен только dev — React
   * восстанавливает по eval стек серверных ошибок, в production его не требует.
   */
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`;

  // style-src намеренно без nonce: nonce в директиве отменяет 'unsafe-inline'
  // (CSP3), а на нём держатся Tailwind и инлайн-стили компонентов.
  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  // nonce пробрасываем в заголовки запроса: `x-nonce` — для корневого layout и
  // сторонних скриптов, `Content-Security-Policy` — чтобы Next.js мог подставить
  // nonce в свои инлайн-скрипты. Пока страницы пререндерены статически, механизм
  // «спит» (в script-src nonce не входит) и включается одним изменением
  // scriptSrc, если панель перейдёт на динамический рендер.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  if (cspEnabled) requestHeaders.set("Content-Security-Policy", csp);

  const isApi = pathname.startsWith("/api/");
  const isProtected = protectedPaths.some((p) => pathname.startsWith(p));
  const isMemberArea = memberPaths.some((p) => pathname.startsWith(p));
  const isStaffArea = staffPaths.some((p) => pathname.startsWith(p));
  const isAnySessionArea = anySessionPaths.some((p) => pathname.startsWith(p));

  const withCsp = (res: NextResponse) => {
    if (cspEnabled && !isApi) res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  const deny = (message: string, redirectTo = "/login") => {
    if (isApi) return NextResponse.json({ error: message }, { status: 403 });
    return NextResponse.redirect(new URL(redirectTo, req.url));
  };

  /**
   * «Арсенал»: достаточно любой действующей сессии — кабинета бойца или панели.
   * Роль здесь не различаем (просмотр разрешён и бойцу, и штабу), а правку
   * шаблонов отдельно закрывает staffPaths и сам роут.
   */
  if (isAnySessionArea) {
    const memberToken = req.cookies.get("member_token")?.value;
    if (memberToken && (await memberClaims(memberToken))) {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }
    const panelToken = req.cookies.get("auth_token")?.value;
    if (panelToken && (await panelRole(panelToken))) {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }
    return deny("Нет доступа: войдите в личный кабинет или панель", "/login");
  }

  // Кабинет и раздел модерации: проверяем cookie бойца отдельно от панели.
  // Полная проверка (статус, права, отзыв токена) выполняется в роутах —
  // middleware лишь не пускает заведомо чужих, чтобы не показывать пустой
  // интерфейс и не гонять запросы в БД на каждый переход.
  if (isMemberArea || isStaffArea) {
    const memberToken = req.cookies.get("member_token")?.value;
    const claims = memberToken ? await memberClaims(memberToken) : null;

    if (!claims) {
      // Командир и администратор панели сохраняют доступ к модерации рапортов
      if (isStaffArea) {
        const panelToken = req.cookies.get("auth_token")?.value;
        const role = panelToken ? await panelRole(panelToken) : null;
        if (role === "admin" || role === "officer") {
          return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
        }
        return deny("Нет доступа: раздел доступен командирам", "/login");
      }
      return deny("Нет доступа: войдите в личный кабинет", "/login");
    }

    if (isStaffArea && claims.role !== "admin" && claims.role !== "officer") {
      // Боец без прав штаба: модерация рапортов ему недоступна
      const panelToken = req.cookies.get("auth_token")?.value;
      const role = panelToken ? await panelRole(panelToken) : null;
      const panelStaff = role === "admin" || role === "officer";
      if (!panelStaff) return deny("Недостаточно прав", "/profile");
    }

    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  if (!isProtected) return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));

  const token = req.cookies.get("auth_token")?.value;
  if (!token) {
    if (isApi) return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    const role = await panelRole(token);
    if (!role) {
      if (isApi) return NextResponse.json({ error: "Сессия устарела" }, { status: 401 });
      return NextResponse.redirect(new URL("/login", req.url));
    }

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
