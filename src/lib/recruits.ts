/**
 * Домен новобранцев: позывные, звания, подразделения, статусы и анкеты.
 *
 * Модуль намеренно не зависит ни от БД, ни от Next.js, ни от Discord: это
 * позволяет тестировать боевые правила напрямую (tests/recruits.test.ts) и
 * использовать их одинаково на сервере (роуты) и в интерфейсе (формы).
 * Если правило нужно и роуту, и форме — живёт здесь, а не копией в двух местах.
 */

/* ------------------------------------------------------------------ */
/* Позывной (он же логин)                                              */
/* ------------------------------------------------------------------ */

/** Минимальная длина позывного */
export const CALLSIGN_MIN_LENGTH = 3;
/** Максимальная длина позывного (как и логинов панели) */
export const CALLSIGN_MAX_LENGTH = 32;

/**
 * Приводит введённый позывной к каноническому виду: обрезает пробелы по краям
 * и схлопывает внутренние. Регистр НЕ трогаем — позывной виден в табеле и
 * Google Таблице так, как его написал боец («Скиф» ≠ «скиф»).
 */
export function normalizeCallsign(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, CALLSIGN_MAX_LENGTH * 2);
}

/**
 * Проверка позывного по формату ШДС.
 *
 * Допускаются буквы (кириллица/латиница), цифры, пробел, точка, дефис и
 * подчёркивание: в таблице встречаются позывные вида «Скиф», «Гром-2»,
 * «Штурман 1». Спецсимволы и эмодзи отсекаются — они ломают поиск по листу
 * и позволяют создать визуально неотличимый логин.
 * Позывной должен содержать хотя бы одну букву (не может быть только цифрами).
 */
export function isCallsign(value: unknown): boolean {
  const callsign = normalizeCallsign(value);
  if (callsign.length < CALLSIGN_MIN_LENGTH || callsign.length > CALLSIGN_MAX_LENGTH) {
    return false;
  }
  // Разрешены буквы, цифры, пробелы, точка, дефис, подчёркивание
  if (!/^[\wА-Яа-яЁё.\- ]+$/u.test(callsign)) {
    return false;
  }
  // Позывной должен содержать хотя бы одну букву
  return /[a-zA-ZА-Яа-яЁё]/.test(callsign);
}

/* ------------------------------------------------------------------ */
/* Звания, подразделения, статусы, роли                                */
/* ------------------------------------------------------------------ */

/** Звания, используемые в системе (совпадают с ролями Discord, см. roles.ts) */
export const RANKS = [
  "Курсант",
  "Рядовой",
  "Ефрейтор",
  "Мл. Сержант",
  "Сержант",
  "Ст. Сержант",
  "Старшина",
  "Прапорщик",
  "Ст. Прапорщик",
  "Лейтенант",
  "Ст. Лейтенант",
  "Капитан",
  "Майор",
  "Подполковник",
  "Полковник",
] as const;

export type Rank = (typeof RANKS)[number];

/** Звание по умолчанию при создании рапорта */
export const DEFAULT_RANK: Rank = "Курсант";

/**
 * Подразделения. Значения совпадают с названиями листов Google Таблицы —
 * именно так их ожидает resolveLayout()/getSheet() в src/lib/gsheets.ts,
 * поэтому «Танковая рота» и «Артиллерийский дивизион» переименовывать нельзя.
 */
export const UNITS = ["Танковая рота", "Артиллерийский дивизион"] as const;

export type Unit = (typeof UNITS)[number];

/** Статус учётной записи бойца */
export const MEMBER_STATUS = {
  /** Рапорт подан и находится на рассмотрении штаба */
  PENDING: "pending",
  /** В строю — доступен личный кабинет */
  ACTIVE: "active",
  /** В отпуске — доступ к кабинету сохраняется */
  VACATION: "vacation",
  /** Рапорт отклонён / боец исключён — вход закрыт */
  DISMISSED: "dismissed",
} as const;

export type MemberStatus = (typeof MEMBER_STATUS)[keyof typeof MEMBER_STATUS];

const STATUSES: readonly string[] = Object.values(MEMBER_STATUS);

export function isMemberStatus(value: unknown): value is MemberStatus {
  return typeof value === "string" && STATUSES.includes(value);
}

/** Человекочитаемые названия статусов для интерфейса */
export const STATUS_LABELS: Record<MemberStatus, string> = {
  pending: "На рассмотрении",
  active: "В строю",
  vacation: "Отпуск",
  dismissed: "Отклонён",
};

/** Статус, который показывается бойцу в кабинете и модерации */
export function statusLabel(status: MemberStatus): string {
  return STATUS_LABELS[status] ?? STATUS_LABELS.pending;
}

/** Уровень доступа в системе панели */
export const MEMBER_ROLES = ["recruit", "member", "officer", "admin"] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);
}

/** Человекочитаемые названия уровней доступа */
export const ROLE_LABELS: Record<MemberRole, string> = {
  recruit: "Новобранец",
  member: "Боец",
  officer: "Командир",
  admin: "Администратор",
};

/**
 * Кто допущен в панель модерации рапортов.
 * admin проходит всегда — эту проверку выполняет requireRole().
 */
export function isStaffRole(role: MemberRole): boolean {
  return role === "officer" || role === "admin";
}

/**
 * Приведение значения статуса к сравнимому виду.
 *
 * Зачем: в division_members.status попадают значения из разных источников —
 * синхронизации rs-red.com, бота и ручных правок. Кроме канонических
 * `active`/`vacation` встречаются `in_service`, `service` и русские подписи
 * «В строю» / «В отпуске». Точное сравнение со строкой "active" из-за этого
 * отвечало «нет доступа» действующему бойцу, и вход через Discord показывал
 * экран «рапорт на рассмотрении» человеку, который давно в строю.
 *
 * Нормализация: неразрывные пробелы → обычные, регистр вниз, «ё» → «е».
 */
export function normalizeStatusToken(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

/**
 * Значения статуса (включая алиасы), при которых личный кабинет доступен.
 * Элементы уже приведены к виду normalizeStatusToken.
 */
const PROFILE_ACCESS_STATUSES: ReadonlySet<string> = new Set([
  // Канонические
  "active",
  "vacation",
  // Альтернативные написания из синхронизации и ручных правок
  "in_service",
  "in-service",
  "in service",
  "service",
  "on_vacation",
  "on-vacation",
  // Русские подписи статуса
  "в строю",
  "встрой",
  "в отпуске",
  "отпуск",
]);

/** Канонические статусы «служба идёт»: в строю и в отпуске */
const ACTIVE_LIKE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "in_service",
  "in-service",
  "in service",
  "service",
  "в строю",
  "встрой",
]);

/** Канонические статусы отпуска */
const VACATION_LIKE_STATUSES: ReadonlySet<string> = new Set([
  "vacation",
  "on_vacation",
  "on-vacation",
  "в отпуске",
  "отпуск",
]);

/** Канонические статусы исключения */
const DISMISSED_LIKE_STATUSES: ReadonlySet<string> = new Set([
  "dismissed",
  "excluded",
  "исключен",
  "отклонен",
]);

/**
 * Канонический статус бойца по произвольному значению из БД.
 *
 * Возвращает одно из значений MemberStatus: алиасы «в строю» / in_service /
 * service сводятся к `active`, «в отпуске» — к `vacation`. Неизвестное значение
 * считается `pending` (доступа нет), чтобы опечатка в статусе не выдавала
 * кабинет постороннему.
 */
export function normalizeMemberStatus(value: unknown): MemberStatus {
  const token = normalizeStatusToken(value);
  if (!token) return MEMBER_STATUS.PENDING;
  if (ACTIVE_LIKE_STATUSES.has(token)) return MEMBER_STATUS.ACTIVE;
  if (VACATION_LIKE_STATUSES.has(token)) return MEMBER_STATUS.VACATION;
  if (DISMISSED_LIKE_STATUSES.has(token)) return MEMBER_STATUS.DISMISSED;
  return MEMBER_STATUS.PENDING;
}

/**
 * Статусы, при которых личный кабинет доступен.
 *
 * Принимает не только MemberStatus, но и строковые аналоги из БД: вход через
 * Discord передаёт сюда статус прямо из division_members, и требование «в строю
 * = доступ» не должно зависеть от того, каким синонимом записан статус.
 */
export function hasProfileAccess(status: unknown): boolean {
  return PROFILE_ACCESS_STATUSES.has(normalizeStatusToken(status));
}

/* ------------------------------------------------------------------ */
/* Discord ID                                                          */
/* ------------------------------------------------------------------ */

/**
 * Маркер «Discord не привязан, ID впишет модератор».
 * Нужен, потому что столбец discord_id уникален: у двух кандидатов без
 * Discord он должен быть NULL, а не пустой строкой (пустые строки совпали бы).
 */
export const MANUAL_DISCORD_ID = "manual";

/** Discord ID (снежинка) — только цифры. Маркер «manual» и пустое значение не проходят */
export function isDiscordSnowflake(value: unknown): boolean {
  const id = String(value ?? "").trim();
  if (!id || id === MANUAL_DISCORD_ID) return false;
  return /^\d{5,25}$/.test(id);
}
/* ------------------------------------------------------------------ */
/* Анкета рапорта                                                      */
/* ------------------------------------------------------------------ */

/** Границы возраста кандидата */
export const AGE_MIN = 10;
export const AGE_MAX = 70;

/** Подсказки специализаций (поле остаётся свободным — можно вписать свою) */
export const SPECIALIZATIONS = [
  "Танкист (наводчик)",
  "Механик-водитель",
  "Командир экипажа",
  "Артиллерист (наводчик орудия)",
  "Командир орудия",
  "Разведчик-корректировщик",
  "Связист",
  "Логист / снабжение",
  "Не определился",
] as const;

/** Максимальная длина свободных текстовых полей анкеты */
export const APPLICATION_TEXT_MAX = 1000;

export type ApplicationInput = {
  age?: unknown;
  armaExperience?: unknown;
  specialization?: unknown;
  comment?: unknown;
  /**
   * Вид заявки. Для возврата из запаса анкета необязательна: боец уже служил,
   * и требование спрашивает у него только позывной и ФИО.
   */
  kind?: RecruitApplicationKind;
};

export type ApplicationData = {
  age: number;
  armaExperience: string;
  specialization: string;
  comment: string;
};

export type ApplicationValidation =
  | { ok: true; data: ApplicationData }
  | { ok: false; error: string };

/** Обрезает строку до лимита, чтобы в БД не уезжал «роман» на мегабайт */
function clip(value: unknown, max: number = APPLICATION_TEXT_MAX): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

/**
 * Проверяет и нормализует анкету рапорта.
 *
 * Возраст приводится к числу здесь, а не в роуте: из формы он приходит
 * строкой, и такие значения сохранялись бы как «18» — после этого сравнения
 * вида `age < 18` молча работали бы со строкой.
 *
 * `kind` меняет набор обязательных полей. Возврат из запаса анкеты не требует:
 * боец известен, его данные уже в табеле, а требование называет для него лишь
 * позывной и ФИО (проверяет их роут). Опыт и специализацию при этом сохраняем,
 * если их заполнили, — они попадают в карточку модерации.
 */
export function validateApplication(input: ApplicationInput): ApplicationValidation {
  const ageRaw = typeof input.age === "string" ? input.age.trim() : input.age;
  const age = typeof ageRaw === "number" ? ageRaw : Number(ageRaw);
  const armaExperience = clip(input.armaExperience);
  const specialization = clip(input.specialization, 100);
  const comment = clip(input.comment);

  // Анкета возвращающегося: возраст и опыт не спрашиваем (он уже служил)
  if (input.kind === APPLICATION_KIND_RESERVE_RETURN) {
    return {
      ok: true,
      data: {
        age: Number.isInteger(age) && age > 0 ? age : AGE_MIN,
        armaExperience,
        specialization: specialization || "Возврат из запаса",
        comment,
      },
    };
  }

  if (!Number.isInteger(age) || age < AGE_MIN || age > AGE_MAX) {
    return { ok: false, error: `Возраст: укажите целое число от ${AGE_MIN} до ${AGE_MAX}` };
  }

  if (armaExperience.length < 2) {
    return { ok: false, error: "Опыт в Arma 3: заполните поле (например «600 часов, 3 года»)" };
  }

  if (specialization.length < 2) {
    return { ok: false, error: "Специализация: выберите вариант или впишите свою" };
  }

  return { ok: true, data: { age, armaExperience, specialization, comment } };
}

/**
 * Безопасное чтение анкеты из jsonb.
 *
 * Поле может содержать что угодно: старые записи, ручные правки в psql,
 * мусор после неудачной миграции. Возвращаем строго типизированный объект,
 * иначе интерфейс модерации падал бы на чтении свойства у undefined.
 */
export function readApplication(value: unknown): Partial<ApplicationData> {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<ApplicationData> = {};
  const age = Number(raw.age);
  if (Number.isInteger(age) && age > 0) out.age = age;
  if (typeof raw.armaExperience === "string") {
    out.armaExperience = raw.armaExperience.slice(0, APPLICATION_TEXT_MAX);
  }
  if (typeof raw.specialization === "string") out.specialization = raw.specialization.slice(0, 100);
  if (typeof raw.comment === "string") out.comment = raw.comment.slice(0, APPLICATION_TEXT_MAX);
  return out;
}

/* ------------------------------------------------------------------ */
/* Сообщения для кандидата                                             */
/* ------------------------------------------------------------------ */

/** Подпись, которую кандидат видит сразу после отправки рапорта */
export const PENDING_NOTICE = "Ваш рапорт находится на рассмотрении штаба";

/* ------------------------------------------------------------------ */
/* Вид заявки: новобранец или возврат из запаса                        */
/* ------------------------------------------------------------------ */

/**
 * Виды заявки на вступление (колонка kind в recruit_applications).
 *
 * RECRUIT — обычное зачисление нового бойца, RESERVE_RETURN — возврат из
 * запаса: бойца не создают заново, а восстанавливают его строку в ШДС
 * (лист «Запас» → свободная строка «Вакант» подразделения), снимают роль
 * «Запас» и возвращают прежние роли из колонки AI (у записей старого формата —
 * из колонки V).
 *
 * Значения — единый источник и для формы (/apply), и для модерации, и для
 * решения: строка, набранная руками в одном месте, разошлась бы с другим.
 */
export const RECRUIT_APPLICATION_KINDS = ["recruit", "reserve_return"] as const;

/** Обычное зачисление нового бойца */
export const APPLICATION_KIND_RECRUIT = "recruit" as const;
/** Возврат из запаса: восстановление строки в ШДС и прежних ролей */
export const APPLICATION_KIND_RESERVE_RETURN = "reserve_return" as const;

export type RecruitApplicationKind = (typeof RECRUIT_APPLICATION_KINDS)[number];

/** Значение по умолчанию: заявка без вида — обычное зачисление */
export const DEFAULT_APPLICATION_KIND: RecruitApplicationKind = "recruit";

export function isRecruitApplicationKind(value: unknown): value is RecruitApplicationKind {
  return (
    typeof value === "string" &&
    (RECRUIT_APPLICATION_KINDS as readonly string[]).includes(value)
  );
}

/** Подписи видов заявки: их видит и кандидат в форме, и штаб в модерации */
export const APPLICATION_KIND_LABELS: Record<RecruitApplicationKind, string> = {
  recruit: "Новобранец",
  reserve_return: "Возврат из запаса",
};

/**
 * Заголовок заявки для панели модерации и Embed.
 *
 * Возврат помечается явной формулировкой из требования — «Запрос на возврат из
 * запаса», чтобы модератор не принял его за обычное зачисление: решение по
 * такому запросу двигает строку в Google Таблице, а не создаёт новую.
 */
export const APPLICATION_KIND_TITLES: Record<RecruitApplicationKind, string> = {
  recruit: "Заявка на вступление",
  reserve_return: "Запрос на возврат из запаса",
};

export const FULL_NAME_MIN_LENGTH = 5;
export const FULL_NAME_MAX_LENGTH = 60;

/**
 * Проверка ФИО для возврата из запаса.
 *
 * ФИО обязательно ищется на листе «Запас»: без него строку найти нечем, и
 * восстановление невозможно. Требования к формату мягкие (буквы, пробел,
 * точка, дефис) — в табеле встречаются записи вида «Волков Д. В.».
 */
export function normalizeFullName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, FULL_NAME_MAX_LENGTH);
}

export function isFullName(value: unknown): boolean {
  const name = normalizeFullName(value);
  if (name.length < FULL_NAME_MIN_LENGTH || name.length > FULL_NAME_MAX_LENGTH) return false;
  return /^[\wА-Яа-яЁё.\- ]+$/u.test(name);
}

/**
 * Латинские двойники, которые визуально совпадают с кириллицей.
 *
 * В таблицу ФИО попадают копированием из Discord и из других систем, где
 * инициалы набраны латиницей: «Розгов A.В.» латинская «A» не равна кириллической
 * «А», и поиск бойца на листе отвечал «не найден», хотя строка есть. Сводятся
 * только буквы, которые в кириллице выглядят так же — остальные буквы латиницы
 * не трогаем, иначе «Ivanov» превратился бы в «Иван».
 */
const CYRILLIC_HOMOGLYPHS: Record<string, string> = {
  A: "А",
  B: "В",
  C: "С",
  E: "Е",
  H: "Н",
  K: "К",
  M: "М",
  O: "О",
  P: "Р",
  T: "Т",
  X: "Х",
  Y: "У",
};

/** Замена латинских двойников кириллицей (регистр сохраняется) */
export function toCyrillicHomoglyphs(value: string): string {
  return String(value ?? "").replace(/[A-Za-z]/g, (ch) => {
    const upper = ch.toUpperCase();
    const cyrillic = CYRILLIC_HOMOGLYPHS[upper];
    if (!cyrillic) return ch;
    return ch === upper ? cyrillic : cyrillic.toLowerCase();
  });
}

/**
 * Ключ сравнения ФИО из таблицы ШДС и из базы.
 *
 * Правила (нужны, потому что одно и то же ФИО записано по-разному):
 *   1. неразрывные пробелы из Google Таблиц → обычные, trim и схлопывание;
 *   2. латинские двойники → кириллица;
 *   3. точки в инициалах: «Розгов А.В.» == «Розгов А. В.»
 *      (пробел после точки убирается, точки остаются значимыми);
 *   4. «ё» → «е», регистр вниз.
 *
 * Возвращает уже сравнимую строку: её используют и поиск по листу, и тесты.
 */
export function normalizePersonName(value: unknown): string {
  if (typeof value !== "string") return "";
  return toCyrillicHomoglyphs(value)
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.\s+/g, ".") // «А. В.» → «А.В.»
    .replace(/\s*\.\s*/g, ".") // «А . В .» → «А.В.»
    .toLowerCase()
    .replace(/ё/g, "е");
}

/** Подпись для отклонённого рапорта */
export const DISMISSED_NOTICE =
  "Рапорт отклонён. Свяжитесь с командирским составом в Discord для уточнения причин";

/**
 * Позывной из имени бойца в rs-red.com (handle).
 * Нужен, чтобы предзаполнить форму рапорта тому, кто только что вошёл через
 * Discord: аккаунта у него ещё нет, но имя из подразделения уже известно.
 */
export function callsignFromHandle(handle: string | null | undefined): string {
  const value = normalizeCallsign(handle);
  return isCallsign(value) ? value : "";
}

/* ------------------------------------------------------------------ */
/* Ограничитель попыток входа                                          */
/* ------------------------------------------------------------------ */

/** Параметры защиты от перебора паролей */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
/** Записи о неудачах дольше суток не нужны — карта не должна расти вечно */
const LOGIN_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

type ThrottleRecord = { attempts: number; lockUntil: number; at: number };

export type LoginThrottleState = { locked: boolean; retryAfterMinutes: number };

/**
 * Счётчик неудачных попыток входа с блокировкой.
 *
 * Логика вынесена из роута в чистый класс: при переносе кода в роут легко
 * потерять ветку «после N неудач аккаунт блокируется», и проверяется такое
 * только тестом. Ключ — IP + позывной, поэтому перебор по одному аккаунту
 * не блокирует остальных бойцов с того же адреса.
 */
export class LoginThrottle {
  private readonly records = new Map<string, ThrottleRecord>();
  private readonly maxAttempts: number;
  private readonly lockMs: number;
  private readonly maxKeys: number;

  /**
   * Поля объявлены явно, а не через параметры конструктора: тесты исполняют
   * TypeScript напрямую (node:test, strip-only режим), который такие параметры
   * не поддерживает — боевой код должен оставаться тестируемым.
   */
  constructor(maxAttempts: number = LOGIN_MAX_ATTEMPTS, lockMs: number = LOGIN_LOCK_MS, maxKeys = 5000) {
    this.maxAttempts = maxAttempts;
    this.lockMs = lockMs;
    this.maxKeys = maxKeys;
  }

  /** Состояние на текущий момент: заблокирован ли ключ */
  check(key: string, now: number = Date.now()): LoginThrottleState {
    const record = this.records.get(key);
    if (record && record.lockUntil > now) {
      return {
        locked: true,
        retryAfterMinutes: Math.ceil((record.lockUntil - now) / 60000),
      };
    }
    return { locked: false, retryAfterMinutes: 0 };
  }

  /** Отмечает неудачную попытку; возвращает выданную блокировку */
  registerFailure(key: string, now: number = Date.now()): LoginThrottleState {
    const previous = this.records.get(key);
    const attempts = (previous?.attempts || 0) + 1;
    const lockUntil = attempts >= this.maxAttempts ? now + this.lockMs : 0;
    this.records.set(key, { attempts, lockUntil, at: now });
    if (this.records.size > this.maxKeys) this.evict(now);
    return {
      locked: lockUntil > now,
      retryAfterMinutes: lockUntil ? Math.ceil((lockUntil - now) / 60000) : 0,
    };
  }

  /** Успешный вход снимает счётчик неудач */
  reset(key: string): void {
    this.records.delete(key);
  }

  /**
   * Убирает записи, потерявшие смысл: снятую блокировку и всё, что старше
   * суток. Вызывается из обслуживания системы (pruneExpiredSessionsAndLogs):
   * без этого карта живёт до вытеснения по лимиту, и «очистка устаревших
   * сессий» в панели ничего не меняла бы в памяти процесса.
   *
   * Возвращает число удалённых записей.
   */
  pruneExpired(now: number = Date.now()): number {
    const cutoff = now - LOGIN_RECORD_TTL_MS;
    let removed = 0;
    for (const [key, record] of this.records) {
      // Блокировка действует — запись нужна: снятие сбросило бы защиту.
      if (record.lockUntil > now) continue;
      if (record.at < cutoff) {
        this.records.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Держим карту в границах: сначала выбрасываем записи старше суток, затем —
   * самые старые, если лимита всё ещё недостаточно (иначе при плотном потоке
   * «устаревших» может не быть вовсе, и карта росла бы без ограничений).
   */
  private evict(now: number): void {
    const cutoff = now - LOGIN_RECORD_TTL_MS;
    for (const [key, record] of this.records) {
      if (record.at < cutoff) this.records.delete(key);
    }
    if (this.records.size <= this.maxKeys) return;
    const excess = this.records.size - this.maxKeys;
    let removed = 0;
    for (const key of this.records.keys()) {
      if (removed >= excess) break;
      this.records.delete(key);
      removed++;
    }
  }

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }
}