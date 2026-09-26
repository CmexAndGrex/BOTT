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
 */
export function isCallsign(value: unknown): boolean {
  const callsign = normalizeCallsign(value);
  if (callsign.length < CALLSIGN_MIN_LENGTH || callsign.length > CALLSIGN_MAX_LENGTH) {
    return false;
  }
  return /^[\wА-Яа-яЁё.\- ]+$/u.test(callsign);
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

/** Статусы, при которых личный кабинет доступен */
export function hasProfileAccess(status: MemberStatus): boolean {
  return status === MEMBER_STATUS.ACTIVE || status === MEMBER_STATUS.VACATION;
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
 */
export function validateApplication(input: ApplicationInput): ApplicationValidation {
  const ageRaw = typeof input.age === "string" ? input.age.trim() : input.age;
  const age = typeof ageRaw === "number" ? ageRaw : Number(ageRaw);
  if (!Number.isInteger(age) || age < AGE_MIN || age > AGE_MAX) {
    return { ok: false, error: `Возраст: укажите целое число от ${AGE_MIN} до ${AGE_MAX}` };
  }

  const armaExperience = clip(input.armaExperience);
  if (armaExperience.length < 2) {
    return { ok: false, error: "Опыт в Arma 3: заполните поле (например «600 часов, 3 года»)" };
  }

  const specialization = clip(input.specialization, 100);
  if (specialization.length < 2) {
    return { ok: false, error: "Специализация: выберите вариант или впишите свою" };
  }

  return {
    ok: true,
    data: { age, armaExperience, specialization, comment: clip(input.comment) },
  };
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