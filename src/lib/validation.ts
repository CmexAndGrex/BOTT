/**
 * Чистые проверки и нормализации для L3–L9.
 *
 * Модуль намеренно не зависит ни от Next.js, ни от БД: это позволяет
 * тестировать боевую логику напрямую (tests/*.test.ts) без стенда и моков.
 * Если правило нужно и роуту, и тесту — живёт здесь, а не копией в двух местах.
 *
 * Из recruits.ts берутся только предикаты ролей бойца: они уже описаны там
 * (единый источник значений «officer»/«admin»), а второй их копии здесь быть
 * не должно — иначе правило доступа разошлось бы в двух местах.
 */
import { isMemberRole, isStaffRole, MEMBER_ROLES, type MemberRole } from "@/lib/recruits";

/** Проверка, что идентификатор Discord — «снежинка» (только цифры) */
export function isDiscordId(value: string | null | undefined): boolean {
  return /^\d{5,25}$/.test((value || "").trim());
}

/**
 * Ужесточённая проверка ID на границе Discord API.
 *
 * ID берутся из настроек панели и подставляются прямо в путь запроса
 * `/channels/{id}/messages`. Значение вида `123/../../users/@me` уехало бы
 * в другой эндпоинт Discord API (path injection).
 */
export function assertDiscordId(value: string, label: string): string {
  const id = (value || "").trim();
  if (!isDiscordId(id)) {
    throw new Error(
      `Некорректный ${label}: ожидается числовой ID (получено «${id.slice(0, 40)}»)`
    );
  }
  return id;
}

/**
 * Приводит Discord ID к каноническому виду («снежинке»).
 *
 * Копия профиля из Discord приходит с разделителями и упоминаниями
 * («<@123 456>»), а в БД должен лежать чистый ID: по нему ищется боец при
 * входе. null — значение не является ID: пустая строка означает «не задан»,
 * а мусор вида «1» или «user#1234» писать нельзя — по такому значению потом
 * ищется владелец учётной записи.
 */
export function normalizeDiscordSnowflake(value: unknown): string | null {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return isDiscordId(digits) ? digits : null;
}

/* ------------------------------------------------------------------ */
/* Ручная привязка Discord ID из табеля «Состав»                       */
/* ------------------------------------------------------------------ */

/**
 * Границы длины Discord Snowflake ID при ручном вводе из панели.
 *
 * Почему уже, чем isDiscordId (5–25): тот стоит на границе Discord API, где
 * значение приходит от самого Discord и важно лишь «это цифры, а не путь».
 * Здесь значение вводит человек, и слишком короткая строка («12345») — это
 * почти наверняка опечатка: такой ID не существует, а бот потом молча не
 * упомянет бойца. Действующие снежинки Discord — 17–19 цифр.
 */
export const ROSTER_DISCORD_ID_MIN_LENGTH = 17;
export const ROSTER_DISCORD_ID_MAX_LENGTH = 19;

/** Итог проверки введённого ID: значение (null — очистка) либо текст ошибки */
export type RosterDiscordIdResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Проверка Discord ID, введённого вручную в табеле «Состав».
 *
 * Правило одно для интерфейса и роута (как validateEquipment в «Арсенале»):
 * форма показывает требование сразу, а сервер отвечает той же формулировкой —
 * две копии проверки разошлись бы, и панель отклоняла бы то, что принимает API.
 *
 * Пустое значение — это не ошибка, а осознанная очистка: штаб так снимает
 * привязку (боец сменил Discord). Значение вроде «<@123…>» принимается: при
 * копипасте из Discord человек захватывает упоминание целиком, и требовать
 * снять «@» руками — лишняя работа для штаба.
 */
export function validateRosterDiscordId(value: unknown): RosterDiscordIdResult {
  const text = String(value ?? "").trim();
  if (!text) return { ok: true, value: null };

  const digits = text.replace(/[^\d]/g, "");
  if (!digits) {
    return { ok: false, error: "Discord ID состоит только из цифр" };
  }
  if (digits.length < ROSTER_DISCORD_ID_MIN_LENGTH || digits.length > ROSTER_DISCORD_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: `Discord ID — от ${ROSTER_DISCORD_ID_MIN_LENGTH} до ${ROSTER_DISCORD_ID_MAX_LENGTH} цифр (введено ${digits.length})`,
    };
  }
  return { ok: true, value: digits };
}

/* ------------------------------------------------------------------ */
/* Учётные записи панели: роли и приватность полей состава             */
/* ------------------------------------------------------------------ */

/** Роли учётной записи панели, дающие доступ к модерации и приватным полям */
export const PANEL_STAFF_ROLES = ["admin", "officer"] as const;

export type PanelStaffRole = (typeof PANEL_STAFF_ROLES)[number];

/**
 * Является ли роль ролью штаба панели.
 * Роли приходят из БД обычным текстом, поэтому неизвестное значение
 * («guest», мусор после ручной правки) должно трактоваться как «доступа нет».
 */
export function isPanelStaffRole(value: unknown): value is PanelStaffRole {
  return typeof value === "string" && (PANEL_STAFF_ROLES as readonly string[]).includes(value);
}

/**
 * Право видеть приватные поля состава (Discord ID).
 *
 * Правило одно для сервера и интерфейса: доступ есть у штаба панели
 * (admin/officer) ИЛИ у штаба бойца — командир, вошедший в кабинет, а не в
 * панель, тоже не должен терять рабочий инструмент. Все прочие видят табель
 * без технических ID.
 */
export function canViewPrivateFields(panelRole: unknown, memberRole: unknown): boolean {
  if (isPanelStaffRole(panelRole)) return true;
  return isMemberRole(memberRole) && isStaffRole(memberRole);
}

/**
 * Роль бойца при связке с аккаунтом панели.
 *
 * Уровень доступа только поднимается до роли аккаунта и никогда не понижается:
 * связка означает «этот человек — командир или администратор», а решение о
 * понижении принимается отдельно в модерации рапортов, где виден статус и
 * история бойца. Иначе привязка аккаунта командира к бойцу-«member» молча
 * отняла бы у него права штаба, которые он получил раньше.
 */
export function roleAfterLink(current: unknown, target: PanelStaffRole): MemberRole {
  const desired = target;
  if (!isMemberRole(current)) return desired;
  const order = (role: MemberRole): number => MEMBER_ROLES.indexOf(role);
  return order(current) > order(desired) ? current : desired;
}

/**
 * Счётчик предупреждений бойца.
 *
 * Раньше значение ПЕРЕЗАПИСЫВАЛОСЬ по типу запроса (`type === 1 → 1`), из-за
 * чего повторная выдача «1/2» сбрасывала накопленные предупреждения и боец
 * с 2/2 снова «становился» 1/2. Теперь счётчик только растёт, а явный тип 2
 * сразу доводит до исключения.
 */
export function nextWarningCount(current: number, requested: 1 | 2): number {
  const base = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  return Math.min(Math.max(base + 1, requested), 2);
}

/**
 * Лимит частоты запросов по произвольному ключу.
 *
 * Заменяет прежний глобальный лимит на одну константу: ключ `${кто}:${кому}`
 * означает, что один офицер больше не блокирует выдачу предупреждений
 * остальным, но не может «даблкликать» по одному и тому же бойцу.
 */
export class CooldownLimiter {
  private readonly hits = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly maxKeys: number;
  private readonly staleMs: number;

  constructor(cooldownMs: number, maxKeys = 2000, staleMs = 60_000) {
    this.cooldownMs = cooldownMs;
    this.maxKeys = maxKeys;
    this.staleMs = staleMs;
  }

  /** true — запрос разрешён, false — сработал лимит */
  allow(key: string, now: number = Date.now()): boolean {
    const last = this.hits.get(key);
    // Ключа ещё нет — это первый запрос, он всегда разрешён. Проверять
    // `now - 0 < cooldownMs` нельзя: при малом времени это ложно блокировало
    // бы самый первый запрос.
    if (last !== undefined && now - last < this.cooldownMs) return false;
    this.hits.set(key, now);
    if (this.hits.size > this.maxKeys) this.evict(now);
    return true;
  }

  /**
   * Держим карту в границах: сначала выбрасываем устаревшие ключи, а если
   * жёсткого лимита всё ещё недостаточно — самые старые. Без второго шага
   * при плотном потоке (когда «устаревших» ещё нет) карта росла бы бесконечно,
   * вопреки заявленному ограничению.
   */
  private evict(now: number): void {
    const cutoff = now - this.staleMs;
    for (const [k, at] of this.hits) {
      if (at < cutoff) this.hits.delete(k);
    }
    if (this.hits.size <= this.maxKeys) return;
    // Map сохраняет порядок вставки — удаляем с начала, пока не уложимся
    const excess = this.hits.size - this.maxKeys;
    let removed = 0;
    for (const k of this.hits.keys()) {
      if (removed >= excess) break;
      this.hits.delete(k);
      removed++;
    }
  }

  get size(): number {
    return this.hits.size;
  }

  clear(): void {
    this.hits.clear();
  }
}

/**
 * Выбирает безопасный origin для адреса панели.
 *
 * Раньше адрес брался из клиентских заголовков (Referer / X-Forwarded-Host),
 * поэтому в архив расширения можно было вшить чужой домен и увести cookie
 * rs-red.com на сторону. Возвращаем первый кандидат, похожий на реальный
 * адрес: только http(s) и только правдоподобный хост.
 */
export function firstSafeOrigin(candidates: string[]): string | null {
  for (const raw of candidates) {
    const candidate = (raw || "").trim();
    if (!candidate) continue;
    // Домены/поддомены, допускается порт; без пробелов, кавычек и слэшей
    const host = candidate.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9.-]+(:\d{2,5})?$/i.test(host)) continue;
    const withProto = /^https?:\/\//i.test(candidate) ? candidate : `https://${host}`;
    try {
      const u = new URL(withProto);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      return u.origin;
    } catch {
      continue;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Origin глазами браузера                                             */
/* ------------------------------------------------------------------ */

/**
 * Адрес прослушивания, а не адрес визита.
 *
 * В Dockerfile задано `HOSTNAME=0.0.0.0`, и Next подставляет это значение в
 * req.url (см. route-module: initURL собирается из hostname, потому что
 * trustHostHeader выключен). Редирект на такой адрес браузер отклоняет с
 * ERR_ADDRESS_INVALID, поэтому «нулевой» хост заменяем на localhost.
 */
const LISTEN_ALL_HOST = "0.0.0.0";

/** Хост без порта, в нижнем регистре */
function hostName(host: string): string {
  return host.split(":")[0].toLowerCase();
}

/** Локальный запуск: протокол там http, а не https */
function isLocalHost(host: string): boolean {
  const name = hostName(host);
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/**
 * Хост — IP-адрес. Панель без домена (docker-compose открывает порт 3000
 * наружу) работает по http, поэтому для IP протокол не повышаем до https —
 * иначе редирект увёл бы браузер на несуществующий TLS-порт.
 */
function isIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}(:\d{2,5})?$/.test(host) || /^\[[0-9a-f:]+\](:\d{2,5})?$/i.test(host);
}

/** Похож ли хост на адрес, который браузер реально откроет: домен, IP или localhost */
function isUsableHost(host: string): boolean {
  return /^[a-z0-9.-]+(:\d{2,5})?$/i.test(host) && !host.startsWith(".") && !host.includes("..");
}

/**
 * Origin для перенаправления браузера.
 *
 * Почему не `new URL(path, req.url)`: req.url в Next собран из переменной
 * окружения HOSTNAME, а в контейнере это 0.0.0.0 — браузер по такому адресу
 * не пойдёт (ERR_ADDRESS_INVALID). Хост берём из заголовков запроса, как это
 * уже делает discordRedirectUri. Значение X-Forwarded-* подставляет обратный
 * прокси, но формат всё равно проверяем: иначе в Location можно было бы
 * подставить чужой домен и увести человека на фишинговую копию панели.
 *
 * Возвращает origin без пути, например «https://atk-red.site».
 */
export function browserOrigin(headers: Headers, fallbackHost = "localhost:3000"): string {
  const firstValue = (value: string | null): string => (value || "").split(",")[0].trim();

  const candidates = [
    firstValue(headers.get("x-forwarded-host")),
    firstValue(headers.get("host")),
    firstValue(fallbackHost),
  ];

  let host = "";
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Адрес прослушивания открыть нельзя — ведём на localhost, сохраняя порт
    const reachable = candidate
      .replace(/\s/g, "")
      .replaceAll(LISTEN_ALL_HOST, "localhost")
      .replace(/^\[::\](?=:|$)/, "localhost");
    if (isUsableHost(reachable)) {
      host = reachable;
      break;
    }
  }
  if (!host) host = fallbackHost;

  const forwardedProto = firstValue(headers.get("x-forwarded-proto")).toLowerCase();
  const proto =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : isLocalHost(host) || isIpHost(host)
        ? "http"
        : "https";

  return `${proto}://${host}`;
}
/**
 * Локальный путь возврата после входа (?next=/profile).
 *
 * Зачем: клик «Войти» на /profile вёл на /login, а после входа человек попадал
 * на «/» или снова на кабинет — то есть в цикл «/profile → /login → /profile»
 * из отчёта. Возврат на исходную страницу его устраняет.
 *
 * Принимаем ТОЛЬКО локальный путь (начинается с одного «/»): значение вида
 * «//evil.com» или «https://evil.com» браузер трактует как чужой адрес, и
 * возврат после входа стал бы открытым редиректом — удобным для фишинга, ведь
 * ссылка выглядит как наш домен. Схемы, обратные слеши и переводы строк
 * отсекаем явно (браузеры нормализуют «/\» и «\» в «//»).
 */
export function safeRedirectPath(raw: unknown, fallback = "/"): string {
  const value = typeof raw === "string" ? raw.trim().slice(0, 300) : "";
  if (!value) return fallback;
  // Ровно один ведущий слеш: «//host» и «/\host» — это чужой origin
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  // Управляющие символы (в т.ч. перевод строки) в Location недопустимы
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  // Схема внутри пути («/x?u=https://evil») безопасна: она остаётся путём на
  // нашем домене, поэтому проверять её не нужно — важно лишь начало строки.
  return value;
}

/**
 * Приводит ссылку к http(s); null — если она невалидна или небезопасна.
 *
 * Отсекаем ссылки с логином/паролем (`https://user:pass@host` — маскировка
 * реального домена), схемы javascript:/data:/vbscript:/file:/blob:, а также
 * локальные и приватные адреса, чтобы панель нельзя было использовать как
 * «маячок» для внутренней сети.
 */
export function normalizeUrl(input: string): string | null {
  let raw = input.trim().slice(0, 2000);
  if (!raw) return null;

  // Явно отклоняем опасные схемы до автодобавления https://
  if (/^(javascript|data|vbscript|file|blob|about):/i.test(raw)) return null;

  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;

    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return null;
    }
    // Приватные диапазоны IPv4 (10/8, 127/8, 192.168/16, 172.16-31/12, 169.254/16)
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const [a, b] = host.split(".").map(Number);
      const priv =
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 169 && b === 254);
      if (priv) return null;
    }

    return u.toString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Командный состав: иммунитет от предупреждений онлайна               */
/* ------------------------------------------------------------------ */
/*
 * Раньше комсостав определялся по подстроке «командир» в должности, из-за чего
 * иммунитет от предупреждений получали командиры боевых машин, отделений и
 * расчётов — те, кто обязан выполнять общую норму часов наравне со всеми.
 * Плашка «★ КОМАНДИР» в панели «Контроль» появлялась у младших командиров, а
 * кнопки «1/2 Пред.» / «2/2 Пред.» у них скрывались.
 *
 * Теперь состав определяется явно и узко:
 *   * «★ КОМАНДИР КОРПУСА» — ФИО «Волков Д. В.» ИЛИ должность «Командир Корпуса»;
 *   * «★ ЗАМ. КОМАНДИРА»   — реальные заместители (зам. ком. корпуса, заместитель
 *                            командира);
 *   * «★ КОМ. РОТЫ» / «★ КОМ. ДИВИЗИОНА» — командиры роты и арт. дивизиона.
 * Прочие должности со словом «командир» (КБМ, отделение, расчёт, экипаж)
 * командованием НЕ считаются: они получают стандартные кнопки предупреждений.
 *
 * Правило намеренно не зависит от БД и Next.js: оно живёт рядом с прочими
 * чистыми предикатами validation.ts и проверяется напрямую
 * (tests/commander-protection.test.ts). Клиент «Контроль» и роут /api/warn
 * используют одну и ту же функцию, поэтому «плашка есть, а кнопок нет» больше
 * разойтись не может.
 */

/** ФИО Командира Корпуса; сравнение — без учёта регистра, точек и пробелов */
export const CORPS_COMMANDER_FULL_NAME = "Волков Д. В.";

/** Должность Командира Корпуса (сравнение — строгое, по нормализованной строке) */
export const CORPS_COMMANDER_POSTS: readonly string[] = ["командир корпуса"];

/** Признаки заместителя командира — подстрока нормализованной должности */
export const DEPUTY_COMMANDER_MARKERS: readonly string[] = [
  "зам ком корпуса",
  "заместитель командира",
  "зам командира",
];

/** Командиры роты — должность строго равна одному из написаний */
export const COMPANY_COMMANDER_POSTS: readonly string[] = [
  "командир роты",
  "командир танковой роты",
];

/** Командиры артиллерийского дивизиона — должность строго равна одному из написаний */
export const DIVISION_COMMANDER_POSTS: readonly string[] = [
  "командир дивизиона",
  "командир арт дивизиона",
  "командир артиллерийского дивизиона",
];

/**
 * Ключ сравнения должности: нижний регистр, «ё»→«е», точки вырезаны, лишние
 * пробелы сжаты. Должность приходит из ШДС, rs-red.com и ручного ввода панели,
 * поэтому «Командир арт. дивизиона» и «КОМАНДИР  АРТ. ДИВИЗИОНА» обязаны
 * распознаваться одинаково.
 */
function postKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ключ ФИО: нижний регистр, «ё»→«е», любые разделители (пробелы, точки)
 * удаляются, поэтому «Волков Д. В.», «Волков Д.В.» и «волков  д в» дают один
 * ключ. Инициалы в табеле встречаются и с пробелом, и без — сравнивать их
 * построчно значило бы не признать командира в написании «Волков Д.В.».
 */
function fullNameKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]/g, "");
}

/** Ключ ФИО командира корпуса — вычисляется один раз */
const CORPS_COMMANDER_NAME_KEY = fullNameKey(CORPS_COMMANDER_FULL_NAME);

/** Боец — Командир Корпуса: по ФИО «Волков Д. В.» или должности «Командир Корпуса» */
export function isCorpsCommander(fighter: { name?: string | null; post?: string | null }): boolean {
  if (fullNameKey(fighter?.name) === CORPS_COMMANDER_NAME_KEY) return true;
  return CORPS_COMMANDER_POSTS.includes(postKey(fighter?.post));
}

/** Проверка, является ли боец именно заместителем командира */
export function isDeputyCommander(fighter: { post?: string | null }): boolean {
  const post = postKey(fighter?.post);
  if (!post) return false;
  return DEPUTY_COMMANDER_MARKERS.some((marker) => post.includes(marker));
}

/** Боец — командир роты (в том числе танковой) */
export function isCompanyCommander(fighter: { post?: string | null }): boolean {
  return COMPANY_COMMANDER_POSTS.includes(postKey(fighter?.post));
}

/** Боец — командир артиллерийского дивизиона */
export function isDivisionCommander(fighter: { post?: string | null }): boolean {
  return DIVISION_COMMANDER_POSTS.includes(postKey(fighter?.post));
}

/** Боец — командир роты или дивизиона (любой из уровней подразделения) */
export function isUnitCommander(fighter: { post?: string | null }): boolean {
  return isCompanyCommander(fighter) || isDivisionCommander(fighter);
}

/**
 * Боец — высший командный состав корпуса (иммунитет от предупреждений).
 *
 * Сюда НЕ попадают командиры боевых машин, отделений, расчётов и экипажей: они
 * выполняют общую норму часов и получают стандартные кнопки предупреждений.
 */
export function isCommanderFighter(fighter: { name?: string | null; post?: string | null }): boolean {
  return isCorpsCommander(fighter) || isDeputyCommander(fighter) || isUnitCommander(fighter);
}

/** Бейдж командного состава для панели «Контроль»; null — обычный боец */
export function commanderBadgeLabel(fighter: { name?: string | null; post?: string | null }): string | null {
  if (isCorpsCommander(fighter)) return "★ КОМАНДИР КОРПУСА";
  if (isDeputyCommander(fighter)) return "★ ЗАМ. КОМАНДИРА";
  if (isCompanyCommander(fighter)) return "★ КОМ. РОТЫ";
  if (isDivisionCommander(fighter)) return "★ КОМ. ДИВИЗИОНА";
  return null;
}
