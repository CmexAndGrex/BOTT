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
import {
  APPLICATION_KIND_TITLES,
  APPLICATION_KIND_RECRUIT,
  APPLICATION_KIND_RESERVE_RETURN,
  RANKS,
  UNITS,
  type Rank,
  type RecruitApplicationKind,
  type Unit,
} from "@/lib/recruits";

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
  "position_transfer",
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
    type: "position_transfer",
    label: "Перевод по должности ШДС",
    hint: "Перенос строки в секцию мехвода или наводчика-оператора",
    icon: "🔀",
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
  /**
   * Смысловой блок шапки листа (optgroup в форме подачи).
   *
   * Блоки — это реальные секции листа ШДС: «Механик - Водитель» и
   * «Наводчик-Оператор» у роты, «Допуск на Минометы», «Мех-вод.»,
   * «Допуск на САУ + Гаубицы», «Допуск на РСЗО» у дивизиона. По блоку строится
   * и группировка нормативов в форме, и требования должностей: боец видит
   * ровно те столбцы, что стоят в его блоке сетки, а не сплошной список из
   * двух подразделений.
   */
  group?: string;
  /**
   * Прочие написания норматива: они принимаются рапортом и засчитывают тот же
   * столбец листа. Нужны там, где панель и таблица называют норматив по-разному
   * («Уставы общие» в панели и «Уставы (общевойсковые)» в шапке).
   */
  aliases?: readonly string[];
  /**
   * Норматив засчитывается автоматически по другим (сейчас — «Берет» после
   * сдачи всех четырёх нормативов экзамена на берет).
   *
   * Такой норматив есть в шапке листа (бот закрашивает его столбец), но в форме
   * подачи не показывается: рапортом его не сдают — он закрывается сам.
   */
  derived?: boolean;
};

/* --- Смысловые блоки шапок листов (подписи optgroup) ---------------- */

/** Блоки «Танковой роты» — как они подписаны в сетке листа */
export const TR_EXAM_GROUPS = {
  DRIVER: "Механик - Водитель",
  GUNNER: "Наводчик-Оператор",
  SERGEANT: "от Мл. Сержанта",
  SPECIALS: "Спецкурсы",
  BERET: "Экзамен на берет",
} as const;

/** Блоки «Артиллерийского дивизиона» — как они подписаны в сетке листа */
export const AD_EXAM_GROUPS = {
  MORTAR: "Допуск на Минометы",
  DRIVER: "Мех-вод.",
  SPG: "Допуск на САУ + Гаубицы",
  MLRS: "Допуск на РСЗО",
  EXTRA: "Дополнительно",
  BERET: "Экзамены на берет",
} as const;

/** Подпись блока для нормативов, которым он не назначен */
const FALLBACK_EXAM_GROUP = "Прочее";

/**
 * Экзамен на берет: четыре норматива, одинаковые у роты и дивизиона.
 *
 * В шапке листа они записаны в кавычках («“Топография”»), но это те же
 * столбцы: кавычки снимает сопоставление (matchExamColumns), поэтому код дан
 * без них.
 */
export const BERET_EXAM_CODES = [
  "Топография",
  "Связь",
  "Строевая подготовка",
  "Должностные лица",
] as const;

/** Итоговый норматив берета: закрывается сам, когда сданы все четыре выше */
export const BERET_CODE = "Берет";

/**
 * Столбцы экзамена на берет в составе блока листа.
 *
 * Подпись блока у роты и дивизиона разная («Экзамен на берет» и «Экзамены на
 * берет») — она передаётся параметром, поэтому одного списка нормативов хватает
 * обоим подразделениям.
 */
function beretColumnExams(group: string): readonly ExamDefinition[] {
  return BERET_EXAM_CODES.map((code) => ({ code, graded: true, group }));
}

/**
 * «Берет» — производный норматив: своего рапорта у него нет.
 *
 * Столбец в листе существует (AE у роты, AG у дивизиона), и бот его закрашивает,
 * но сдавать берет рапортом нельзя — он закрывается автоматически, когда сданы
 * все четыре норматива экзамена (см. isBeretPassed). Поэтому в форме подачи его
 * нет, а в разделе «Экзамены» он показывается зелёным.
 */
const BERET_BADGE: ExamDefinition = { code: BERET_CODE, graded: true, derived: true };

/**
 * Общие нормативы роты и дивизиона: в листах они названы по-разному, но это один
 * и тот же столбец по смыслу.
 *
 * Алиасы даны в ОБЕ стороны осознанно: рапорт подразделения обязан закрасить
 * свой столбец, и «Сдача на мехвода» из листа дивизиона должна засчитываться там
 * же, где ротная «Сдача на Мех. Водителя». Без этого рапорт «одобрялся» бы, а
 * столбец оставался пустым.
 */
const SHARED_GEAR_ALIASES = ["Снаряжение, обслуживание техники", "Снаряжение и обслуживание техники"];
const SHARED_DRIVER_ALIASES = [
  "Сдача на Мех. Водителя",
  "Сдача на мехвода",
  "Сдача на мех. водителя",
  "Сдача на мехводителя",
];

/**
 * Нормативы «Танковая рота» — столбцы H–AE шапки листа (строка 6), по порядку.
 *
 * Каталог ПОЛНЫЙ: спецкурсы, экзамен на берет и «Берет» тоже имеют столбцы в
 * таблице, поэтому рапорт по любому нормативу бот закрашивает сам. Раньше
 * хвост шапки (КБМ, уставы, миномётное и артиллерийское дело, ПВО, берет)
 * считался «внеплановым» и в таблицу не попадал вовсе.
 *
 * `aliases` — написания, которыми тот же норматив зовут в панели и в ТЗ: рапорт
 * с любым из них засчитывает тот же столбец.
 */
const TR_EXAMS: readonly ExamDefinition[] = [
  // Блок «Механик - Водитель»: восемь нормативов допуска к вождению
  { code: "КМБТ", graded: false, group: TR_EXAM_GROUPS.DRIVER },
  {
    code: "Снаряжение, обслуживание техники",
    graded: true,
    group: TR_EXAM_GROUPS.DRIVER,
    aliases: SHARED_GEAR_ALIASES,
  },
  { code: "Огневая подготовка", graded: true, group: TR_EXAM_GROUPS.DRIVER },
  { code: "ТТХ (Часть 1)", graded: true, group: TR_EXAM_GROUPS.DRIVER },
  { code: "Физ. Подготовка", graded: true, group: TR_EXAM_GROUPS.DRIVER },
  { code: "ПМП", graded: true, group: TR_EXAM_GROUPS.DRIVER },
  {
    code: "Езда в сложно-проходимых условиях",
    graded: true,
    group: TR_EXAM_GROUPS.DRIVER,
  },
  {
    code: "Сдача на Мех. Водителя",
    graded: true,
    group: TR_EXAM_GROUPS.DRIVER,
    aliases: SHARED_DRIVER_ALIASES,
  },

  // Блок «Наводчик-Оператор»: вооружение, тактика и устав боевой машины
  { code: "ТТХ (Часть 2)", graded: true, group: TR_EXAM_GROUPS.GUNNER },
  { code: "Тактическая Подготовка", graded: true, group: TR_EXAM_GROUPS.GUNNER },
  { code: "Техника АТК", graded: true, group: TR_EXAM_GROUPS.GUNNER },
  { code: "Учебные стрельбы", graded: true, group: TR_EXAM_GROUPS.GUNNER },
  { code: "Устав АТК", graded: true, group: TR_EXAM_GROUPS.GUNNER },

  // Блок «от Мл. Сержанта!»: ступень сержантского состава
  { code: "КБМ Испыт.", graded: true, group: TR_EXAM_GROUPS.SERGEANT },
  {
    // В шапке роты слово напечатано с опечаткой («общевоисковые») — она
    // снимается сопоставлением заголовков (см. EXAM_TITLE_ALIASES в gsheets.ts)
    code: "Уставы (общевойсковые)",
    graded: true,
    group: TR_EXAM_GROUPS.SERGEANT,
    aliases: ["Уставы общие", "Уставы (общевоисковые)"],
  },
  { code: "КБМ", graded: true, group: TR_EXAM_GROUPS.SERGEANT },

  // Спецкурсы роты: столбцы есть в листе, но отдельных ступеней не образуют
  {
    code: "Миномётное дело (Экзамен)",
    graded: true,
    group: TR_EXAM_GROUPS.SPECIALS,
    aliases: ["Миномётное дело", "Минометное дело", "Миномётное дело (экзамен)"],
  },
  {
    // Написание из ТЗ («Артиллирийское») стоит и в шапке листа, и в матрице
    // техники (vehicles.ts) — код хранит его, корректное написание взято алиасом
    code: "Артиллирийское Дело (Экзамен)",
    graded: true,
    group: TR_EXAM_GROUPS.SPECIALS,
    aliases: [
      "Арт. дело",
      "Арт. дело (экзамен)",
      "Артиллерийское дело",
      "Артиллерийское дело (Экзамен)",
      "Артиллерийское Дело (Экзамен)",
    ],
  },
  { code: "ПВО", graded: true, group: TR_EXAM_GROUPS.SPECIALS },

  // Экзамен на берет: четыре столбца плюс итоговый производный «Берет»
  ...beretColumnExams(TR_EXAM_GROUPS.BERET),
  { ...BERET_BADGE, group: TR_EXAM_GROUPS.BERET },
];

/** Нормативы «Артиллерийский дивизион» — столбцы I–AG шапки листа (строка 8) */
const AD_EXAMS: readonly ExamDefinition[] = [
  // Блок «Допуск на Минометы»: семь нормативов миномётного расчёта
  { code: "КМБТ", graded: false, group: AD_EXAM_GROUPS.MORTAR },
  { code: "Физ. Подготовка", graded: true, group: AD_EXAM_GROUPS.MORTAR },
  { code: "ТТХ (минометы)", graded: true, group: AD_EXAM_GROUPS.MORTAR },
  { code: "Миномётное дело (обучение)", graded: true, group: AD_EXAM_GROUPS.MORTAR },
  {
    code: "Прохождение теста по теории",
    graded: true,
    group: AD_EXAM_GROUPS.MORTAR,
  },
  {
    code: "Миномётное дело (Экзамен)",
    graded: true,
    group: AD_EXAM_GROUPS.MORTAR,
    aliases: ["Миномётное дело", "Минометное дело", "Миномётное дело (экзамен)"],
  },
  { code: "ПМП", graded: true, group: AD_EXAM_GROUPS.MORTAR },

  // Блок «Мех-вод.»: допуск к вождению гусеничной техники дивизиона
  {
    code: "Снаряжение и обслуживание техники",
    graded: true,
    group: AD_EXAM_GROUPS.DRIVER,
    aliases: SHARED_GEAR_ALIASES,
  },
  { code: "ТТХ (ствольная артиллерия)", graded: true, group: AD_EXAM_GROUPS.DRIVER },
  { code: "Управление гусеничной техникой", graded: true, group: AD_EXAM_GROUPS.DRIVER },
  { code: "Сдача на мехвода", graded: true, group: AD_EXAM_GROUPS.DRIVER, aliases: SHARED_DRIVER_ALIASES },
  { code: "Устав АТК", graded: true, group: AD_EXAM_GROUPS.DRIVER },

  // Блок «Допуск на САУ + Гаубицы»
  {
    code: "Артиллерийское дело (обучение)",
    graded: true,
    group: AD_EXAM_GROUPS.SPG,
    aliases: ["Артиллирийское Дело (обучение)", "Арт. дело (обучение)", "Арт. дело обучение"],
  },
  {
    // Код совпадает с требованием матрицы техники (vehicles.ts), чтобы допуск к
    // САУ и отметка в разделе «Экзамены» не расходились
    code: "Артиллирийское Дело (Экзамен)",
    graded: true,
    group: AD_EXAM_GROUPS.SPG,
    aliases: [
      "Арт. дело",
      "Арт. дело (экзамен)",
      "Артиллерийское дело (экзамен)",
      "Артиллерийское Дело (Экзамен)",
    ],
  },

  // Блок «Допуск на РСЗО»
  { code: "РСЗО (обучение)", graded: true, group: AD_EXAM_GROUPS.MLRS },
  { code: "РСЗО (Экзамен)", graded: true, group: AD_EXAM_GROUPS.MLRS },

  // Блок «Дополнительно»: общие курсы дивизиона
  { code: "Техника АТК", graded: true, group: AD_EXAM_GROUPS.EXTRA },
  {
    code: "Уставы (общевойсковые)",
    graded: true,
    group: AD_EXAM_GROUPS.EXTRA,
    aliases: ["Уставы общие", "Уставы (общевоисковые)"],
  },
  { code: "ПВО", graded: true, group: AD_EXAM_GROUPS.EXTRA },
  { code: "БПЛА", graded: true, group: AD_EXAM_GROUPS.EXTRA },

  // Блок «Экзамены на берет»
  ...beretColumnExams(AD_EXAM_GROUPS.BERET),
  { ...BERET_BADGE, group: AD_EXAM_GROUPS.BERET },
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

/** Все нормативы каталога: рота, дивизион и объединённый перечень без дублей */
function allExamDefinitions(): ExamDefinition[] {
  const list = [...TR_EXAMS];
  for (const exam of AD_EXAMS) {
    if (!list.some((e) => e.code === exam.code)) list.push(exam);
  }
  return list;
}

/**
 * Все написания норматива: код и его алиасы.
 *
 * Алиасы нужны и серверу (валидатор принимает рапорт с любым написанием), и
 * сопоставлению сданного норматива со шкалой: боец мог сдать «Уставы общие», а
 * столбец в листе называется «Уставы (общевойсковые)».
 */
export function examCodeKeys(exam: ExamDefinition): string[] {
  return [exam.code, ...(exam.aliases ?? [])].map((value) => normalizeExamCode(value)).filter(Boolean);
}

/** Поиск норматива по названию (регистр, «ё» и алиасы не важны) */
export function findExam(code: string): ExamDefinition | null {
  const needle = normalizeExamCode(code);
  if (!needle) return null;
  for (const exam of allExamDefinitions()) {
    if (examCodeKeys(exam).includes(needle)) return exam;
  }
  return null;
}

/**
 * Все допустимые названия нормативов: коды каталога и их алиасы.
 *
 * Каталог полный (см. TR_EXAMS/AD_EXAMS), поэтому отдельного списка
 * «внеплановых» нормативов больше нет: спецкурсы, экзамен на берет и «Берет»
 * тоже закрашиваются ботом в свои столбцы.
 */
export function allExamCodes(): string[] {
  const codes = new Set<string>();
  for (const exam of allExamDefinitions()) {
    codes.add(exam.code);
    for (const alias of exam.aliases ?? []) codes.add(alias);
  }
  return [...codes];
}

/**
 * Норматив, который сдаётся рапортом: у производных («Берет») своего рапорта нет,
 * они закрываются автоматически по другим нормативам.
 */
export function isReportableExam(code: string): boolean {
  const exam = findExam(code);
  return Boolean(exam) && exam?.derived !== true;
}

/**
 * Норматив в форме подачи.
 *
 * Поле `inShds` сохраняется как контракт интерфейса, но теперь всегда true: у
 * всех нормативов каталога есть столбец в листе, «ручных» отметок не осталось.
 */
export type FormExamOption = ExamDefinition & {
  /** Столбец есть в листе подразделения — бот закрасит его при одобрении */
  inShds: boolean;
};

/**
 * Норматив каталога подразделения, которому соответствует название.
 *
 * Один и тот же норматив в листах роты и дивизиона назван по-разному
 * («Сдача на Мех. Водителя» и «Сдача на мехвода», «Снаряжение, обслуживание
 * техники» и «Снаряжение и обслуживание техники»), поэтому сравнение идёт по всем
 * написаниям, а не строкой: иначе рапорт танкиста, поданный дивизионом, «одобрился»
 * бы без отметки в столбце.
 *
 * Возвращается именно столбец листа подразделения: его код и уезжает в таблицу.
 */
export function columnExamFor(
  unit: string | null | undefined,
  code: string
): ExamDefinition | null {
  const needle = normalizeExamCode(code);
  if (!needle) return null;

  // Все написания названия: сам код и алиасы норматива каталога, которому он
  // соответствует. Плюс обратный поиск — требование шкалы могло быть записано
  // написанием, которого нет в алиасах столбца.
  const keys = new Set<string>([needle]);
  for (const value of [code, ...(findExam(code)?.aliases ?? [])]) {
    const key = normalizeExamCode(value);
    if (key) keys.add(key);
  }

  return (
    examCatalog(unit).exams.find((exam) => examCodeKeys(exam).some((key) => keys.has(key))) ?? null
  );
}

/**
 * Перечень нормативов для формы подачи рапорта.
 *
 * Берётся из каталога подразделения: у каждого норматива есть столбец в листе
 * (бот закрашивает его при одобрении), поэтому «ручных» отметок больше нет.
 * Производный «Берет» из формы исключён: он закрывается сам, когда сданы все
 * четыре норматива экзамена на берет.
 */
export function formExamOptions(unit: string | null | undefined): FormExamOption[] {
  return examCatalog(unit)
    .exams.filter((exam) => exam.derived !== true)
    .map((exam) => ({ ...exam, inShds: true }));
}

/** Блок нормативов для формы подачи: подпись optgroup и его нормативы */
export type FormExamGroup = {
  /** Подпись блока — как он подписан в сетке листа ШДС */
  group: string;
  /** Нормативы блока, в порядке шапки листа */
  exams: FormExamOption[];
};

/**
 * Нормативы формы, сгруппированные по смысловым блокам листа.
 *
 * Список optgroup собирается по порядку блоков в каталоге подразделения, а не
 * сортировкой по алфавиту: боец ищет нужный норматив там же, где видит его в
 * сетке ШДС, — «Механик - Водитель», затем «Наводчик-Оператор» и т.д.
 * Пустые блоки не возвращаются: у подразделения их не бывает, а у бойца без
 * подразделения объединённый каталог даёт блоки обоих листов.
 */
export function formExamGroups(unit: string | null | undefined): FormExamGroup[] {
  const groups: FormExamGroup[] = [];
  for (const exam of formExamOptions(unit)) {
    const key = exam.group || FALLBACK_EXAM_GROUP;
    const bucket = groups.find((item) => item.group === key);
    if (bucket) bucket.exams.push(exam);
    else groups.push({ group: key, exams: [exam] });
  }
  return groups;
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
/* Секции ШДС: должности, на которые боец подаёт рапорт сам            */
/* ------------------------------------------------------------------ */

/**
 * Норматив, обязательный для перевода в секцию.
 *
 * Форма та же, что у требования шкалы (exams.ts): `title` — как это зовут в
 * интерфейсе, `code` и `aliases` — как норматив записан в шапке листа ШДС.
 * Каталог рапортов про сдачу нормативов (reports.ts) и справочник секций
 * обязаны называть экзамен одинаково: иначе требование ступени не нашлось бы
 * среди сданных, и перевод отклонялся бы «навсегда».
 */
export type SectionRequirement = {
  title: string;
  code: string;
  aliases?: readonly string[];
};

/**
 * Секция ШДС — блок строк листа с одной должностью.
 *
 * Нужна для рапорта о переводе (position_transfer): боец выбирает секцию,
 * система ищет в ней первую свободную строку «Вакант», переносит строку бойца
 * (с отметками экзаменов) и зачищает прежнее место.
 *
 * `rows` — границы блока, `post` — что именно попадает в колонку «Должность».
 * Диапазоны совпадают с postRanges в gsheets.ts: расхождение означало бы, что
 * вакантная строка ищется не в том блоке, где стоит должность.
 */
export type ShdsSection = {
  /** Стабильный ключ: он уезжает в payload рапорта и в БД */
  key: string;
  /** Подразделение (оно же лист ШДС), к которому относится секция */
  unit: Unit;
  /** Название секции для интерфейса */
  title: string;
  /** Должность, записываемая в колонку D листа */
  post: string;
  /** Границы блока строк на листе (1-based, включительно) */
  rows: { top: number; bottom: number };
  /** Обязательные нормативы: без них перевод не одобряется */
  required: readonly SectionRequirement[];
  /** Подсказка в форме подачи */
  hint: string;
  /**
   * Командирская (штабная) должность.
   *
   * Такие секции описаны в справочнике — по ним штаб видит блок строк и
   * должность, — но рапортом бойца недоступны: positionSections() их отсеивает,
   * а валидатор отклоняет даже прямой ключ секции. Иначе боец, отправив
   * `{ section: "tr_bcm" }`, «перевёлся» бы в командный блок в обход формы.
   */
  isCommand?: boolean;
};

/**
 * Нормативы блока листа как требования секции.
 *
 * Требования ступени берутся из того же каталога, что и столбцы блока оценок:
 * должность мехвода требует ровно те восемь нормативов, что стоят в блоке
 * «Механик - Водитель», и перечислить их второй раз руками значило бы завести
 * копию, которая разойдётся с сеткой при первой же правке листа.
 */
function groupRequirements(unit: Unit, group: string): SectionRequirement[] {
  return examCatalog(unit)
    .exams.filter((exam) => exam.group === group && exam.derived !== true)
    .map((exam) => ({ title: exam.code, code: exam.code, aliases: exam.aliases }));
}

/** Подсказка секции: «Требуется сдать 8 нормативов блока «…»» */
function groupHint(group: string, required: readonly SectionRequirement[]): string {
  return `Требуется сдать все нормативы блока «${group}» (${required.length})`;
}

/* --- Нормативы блоков, из которых собраны требования ступеней ------- */

const TR_DRIVER_BLOCK = groupRequirements("Танковая рота", TR_EXAM_GROUPS.DRIVER);
const TR_GUNNER_BLOCK = groupRequirements("Танковая рота", TR_EXAM_GROUPS.GUNNER);

const AD_MORTAR_BLOCK = groupRequirements("Артиллерийский дивизион", AD_EXAM_GROUPS.MORTAR);
const AD_DRIVER_BLOCK = groupRequirements("Артиллерийский дивизион", AD_EXAM_GROUPS.DRIVER);
const AD_SPG_BLOCK = groupRequirements("Артиллерийский дивизион", AD_EXAM_GROUPS.SPG);
const AD_MLRS_BLOCK = groupRequirements("Артиллерийский дивизион", AD_EXAM_GROUPS.MLRS);

/**
 * Все секции ШДС: и доступные рапортом, и командирские (только для штаба).
 *
 * Рота:
 *   * «Специалист Мех.водитель» — строки 28–39, требования блока
 *     «Механик - Водитель» (восемь нормативов, включая КМБТ и сдачу на мехвода);
 *   * «Специалист Наводчик-Оператор» — строки 20–27, требования блока
 *     «Наводчик-Оператор» ПЛЮС блок мехвода: наводчик садится в машину уже
 *     мехводом, и требование предварительного статуса выражено теми же
 *     нормативами, а не отдельным полем (см. hint секции);
 *   * командирские должности — КБМ (10–19) и Командование (6–9): их назначает
 *     штаб, рапорт бойца строку в этот блок не двигает.
 *
 * Дивизион:
 *   * «Специалист миномётного расчёта» — строки 12–20 (1 ООВ), блок
 *     «Допуск на Минометы»;
 *   * «Механик-водитель САУ» — строки 22–30 (2 ООВ), блок «Мех-вод.»;
 *   * «Специалист - наводчик» — строки 22–30, блок «Допуск на САУ + Гаубицы»;
 *   * «Специалист расчёта РСЗО» — строки 22–30, блок «Допуск на РСЗО»;
 *   * командование дивизиона — строки 1–11, назначает штаб.
 */
const TR_SECTIONS: readonly ShdsSection[] = [
  {
    key: "tr_driver",
    unit: "Танковая рота",
    title: "Специалист Мех.водитель",
    post: "Специалист Мех.водитель",
    // Строки 28–39 — блок мехводов (строки 40–41 отданы учебному отделению
    // вместе с логистами)
    rows: { top: 28, bottom: 39 },
    required: TR_DRIVER_BLOCK,
    hint: groupHint(TR_EXAM_GROUPS.DRIVER, TR_DRIVER_BLOCK),
  },
  {
    key: "tr_gunner",
    unit: "Танковая рота",
    title: "Специалист Наводчик-Оператор",
    post: "Специалист Наводчик-Оператор",
    // Строки 20–27 — блок наводчиков-операторов
    rows: { top: 20, bottom: 27 },
    // Каскад: без блока мехвода ступень не открывается — наводчик садится в
    // машину тем, кто уже сдал на мехвода
    required: [...TR_DRIVER_BLOCK, ...TR_GUNNER_BLOCK],
    hint: `${groupHint(TR_EXAM_GROUPS.DRIVER, TR_DRIVER_BLOCK)}, затем — «${TR_EXAM_GROUPS.GUNNER}» (${TR_GUNNER_BLOCK.length})`,
  },
  {
    key: "tr_bcm",
    unit: "Танковая рота",
    title: "Исп.Командир Боевой Машины",
    post: "Исп.Командир Боевой Машины",
    // Командирский блок боевых машин — строки 10–19
    rows: { top: 10, bottom: 19 },
    required: [],
    hint: "Командирская должность: назначает штаб",
    isCommand: true,
  },
  {
    key: "tr_bcm_full",
    unit: "Танковая рота",
    title: "Командир Боевой Машины",
    post: "Командир Боевой Машины",
    rows: { top: 10, bottom: 19 },
    required: [],
    hint: "Командирская должность: назначает штаб",
    isCommand: true,
  },
  {
    key: "tr_command",
    unit: "Танковая рота",
    title: "Командование",
    post: "Командование",
    // Командование роты — строки 6–9 (совпадает с defaultPosts в gsheets.ts)
    rows: { top: 6, bottom: 9 },
    required: [],
    hint: "Командование роты: назначает штаб",
    isCommand: true,
  },
];

const AD_SECTIONS: readonly ShdsSection[] = [
  {
    key: "ad_mortar",
    unit: "Артиллерийский дивизион",
    title: "Специалист миномётного расчёта",
    post: "Специалист миномётного расчёта",
    rows: { top: 12, bottom: 20 },
    required: AD_MORTAR_BLOCK,
    hint: groupHint(AD_EXAM_GROUPS.MORTAR, AD_MORTAR_BLOCK),
  },
  {
    key: "ad_driver",
    unit: "Артиллерийский дивизион",
    title: "Механик-водитель САУ",
    post: "Механик-водитель САУ",
    rows: { top: 22, bottom: 30 },
    required: AD_DRIVER_BLOCK,
    hint: groupHint(AD_EXAM_GROUPS.DRIVER, AD_DRIVER_BLOCK),
  },
  {
    key: "ad_gunner",
    unit: "Артиллерийский дивизион",
    title: "Специалист - наводчик",
    post: "Специалист - наводчик",
    rows: { top: 22, bottom: 30 },
    required: AD_SPG_BLOCK,
    hint: groupHint(AD_EXAM_GROUPS.SPG, AD_SPG_BLOCK),
  },
  {
    key: "ad_mlrs",
    unit: "Артиллерийский дивизион",
    title: "Специалист расчёта РСЗО",
    post: "Специалист расчёта РСЗО",
    rows: { top: 22, bottom: 30 },
    required: AD_MLRS_BLOCK,
    hint: groupHint(AD_EXAM_GROUPS.MLRS, AD_MLRS_BLOCK),
  },
  {
    key: "ad_command",
    unit: "Артиллерийский дивизион",
    title: "Командование дивизиона",
    post: "Командование дивизиона",
    rows: { top: 1, bottom: 11 },
    required: [],
    hint: "Командование дивизиона: назначает штаб",
    isCommand: true,
  },
];

/**
 * Признак командирской (штабной) должности.
 *
 * Такие должности боец не занимает рапортом: их назначает штаб. Регулярное
 * выражение, а не список строк: в таблице должность записана по-разному
 * («Командир отделения», «Командование», «КБМ»), а форма рапорта присылает
 * свободный текст из старых заявок.
 */
export const COMMAND_POST_RE = /командир|командован|кбм/i;

/** Должность назначается только штабом */
export function isCommandPost(post: unknown): boolean {
  return COMMAND_POST_RE.test(String(post ?? ""));
}

/** Секция — командирская: рапортом бойца недоступна */
export function isCommandSection(section: ShdsSection | null | undefined): boolean {
  if (!section) return false;
  return section.isCommand === true || isCommandPost(section.post);
}

/** Все секции подразделения, доступные бойцу рапортом (без командирских) */
export function positionSections(unit: string | null | undefined): readonly ShdsSection[] {
  const normalized = (unit || "").trim().toLowerCase();
  if (!normalized) return [];
  return POSITION_SECTIONS.filter(
    (section) => section.unit.toLowerCase() === normalized && !isCommandSection(section)
  );
}

/** Секция по ключу — из всего справочника, независимо от подразделения */
export function findPositionSection(key: unknown): ShdsSection | null {
  const needle = String(key ?? "").trim();
  if (!needle) return null;
  return POSITION_SECTIONS.find((section) => section.key === needle) ?? null;
}

/** Весь справочник секций: используется проверками и тестами */
export const POSITION_SECTIONS: readonly ShdsSection[] = [...TR_SECTIONS, ...AD_SECTIONS];

/**
 * Найден ли норматив секции среди сданных бойцом.
 *
 * Сравнение идёт по всем написаниям (код, алиасы секции и алиасы каталога
 * рапортов), как и зачёт столбцов в таблице: «Сдача на мехвода» из листа
 * дивизиона обязана закрывать требование «Вождение техники» роты.
 */
export function matchSectionExam(
  requirement: SectionRequirement,
  passed: readonly { code: string }[]
): boolean {
  const keys = new Set<string>();
  const values = [
    requirement.code,
    ...(requirement.aliases ?? []),
    ...(findExam(requirement.code)?.aliases ?? []),
  ];
  for (const value of values) {
    const key = normalizeExamCode(value);
    if (key) keys.add(key);
  }
  return passed.some((item) => keys.has(normalizeExamCode(item.code)));
}

/**
 * Несданные нормативы секции. Пустой список — требование выполнено.
 *
 * Проверка живёт здесь, а не в валидаторе payload: тот работает и в браузере,
 * где истории сданных рапортов нет. Требования считаются на сервере (review.ts)
 * по одобренным рапортам бойца, а форма показывает их подсказкой заранее.
 */
export function missingSectionExams(
  section: ShdsSection,
  passed: readonly { code: string }[]
): string[] {
  return section.required
    .filter((requirement) => !matchSectionExam(requirement, passed))
    .map((requirement) => requirement.title);
}

/* ------------------------------------------------------------------ */
/* Payload рапорта                                                     */
/* ------------------------------------------------------------------ */

/** Максимальная длина свободного текста в рапорте */
export const REPORT_TEXT_MAX = 500;

export type ExamItem = { exam_code: string; grade?: string };

export type ExamPayload = { exams: ExamItem[] };
export type RolePayload = { role: string; post: string; comment: string };
/**
 * Перевод по должности ШДС.
 *
 * Ключ секции, а не свободная должность: от секции зависит и блок строк листа,
 * куда встанет боец, и обязательные экзамены. Свободный текст позволил бы
 * «перевестись» в командирский блок или в должность, которой в таблице нет.
 * Должность запоминается рядом — она уезжает в карточку бойца (members.post)
 * без повторного обращения к справочнику.
 */
export type PositionTransferPayload = { section: string; post: string; comment: string };
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
  | PositionTransferPayload
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

  /**
   * Нормализованное название → канонический код из каталога.
   *
   * В карту попадают и алиасы: боец мог выбрать «Уставы общие», а столбец листа
   * называется «Уставы (общевойсковые)» — в рапорт уедет каноничный код, по
   * которому бот и найдёт столбец.
   */
  const allowed = new Map<string, string>();
  for (const exam of allExamCodes()) {
    const canonical = findExam(exam);
    if (!canonical) continue;
    allowed.set(normalizeExamCode(exam), canonical.code);
  }
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
    if (!isReportableExam(canonical)) {
      // «Берет» закрывается автоматически после четырёх нормативов экзамена —
      // рапортом его не сдают, и одобрять такой рапорт было бы нечем
      return {
        ok: false,
        error: `Сдать экзамены: «${canonical}» засчитывается автоматически после экзамена на берет`,
      };
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

/**
 * Перевод по должности ШДС.
 *
 * Секция выбирается из справочника (POSITION_SECTIONS), а не вводится текстом:
 * от ключа зависят и блок строк листа, и обязательные экзамены. Должность в
 * payload подставляется из справочника — присланное бойцом значение
 * игнорируется, иначе рапорт «на перевод» мог бы уехать в командный блок,
 * который назначается только штабом.
 */
function validatePositionTransfer(
  input: Record<string, unknown>
): ReportValidation<PositionTransferPayload> {
  const key = clip(input.section ?? input.position ?? input.должность, 60);
  const section = findPositionSection(key);
  if (!section) {
    if (isCommandPost(key)) {
      // Командирские должности назначает штаб: рапортом бойца строка в
      // командный блок не переносится
      return {
        ok: false,
        error: "Перевод по должности: командирские должности назначает штаб",
      };
    }
    return { ok: false, error: "Перевод по должности: выберите должность из списка" };
  }
  if (isCommandSection(section)) {
    // Ключ командирской секции справочнику известен, но рапорт бойца по нему
    // отклоняется так же, как по свободному тексту «Командир отделения»: иначе
    // форму можно было бы обойти прямым запросом к API и «перевестись» в
    // командный блок в обход штаба
    return {
      ok: false,
      error: `Перевод по должности: «${section.title}» — командирская должность, её назначает штаб`,
    };
  }
  return {
    ok: true,
    payload: {
      section: section.key,
      post: section.post,
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
    case "position_transfer":
      return validatePositionTransfer(raw);
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
    case "position_transfer": {
      /**
       * Должность берётся из справочника, а не из БД: в jsonb мог лежать
       * свободный текст старой записи, и показывать его как должность нельзя —
       * бот по этому полю ищет секцию и переносит строку в таблице.
       */
      const section = findPositionSection(raw.section);
      return {
        section: section?.key ?? "",
        post: section?.post ?? clip(raw.post, 100),
        comment: clip(raw.comment, REPORT_TEXT_MAX),
      };
    }
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
    case "position_transfer": {
      const transfer = payload as PositionTransferPayload;
      const comment = transfer.comment ? ` · ${transfer.comment}` : "";
      return `${transfer.post}${comment}`.slice(0, REPORT_TEXT_MAX);
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
  /** Вид заявки: новобранец или возврат из запаса (см. recruits.ts) */
  kind?: RecruitApplicationKind | null;
  /** ФИО возвращающегося из запаса — показывается отдельным полем */
  fullName?: string | null;
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

  /**
   * Возврат из запаса — не зачисление: заголовок и первое поле меняются, чтобы
   * модератор в канале и в панели сразу видел «Запрос на возврат из запаса».
   * Решение по такой заявке двигает строку в Google Таблице, и путать её с
   * приёмом новобранца нельзя.
   */
  const kind = input.kind ?? APPLICATION_KIND_RECRUIT;
  const isReserveReturn = kind === APPLICATION_KIND_RESERVE_RETURN;

  const fields: ReviewEmbed["fields"] = [
    { name: "Позывной", value: embedValue(input.callsign), inline: true },
    { name: "Возраст", value: input.age ? String(input.age) : "—", inline: true },
    ...(isReserveReturn
      ? [
          {
            name: "ФИО в табеле",
            value: embedValue(input.fullName ?? "", "не указано — строку в «Запасе» найти нечем"),
            inline: false,
          },
        ]
      : []),
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
    title: isReserveReturn
      ? `${STATUS_BADGES[input.status]} · ${APPLICATION_KIND_TITLES.reserve_return} #${input.id}`
      : `${STATUS_BADGES[input.status]} · ${APPLICATION_KIND_TITLES.recruit} #${input.id}`,
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