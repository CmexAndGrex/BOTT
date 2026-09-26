/**
 * Домен рапортов действующего состава и заявок на вступление.
 *
 * Модуль намеренно не зависит ни от БД, ни от Next.js, ни от Discord — ровно
 * как recruits.ts: правила проверяются тестами напрямую (tests/reports.test.ts)
 * и используются одинаково в роутах, интерфейсе и боте. Если правило нужно и
 * серверу, и форме — живёт здесь, а не копией в двух местах.
 *
 * Названия нормативов в EXAM-каталоге совпадают с заголовками столбцов листов
 * ШДС («Танковая рота» / «Артиллерийский дивизион»): при одобрении рапорта бот
 * закрашивает столбцы через matchExamColumns() из gsheets.ts, которая
 * сопоставляет название из заявки с шапкой листа. Переименование здесь =
 * сломанная синхронизация, поэтому каталог — единый источник и для формы,
 * и для таблицы.
 */
import { RANKS, UNITS, type Rank, type Unit } from "@/lib/recruits";

/* ------------------------------------------------------------------ */
/* Embed-сообщение рапорта/заявки                                      */
/* ------------------------------------------------------------------ */

/**
 * Минимальная форма Discord-Embed, нужная для сборки сообщения.
 *
 * Описана здесь, а не импортируется из discord.ts: reports.ts используется и в
 * браузере (формы рапортов, подменю сайдбара), а тот модуль тянет настройки,
 * БД и fetch. Структурная совместимость с ReviewEmbed из discord.ts сохраняется,
 * поэтому объект передаётся в отправку без приведения типов.
 */
export type ReviewEmbed = {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
};

/* ------------------------------------------------------------------ */
/* Типы рапортов                                                       */
/* ------------------------------------------------------------------ */

export const SERVICE_REPORT_TYPES = [
  "exam",
  "role",
  "vacation",
  "reserve",
  "shds_entry",
] as const;

export type ServiceReportType = (typeof SERVICE_REPORT_TYPES)[number];

export function isServiceReportType(value: unknown): value is ServiceReportType {
  return typeof value === "string" && (SERVICE_REPORT_TYPES as readonly string[]).includes(value);
}

/** Метаданные типа рапорта для меню «Подать рапорт» */
export type ReportTypeMeta = {
  type: ServiceReportType;
  /** Заголовок пункта меню */
  label: string;
  /** Короткое пояснение под заголовком */
  hint: string;
  /** Пиктограмма пункта (эмодзи из ТЗ) */
  icon: string;
};

export const REPORT_TYPE_META: readonly ReportTypeMeta[] = [
  {
    type: "exam",
    label: "Сдать экзамены / нормативы",
    hint: "Пакетный выбор нормативов и оценок",
    icon: "📝",
  },
  {
    type: "role",
    label: "Запрос на специальность / роль",
    hint: "Перевод на должность или специальность",
    icon: "🎖️",
  },
  {
    type: "vacation",
    label: "Рапорт на отпуск",
    hint: "Диапазон дат и причина",
    icon: "🏖️",
  },
  {
    type: "reserve",
    label: "Перевод в резерв",
    hint: "Уход в запас с сохранением строки ШДС",
    icon: "🛡️",
  },
  {
    type: "shds_entry",
    label: "Запись в ШДС",
    hint: "Первичная анкета для ведомости",
    icon: "📋",
  },
];

/** Пиктограмма и заголовок типа — для карточек модерации и Embed */
export function reportTypeMeta(type: ServiceReportType): ReportTypeMeta {
  return (
    REPORT_TYPE_META.find((m) => m.type === type) ?? { type, label: type, hint: "", icon: "📄" }
  );
}

/* ------------------------------------------------------------------ */
/* Статусы рассмотрения (заявки и рапорты)                             */
/* ------------------------------------------------------------------ */

export const REVIEW_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const;

export type ReviewStatus = (typeof REVIEW_STATUS)[keyof typeof REVIEW_STATUS];

const REVIEW_STATUSES: readonly string[] = Object.values(REVIEW_STATUS);

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && REVIEW_STATUSES.includes(value);
}

/** Человекочитаемые названия статусов */
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: "На рассмотрении",
  approved: "Одобрено",
  rejected: "Отклонено",
};

export function reviewStatusLabel(status: ReviewStatus): string {
  return REVIEW_STATUS_LABELS[status] ?? REVIEW_STATUS_LABELS.pending;
}

/* ------------------------------------------------------------------ */
/* Каталог нормативов (совпадает с шапками листов ШДС)                 */
/* ------------------------------------------------------------------ */

/** Оценка за норматив. Ограниченный набор: значения уезжают в ячейку ШДС */
export const EXAM_GRADES = [
  "Отлично",
  "Хорошо",
  "Удовлетворительно",
  "Неудовлетворительно",
] as const;

export type ExamGrade = (typeof EXAM_GRADES)[number];

export type ExamDefinition = {
  /** Название столбца листа ШДС — сопоставляется с шапкой через matchExamColumns */
  code: string;
  /**
   * Предусмотрена ли оценка. КМБТ — базовый экзамен: он закрашивается, но
   * оценки не получает (то же правило в gsheets.ts, сценарий EXAM).
   */
  graded: boolean;
};

/** Нормативы «Танковая рота» (заголовки столбцов листа, начиная с КМБТ) */
const TR_EXAMS: readonly ExamDefinition[] = [
  { code: "КМБТ", graded: false },
  { code: "Снаряжение, обслуживание техники", graded: true },
  { code: "Огневая подготовка", graded: true },
  { code: "ТТХ (Часть 1)", graded: true },
  { code: "Физ. Подготовка", graded: true },
  { code: "ПМП", graded: true },
  { code: "Езда в сложно-проходимых условиях", graded: true },
  { code: "Сдача на Мех. Водителя", graded: true },
  { code: "ТТХ (Часть 2)", graded: true },
  { code: "Тактическая Подготовка", graded: true },
  { code: "Техника АТК", graded: true },
  { code: "Учебные стрельбы", graded: true },
  { code: "Устав АТК", graded: true },
];

/** Нормативы «Артиллерийский дивизион» */
const AD_EXAMS: readonly ExamDefinition[] = [
  { code: "КМБТ", graded: false },
  { code: "Физ. Подготовка", graded: true },
  { code: "ТТХ (минометы)", graded: true },
  { code: "Миномётное дело (обучение)", graded: true },
  { code: "Прохождение теста по теории", graded: true },
  { code: "Миномётное дело (Экзамен)", graded: true },
  { code: "ПМП", graded: true },
  { code: "Снаряжение и обслуживание техники", graded: true },
  { code: "ТТХ (ствольная артиллерия)", graded: true },
  { code: "Управление гусеничной техникой", graded: true },
  { code: "Сдача на мехвода", graded: true },
  { code: "Устав АТК", graded: true },
];

export type ExamCatalog = {
  /** Подразделение бойца: null — ещё не назначено */
  unit: Unit | null;
  exams: readonly ExamDefinition[];
  /** true — подразделение не назначено, показан объединённый перечень */
  assumed: boolean;
};

/**
 * Нормативы по подразделению бойца.
 *
 * У бойца без назначенного подразделения списка «по умолчанию» нет: показываем
 * объединённый перечень, чтобы он не остался без формы, а признак `assumed`
 * подсказывает интерфейсу, что подразделение ещё не назначено и модератор
 * уточнит лист при одобрении.
 */
export function examCatalog(unit: string | null | undefined): ExamCatalog {
  const normalized = (unit || "").trim().toLowerCase();
  const exact = UNITS.find((u) => u.toLowerCase() === normalized);
  if (exact === "Танковая рота") return { unit: exact, exams: TR_EXAMS, assumed: false };
  if (exact === "Артиллерийский дивизион") return { unit: exact, exams: AD_EXAMS, assumed: false };

  const union = [...TR_EXAMS];
  for (const exam of AD_EXAMS) {
    if (!union.some((e) => e.code === exam.code)) union.push(exam);
  }
  return { unit: null, exams: union, assumed: true };
}

/** Нормализация названия норматива: регистр, «ё/е», пробелы и неразрывный пробел */
export function normalizeExamCode(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/ё/gi, "е")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Поиск норматива по названию (регистр и «ё» не важны) */
export function findExam(code: string): ExamDefinition | null {
  const needle = normalizeExamCode(code);
  if (!needle) return null;
  for (const exam of [...TR_EXAMS, ...AD_EXAMS]) {
    if (normalizeExamCode(exam.code) === needle) return exam;
  }
  return null;
}

/** Все допустимые названия нормативов (для серверной проверки payload) */
export function allExamCodes(): string[] {
  const codes = new Set<string>();
  for (const exam of [...TR_EXAMS, ...AD_EXAMS]) codes.add(exam.code);
  return [...codes];
}

/**
 * Названия нормативов в виде, который принимает matchExamColumns() из gsheets.ts.
 *
 * Если название САМО содержит запятую («Снаряжение, обслуживание техники»),
 * функция сопоставления ждёт его разрезанным на куски: она делит по запятой и
 * заголовок листа, и запрос, а совпадение считается по кускам. Передай мы
 * название целиком — столбец не нашёлся бы, и рапорт «одобрился» бы без отметки
 * в таблице (молчаливый отказ вместо ошибки).
 */
export function examColumnTokens(codes: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const code of codes) {
    const parts = String(code)
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    tokens.push(...parts);
  }
  return tokens;
}

/** Нормативы с оценкой — для подсказки в интерфейсе */
export function gradedExamCodes(): string[] {
  return allExamCodes().filter((code) => findExam(code)?.graded !== false);
}

/* ------------------------------------------------------------------ */
/* Payload рапорта                                                     */
/* ------------------------------------------------------------------ */

/** Максимальная длина свободного текста в рапорте */
export const REPORT_TEXT_MAX = 500;

export type ExamItem = { exam_code: string; grade?: string };

export type ExamPayload = { exams: ExamItem[] };
export type RolePayload = { role: string; post: string; comment: string };
export type VacationPayload = { from: string; to: string; reason: string };
export type ReservePayload = { reason: string };
export type ShdsEntryPayload = {
  unit: string;
  rank: string;
  steamId: string;
  discordId: string;
  отделение: string;
  должность: string;
};

export type ReportPayload =
  | ExamPayload
  | RolePayload
  | VacationPayload
  | ReservePayload
  | ShdsEntryPayload;

export type ReportValidation<T> = { ok: true; payload: T } | { ok: false; error: string };

/** Обрезка строки до лимита — в БД не должен уезжать «роман» на мегабайт */
function clip(value: unknown, max: number = REPORT_TEXT_MAX): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

/** Является ли значение реальной календарной датой вида «ГГГГ-ММ-ДД» */
export function isIsoDate(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/** Границы года для дат рапорта: защита от «2999» и опечаток вроде «2206» */
const YEAR_MIN = 2020;
const YEAR_MAX = 2100;

/** Дата в разумных границах — иначе это опечатка, а не отпуск */
export function isReasonableIsoDate(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!isIsoDate(raw)) return false;
  const year = Number(raw.slice(0, 4));
  return year >= YEAR_MIN && year <= YEAR_MAX;
}

/** Разбор пакетного списка нормативов (чекбоксы + поля оценок) */
function validateExams(input: unknown): ReportValidation<ExamPayload> {
  const raw = Array.isArray(input) ? input : [];
  if (raw.length === 0) {
    return { ok: false, error: "Сдать экзамены: выберите хотя бы один норматив" };
  }
  if (raw.length > 32) {
    return { ok: false, error: "Сдать экзамены: слишком много нормативов в одном рапорте" };
  }

  /** Нормализованное название → каноническое написание из каталога */
  const allowed = new Map(allExamCodes().map((code) => [normalizeExamCode(code), code]));
  const exams: ExamItem[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    // Форма присылает объект {exam_code, grade}; строку тоже принимаем —
    // так рапорт можно подать и простым перечнем названий
    if (typeof entry !== "string" && (typeof entry !== "object" || entry === null)) {
      return { ok: false, error: "Сдать экзамены: некорректный норматив в списке" };
    }
    const item: Record<string, unknown> =
      typeof entry === "string" ? { exam_code: entry } : (entry as Record<string, unknown>);

    const code = clip(item.exam_code, 120);
    if (!code) return { ok: false, error: "Сдать экзамены: у норматива нет названия" };

    const canonical = allowed.get(normalizeExamCode(code));
    if (!canonical) {
      // Название уезжает в шапку листа ШДС: произвольная строка оставила бы
      // заявку без столбцов и «молча» ничего не зачла бы
      return { ok: false, error: `Сдать экзамены: норматив «${code}» неизвестен` };
    }

    const key = normalizeExamCode(canonical);
    if (seen.has(key)) continue; // повтор того же норматива — не дубль в таблице
    seen.add(key);

    const grade = clip(item.grade, 30);
    if (grade && findExam(canonical)?.graded === false) {
      return {
        ok: false,
        error: `Сдать экзамены: «${canonical}» сдаётся без оценки — оставьте поле пустым`,
      };
    }
    if (grade && !(EXAM_GRADES as readonly string[]).includes(grade)) {
      return { ok: false, error: `Сдать экзамены: недопустимая оценка «${grade}»` };
    }

    exams.push(grade ? { exam_code: canonical, grade } : { exam_code: canonical });
  }

  return { ok: true, payload: { exams } };
}

function validateRole(input: Record<string, unknown>): ReportValidation<RolePayload> {
  const role = clip(input.role ?? input.specialization, 100);
  if (role.length < 2) {
    return { ok: false, error: "Специальность/роль: укажите желаемую специальность или роль" };
  }
  return {
    ok: true,
    payload: {
      role,
      post: clip(input.post ?? input.должность, 100),
      comment: clip(input.comment, REPORT_TEXT_MAX),
    },
  };
}

function validateVacation(input: Record<string, unknown>): ReportValidation<VacationPayload> {
  const from = clip(input.from, 10);
  const to = clip(input.to, 10);
  if (!isReasonableIsoDate(from) || !isReasonableIsoDate(to)) {
    return { ok: false, error: "Рапорт на отпуск: укажите даты в формате ГГГГ-ММ-ДД" };
  }
  if (to < from) {
    return { ok: false, error: "Рапорт на отпуск: дата возвращения раньше даты начала" };
  }
  const reason = clip(input.reason, REPORT_TEXT_MAX);
  if (reason.length < 2) {
    return { ok: false, error: "Рапорт на отпуск: укажите причину" };
  }
  return { ok: true, payload: { from, to, reason } };
}

function validateReserve(input: Record<string, unknown>): ReportValidation<ReservePayload> {
  const reason = clip(input.reason, REPORT_TEXT_MAX);
  if (reason.length < 2) {
    return { ok: false, error: "Перевод в резерв: укажите причину" };
  }
  return { ok: true, payload: { reason } };
}

function validateShdsEntry(input: Record<string, unknown>): ReportValidation<ShdsEntryPayload> {
  const unit = clip(input.unit, 60);
  if (!(UNITS as readonly string[]).includes(unit)) {
    // Подразделение = имя листа Google Таблицы
    return { ok: false, error: "Запись в ШДС: выберите подразделение" };
  }
  const rank = clip(input.rank, 40);
  if (!(RANKS as readonly string[]).includes(rank)) {
    return { ok: false, error: "Запись в ШДС: выберите звание" };
  }
  const discordIdRaw = clip(input.discordId, 40);
  // Discord ID необязателен, но если указан — проверяем, что это «снежинка»:
  // значение уезжает в столбец листа и в поиск бойца
  const discordDigits = discordIdRaw.replace(/\D/g, "");
  if (discordIdRaw && !/^\d{5,25}$/.test(discordDigits)) {
    return { ok: false, error: "Запись в ШДС: Discord ID — только цифры" };
  }
  return {
    ok: true,
    payload: {
      unit,
      rank,
      steamId: clip(input.steamId, 64),
      discordId: discordDigits,
      отделение: clip(input.отделение, 60),
      должность: clip(input.должность, 100),
    },
  };
}

/**
 * Проверка и нормализация payload рапорта по его типу.
 *
 * Payload уходит в jsonb и далее в Google Таблицу (оценки, подразделение,
 * звание), поэтому произвольный текст здесь недопустим: каждое поле либо
 * приводится к известному значению, либо рапорт отклоняется с понятной причиной.
 */
export function validateReportPayload(
  type: ServiceReportType,
  input: unknown
): ReportValidation<ReportPayload> {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  switch (type) {
    case "exam":
      return validateExams(Array.isArray(input) ? input : raw.exams);
    case "role":
      return validateRole(raw);
    case "vacation":
      return validateVacation(raw);
    case "reserve":
      return validateReserve(raw);
    case "shds_entry":
      return validateShdsEntry(raw);
    default:
      return { ok: false, error: "Неизвестный тип рапорта" };
  }
}

/* ------------------------------------------------------------------ */
/* Безопасное чтение payload из БД                                     */
/* ------------------------------------------------------------------ */

/**
 * Чтение payload из jsonb для интерфейса.
 *
 * В поле может лежать что угодно (старые записи, ручная правка в psql, мусор
 * после неудачной миграции), поэтому значения не считаются доверенными:
 * возвращаются только строки ожидаемой формы, остальное выбрасывается.
 */
export function readReportPayload(type: ServiceReportType, value: unknown): ReportPayload {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  switch (type) {
    case "exam": {
      const list = Array.isArray(raw.exams) ? raw.exams : [];
      const exams: ExamItem[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const code = clip(record.exam_code, 120);
        if (!code) continue;
        const grade = clip(record.grade, 30);
        exams.push(grade ? { exam_code: code, grade } : { exam_code: code });
      }
      return { exams };
    }
    case "role":
      return {
        role: clip(raw.role, 100),
        post: clip(raw.post, 100),
        comment: clip(raw.comment, REPORT_TEXT_MAX),
      };
    case "vacation": {
      const from = clip(raw.from, 10);
      const to = clip(raw.to, 10);
      return {
        from: isIsoDate(from) ? from : "",
        to: isIsoDate(to) ? to : "",
        reason: clip(raw.reason, REPORT_TEXT_MAX),
      };
    }
    case "reserve":
      return { reason: clip(raw.reason, REPORT_TEXT_MAX) };
    case "shds_entry":
      return {
        unit: clip(raw.unit, 60),
        rank: clip(raw.rank, 40),
        steamId: clip(raw.steamId, 64),
        discordId: clip(raw.discordId, 40).replace(/\D/g, ""),
        отделение: clip(raw.отделение, 60),
        должность: clip(raw.должность, 100),
      };
    default:
      return { reason: "" };
  }
}

/** Дата ISO → «ДД.ММ.ГГГГ» (для интерфейса и Embed) */
export function formatIsoDate(value: string): string {
  if (!isIsoDate(value)) return value || "—";
  const [y, m, d] = value.split("-");
  return `${d}.${m}.${y}`;
}

/** Короткая выжимка payload для таблицы модерации, логов и Embed */
export function summarizeReport(type: ServiceReportType, payload: ReportPayload): string {
  switch (type) {
    case "exam": {
      const exam = payload as ExamPayload;
      if (!exam.exams.length) return "—";
      return exam.exams
        .map((e) => (e.grade ? `${e.exam_code} — ${e.grade}` : e.exam_code))
        .join(", ")
        .slice(0, REPORT_TEXT_MAX);
    }
    case "role": {
      const role = payload as RolePayload;
      const post = role.post ? `, должность: ${role.post}` : "";
      return `${role.role}${post}`.slice(0, REPORT_TEXT_MAX);
    }
    case "vacation": {
      const vacation = payload as VacationPayload;
      return `${formatIsoDate(vacation.from)} — ${formatIsoDate(vacation.to)}: ${vacation.reason}`.slice(
        0,
        REPORT_TEXT_MAX
      );
    }
    case "reserve":
      return (payload as ReservePayload).reason.slice(0, REPORT_TEXT_MAX);
    case "shds_entry": {
      const entry = payload as ShdsEntryPayload;
      return [entry.unit, entry.rank, entry.отделение, entry.должность].filter(Boolean).join(" · ");
    }
    default:
      return "—";
  }
}

/* ------------------------------------------------------------------ */
/* CustomId кнопок Discord                                             */
/* ------------------------------------------------------------------ */

/**
 * Область кнопки: заявка на вступление (recruit) или рапорт (report).
 * Разделение обязательно: идентификаторы обеих таблиц пересекаются, и по
 * одному числу нельзя понять, какую запись решает офицер.
 */
export type ReviewScope = "recruit" | "report";

export type ReviewAction = "approve" | "reject";

export type ReviewCustomId = { scope: ReviewScope; action: ReviewAction; id: number };

/** customId кнопки, например «recruit_approve_12» */
export function reviewCustomId(scope: ReviewScope, action: ReviewAction, id: number): string {
  return `${scope}_${action}_${id}`;
}

/**
 * Разбор customId кнопки. null — строка не нашего формата: чужие компоненты
 * (другие боты, старые сообщения) игнорируются, а не падают ошибкой.
 */
export function parseReviewCustomId(value: unknown): ReviewCustomId | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(recruit|report)_(approve|reject)_(\d{1,12})$/);
  if (!match) return null;
  const id = Number(match[3]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { scope: match[1] as ReviewScope, action: match[2] as ReviewAction, id };
}

/** Тексты кнопок из ТЗ */
export const REVIEW_BUTTON_LABELS: Record<ReviewAction, string> = {
  approve: "✅ Одобрить",
  reject: "❌ Отклонить",
};

/** Звания и подразделения для формы «Запись в ШДС» */
export const SHDS_ENTRY_RANKS: readonly Rank[] = RANKS;
export const SHDS_ENTRY_UNITS: readonly Unit[] = UNITS;

/* ------------------------------------------------------------------ */
/* Embed-сообщения Discord (чистые функции — тестируются напрямую)      */
/* ------------------------------------------------------------------ */

/**
 * Цвета Embed по статусу рассмотрения.
 * Импорт типа — только типовой (`import type`), поэтому модуль остаётся
 * независимым от серверных зависимостей discord.ts (настройки, fetch).
 */
export const REVIEW_COLORS: Record<ReviewStatus, number> = {
  pending: 0xffb020, // ожидает решения — янтарный
  approved: 0x3ddc84, // одобрено — зелёный
  rejected: 0xff3d3d, // отклонено — красный
};

/** Метка статуса для заголовка Embed */
const STATUS_BADGES: Record<ReviewStatus, string> = {
  pending: "🕓 На рассмотрении",
  approved: "✅ Одобрено",
  rejected: "🛑 Отклонено",
};

export type RecruitEmbedInput = {
  id: number;
  callsign: string;
  discordTag: string;
  discordId: string | null;
  age: number | null;
  armaExperience: string;
  about: string;
  createdAt: Date | string;
  status: ReviewStatus;
  /** Позывной офицера, принявшего решение */
  reviewedBy?: string | null;
  /** Дополнительная строка итога (например, «ЛК выслан» или причина отказа) */
  outcome?: string | null;
};

/** Строка «ДД.ММ.ГГГГ ЧЧ:ММ» в московском времени */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Обрезка значения поля Embed: у Discord лимит 1024 символа на поле */
function embedValue(text: string, fallback = "—"): string {
  const value = (text || "").trim();
  if (!value) return fallback;
  return value.length > 1000 ? `${value.slice(0, 997)}...` : value;
}

/**
 * Embed заявки на вступление.
 *
 * Статус зашит и в цвет, и в заголовок: по цвету офицер видит решение с ходу,
 * а заголовок читается в списке уведомлений и в поиске Discord.
 */
export function buildRecruitEmbed(input: RecruitEmbedInput): ReviewEmbed {
  const discord = input.discordTag
    ? `${input.discordTag}${input.discordId ? ` (ID: ${input.discordId})` : ""}`
    : input.discordId
      ? `ID: ${input.discordId}`
      : "не указан — впишет командир";

  const fields: ReviewEmbed["fields"] = [
    { name: "Позывной", value: embedValue(input.callsign), inline: true },
    { name: "Возраст", value: input.age ? String(input.age) : "—", inline: true },
    { name: "Discord", value: embedValue(discord), inline: false },
    { name: "Опыт в Arma", value: embedValue(input.armaExperience), inline: false },
    { name: "О себе", value: embedValue(input.about), inline: false },
  ];

  if (input.status !== "pending") {
    fields.push({
      name: "Решение",
      value: embedValue(
        `${input.reviewedBy ? `Офицер ${input.reviewedBy}` : "Штаб"}${
          input.outcome ? ` · ${input.outcome}` : ""
        }`
      ),
      inline: false,
    });
  }

  return {
    title: `${STATUS_BADGES[input.status]} · Заявка на вступление #${input.id}`,
    description: `Подана: ${formatDateTime(input.createdAt)} (МСК)`,
    color: REVIEW_COLORS[input.status],
    fields,
    footer: { text: `Заявка #${input.id} · ATK RED` },
    timestamp: new Date().toISOString(),
  };
}

export type ReportEmbedInput = {
  id: number;
  type: ServiceReportType;
  callsign: string;
  unit?: string | null;
  rank?: string | null;
  payload: ReportPayload;
  createdAt: Date | string;
  status: ReviewStatus;
  reviewedBy?: string | null;
  moderatorComment?: string | null;
  /** Итог применения: что именно записано в ШДС/какие роли выданы */
  outcome?: string | null;
};

/** Embed рапорта действующего состава */
export function buildReportEmbed(input: ReportEmbedInput): ReviewEmbed {
  const meta = reportTypeMeta(input.type);

  const fields: ReviewEmbed["fields"] = [
    { name: "Боец", value: embedValue(input.callsign), inline: true },
    { name: "Подразделение", value: embedValue(input.unit || "не назначено"), inline: true },
    { name: "Звание", value: embedValue(input.rank || "—"), inline: true },
    { name: "Суть рапорта", value: embedValue(summarizeReport(input.type, input.payload)), inline: false },
  ];

  if (input.status !== "pending") {
    fields.push({
      name: "Решение",
      value: embedValue(
        `${input.reviewedBy ? `Офицер ${input.reviewedBy}` : "Штаб"}${
          input.moderatorComment ? ` · ${input.moderatorComment}` : ""
        }`
      ),
      inline: false,
    });
  }
  if (input.outcome) {
    fields.push({ name: "Итог", value: embedValue(input.outcome), inline: false });
  }

  return {
    title: `${STATUS_BADGES[input.status]} · ${meta.icon} ${meta.label} #${input.id}`,
    description: `Подано: ${formatDateTime(input.createdAt)} (МСК)`,
    color: REVIEW_COLORS[input.status],
    fields,
    footer: { text: `Рапорт #${input.id} · ATK RED` },
    timestamp: new Date().toISOString(),
  };
}