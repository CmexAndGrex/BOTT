/**
 * Матрица техники подразделения и правила допуска к ней.
 *
 * Модуль намеренно не зависит ни от БД, ни от Next.js, ни от Discord — как
 * recruits.ts, reports.ts и armory.ts: правила проверяются тестами напрямую
 * (tests/profile-and-vehicles.test.ts) и используются одинаково на сервере
 * (роут досье) и в интерфейсе (сетка «Техника»). Если правило нужно и роуту,
 * и карточке — живёт здесь, а не копией в двух местах.
 *
 * Два разных принципа допуска, как и в жизни подразделения:
 *   * Танковая рота — допуск по ЗВАНИЮ. Звание открывает технику своего уровня
 *     и всего, что ниже: «Старшина» водит и Т-90СМ, и всё, что положено
 *     рядовому. Поэтому матрица хранится ступенями, а не флагами «можно/нельзя».
 *   * Артиллерийский дивизион — допуск по КВАЛИФИКАЦИИ. Звание здесь ничего не
 *     решает: миномётчик, САУ и РСЗО требуют сданных столбцов ШДС (например,
 *     «Миномётное дело (Экзамен)» и «Сдача на мехвода»). Названия нормативов
 *     совпадают с шапкой листа ШДС — переименование здесь означало бы вечный
 *     «требуется сдача» у того, кто давно сдал.
 *
 * Цены ($) — стоимость единицы в экономике подразделения, показывается в карточке.
 *
 * Третий признак — УРОВЕНЬ VIP (`vipTier`) и минимальное звание реестра гаража
 * (`requiredRank`): они не меняют допуск, но их показывает карточка, и по
 * `vipTier` кабинет фильтрует список (см. vipFilterCounts). Названия и цены
 * сверены с реестром гаража: «Т-90М «Прорыв»», «БМП-3 (VВесна-К/ДБ)»,
 * «ЗСУ-23-4 «Шилка»» — это строки оттуда, а не пересказ.
 */
import { RANKS, type Rank } from "@/lib/recruits";
import { normalizeExamCode } from "@/lib/reports";

/* ------------------------------------------------------------------ */
/* Общие типы                                                          */
/* ------------------------------------------------------------------ */

/** Категория техники: подпись выводится в интерфейсе рядом с названием */
export type VehicleCategory = "tank" | "ifv" | "spg" | "mlrs" | "sam" | "mortar";

export const VEHICLE_CATEGORY_LABELS: Record<VehicleCategory, string> = {
  tank: "Танк",
  ifv: "БМП",
  spg: "САУ",
  mlrs: "РСЗО",
  sam: "ПВО",
  mortar: "Миномёт",
};

/* ------------------------------------------------------------------ */
/* Уровни VIP                                                          */
/* ------------------------------------------------------------------ */

/**
 * Уровень VIP: 0 — обычная техника, 1 — VIP 1, 2 — VIP 2.
 *
 * Шкала взята из реестра игрового гаража и живёт рядом с допуском по званию, а
 * не вместо него: VIP-машина требует и уровня подписки, и допуска подразделения.
 * Отдельного поля «есть ли у бойца VIP» в карточке нет — поэтому здесь только
 * КАТЕГОРИЯ единицы техники, по которой кабинет фильтрует и рисует бейджи.
 */
export type VipTier = 0 | 1 | 2;

/** Подписи уровней: те же строки, что на кнопках-фильтрах кабинета */
export const VEHICLE_VIP_LABELS: Record<VipTier, string> = {
  0: "Базовая",
  1: "VIP 1",
  2: "VIP 2",
};

/**
 * Ключ фильтра техники в кабинете.
 *
 * `all` — «Все», остальные значения однозначно соответствуют уровню VIP: фильтр
 * не вводит второй шкалы, а лишь называет уже описанные ступени.
 */
export type VehicleVipFilter = "all" | "base" | "vip1" | "vip2";

/** Порядок кнопок фильтра: «Все · Базовая · VIP 1 · VIP 2» */
export const VEHICLE_VIP_FILTERS: readonly VehicleVipFilter[] = ["all", "base", "vip1", "vip2"];

/** Уровень VIP, которым ограничивает фильтр; null — фильтр ничего не отсекает */
export function vipTierOfFilter(filter: VehicleVipFilter): VipTier | null {
  if (filter === "base") return 0;
  if (filter === "vip1") return 1;
  if (filter === "vip2") return 2;
  return null;
}

/** Подходит ли единица техники выбранному фильтру */
export function matchesVipFilter(vehicle: Vehicle, filter: VehicleVipFilter): boolean {
  const tier = vipTierOfFilter(filter);
  return tier === null || vehicle.vipTier === tier;
}

/** Карточка в том виде, в каком её достаточно для подсчёта счётчиков */
export type VipCountable = { vehicle: Vehicle };

/**
 * Сколько единиц в каждой категории фильтра — для счётчиков на кнопках.
 *
 * Считаем по ТЕКУЩЕМУ списку (открытая или закрытая техника), а не по всему
 * реестру: счётчик «Базовая (12)» рядом с пустым списком читался бы как ошибка
 * фильтра, хотя вкладка «Требует повышения» просто пуста.
 */
export function vipFilterCounts(cards: readonly VipCountable[]): Record<VehicleVipFilter, number> {
  const counts: Record<VehicleVipFilter, number> = {
    all: cards.length,
    base: 0,
    vip1: 0,
    vip2: 0,
  };
  for (const card of cards) {
    if (card.vehicle.vipTier === 1) counts.vip1 += 1;
    else if (card.vehicle.vipTier === 2) counts.vip2 += 1;
    else counts.base += 1;
  }
  return counts;
}

/**
 * Единица техники.
 *
 * `id` — стабильный ключ для React-списков и тестов: название содержит пробелы,
 * скобки и кавычки-ёлочки, а сравнивать карточки по нему неудобно и хрупко.
 */
export type Vehicle = {
  id: string;
  /** Название так, как его называют в подразделении: «Т-72Б (1985) (RHS)» */
  name: string;
  category: VehicleCategory;
  /** Модификация/источник («RHS», «RED»); null — модификация не указывается */
  mod: string | null;
  /** Стоимость единицы; null — цена не установлена (техника ивентов) */
  price: number | null;
  /** Уровень VIP из реестра гаража: 0 — базовая, 1 — VIP 1, 2 — VIP 2 */
  vipTier: VipTier;
  /**
   * Минимальное звание из реестра («Мин. звание»); null — отдельного требования
   * в реестре нет, и допуск определяет ступень матрицы либо нормативы ШДС.
   */
  requiredRank: Rank | null;
};

/** Подпись состояния доступа в карточке техники */
export const VEHICLE_STATUS_LABELS = {
  unlocked: "Допуск получен",
  lockedByRank: "Требуется повышение",
  lockedByExam: "Требуется сдача норматива",
} as const;

export type VehicleStatusLabel =
  (typeof VEHICLE_STATUS_LABELS)[keyof typeof VEHICLE_STATUS_LABELS];

/* ------------------------------------------------------------------ */
/* Танковая рота: ступени по званию                                    */
/* ------------------------------------------------------------------ */

/** Ступень допуска: звание и техника, которую оно открывает */
export type RankTier = {
  rank: Rank;
  vehicles: readonly Vehicle[];
};

/** Обозначение модификации вынесено, чтобы не плодить строковые литералы */
const RHS = "RHS";
const RED = "RED";

/**
 * Базовая техника из реестра гаража: без VIP и без отдельного «мин. звания».
 *
 * Базовые машины по-прежнему открываются ступенью матрицы: звание бойца и есть
 * их минимальное звание. Поле requiredRank остаётся null — там, где реестр
 * называет звание явно (Т-90М, вся VIP-линейка), оно заполняется вручную.
 */
const BASE = { vipTier: 0, requiredRank: null } as const;

/**
 * Матрица «Танковая рота».
 *
 * Порядок ступеней совпадает с порядком званий в RANKS — на этом построен
 * вывод «что откроется на следующем звании»: следующая ступень ищется по
 * индексу звания в общем списке, а не по порядку в этом массиве.
 *
 * VIP-техника живёт в тех же ступенях, что и раньше: уровень VIP — это
 * подписка на единицу из реестра гаража, а допуск по-прежнему даёт звание.
 * Так карточка честно показывает и «когда можно», и «что это VIP-машина».
 */
export const TANK_RANK_MATRIX: readonly RankTier[] = [
  {
    rank: "Рядовой",
    vehicles: [
      { id: "t-72b-1985-rhs", name: "Т-72Б (1985) (RHS)", category: "tank", mod: RHS, price: 235, ...BASE },
      { id: "t-72b-1989-rhs", name: "Т-72Б (1989) (RHS)", category: "tank", mod: RHS, price: 215, ...BASE },
      { id: "2s25-sprut-sd", name: "2С25 (Спрут-СД)", category: "spg", mod: null, price: 215, ...BASE },
      { id: "btr-80a", name: "БТР-80А", category: "ifv", mod: null, price: 160, ...BASE },
      { id: "mt-lb-lv-camo", name: "MT-LB LV (Camo)", category: "ifv", mod: null, price: 100, ...BASE },
      { id: "zsu-23-4-shilka", name: "ЗСУ-23-4 «Шилка»", category: "sam", mod: null, price: 100, ...BASE },
    ],
  },
  {
    rank: "Ефрейтор",
    vehicles: [
      { id: "t-72a-red", name: "Т-72А (RED)", category: "tank", mod: RED, price: 250, ...BASE },
      { id: "t-72b3-2012-rhs", name: "Т-72Б3 (2012) (RHS)", category: "tank", mod: RHS, price: 250, ...BASE },
      { id: "t-80b-red", name: "Т-80Б (RED)", category: "tank", mod: RED, price: 250, ...BASE },
      { id: "t-80u-rhs", name: "Т-80У (RHS)", category: "tank", mod: RHS, price: 280, ...BASE },
      { id: "t-80u-45m-rhs", name: "Т-80У (45М) (RHS)", category: "tank", mod: RHS, price: 295, ...BASE },
      { id: "t-80ue1-rhs", name: "Т-80УЕ-1 (RHS)", category: "tank", mod: RHS, price: 260, ...BASE },
      {
        id: "2s6-tunguska", name: "2С6 «Тунгуска»", category: "sam", mod: null, price: 450,
        vipTier: 1, requiredRank: "Ефрейтор",
      },
      { id: "bmp-2k-rhs", name: "БМП-2К (RHS)", category: "ifv", mod: RHS, price: 210, ...BASE },
    ],
  },
  {
    rank: "Мл. Сержант",
    vehicles: [
      { id: "t-72b-red", name: "Т-72Б (RED)", category: "tank", mod: RED, price: 285, ...BASE },
      { id: "t-72b3-2016-rhs", name: "Т-72Б3 (2016) (RHS)", category: "tank", mod: RHS, price: 275, ...BASE },
      { id: "t-80bv-red", name: "Т-80БВ (RED)", category: "tank", mod: RED, price: 300, ...BASE },
      { id: "t-80uk-rhs", name: "Т-80УК (RHS)", category: "tank", mod: RHS, price: 315, ...BASE },
      { id: "t-90a-2006-rhs", name: "Т-90А (2006) (RHS)", category: "tank", mod: RHS, price: 290, ...BASE },
      {
        id: "pantsir-s1", name: "Панцирь-С1", category: "sam", mod: null, price: 900,
        vipTier: 2, requiredRank: "Мл. Сержант",
      },
      { id: "bmp-2d-rhs", name: "БМП-2Д (RHS)", category: "ifv", mod: RHS, price: 230, ...BASE },
      { id: "bmp-3-poz", name: "БМП-3 (Поз.)", category: "ifv", mod: null, price: 275, ...BASE },
      { id: "bmp-3-vesna-k", name: "БМП-3 (VВесна-К)", category: "ifv", mod: null, price: 300, ...BASE },
      {
        id: "bmp-3m", name: "БМП-3М", category: "ifv", mod: null, price: 340,
        vipTier: 1, requiredRank: "Мл. Сержант",
      },
    ],
  },
  {
    rank: "Сержант",
    vehicles: [
      { id: "t-72b3-red", name: "Т-72Б3 (RED)", category: "tank", mod: RED, price: 310, ...BASE },
      { id: "t-90sa-rhs", name: "Т-90СА (RHS)", category: "tank", mod: RHS, price: 330, ...BASE },
      {
        id: "bmp-3-vesna-k-db", name: "БМП-3 (VВесна-К/ДБ)", category: "ifv", mod: null, price: 325,
        vipTier: 2, requiredRank: "Сержант",
      },
    ],
  },
  {
    rank: "Ст. Сержант",
    vehicles: [
      {
        id: "t-80u-red", name: "Т-80У (RED)", category: "tank", mod: RED, price: 350,
        vipTier: 1, requiredRank: "Ст. Сержант",
      },
      { id: "t-90a-red", name: "Т-90А (RED)", category: "tank", mod: RED, price: 400, ...BASE },
      { id: "t-90am-rhs", name: "Т-90АМ (RHS)", category: "tank", mod: RHS, price: 410, ...BASE },
    ],
  },
  {
    rank: "Старшина",
    vehicles: [
      {
        id: "t-90sm-rhs", name: "Т-90СМ (объект 188СМ) (RHS)", category: "tank", mod: RHS, price: 410,
        vipTier: 1, requiredRank: "Старшина",
      },
    ],
  },
  {
    rank: "Прапорщик",
    vehicles: [
      {
        id: "t-80ue1-red", name: "Т-80УЕ-1 (RED)", category: "tank", mod: RED, price: 400,
        vipTier: 2, requiredRank: "Прапорщик",
      },
    ],
  },
  {
    rank: "Ст. Прапорщик",
    vehicles: [
      { id: "t-72b3-ubh-red", name: "Т-72Б3 УБХ (RED)", category: "tank", mod: RED, price: 410, ...BASE },
    ],
  },
  {
    rank: "Лейтенант",
    vehicles: [
      // Т-90М в реестре идёт базовой машиной, но с явным требованием по званию
      {
        id: "t-90m-red", name: "Т-90М (RED)", category: "tank", mod: RED, price: 450,
        vipTier: 0, requiredRank: "Лейтенант",
      },
      {
        id: "t-90m-proryv-3", name: "Т-90М «Прорыв» (Proryv-3)", category: "tank", mod: null, price: 510,
        vipTier: 2, requiredRank: "Лейтенант",
      },
      {
        id: "t-90ms-tagil", name: "Т-90MS Tagil", category: "tank", mod: null, price: 500,
        vipTier: 1, requiredRank: "Лейтенант",
      },
      // Техника ивентов: цена не установлена — в карточке показывается «по решению штаба»
      { id: "t-100-black-eagle", name: "Т-100 «Чёрный Орёл» (Ивентолог)", category: "tank", mod: null, price: null, ...BASE },
      {
        id: "t-15-armata-ifv", name: "Т-15 Армата ИФВ", category: "ifv", mod: null, price: 500,
        vipTier: 1, requiredRank: "Лейтенант",
      },
    ],
  },
  {
    rank: "Ст. Лейтенант",
    vehicles: [
      {
        id: "t-14-armata", name: "Т-14 Армата", category: "tank", mod: null, price: 510,
        vipTier: 2, requiredRank: "Ст. Лейтенант",
      },
    ],
  },
];
/* ------------------------------------------------------------------ */
/* Артиллерийский дивизион: допуски по нормативам ШДС                  */
/* ------------------------------------------------------------------ */

/**
 * Норматив, подтверждающий допуск.
 *
 * `code` — основное название столбца листа ШДС (так его пишет штаб в таблице).
 * `aliases` — написания, которые реально встречаются в таблицах и заявках:
 * «ё/е», опечатки вида «Артиллирийское», сокращения. Без них боец со сданным
 * нормативом видел бы «требуется сдача» из-за одной буквы.
 */
export type QualificationExam = {
  code: string;
  aliases: readonly string[];
};

/** Категории артиллерии: у каждой свой набор нормативов допуска */
export type ArtilleryCategoryKey = "mortar" | "spg" | "mlrs";

export type ArtilleryCategory = {
  key: ArtilleryCategoryKey;
  title: string;
  hint: string;
  vehicles: readonly Vehicle[];
  required: readonly QualificationExam[];
};

export const ARTILLERY_CATEGORIES: readonly ArtilleryCategory[] = [
  {
    key: "mortar",
    title: "Миномётная батарея",
    hint: "Поднос 2Б14 и миномёты расчёта",
    vehicles: [
      { id: "mortar-2b14-podnos", name: "2Б14 «Поднос» (82-мм миномёт)", category: "mortar", mod: null, price: null, ...BASE },
      { id: "mortar-crew-nomenclature", name: "Миномёты расчёта батареи", category: "mortar", mod: null, price: null, ...BASE },
    ],
    required: [
      { code: "Миномётное дело (Экзамен)", aliases: ["Минометное дело (экзамен)", "Миномётное дело (экзамен)"] },
    ],
  },
  {
    key: "spg",
    title: "Самоходная артиллерия",
    hint: "2С1 «Гвоздика», 2С3М1 «Акация», 2С19 «Мста-С»",
    vehicles: [
      { id: "2s1-gvozdika", name: "2С1 «Гвоздика»", category: "spg", mod: null, price: null, ...BASE },
      { id: "2s3m1-akatsiya", name: "2С3М1 «Акация»", category: "spg", mod: null, price: null, ...BASE },
      { id: "2s19-msta-s", name: "2С19 «Мста-С»", category: "spg", mod: null, price: null, ...BASE },
    ],
    required: [
      {
        code: "Артиллирийское Дело (Экзамен)",
        // В ТЗ норматив назван именно так; в шапке листа встречается и корректное
        // написание — принимаем оба, иначе допуск к САУ никогда не подтвердится.
        aliases: [
          "Артиллерийское дело (экзамен)",
          "Артиллерийское Дело (Экзамен)",
          "Артиллерийское дело",
        ],
      },
      {
        code: "Сдача на мехвода",
        aliases: ["Сдача на Мех. Водителя", "Сдача на мех. водителя", "Сдача на мехводителя"],
      },
    ],
  },
  {
    key: "mlrs",
    title: "Реактивная артиллерия",
    hint: "2Б26 «Град-К», Торнадо-Г",
    vehicles: [
      { id: "2b26-grad-k", name: "2Б26 «Град-К»", category: "mlrs", mod: null, price: 325, ...BASE },
      { id: "tornado-g", name: "Торнадо-Г", category: "mlrs", mod: null, price: null, ...BASE },
    ],
    required: [{ code: "РСЗО (Экзамен)", aliases: ["РСЗО (экзамен)", "РСЗО"] }],
  },
];
/* ------------------------------------------------------------------ */
/* Звания: сопоставление и порядок                                     */
/* ------------------------------------------------------------------ */

/**
 * Варианты написания званий, которые встречаются в ШДС и заявках. Ключ — как
 * звание хранится в RANKS, значения — как его ещё пишут.
 */
const RANK_ALIASES: Record<Rank, readonly string[]> = {
  Курсант: [],
  Рядовой: [],
  Ефрейтор: [],
  "Мл. Сержант": ["Младший Сержант", "Мл.Сержант"],
  Сержант: [],
  "Ст. Сержант": ["Старший Сержант", "Ст.Сержант"],
  Старшина: [],
  Прапорщик: [],
  "Ст. Прапорщик": ["Старший Прапорщик", "Ст.Прапорщик"],
  Лейтенант: [],
  "Ст. Лейтенант": ["Старший Лейтенант", "Ст.Лейтенант"],
  Капитан: [],
  Майор: [],
  Подполковник: [],
  Полковник: [],
};

/** Приведение звания к каноническому виду: регистр, «ё», лишние пробелы */
function normalizeRankText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/ё/gi, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Каноническое звание по любой записи из ШДС. null — звания нет в RANKS */
export function normalizeRank(value: unknown): Rank | null {
  const needle = normalizeRankText(value);
  if (!needle) return null;
  for (const rank of RANKS) {
    if (normalizeRankText(rank) === needle) return rank;
    if (RANK_ALIASES[rank].some((alias) => normalizeRankText(alias) === needle)) return rank;
  }
  return null;
}

/** Позиция звания в общей лестнице; -1 — звание неизвестно */
export function rankIndex(value: unknown): number {
  const rank = normalizeRank(value);
  if (!rank) return -1;
  return RANKS.indexOf(rank);
}

/**
 * Ближайшая ступень ВЫШЕ текущего звания.
 *
 * Ищем по индексу в RANKS, а не по порядку в матрице: иначе «Прапорщик» (у него
 * в матрице одна машина) считался бы следующей ступенью после «Старшины» и
 * лейтенантская техника «терялась» бы из предпросмотра.
 */
export function nextTankTier(rank: Rank | null): RankTier | null {
  const from = rank ? RANKS.indexOf(rank) : -1;
  return TANK_RANK_MATRIX.find((tier) => RANKS.indexOf(tier.rank) > from) ?? null;
}

/** Все единицы техники Танковой роты (для сводки «открыто N из M») */
export function allTankVehicles(): Vehicle[] {
  return TANK_RANK_MATRIX.flatMap((tier) => [...tier.vehicles]);
}

/** Все единицы техники артиллерии */
export function allArtilleryVehicles(): Vehicle[] {
  return ARTILLERY_CATEGORIES.flatMap((category) => [...category.vehicles]);
}

/* ------------------------------------------------------------------ */
/* Сопоставление сданных нормативов                                    */
/* ------------------------------------------------------------------ */

/** Все написания, которые засчитывают норматив */
function examKeys(exam: QualificationExam): string[] {
  return [exam.code, ...exam.aliases].map((value) => normalizeExamCode(value)).filter(Boolean);
}

/**
 * Сдан ли норматив.
 *
 * Сравнение идёт по нормализованным названиям (регистр, «ё/е», неразрывный
 * пробел) — ровно так же сопоставляются столбцы ШДС при зачёте экзамена
 * (matchExamColumns), поэтому «сдал в таблице» и «допущен к технике» не
 * расходятся.
 */
export function isQualificationPassed(
  exam: QualificationExam,
  passed: readonly string[]
): boolean {
  const keys = new Set(examKeys(exam));
  return passed.some((value) => keys.has(normalizeExamCode(value)));
}

/* ------------------------------------------------------------------ */
/* Результат: что открыто, что заперто и что нужно сделать             */
/* ------------------------------------------------------------------ */

export type VehicleCard = {
  vehicle: Vehicle;
  status: "unlocked" | "locked";
  statusLabel: VehicleStatusLabel;
  /** Выполненные условия допуска */
  satisfied: string[];
  /** Чего не хватает: «звание Старшина», «норматив РСЗО (Экзамен)» */
  missing: string[];
  /** Звание, с которого открывается техника (Танковая рота); иначе null */
  unlocksAtRank: Rank | null;
};

export type TankTierView = {
  rank: Rank;
  /** Ступень уже пройдена: звание бойца не ниже */
  unlocked: boolean;
  vehicles: VehicleCard[];
};

export type ArtilleryCategoryView = {
  key: ArtilleryCategoryKey;
  title: string;
  hint: string;
  /** Все нормативы категории сданы */
  unlocked: boolean;
  statusLabel: VehicleStatusLabel;
  satisfied: string[];
  missing: string[];
  vehicles: VehicleCard[];
};

/**
 * Прогресс до следующего допуска.
 *
 * `satisfied/total` считаются «шагами»: для Танковой роты — позиция в лестнице
 * званий, для артиллерии — сколько категорий допуска уже открыто из трёх.
 */
export type VehicleProgress = {
  kind: "rank" | "qualification" | "none";
  /** Что откроется дальше: «Мл. Сержант», «Самоходная артиллерия» */
  next: string | null;
  satisfied: number;
  total: number;
  percent: number;
  missing: string[];
};

export type VehicleAccessReport = {
  division: "tank" | "artillery" | "unknown";
  unit: string | null;
  rank: Rank | null;
  /** Позиция звания в RANKS; -1 — звание неизвестно */
  rankIndex: number;
  unlocked: VehicleCard[];
  locked: VehicleCard[];
  /** Танковая рота: ступени по званиям (текущая и предпросмотр следующей) */
  tiers: TankTierView[];
  /** Артиллерия: категории допуска */
  categories: ArtilleryCategoryView[];
  progress: VehicleProgress;
  /** Короткая сводка для заголовка карточки */
  summary: string;
};

/** Боец, для которого считается допуск */
export type VehicleHolder = {
  /** Звание как оно записано в карточке или ШДС */
  rank?: string | null;
  /** Подразделение: «Танковая рота» / «Артиллерийский дивизион» */
  unit?: string | null;
  /**
   * Сданные нормативы — названия столбцов ШДС. Источник на сервере: одобренные
   * рапорты на экзамены (они и закрашивают столбцы), см. collectQualifications.
   */
  qualifications?: readonly string[] | null;
};

/**
 * Подразделение по названию. Те же регулярные выражения, что в resolveLayout()
 * (gsheets.ts): «Танковая рота» и «Артиллерийский дивизион» — это имена листов
 * ШДС, и раскладку определяет подразделение, а не точная строка.
 */
export function vehicleDivision(unit: string | null | undefined): VehicleAccessReport["division"] {
  const value = String(unit ?? "").toLowerCase();
  if (/танк/.test(value)) return "tank";
  if (/дивизион|артиллер/.test(value)) return "artillery";
  return "unknown";
}

/** Сводка «Открыто N из M единиц техники» */
function buildSummary(unlocked: number, total: number): string {
  if (total === 0) return "Матрица техники для подразделения не определена";
  return `Открыто ${unlocked} из ${total} единиц техники`;
}

/** Процент с защитой от деления на ноль */
function percentOf(satisfied: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((satisfied / total) * 100)));
}

/* ------------------------------------------------------------------ */
/* Танковая рота: расчёт допуска                                       */
/* ------------------------------------------------------------------ */

/**
 * Более строгое из двух званий.
 *
 * Нужно там, где требование единицы техники может быть названо дважды: ступенью
 * матрицы и полем «мин. звание» реестра. Сравнение идёт по позиции в RANKS, а не
 * по алфавиту; неизвестное звание (index -1) требование не ослабляет — вернётся
 * известное.
 */
function stricterRank(a: Rank, b: Rank | null): Rank {
  if (!b) return a;
  return RANKS.indexOf(b) > RANKS.indexOf(a) ? b : a;
}

function buildTankReport(
  unit: string | null,
  rank: Rank | null,
  holderIndex: number
): Omit<VehicleAccessReport, "division" | "categories"> {
  const tiers: TankTierView[] = TANK_RANK_MATRIX.map((tier) => {
    const tierIndex = RANKS.indexOf(tier.rank);
    return {
      rank: tier.rank,
      unlocked: holderIndex >= tierIndex,
      vehicles: tier.vehicles.map((vehicle): VehicleCard => {
        /**
         * Порог единицы техники — не всегда порог ступени.
         *
         * У базовых машин требование задаёт ступень матрицы, но у части реестра
         * «мин. звание» названо прямо в карточке (Т-90М, Т-14). Порог берём как
         * более высокое из двух званий: если машину однажды переставят в другую
         * ступень, допуск не станет мягче случайно.
         */
        const thresholdRank = stricterRank(tier.rank, vehicle.requiredRank);
        const unlocked = holderIndex >= RANKS.indexOf(thresholdRank);

        if (unlocked) {
          return {
            vehicle,
            status: "unlocked",
            statusLabel: VEHICLE_STATUS_LABELS.unlocked,
            satisfied: [`звание ${thresholdRank}`],
            missing: [],
            unlocksAtRank: thresholdRank,
          };
        }
        return {
          vehicle,
          status: "locked",
          statusLabel: VEHICLE_STATUS_LABELS.lockedByRank,
          satisfied: rank ? [`звание ${rank}`] : [],
          missing: [`звание ${thresholdRank}`],
          unlocksAtRank: thresholdRank,
        };
      }),
    };
  });

  /**
   * Списки собираются по СОСТОЯНИЮ КАРТОЧКИ, а не по флагу ступени.
   *
   * Раньше делили по `tier.unlocked`, и это расходилось с тем, что показывает
   * интерфейс: внутри пройденной ступени машина может требовать более высокого
   * звания. Пример — Т-90М: он стоит в ступени «Лейтенант», но и «мин. звание»
   * у него названо отдельно, поэтому при звании ниже порога карточка честно
   * говорила «Требуется повышение», а список открытой техники относил его к
   * допущенной. Источник истины теперь один — status самой карточки.
   */
  const allCards = tiers.flatMap((tier) => tier.vehicles);
  const unlocked = allCards.filter((card) => card.status === "unlocked");
  const locked = allCards.filter((card) => card.status !== "unlocked");

  // Предпросмотр: ближайшая ступень выше текущего звания. Даже если выше есть
  // ступени с техникой, показываем именно следующую — бойцу важно знать, что
  // даст ближайшее повышение.
  const nextTier = nextTankTier(rank);
  const steps = nextTier ? Math.max(1, RANKS.indexOf(nextTier.rank)) : 1;
  const done = Math.max(0, Math.min(holderIndex, steps));
  const progress: VehicleProgress = nextTier
    ? {
        kind: "rank",
        next: nextTier.rank,
        satisfied: done,
        total: steps,
        percent: percentOf(done, steps),
        missing: [`звание ${nextTier.rank}`],
      }
    : { kind: "rank", next: null, satisfied: 1, total: 1, percent: 100, missing: [] };

  return {
    unit,
    rank,
    rankIndex: holderIndex,
    unlocked,
    locked,
    tiers,
    progress,
    summary: buildSummary(unlocked.length, unlocked.length + locked.length),
  };
}
/* ------------------------------------------------------------------ */
/* Артиллерия: расчёт допуска                                          */
/* ------------------------------------------------------------------ */

function buildArtilleryReport(
  unit: string | null,
  rank: Rank | null,
  qualifications: readonly string[]
): Omit<VehicleAccessReport, "division" | "tiers"> {
  const categories: ArtilleryCategoryView[] = ARTILLERY_CATEGORIES.map((category) => {
    const satisfied: string[] = [];
    const missing: string[] = [];

    for (const exam of category.required) {
      if (isQualificationPassed(exam, qualifications)) satisfied.push(exam.code);
      else missing.push(exam.code);
    }

    const unlocked = missing.length === 0;
    const statusLabel: VehicleStatusLabel = unlocked
      ? VEHICLE_STATUS_LABELS.unlocked
      : VEHICLE_STATUS_LABELS.lockedByExam;

    return {
      key: category.key,
      title: category.title,
      hint: category.hint,
      unlocked,
      statusLabel,
      satisfied,
      missing,
      vehicles: category.vehicles.map((vehicle): VehicleCard => ({
        vehicle,
        status: unlocked ? "unlocked" : "locked",
        statusLabel,
        satisfied,
        missing,
        unlocksAtRank: null,
      })),
    };
  });

  const unlockedCategories = categories.filter((category) => category.unlocked);
  const unlocked = unlockedCategories.flatMap((category) => category.vehicles);
  const locked = categories
    .filter((category) => !category.unlocked)
    .flatMap((category) => category.vehicles);

  // Ближайшая к открытию категория: у неё меньше всего несданных нормативов.
  const nearest = categories
    .filter((category) => !category.unlocked)
    .sort((a, b) => a.missing.length - b.missing.length)[0];

  return {
    unit,
    rank,
    rankIndex: rankIndex(rank),
    unlocked,
    locked,
    categories,
    progress: nearest
      ? {
          kind: "qualification",
          next: nearest.title,
          satisfied: unlockedCategories.length,
          total: categories.length,
          percent: percentOf(unlockedCategories.length, categories.length),
          missing: nearest.missing,
        }
      : {
          kind: "qualification",
          next: null,
          satisfied: categories.length,
          total: categories.length,
          percent: 100,
          missing: [],
        },
    summary: buildSummary(unlocked.length, unlocked.length + locked.length),
  };
}

/* ------------------------------------------------------------------ */
/* Публичная точка входа                                               */
/* ------------------------------------------------------------------ */

/**
 * Допуск бойца к технике.
 *
 * Возвращает открытую технику, запертую (с причиной и требуемым условием) и
 * прогресс до следующей ступени. Значения из БД и ШДС никогда не считаются
 * доверенными: подразделение и звание определяются по словарю, список
 * нормативов — по нормализованному сопоставлению. Неизвестное подразделение не
 * даёт доступа ни к чему: пустая матрица честнее «наугад выданной» техники.
 */
export function getAvailableVehicles(holder: VehicleHolder): VehicleAccessReport {
  const unit = holder.unit ? String(holder.unit).trim() || null : null;
  const rank = normalizeRank(holder.rank);
  const division = vehicleDivision(unit);
  const qualifications = (holder.qualifications ?? []).map((value) => String(value ?? ""));

  if (division === "tank") {
    const base = buildTankReport(unit, rank, rank ? RANKS.indexOf(rank) : -1);
    return { division, categories: [], ...base };
  }

  if (division === "artillery") {
    const base = buildArtilleryReport(unit, rank, qualifications);
    return { division, tiers: [], ...base };
  }

  return {
    division: "unknown",
    unit,
    rank,
    rankIndex: rank ? RANKS.indexOf(rank) : -1,
    unlocked: [],
    locked: [],
    tiers: [],
    categories: [],
    progress: {
      kind: "none",
      next: null,
      satisfied: 0,
      total: 0,
      percent: 0,
      missing: ["подразделение не назначено"],
    },
    summary: buildSummary(0, 0),
  };
}