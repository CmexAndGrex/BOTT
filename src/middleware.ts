import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { getJwtSecret } from "@/lib/auth";
import { isCrossSiteRequest, isUnsafeMethod } from "@/lib/csrf";

const SECRET = getJwtSecret();

const protectedPaths = [
  "/settings", "/logs", "/users",
  "/api/actions", "/api/sync", "/api/logs",
  "/api/extension.zip", "/api/users",
  // Обслуживание системы: резервные копии, синхронизация ШДС, очистка данных
  "/api/admin/maintenance",
  // Правка Discord ID из табеля «Состав»: меняет и базу панели, и Google Таблицу
  "/api/admin/roster",
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
  // Вход по паролю и отладочный вход: меняют сессию (ставят cookie), поэтому
  // запрос с чужого сайта отклоняем. Вне production dev-login отвечает 404,
  // но источник проверяется всё равно — правило не должно зависеть от режима.
  "/api/auth/member-login", "/api/auth/dev-login",
  // Рапорты и решения штаба из панели: cookie-авторизация, значит нужна
  // CSRF-проверка (иначе чужой сайт мог бы отправить рапорт за бойца)
  "/api/member/reports", "/api/admin/reports",
  // Шаблоны выкладок: создание, правка и архив — cookie-авторизация
  "/api/admin/armory",
  // Обслуживание системы: кнопки бэкапа/синхронизации/очистки меняют состояние
  // базы и диска, значит чужой сайт не должен иметь возможности их нажать
  "/api/admin/maintenance",
  // Правка Discord ID: запрос меняет запись бойца и внешний документ, поэтому
  // межсайтовый PATCH отклоняется (роут проверяет источник и сам)
  "/api/admin/roster",
  // Удаление профиля бойца: запрос необратим, чужой сайт не должен уметь
  // отправить DELETE за администратора (роут проверяет источник и сам)
  "/api/admin/members",
];

/**
 * Отсекаем межсайтовые запросы к cookie-авторизованным роутам.
 *
 * Правило живёт в src/lib/csrf.ts: им пользуются и middleware, и роуты
 * обслуживания (они обязаны проверять источник сами, не полагаясь только на
 * этот слой). Здесь оставлена тонкая обёртка, чтобы вызовы ниже читались как
 * прежде.
 */
function isCrossSite(req: NextRequest): boolean {
  return isCrossSiteRequest(req);
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
  // Шкала нормативов: раздел показывает допуски бойца, и гостю в нём нечего
  // делать — страница сама объяснит состояние доступа, но пускать незачем
  "/exams",
  // Досье и «Кто на ВЧ»: адрес игрового сервера и состав — внутренняя
  // информация подразделения, гостю здесь нечего делать (роуты дублируют
  // проверку гвардом requireActiveMember)
  "/api/member/dossier",
  "/api/member/vch",
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
  if (isUnsafeMethod(req.method) && cookieAuthApiPaths.some((p) => pathname.startsWith(p))) {
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
    // Аватарки бойцов приходят с Discord CDN. Без этих хостов браузер
    // блокирует картинку ещё до запроса, и в досье остаётся пустой квадрат.
    // referrerPolicy="no-referrer" на теге <img> обязателен по другой причине:
    // Discord отдаёт 403, если видит чужой Referer (см. lib/discord-avatar.ts).
    "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net",
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
    // Возврат на исходную страницу после входа (?next=): без него клик «Войти»
    // на /profile вёл на /login, а после входа человек снова оказывался на
    // кабинете с заглушкой — цикл «/profile → /login → /profile» из отчёта.
    // Путь всегда локальный (строится из pathname запроса), поэтому открытого
    // редиректа здесь быть не может; страница входа проверит его ещё раз.
    // Добавляем только к входу: у отказа «Недостаточно прав» с уводом на
    // /profile возврат на исходную страницу был бы бессмысленным.
    const target =
      redirectTo === "/login" ? `${redirectTo}?next=${encodeURIComponent(pathname)}` : redirectTo;
    return NextResponse.redirect(new URL(target, req.url));
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
      // Командир и администратор панели сюда тоже допускаются: у командира
      // может не быть строки бойца в табеле, но свой кабинет (/profile) он
      // должен открывать — по ТЗ у него полный доступ и к панели, и к досье.
      // Страница сама объяснит, что личное дело доступно зачисленным: она
      // получает 401/403 от /api/member/dossier и показывает экран входа.
      const panelToken = req.cookies.get("auth_token")?.value;
      const role = panelToken ? await panelRole(panelToken) : null;
      if (role === "admin" || role === "officer") {
        return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
      }

      if (isStaffArea) {
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

  /**
   * Ручные задачи и синхронизация (/api/sync, /api/actions): командир или
   * администратор по ЛЮБОЙ из сессий.
   *
   * Ветка стоит до protectedPaths намеренно: та требует cookie панели
   * (auth_token), поэтому администратор и командир, работающие из кабинета
   * (member_token), получали «Нет прав» на кнопках главной ещё до роута.
   * Здесь допускается любая действующая сессия, а полную проверку прав (роль,
   * должность, звание — resolvePanelRights) выполняет роут через requireStaff.
   */
  if (
    pathname === "/api/sync" ||
    pathname.startsWith("/api/sync/") ||
    pathname === "/api/actions" ||
    pathname.startsWith("/api/actions/")
  ) {
    const panelToken = req.cookies.get("auth_token")?.value;
    const role = panelToken ? await panelRole(panelToken) : null;
    if (role === "admin" || role === "officer" || role === "commander") {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }

    const memberToken = req.cookies.get("member_token")?.value;
    if (memberToken && (await memberClaims(memberToken))) {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }

    if (isApi) {
      return NextResponse.json(
        { error: "Только для командиров и администраторов" },
        { status: panelToken || memberToken ? 403 : 401 }
      );
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  /**
   * Правка Discord ID из табеля «Состав»: командир или администратор.
   *
   * Проверка стоит ДО общей ветки protectedPaths намеренно: роут внесён в
   * protectedPaths, а та ветка требует cookie панели (auth_token) и ответила бы
   * 401 командиру, который работает из кабинета бойца (member_token) — ровно
   * тот случай, когда «в табеле поле заблокировано». Здесь допускается любая из
   * двух сессий: middleware лишь не пускает заведомо чужих, а полную проверку
   * прав (роль из БД, должность, звание) выполняет сам роут через
   * requireRosterEditor.
   */
  if (pathname.startsWith("/api/admin/roster")) {
    const panelToken = req.cookies.get("auth_token")?.value;
    const role = panelToken ? await panelRole(panelToken) : null;
    if (role === "admin" || role === "officer" || role === "commander") {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }

    const memberToken = req.cookies.get("member_token")?.value;
    if (memberToken && (await memberClaims(memberToken))) {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }

    if (isApi) {
      return NextResponse.json(
        { error: "Только для командиров и администраторов" },
        { status: panelToken || memberToken ? 403 : 401 }
      );
    }
    return NextResponse.redirect(new URL("/", req.url));
  }

  /**
   * Удаление профиля бойца (/api/admin/members): СТРОГО администратор.
   *
   * Ветка отдельная от правки состава намеренно. Правка карточки (roster) —
   * инструмент командира подразделения, а удаление уничтожает личное дело
   * вместе с допусками, историей и связью с Discord, поэтому командир здесь
   * получает 403, а не 200. Проверяются обе сессии: у администратора панели
   * может не быть строки в табеле, а у бойца-администратора — cookie панели.
   *
   * Middleware лишь отсекает заведомо чужих (роль из токена, без обращения к
   * БД); окончательное решение — memberDeletionDecision в самом роуте, где
   * роль читается из базы и понижение прав действует немедленно.
   */
  if (pathname.startsWith("/api/admin/members")) {
    const panelToken = req.cookies.get("auth_token")?.value;
    const role = panelToken ? await panelRole(panelToken) : null;
    if (role === "admin") {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }

    const memberToken = req.cookies.get("member_token")?.value;
    const claims = memberToken ? await memberClaims(memberToken) : null;
    if (claims?.role === "admin") {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }

    if (isApi) {
      return NextResponse.json(
        { error: "Только для администратора" },
        { status: panelToken || memberToken ? 403 : 401 }
      );
    }
    return NextResponse.redirect(new URL("/", req.url));
  }

  /**
   * «Журнал» (/logs и /api/logs): командир или администратор.
   *
   * Ветка стоит до общей проверки protectedPaths намеренно: /logs и /api/logs
   * внесены в protectedPaths, а та ветка требует cookie панели (auth_token) и
   * ответила бы редиректом/401 командиру, который работает из кабинета бойца
   * (member_token) — ровно симптом «клик по Журналу уводит на /login?error=pending».
   *
   * Middleware лишь не пускает заведомо чужих: действующую сессию бойца
   * пропускаем независимо от роли, а полную проверку прав (роль, должность,
   * звание — resolvePanelRights) выполняют страница (через /api/me) и сам роут
   * через requireStaff. Так командир подразделения по должности тоже открывает
   * журнал, а обычный боец получает внятный отказ внутри страницы/роута.
   */
  if (
    pathname === "/logs" ||
    pathname.startsWith("/logs/") ||
    pathname === "/api/logs" ||
    pathname.startsWith("/api/logs/")
  ) {
    const panelToken = req.cookies.get("auth_token")?.value;
    const role = panelToken ? await panelRole(panelToken) : null;
    if (role === "admin" || role === "officer" || role === "commander") {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }

    const memberToken = req.cookies.get("member_token")?.value;
    if (memberToken && (await memberClaims(memberToken))) {
      return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    }

    if (isApi) {
      return NextResponse.json(
        { error: "Только для командиров и администраторов" },
        { status: panelToken || memberToken ? 403 : 401 }
      );
    }
    return NextResponse.redirect(new URL("/login", req.url));
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
      pathname.startsWith("/api/extension.zip") ||
      // Обслуживание системы: ротация копий, очистка журнала и правка состава
      // необратимы, поэтому командира сюда не пускаем ещё на входе. Роут
      // дублирует проверку (requireMaintenance) — обход middleware не должен
      // открывать доступ.
      pathname.startsWith("/api/admin/maintenance");

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
