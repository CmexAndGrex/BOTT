/**
 * Раздел «Экзамены»: специальности подразделений и нормативы допуска к ним.
 *
 * Модуль намеренно не зависит ни от БД, ни от Next.js, ни от React — как
 * reports.ts и vehicles.ts: правила проверяются тестами напрямую
 * (tests/exams.test.ts) и используются одинаково страницей /exams и формами
 * подачи рапорта. Если правило нужно и странице, и форме — живёт здесь, а не
 * копией в двух местах.
 *
 * Названия нормативов совпадают с каталогом рапортов (reports.ts), а тот — с
 * шапками листов ШДС: при одобрении рапорта бот закрашивает столбец по названию
 * (matchExamColumns), поэтому переименование здесь = молча не зачтённый
 * норматив. «Ручных» отметок больше нет: у каждого норматива шкалы есть свой
 * столбец в листе роты или дивизиона.
 *
 * Шкала специальностей каскадная: «Наводчик-оператор» включает ВСЕ экзамены
 * мехвода, «КБМ / Испытатель» — все экзамены мехвода и наводчика. Так допуск к
 * следующей специальности виден на одной шкале вместе с базовыми экзаменами, а
 * прогресс не «сбрасывается» при переходе на вкладку выше.
 *
 * Две ступени зависят от других нормативов, а не от своего рапорта:
 *   * «Берет» — закрывается сам, когда сданы все четыре норматива экзамена на
 *     берет (см. isBeretPassed): столбец в листе закрашивает бот при одобрении
 *     последнего из них, а бойцу выдаётся серверная роль «Берет»;
 *   * «Допуск на РСЗО» — высшая ступень дивизиона: пока берет не сдан, вкладка
 *     помечается заблокированной с подсказкой, хотя прогресс по нормативам
 *     виден (см. beretGate в ExamSpeciality).
 */
import { BERET_CODE, BERET_EXAM_CODES, columnExamFor, normalizeExamCode } from "@/lib/reports";
import { vehicleDivision } from "@/lib/vehicles";

/* ------------------------------------------------------------------ */
/* Подразделение                                                       */
/* ------------------------------------------------------------------ */

/**
 * Подразделение бойца для выбора набора специальностей.
 *
 * Правило берётся из матрицы техники (vehicleDivision): «танк…» → рота,
 * «дивизион/артиллер…» → артиллерия. Второй копии регулярных выражений здесь
 * быть не должно — иначе допуск к технике и раздел «Экзамены» разойдутся.
 */
export const examDivision = vehicleDivision;

export type ExamDivision = ReturnType<typeof vehicleDivision>;

/* ------------------------------------------------------------------ */
/* Нормативы и специальности                                           */
/* ------------------------------------------------------------------ */

/**
 * Норматив специальности.
 *
 * `title` — как норматив называется в разделе, `code` — как он записан в ШДС и
 * в каталоге рапортов, `aliases` — прочие написания (в ШДС встречаются и
 * «Сдача на мехвода», и «Сдача на Мех. Водителя»), которые засчитывают норматив.
 */
export type ExamRequirement = {
  title: string;
  code: string;
  aliases?: readonly string[];
  /**
   * Производный норматив: рапортом не сдаётся, засчитывается по другим.
   *
   * Сейчас так устроен «Берет»: он закрывается сам, когда сданы все четыре
   * норматива экзамена на берет, поэтому кнопки «Сдать норматив» у него быть не
   * должно (валидатор такой рапорт и не примет).
   */
  derived?: boolean;
};

export type ExamSpeciality = {
  /** Стабильный ключ вкладки */
  key: string;
  title: string;
  /** Короткое пояснение под заголовком */
  hint: string;
  requirements: readonly ExamRequirement[];
  /**
   * Ступень требует сданного берета. Само требование «Берет» уже входит в
   * `requirements` (иначе прогресс не отражал бы условие), а признак нужен,
   * чтобы отличить «не хватает норматива» от «ступень пока закрыта»: интерфейс
   * показывает по нему заблокированную вкладку с подсказкой.
   */
  requiresBeret?: boolean;
  /**
   * Подсказка блокировки ступени: пока не выполнено условие, вкладка помечается
   * заблокированной. Сейчас так устроен «Допуск на РСЗО» — он требует сдачи
   * экзамена на берет. Пустая строка/отсутствие — ступень доступна сразу.
   */
  blockedHint?: string;
};

/* --- Общие наборы -------------------------------------------------- */

/** Сдача на мехвода: в ШДС встречается в трёх написаниях, засчитывается любое */
const MECHANIC_DRIVER: ExamRequirement = {
  title: "Сдача на мехвода",
  code: "Сдача на Мех. Водителя",
  aliases: ["Сдача на мехвода", "Сдача на мех. водителя", "Сдача на мехводителя"],
};

/** Нормативы экзамена на берет в виде требований шкалы (без самого «Берета») */
const BERET_STEPS: readonly ExamRequirement[] = BERET_EXAM_CODES.map((code) => ({
  title: code,
  code,
}));

/**
 * Экзамен на берет: четыре норматива со своими столбцами в листах обоих
 * подразделений плюс итоговый «Берет», который закрывается автоматически.
 *
 * Итоговый норматив идёт последним: боец видит, что он не сдаётся отдельно, а
 * засчитывается после четырех предыдущих.
 */
const BERET_BADGE_STEP: ExamRequirement = {
  title: "Берет",
  code: BERET_CODE,
  derived: true,
};

const BERET_EXAMS: readonly ExamRequirement[] = [...BERET_STEPS, BERET_BADGE_STEP];

/* --- Танковая рота ------------------------------------------------- */

/** База мехвода: семь экзаменов, с которых начинается любая специальность роты */
const TR_DRIVER: readonly ExamRequirement[] = [
  {
    title: "Снаряжение / обслуживание техники",
    code: "Снаряжение, обслуживание техники",
    // В листе артдивизиона тот же норматив назван через «и»
    aliases: ["Снаряжение и обслуживание техники"],
  },
  { title: "Огневая подготовка", code: "Огневая подготовка" },
  { title: "ТТХ, часть 1", code: "ТТХ (Часть 1)" },
  { title: "Физическая подготовка", code: "Физ. Подготовка" },
  { title: "ПМП", code: "ПМП" },
  { title: "Езда в сложно-проходимых условиях", code: "Езда в сложно-проходимых условиях" },
  MECHANIC_DRIVER,
];

/** Наводчик-оператор: база мехвода плюс вооружение и устав */
const TR_GUNNER: readonly ExamRequirement[] = [
  ...TR_DRIVER,
  { title: "ТТХ, часть 2", code: "ТТХ (Часть 2)" },
  { title: "Тактическая подготовка", code: "Тактическая Подготовка" },
  { title: "Техника АТК", code: "Техника АТК" },
  { title: "Учебные стрельбы", code: "Учебные стрельбы" },
  { title: "Устав АТК", code: "Устав АТК" },
];

/** КБМ / испытатель: нормативы мехвода и наводчика плюс курсы испытателя */
const TR_TESTER: readonly ExamRequirement[] = [
  ...TR_GUNNER,
  { title: "КБМ испытателя", code: "КБМ Испыт." },
  { title: "Уставы общие", code: "Уставы (общевойсковые)" },
  { title: "КБМ", code: "КБМ" },
];

const TANK_SPECIALITIES: readonly ExamSpeciality[] = [
  {
    key: "driver",
    title: "Механик-водитель",
    hint: "База роты: техника, огонь, медицина и вождение",
    requirements: TR_DRIVER,
  },
  {
    key: "gunner",
    title: "Наводчик-оператор",
    hint: "Все экзамены мехвода плюс вооружение, тактика и устав",
    requirements: TR_GUNNER,
  },
  {
    key: "tester",
    title: "КБМ / Испытатель",
    hint: "Все экзамены мехвода и наводчика плюс курсы испытателя",
    requirements: TR_TESTER,
  },
  {
    key: "specials",
    title: "ПВО / Спецкурсы",
    hint: "Отдельные курсы: ПВО, миномётное и артиллерийское дело",
    requirements: [
      { title: "ПВО", code: "ПВО" },
      {
        title: "Миномётное дело",
        code: "Миномётное дело (Экзамен)",
        aliases: ["Миномётное дело", "Минометное дело"],
      },
      {
        title: "Арт. дело",
        // В ТЗ норматив назван с опечаткой («Артиллирийское») — она же стоит в
        // матрице допуска к САУ (vehicles.ts), поэтому принимаем оба написания
        code: "Артиллирийское Дело (Экзамен)",
        aliases: [
          "Арт. дело",
          "Артиллерийское дело",
          "Артиллерийское дело (Экзамен)",
          "Артиллирийское Дело (обучение)",
          "Артиллерийское дело (обучение)",
        ],
      },
    ],
  },
  {
    key: "beret",
    title: "Экзамен на берет",
    hint: "Топография, связь, строй и знание должностных лиц",
    requirements: BERET_EXAMS,
  },
];

/* --- Артиллерийский дивизион --------------------------------------- */

/** База миномётчика: допуск на миномёты — шесть нормативов столбцов J–O */
const AD_MORTAR: readonly ExamRequirement[] = [
  { title: "Физическая подготовка", code: "Физ. Подготовка" },
  { title: "ТТХ (миномёты)", code: "ТТХ (минометы)" },
  { title: "Миномётное дело (обучение)", code: "Миномётное дело (обучение)" },
  {
    title: "Тест по теории",
    code: "Прохождение теста по теории",
    aliases: ["Тест теория", "Прохождение теста"],
  },
  {
    title: "Миномётное дело (экзамен)",
    code: "Миномётное дело (Экзамен)",
    aliases: ["Минометное дело (экзамен)", "Миномётное дело (экзамен)"],
  },
  { title: "ПМП", code: "ПМП" },
];

/**
 * САУ и гаубицы: все миномёты плюс семь нормативов ствольной артиллерии.
 *
 * Каскад обязателен по ТЗ: без шести миномётных нормативов допуск к САУ не
 * выдаётся, поэтому список начинается с них.
 */
const AD_SPG: readonly ExamRequirement[] = [
  ...AD_MORTAR,
  {
    title: "Снаряжение и обслуживание техники",
    code: "Снаряжение и обслуживание техники",
    aliases: ["Снаряжение, обслуживание техники"],
  },
  { title: "ТТХ (ствольная артиллерия)", code: "ТТХ (ствольная артиллерия)" },
  { title: "Управление гусеничной техникой", code: "Управление гусеничной техникой" },
  MECHANIC_DRIVER,
  { title: "Устав АТК", code: "Устав АТК" },
  {
    title: "Арт. дело (обучение)",
    code: "Артиллерийское дело (обучение)",
    aliases: ["Артиллирийское Дело (обучение)", "Арт. дело обучение", "Арт. дело (обучение)"],
  },
  {
    title: "Арт. дело (экзамен)",
    // Код совпадает с требованием матрицы техники (vehicles.ts), чтобы допуск к
    // САУ и отметка в разделе «Экзамены» не расходились
    code: "Артиллирийское Дело (Экзамен)",
    aliases: [
      "Артиллерийское дело (экзамен)",
      "Артиллерийское Дело (Экзамен)",
      "Арт. дело (экзамен)",
      "Арт. дело",
    ],
  },
];

/**
 * РСЗО — высшая ступень дивизиона: всё, что нужно САУ, плюс реактивная
 * артиллерия и «Берет».
 *
 * «Берет» включён в список осознанно: он входит в требования ступени, а
 * признак requiresBeret ниже превращает вкладку в заблокированную, пока берет
 * не сдан (условие выдаётся подсказкой, а не молчаливым «не сдано» на последней
 * строке).
 */
const AD_MLRS: readonly ExamRequirement[] = [
  ...AD_SPG,
  {
    title: "РСЗО (обучение)",
    code: "РСЗО (обучение)",
    aliases: ["РСЗО обучение", "РСЗО (Обучение)"],
  },
  {
    title: "РСЗО (экзамен)",
    // То же название, что в требовании допуска к реактивной артиллерии
    code: "РСЗО (Экзамен)",
    aliases: ["РСЗО (экзамен)", "РСЗО"],
  },
  { title: "Техника АТК", code: "Техника АТК" },
  BERET_BADGE_STEP,
];

const ARTILLERY_SPECIALITIES: readonly ExamSpeciality[] = [
  {
    key: "mortar",
    title: "Допуск на Минометы",
    hint: "Базовый допуск дивизиона: расчёт, теория и медицина",
    requirements: AD_MORTAR,
  },
  {
    key: "spg",
    title: "Допуск на САУ + Гаубицы",
    hint: "Все миномётные нормативы плюс ствольная артиллерия и вождение",
    requirements: AD_SPG,
  },
  {
    key: "mlrs",
    title: "Допуск на РСЗО",
    hint: "Все нормативы САУ плюс реактивная артиллерия",
    requirements: AD_MLRS,
    // Высшая ступень: берётся только с сданным беретом
    requiresBeret: true,
    blockedHint: "Требуется сдача Экзамена на берет",
  },
  {
    key: "specials",
    title: "Дополнительно / Спецкурсы",
    hint: "Отдельные курсы дивизиона: уставы, ПВО и БПЛА",
    requirements: [
      { title: "Уставы (общевойсковые)", code: "Уставы (общевойсковые)" },
      { title: "ПВО", code: "ПВО" },
      { title: "БПЛА", code: "БПЛА" },
    ],
  },
  {
    key: "beret",
    title: "Экзамен на берет",
    hint: "Топография, связь, строй и знание должностных лиц",
    requirements: BERET_EXAMS,
  },
];

/**
 * Специальности бойца по подразделению.
 *
 * Без назначенного подразделения вкладок нет: набор нормативов у роты и
 * дивизиона разный, и «угадать» направление за бойца значило бы показать ему
 * чужие допуски. Страница в этом случае объясняет, что подразделение назначит
 * штаб.
 */
export function examSpecialities(unit: string | null | undefined): readonly ExamSpeciality[] {
  const division = examDivision(unit);
  if (division === "tank") return TANK_SPECIALITIES;
  if (division === "artillery") return ARTILLERY_SPECIALITIES;
  return [];
}

/* ------------------------------------------------------------------ */
/* Статусы нормативов                                                  */
/* ------------------------------------------------------------------ */

/** Сданный норматив: название, оценка и дата (из одобренного рапорта) */
export type ExamPassed = {
  code: string;
  grade?: string | null;
  /** Дата сдачи (ISO) — из ответа /api/member/dossier */
  at?: string | null;
};

/** Статус одного норматива специальности */
export type ExamRequirementStatus = {
  requirement: ExamRequirement;
  /** Норматив сдан: найден среди одобренных рапортов на экзамены */
  passed: boolean;
  /** Оценка экзаменатора (пусто у нормативов без оценки, например КМБТ) */
  grade: string | null;
  /** Дата сдачи (ISO) */
  at: string | null;
  /**
   * Есть ли у норматива столбец в листе ШДС подразделения бойца.
   *
   * Считается по каталогу рапортов (reports.ts), а не проставляется вручную,
   * поэтому расхождение с реальной шапкой листа видно сразу — и в интерфейсе, и
   * в тестах. Для нормативов шкалы признак всегда true: своих столбцов в листах
   * не имеет лишь производный «Берет», и он закрывается по другим нормативам.
   */
  inShds: boolean;
};

/** Итог по специальности: статусы, прогресс и готовая подпись шкалы */
export type SpecialityProgress = {
  speciality: ExamSpeciality;
  statuses: ExamRequirementStatus[];
  /** Всего нормативов специальности */
  total: number;
  /** Сколько сдано */
  passedCount: number;
  /** Процент сдачи (округление вниз: «5 из 12» — это 41%, а не 42%) */
  percent: number;
  /** Названия несданных нормативов */
  missing: string[];
  /** Подпись прогресс-бара: «Сдано: 5 из 12 нормативов (41%)» */
  summary: string;
  /**
   * Ступень закрыта до сдачи берета: нормативы могут быть сданы, но вкладка
   * помечается заблокированной, а в подсказке — почему.
   */
  blocked: boolean;
  /** Подсказка блокировки (пусто, если ступень доступна) */
  blockedHint: string;
};

/** Все написания, которые засчитывают норматив */
function requirementKeys(requirement: ExamRequirement): string[] {
  return [requirement.code, ...(requirement.aliases ?? [])]
    .map((value) => normalizeExamCode(value))
    .filter(Boolean);
}

/**
 * Найденный среди сданных норматив (или null).
 *
 * Сравнение идёт по нормализованным названиям (регистр, «ё/е», пробелы) — ровно
 * так же сопоставляются столбцы ШДС при зачёте экзамена (matchExamColumns),
 * поэтому «сдал в таблице», зелёный бейдж раздела и допуск к технике не
 * расходятся.
 */
export function matchQualification(
  requirement: ExamRequirement,
  passed: readonly ExamPassed[]
): ExamPassed | null {
  const keys = new Set(requirementKeys(requirement));
  return passed.find((item) => keys.has(normalizeExamCode(item.code))) ?? null;
}

/**
 * Сдан ли экзамен на берет целиком: все четыре норматива закрыты.
 *
 * «Берет» — производный норматив: своего рапорта у него нет, и отдельного
 * решения штаба не требуется. Как только сданы «Топография», «Связь»,
 * «Строевая подготовка» и «Должностные лица», берет считается закрытым: бот
 * закрашивает столбец «Берет» в листе, а бойцу выдаётся серверная роль «Берет»
 * (см. role-sync.ts).
 *
 * Норматив, отмеченный в таблице вручную (столбец «Берет» уже закрашен), тоже
 * засчитывается: проверка идёт по названию через общий matchQualification.
 */
export function isBeretPassed(passed: readonly ExamPassed[]): boolean {
  if (matchQualification(BERET_BADGE_STEP, passed)) return true;
  return BERET_STEPS.every((step) => Boolean(matchQualification(step, passed)));
}

/**
 * Ступень заблокирована до сдачи берета.
 *
 * Пока условие не выполнено, вкладка «Допуск на РСЗО» помечается
 * заблокированной с подсказкой «Требуется сдача Экзамена на берет» — иначе боец
 * видел бы лишь несданный «Берет» последней строкой и не понимал, что дело в
 * нём.
 */
export function isSpecialityBlocked(
  speciality: ExamSpeciality,
  passed: readonly ExamPassed[]
): boolean {
  if (speciality.requiresBeret !== true) return false;
  return !isBeretPassed(passed);
}

/**
 * Статус одного норматива.
 *
 * Оценка и дата берутся из одобренного рапорта: в ШДС бот закрашивает столбец и
 * вписывает оценку, а дата решения штаба и есть дата сдачи. Исключение —
 * производный «Берет»: он закрывается по четырём нормативам экзамена.
 */
export function requirementStatus(
  requirement: ExamRequirement,
  unit: string | null | undefined,
  passed: readonly ExamPassed[]
): ExamRequirementStatus {
  const derived = normalizeExamCode(requirement.code) === normalizeExamCode(BERET_CODE);
  const found = derived
    ? isBeretPassed(passed)
      ? { grade: null, at: beretPassedAt(passed) }
      : null
    : matchQualification(requirement, passed);

  return {
    requirement,
    passed: Boolean(found),
    grade: found?.grade ? String(found.grade) : null,
    at: found?.at ? String(found.at) : null,
    inShds: hasShdsColumn(unit, requirement),
  };
}

/** Дата закрытия берета — самая поздняя из четырёх сданных нормативов экзамена */
function beretPassedAt(passed: readonly ExamPassed[]): string | null {
  let latest: string | null = null;
  for (const step of BERET_STEPS) {
    const found = matchQualification(step, passed);
    const at = found?.at ? String(found.at) : null;
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Есть ли у норматива столбец в листе ШДС указанного подразделения.
 *
 * Сопоставление идёт и по алиасам: «Уставы общие» из шкалы засчитываются
 * столбцом «Уставы (общевойсковые)», поэтому норматив не должен выглядеть
 * «ручным» из-за другого написания.
 */
export function hasShdsColumn(
  unit: string | null | undefined,
  requirement: ExamRequirement
): boolean {
  return columnExamFor(unit, requirement.code) !== null;
}

/** Прогресс по специальности: сколько нормативов сдано и что осталось */
export function specialityProgress(
  speciality: ExamSpeciality,
  unit: string | null | undefined,
  passed: readonly ExamPassed[]
): SpecialityProgress {
  const statuses = speciality.requirements.map((requirement) =>
    requirementStatus(requirement, unit, passed)
  );
  const total = statuses.length;
  const passedCount = statuses.filter((status) => status.passed).length;
  const percent = total === 0 ? 0 : Math.floor((passedCount / total) * 100);
  const missing = statuses.filter((status) => !status.passed).map((status) => status.requirement.title);
  const blocked = isSpecialityBlocked(speciality, passed);

  return {
    speciality,
    statuses,
    total,
    passedCount,
    percent,
    missing,
    summary: `Сдано: ${passedCount} из ${total} нормативов (${percent}%)`,
    blocked,
    blockedHint: blocked ? speciality.blockedHint || "" : "",
  };
}

/** Прогресс по всем специальностям подразделения — для сводки над вкладками */
export function specialitiesProgress(
  unit: string | null | undefined,
  passed: readonly ExamPassed[]
): SpecialityProgress[] {
  return examSpecialities(unit).map((speciality) => specialityProgress(speciality, unit, passed));
}