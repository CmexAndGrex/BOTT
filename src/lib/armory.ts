/**
 * Домен «Арсенала» (/armory): пресеты выкладок, проверка структуры, строки для
 * ACE Arsenal и SQF.
 *
 * Модуль намеренно не зависит ни от БД, ни от Next.js, ни от Discord — как
 * recruits.ts и reports.ts: правила проверяются тестами напрямую
 * (tests/armory.test.ts) и используются одинаково в роутах и интерфейсе. Если
 * правило нужно и серверу, и форме — живёт здесь, а не копией в двух местах.
 *
 * Про ключи выкладки. В equipment_breakdown (jsonb) ключи записаны дословно так,
 * как описаны в задании: uniform, vest, helmet, backpack, primary_weapon,
 * secondary_weapon, medical, magazines, misc. Это внешний контракт: jsonb читают
 * инструменты помимо панели, поэтому «причёсывать» их под camelCase остального
 * кода нельзя — переименование тихо сломало бы тех, кто уже разбирает эти данные.
 *
 * Про строки для игры. Обе строки — дословные экспортные данные формата BI:
 *   * aceImportString — текст, который вставляется в ACE Arsenal (Ctrl+V в окне
 *     арсенала; Ctrl+C там же выгружает текущую выкладку в этом же виде);
 *   * sqfCode — массив для setUnitLoadout (Eden), при желании с обёрткой
 *     «player setUnitLoadout [...]».
 * Панель их не пересобирает: корректную выкладку знает только игра, поэтому
 * штаб вставляет экспорт, а модуль отвечает за гигиену текста (sanitizeACEImport)
 * и за проверку того, что это один корректный массив (validateSqfArray).
 */
import { isMemberRole, isStaffRole, type MemberRole } from "@/lib/recruits";
import { isPanelStaffRole } from "@/lib/validation";

/* ------------------------------------------------------------------ */
/* Подразделения                                                       */
/* ------------------------------------------------------------------ */

/**
 * Разделы каталога. Значения совпадают с вкладками фильтра в интерфейсе и с
 * названиями подразделений в recruits.ts (UNITS) там, где они пересекаются:
 * «Танковая рота» и «Артиллерийский дивизион» — те же строки, что и листы ШДС.
 * «Учебная часть» — комплекты КМБТ для новобранцев, «Общий» — то, что положено
 * всем (например, базовый набор медицины).
 */
export const ARMORY_DIVISIONS = [
  "Танковая рота",
  "Артиллерийский дивизион",
  "Учебная часть",
  "Общий",
] as const;

export type ArmoryDivision = (typeof ARMORY_DIVISIONS)[number];

export function isArmoryDivision(value: unknown): value is ArmoryDivision {
  return typeof value === "string" && (ARMORY_DIVISIONS as readonly string[]).includes(value);
}

/** Акцент карточки: интерфейс переводит его в цвет темы (emerald / amber / …) */
export type ArmoryAccent = "green" | "amber" | "blue" | "red";

/** Короткая подпись и акцент раздела — для бейджей на карточках */
export const ARMORY_DIVISION_META: Record<
  ArmoryDivision,
  { short: string; accent: ArmoryAccent }
> = {
  "Танковая рота": { short: "Танковая рота", accent: "green" },
  "Артиллерийский дивизион": { short: "Арт. дивизион", accent: "amber" },
  "Учебная часть": { short: "Учебная часть", accent: "blue" },
  Общий: { short: "Общий", accent: "red" },
};

/* ------------------------------------------------------------------ */
/* Ограничения полей                                                   */
/* ------------------------------------------------------------------ */

/** Границы длин и количеств: защита от «романа» в jsonb и от нечитаемой вёрстки */
export const ARMORY_TITLE_MIN = 3;
export const ARMORY_TITLE_MAX = 140;
export const ARMORY_CODE_MAX = 40;
export const ARMORY_DESCRIPTION_MAX = 2000;
export const ARMORY_SLOT_MAX = 160;
export const ARMORY_ITEM_NAME_MAX = 120;
export const ARMORY_ITEM_COUNT_MAX = 999;
export const ARMORY_LIST_MAX = 60;
export const ARMORY_MISC_MAX = 40;
/** Предел длины экспортной строки ACE Arsenal / SQF (в игре это одна строка) */
export const ARMORY_ARRAY_MAX = 8000;
/** Предел длины поискового запроса */
export const ARMORY_QUERY_MAX = 80;

/* ------------------------------------------------------------------ */
/* Структура выкладки                                                  */
/* ------------------------------------------------------------------ */

/** Позиция списка: название и количество («Bandage (basic)», 10) */
export type ArmoryItem = { name: string; count: number };

/**
 * Разобранная выкладка. Слоты-строки могут содержать как класснейм
 * («rhs_uniform_6b45»), так и человеческое описание — панель их не исполняет,
 * а показывает и копирует, поэтому жёсткой проверки на класснейм здесь нет.
 */
export type ArmoryEquipment = {
  uniform: string;
  vest: string;
  helmet: string;
  backpack: string | null;
  primary_weapon: string | null;
  secondary_weapon: string | null;
  medical: ArmoryItem[];
  magazines: ArmoryItem[];
  misc: string[];
};

/** Пустая выкладка: шаблон формы и безопасное значение по умолчанию */
export function emptyEquipment(): ArmoryEquipment {
  return {
    uniform: "",
    vest: "",
    helmet: "",
    backpack: null,
    primary_weapon: null,
    secondary_weapon: null,
    medical: [],
    magazines: [],
    misc: [],
  };
}

/** Убирает управляющие символы: они ломают и jsonb-выгрузку, и буфер обмена */
function stripControl(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Однострочный текст: управляющие символы, Unicode-пробелы, длина */
function clipText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return normalizeSpaces(stripControl(value)).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Многострочный текст: переносы сохраняем, но не больше двух подряд */
function clipMultiline(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return stripControl(value.replace(/\r\n?/g, "\n"))
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, max);
}

/**
 * Приводит все Unicode-пробелы к обычному пробелу.
 *
 * Неразрывный пробел (U+00A0) и узкие пробелы приезжают из мессенджеров и
 * Word-документов, с виду неотличимы от обычного, а класснейм в игре ломают:
 * предмет молча «не найден». В Arma класснейм вообще не может содержать пробел,
 * поэтому замена безопасна и видна офицеру сразу.
 */
function normalizeSpaces(value: string): string {
  return value.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ");
}

/** Количество приводится к целому в допустимых границах */
function clampCount(value: unknown): number {
  const raw = typeof value === "string" ? Number(value.trim()) : value;
  const count = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : Number.NaN;
  if (!Number.isFinite(count)) return 0;
  if (count < 1) return 1;
  return Math.min(count, ARMORY_ITEM_COUNT_MAX);
}

/** Разбирает список позиций ({name, count}) — терпимо, без исключений */
function readItemList(value: unknown, max: number): ArmoryItem[] {
  if (!Array.isArray(value)) return [];
  const out: ArmoryItem[] = [];
  for (const entry of value) {
    if (out.length >= max) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = clipText(record.name, ARMORY_ITEM_NAME_MAX);
    if (!name) continue;
    out.push({ name, count: clampCount(record.count) });
  }
  return out;
}

/** Разбирает список строк, попутно убирая дубли (порядок сохраняется) */
function readStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= max) break;
    const text = clipText(entry, ARMORY_ITEM_NAME_MAX);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Безопасное чтение выкладки из jsonb.
 *
 * Поле может содержать что угодно: записи прежних версий, ручные правки в psql,
 * мусор после неудачной миграции. Возвращаем строго типизированный объект,
 * иначе интерфейс падал бы на чтении свойства у undefined (та же логика, что у
 * readApplication в recruits.ts).
 */
export function readEquipment(value: unknown): ArmoryEquipment {
  if (!value || typeof value !== "object") return emptyEquipment();
  const raw = value as Record<string, unknown>;
  const backpack = clipText(raw.backpack, ARMORY_SLOT_MAX);
  const primary = clipText(raw.primary_weapon, ARMORY_SLOT_MAX);
  const secondary = clipText(raw.secondary_weapon, ARMORY_SLOT_MAX);
  return {
    uniform: clipText(raw.uniform, ARMORY_SLOT_MAX),
    vest: clipText(raw.vest, ARMORY_SLOT_MAX),
    helmet: clipText(raw.helmet, ARMORY_SLOT_MAX),
    backpack: backpack || null,
    primary_weapon: primary || null,
    secondary_weapon: secondary || null,
    medical: readItemList(raw.medical, ARMORY_LIST_MAX),
    magazines: readItemList(raw.magazines, ARMORY_LIST_MAX),
    misc: readStringList(raw.misc, ARMORY_MISC_MAX),
  };
}

export type ArmoryValidation<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Проверка структуры выкладки на входе (форма штаба, API).
 *
 * Требуем заполненные форму, разгрузку и шлем: комплект без СИБЗ — это ошибка
 * шаблона, а не «почти готовый» пресет. Позиции списков проверяются строго
 * (название и целое количество), потому что именно они уезжают бойцу в текстовый
 * табель и в SQF-фрагменты.
 */
export function validateEquipment(input: unknown): ArmoryValidation<ArmoryEquipment> {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Выкладка: ожидался объект с экипировкой и БК" };
  }
  const raw = input as Record<string, unknown>;

  const uniform = clipText(raw.uniform, ARMORY_SLOT_MAX);
  if (!uniform) return { ok: false, error: "Экипировка: заполните поле «Форма» (uniform)" };
  const vest = clipText(raw.vest, ARMORY_SLOT_MAX);
  if (!vest) return { ok: false, error: "Экипировка: заполните поле «Разгрузка» (vest)" };
  const helmet = clipText(raw.helmet, ARMORY_SLOT_MAX);
  if (!helmet) return { ok: false, error: "Экипировка: заполните поле «Шлем» (helmet)" };

  for (const field of ["medical", "magazines"] as const) {
    const list = raw[field];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      return { ok: false, error: `Список «${field}»: ожидался массив позиций { name, count }` };
    }
    if (list.length > ARMORY_LIST_MAX) {
      return { ok: false, error: `Список «${field}»: не больше ${ARMORY_LIST_MAX} позиций` };
    }
    for (const entry of list) {
      if (!entry || typeof entry !== "object") {
        return {
          ok: false,
          error: `Список «${field}»: позиция должна быть объектом { name, count }`,
        };
      }
      const record = entry as Record<string, unknown>;
      const name = clipText(record.name, ARMORY_ITEM_NAME_MAX);
      if (!name) {
        return { ok: false, error: `Список «${field}»: у позиции не заполнено название` };
      }
      const rawCount = record.count;
      const numeric = typeof rawCount === "string" ? Number(rawCount.trim()) : rawCount;
      if (
        typeof numeric !== "number" ||
        !Number.isInteger(numeric) ||
        numeric < 1 ||
        numeric > ARMORY_ITEM_COUNT_MAX
      ) {
        return {
          ok: false,
          error:
            `Список «${field}», позиция «${name}»: количество — целое число ` +
            `от 1 до ${ARMORY_ITEM_COUNT_MAX}`,
        };
      }
    }
  }

  const miscRaw = raw.misc;
  if (miscRaw !== undefined && miscRaw !== null) {
    if (!Array.isArray(miscRaw)) {
      return { ok: false, error: "Спецсредства: ожидался список строк (misc)" };
    }
    if (miscRaw.length > ARMORY_MISC_MAX) {
      return { ok: false, error: `Спецсредства: не больше ${ARMORY_MISC_MAX} позиций` };
    }
    for (const entry of miscRaw) {
      if (!clipText(entry, ARMORY_ITEM_NAME_MAX)) {
        return { ok: false, error: "Спецсредства: пустая позиция в списке (misc)" };
      }
    }
  }

  return {
    ok: true,
    data: {
      uniform,
      vest,
      helmet,
      backpack: clipText(raw.backpack, ARMORY_SLOT_MAX) || null,
      primary_weapon: clipText(raw.primary_weapon, ARMORY_SLOT_MAX) || null,
      secondary_weapon: clipText(raw.secondary_weapon, ARMORY_SLOT_MAX) || null,
      medical: readItemList(raw.medical, ARMORY_LIST_MAX),
      magazines: readItemList(raw.magazines, ARMORY_LIST_MAX),
      misc: readStringList(raw.misc, ARMORY_MISC_MAX),
    },
  };
}

/** Сколько позиций в выкладке — для бейджа на карточке каталога */
export function equipmentPositionCount(equipment: ArmoryEquipment): number {
  return equipment.medical.length + equipment.magazines.length + equipment.misc.length;
}

/** Краткая сводка «оружие · форма · разгрузка» — то, что видно на карточке */
export function equipmentSummary(equipment: ArmoryEquipment): string {
  return [
    equipment.primary_weapon || "без основного оружия",
    equipment.uniform,
    equipment.vest,
  ]
    .filter(Boolean)
    .join(" · ");
}

/* ------------------------------------------------------------------ */
/* Экспортные строки: чистка и лексическая проверка                    */
/* ------------------------------------------------------------------ */

/** Невидимые «маркеры»: по ним игра молча не находит класснейм */
const INVISIBLE_MARKERS = /[\u200b-\u200d\ufeff\u00ad]/g;
/** Управляющие символы, кроме перевода строки (его сохраняет SQF-строка) */
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;

/**
 * Чистка строки для ACE Arsenal (однострочный экспорт из игры).
 *
 * Что и зачем убираем:
 *   * управляющие символы и переносы — экспорт однострочный, а перевод строки
 *     при вставке в окно арсенала разрывает ввод;
 *   * невидимые маркеры (BOM, U+200B..U+200D, мягкий перенос) — из-за них
 *     сравнение класснеймов в игре не находит предмет, а на глаз строка выглядит
 *     совершенно целой;
 *   * угловые скобки — в класснеймах Arma их не бывает, зато в этом виде строка
 *     попадает в выгрузки (CSV, Embed, сторонний инструмент), где её отрисуют
 *     как разметку. В SQF-коде скобки сохранены отдельной чисткой ниже: там это
 *     операторы сравнения, а не данные;
 *   * длина — строка уезжает в буфер обмена, и «роман» на мегабайт подвесил бы
 *     вставку.
 *
 * Содержимое массива НЕ нормализуется: корректную выкладку знает только игра,
 * и любая наша «правка» формата её сломала бы. Чистим гигиену текста, не данные.
 */
export function sanitizeAceImportString(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeSpaces(
    value
      .replace(CONTROL_ALL, " ")
      .replace(INVISIBLE_MARKERS, "")
      .replace(/[<>]/g, "")
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ARMORY_ARRAY_MAX);
}

/** Чистка SQF-кода: многострочный, кавычки и операторы сравнения сохраняются */
export function sanitizeSqfCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeSpaces(value.replace(/\r\n?/g, "\n"))
    .replace(CONTROL_KEEP_NEWLINE, "")
    .replace(INVISIBLE_MARKERS, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, ARMORY_ARRAY_MAX);
}

export type SqfScanResult = { ok: true } | { ok: false; error: string };

/**
 * Лексическая проверка SQF-подобного текста.
 *
 * Ловит ровно то, что ломает вставку в Eden: лишние и незакрытые скобки,
 * незакрытый строковый литерал (в SQF двойная кавычка внутри строки
 * экранируется удвоением), отсутствие самого массива. Комментарии `// …` до
 * конца строки и всё, что стоит в кавычках, из подсчёта исключаются — иначе
 * русские названия и пояснения давали бы ложные срабатывания.
 *
 * Полноценный парсер SQF здесь не нужен и вреден: мы не исполняем код, а лишь не
 * даём сохранить заведомо битый массив (у бойца это «Error: Missing ]»).
 */
export function scanSqfSource(value: string): SqfScanResult {
  let depth = 0;
  let inString = false;
  let quote = '"';
  let inComment = false;
  let sawArray = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (inComment) {
      if (char === "\n") inComment = false;
      continue;
    }

    if (inString) {
      if (char === quote) {
        if (value[i + 1] === quote) {
          i++; // экранированная кавычка внутри строки
          continue;
        }
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "/" && value[i + 1] === "/") {
      inComment = true;
      i++;
      continue;
    }
    if (char === "[") {
      depth++;
      sawArray = true;
      continue;
    }
    if (char === "]") {
      depth--;
      if (depth < 0) return { ok: false, error: "лишняя закрывающая скобка «]»" };
    }
  }

  if (inString) return { ok: false, error: "незакрытая кавычка в строке" };
  if (depth !== 0) return { ok: false, error: "незакрытая скобка «[»" };
  if (!sawArray) return { ok: false, error: "в тексте нет массива «[…]»" };
  return { ok: true };
}

/** Проверка строки ACE Arsenal перед сохранением в шаблон */
export function validateAceImportString(input: unknown): ArmoryValidation<string> {
  const text = sanitizeAceImportString(input);
  if (!text) {
    return { ok: false, error: "Строка ACE Arsenal пуста: вставьте экспорт из игры (Ctrl+C)" };
  }
  if (!text.startsWith("[")) {
    return { ok: false, error: "Строка ACE Arsenal должна начинаться с «[»" };
  }
  const scan = scanSqfSource(text);
  if (!scan.ok) return { ok: false, error: `Строка ACE Arsenal: ${scan.error}` };
  return { ok: true, data: text };
}

/**
 * Допустимые символы SQF вне строк и комментариев.
 *
 * Так отсекается всё, что заведомо мусор в поле шаблона: markdown-обёртки,
 * неразрывные пробелы из мессенджеров, фигурные скобки из чужого языка. Список
 * намеренно широкий — это НЕ парсер: код в шаблон вставляет штаб, а панель лишь
 * не даёт сохранить строку, которая упадёт у бойца в Eden.
 */
const SQF_TOKEN_CHARS = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_[],;.:'\"+-*/=%<>!&|()#@ \t\n"
);

/** Посторонние символы вне строк и комментариев. Пустой список — код чистый */
function findForeignChars(value: string): string[] {
  const foreign = new Set<string>();
  let inString = false;
  let quote = '"';
  let inComment = false;
  let inBlockComment = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (inBlockComment) {
      if (char === "*" && value[i + 1] === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inComment) {
      if (char === "\n") inComment = false;
      continue;
    }
    if (inString) {
      if (char === quote) {
        if (value[i + 1] === quote) {
          i++;
          continue;
        }
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "/" && value[i + 1] === "/") {
      inComment = true;
      i++;
      continue;
    }
    if (char === "/" && value[i + 1] === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (!SQF_TOKEN_CHARS.has(char)) foreign.add(char);
  }

  return [...foreign];
}

/**
 * Проверка SQF перед сохранением в шаблон.
 *
 * Принимается и «голый» массив выкладки, и готовый код с префиксом
 * (`player setUnitLoadout […]`, `[_unit, …] call …`): офицер вставляет именно ту
 * строку, которой пользуется в редакторе, и заставлять его вырезать массив
 * руками — верный способ получить в шаблоне половину выражения. Поэтому вместо
 * «начинается с [» проверяется, что в тексте есть массив, скобки и кавычки
 * сбалансированы, а посторонних символов вне строк нет.
 */
export function validateSqfArray(input: unknown): ArmoryValidation<string> {
  const text = sanitizeSqfCode(input);
  if (!text) return { ok: false, error: "SQF пуст: вставьте массив выкладки" };

  const scan = scanSqfSource(text);
  if (!scan.ok) return { ok: false, error: `SQF: ${scan.error}` };

  const foreign = findForeignChars(text);
  if (foreign.length > 0) {
    return {
      ok: false,
      error: `SQF: недопустимые символы вне строк и комментариев: ${foreign.join(" ")}`,
    };
  }
  return { ok: true, data: text };
}

/* ------------------------------------------------------------------ */
/* SQF: упаковка значений и готовые обёртки                            */
/* ------------------------------------------------------------------ */

/** Строка в SQF: кавычка экранируется удвоением, обратный слэш — сам */
export function sqfString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '""')}"`;
}

/** Массив строк SQF: пустые значения и null превращаются в nil (позиция важна) */
export function sqfStringArray(values: readonly (string | null | undefined)[]): string {
  const parts = values.map((value) => (value ? sqfString(value) : "nil"));
  return `[${parts.join(", ")}]`;
}

/**
 * Готовый к вставке в Eden фрагмент.
 *
 * Кнопка «Скопировать SQF (Eden)» отдаёт сохранённую строку шаблона, но если это
 * «голый» массив, в редакторе он ничего не сделает: оборачиваем в
 * `player setUnitLoadout …;`. Уже готовую строку с оператором не трогаем — иначе
 * получилось бы «player setUnitLoadout player setUnitLoadout …».
 */
export function sqfForEden(code: string): string {
  const text = code.trim();
  if (!text || !text.startsWith("[")) return text;
  return `player setUnitLoadout ${text};`;
}

/** Обёртка «выдать эту же выкладку другому бойцу»: `[_unit, …] call …setLoadout` */
export function sqfForUnit(code: string): string {
  const text = code.trim();
  if (!text || !text.startsWith("[")) return text;
  return `[_unit, ${text}] call ace_arsenal_fnc_setLoadout;`;
}

/* ------------------------------------------------------------------ */
/* Текстовый табель                                                    */
/* ------------------------------------------------------------------ */

/** Пояснения к типовым спецсредствам — попадают в текстовый табель */
const MISC_HINTS: Record<string, string> = {
  Radio: "проверить канал взвода",
  NVG: "крепление и запас батарей",
  GPS: "включить до выхода",
  Watch: "синхронизировать по МСК",
  Map: "отметки обстановки",
  Binoculars: "дальномер — проверить батарею",
  Compass: "сверить азимут",
};

/** Строка списка с количеством: «Bandage (basic) × 10» */
function itemLine(item: ArmoryItem): string {
  return `${item.name} × ${item.count}`;
}

export type TextChecklistInput = {
  title: string;
  division: string;
  specialtyCode?: string | null;
  description?: string | null;
  equipment: ArmoryEquipment;
};

/**
 * Текстовый табель: читаемый чек-лист для распечатки и переписки.
 *
 * Пустые части помечаются прочерком, а не выбрасываются: бойцу важно видеть, что
 * позиция «не выдаётся», а не догадываться, забыли её или нет. Переводы строк —
 * только `\n`: значение уходит в буфер обмена и в файлы, где CR из `\r\n` попал бы
 * в diff и в чек-лист на печать.
 */
export function buildTextChecklist(input: TextChecklistInput): string {
  const { equipment } = input;
  const lines: string[] = [];

  lines.push(`ТАБЕЛЬ ВЫКЛАДКИ — ${input.title}`);
  lines.push(`Подразделение: ${input.division}`);
  if (input.specialtyCode) lines.push(`Код специальности: ${input.specialtyCode}`);
  if (input.description) {
    lines.push("");
    lines.push("Пояснение:");
    for (const line of input.description.split("\n")) lines.push(`  ${line}`);
  }

  lines.push("");
  lines.push("1. ЭКИПИРОВКА И СИБЗ");
  lines.push(`   Форма:              ${equipment.uniform || "—"}`);
  lines.push(`   Разгрузка:          ${equipment.vest || "—"}`);
  lines.push(`   Шлем:               ${equipment.helmet || "—"}`);
  lines.push(`   Рюкзак:             ${equipment.backpack || "не выдаётся"}`);

  lines.push("");
  lines.push("2. ВООРУЖЕНИЕ И БК");
  lines.push(`   Основное:           ${equipment.primary_weapon || "не выдаётся"}`);
  lines.push(`   Дополнительное:     ${equipment.secondary_weapon || "не выдаётся"}`);
  lines.push(`   Магазины:           ${equipment.magazines.length === 0 ? "—" : ""}`.trimEnd());
  for (const item of equipment.magazines) lines.push(`     - ${itemLine(item)}`);

  lines.push("");
  lines.push("3. МЕДИЦИНА ACE3 И СПЕЦСРЕДСТВА");
  lines.push(`   Медицина:           ${equipment.medical.length === 0 ? "—" : ""}`.trimEnd());
  for (const item of equipment.medical) lines.push(`     - ${itemLine(item)}`);
  lines.push(`   Спецсредства:       ${equipment.misc.length === 0 ? "—" : ""}`.trimEnd());
  for (const item of equipment.misc) {
    const hint = MISC_HINTS[item];
    lines.push(`     - ${item}${hint ? ` (${hint})` : ""}`);
  }

  lines.push("");
  lines.push("Проверка перед выездом: СИБЗ по размеру, БК по норме, медицина в разгрузке.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Доступ                                                              */
/* ------------------------------------------------------------------ */

/**
 * Кто видит каталог «Арсенала».
 *
 * Комплекты — не персональные данные и не тактическая тайна, поэтому смотреть их
 * может любой вошедший: и боец из кабинета, и сотрудник панели. Проверка живёт
 * здесь, а не в роуте, потому что то же решение принимает интерфейс: скрывать
 * кнопки должен тот же предикат, что и отказывать в API.
 */
export function canViewArmory(input: {
  memberRole?: unknown;
  memberStatus?: unknown;
  panelRole?: unknown;
}): boolean {
  if (isPanelStaffRole(input.panelRole)) return true;
  if (!isMemberRole(input.memberRole)) return false;
  // Рапорт на рассмотрении и исключённый боец доступа в систему не имеют
  return input.memberStatus !== "pending" && input.memberStatus !== "dismissed";
}

/**
 * Кто правит шаблоны: командир или администратор — из панели либо из кабинета.
 * Роль бойца при этом сверяется со статусом: «командир» со отклонённым рапортом
 * доступ к мутациям не получает.
 */
export function canManageArmory(input: {
  memberRole?: unknown;
  memberStatus?: unknown;
  panelRole?: unknown;
}): boolean {
  if (isPanelStaffRole(input.panelRole)) return true;
  if (!isMemberRole(input.memberRole)) return false;
  if (input.memberStatus === "pending" || input.memberStatus === "dismissed") return false;
  return isStaffRole(input.memberRole as MemberRole);
}

/* ------------------------------------------------------------------ */
/* Поиск и фильтры каталога                                            */
/* ------------------------------------------------------------------ */

/** Приводит поисковый запрос к каноническому виду: регистр не важен, пробелы сжаты */
export function normalizeQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, ARMORY_QUERY_MAX).toLocaleLowerCase("ru-RU");
}

/**
 * Совпадает ли шаблон с поисковым запросом.
 *
 * Ищем и по названию, и по выкладке: бойцу проще вспомнить «Грач», «6Б45» или
 * «CAT», чем полное название комплекта. Строка из экспорта в поиск НЕ входит —
 * она попадала бы в совпадение по любому класснейму и делала бы выдачу случайной.
 */
export function matchesQuery(
  loadout: {
    title: string;
    specialtyCode?: string | null;
    description?: string | null;
    equipment: ArmoryEquipment;
  },
  query: unknown
): boolean {
  const needle = normalizeQuery(query);
  if (!needle) return true;

  const haystack = [
    loadout.title,
    loadout.specialtyCode || "",
    loadout.description || "",
    loadout.equipment.uniform,
    loadout.equipment.vest,
    loadout.equipment.helmet,
    loadout.equipment.backpack || "",
    loadout.equipment.primary_weapon || "",
    loadout.equipment.secondary_weapon || "",
    ...loadout.equipment.medical.map((item) => item.name),
    ...loadout.equipment.magazines.map((item) => item.name),
    ...loadout.equipment.misc,
  ]
    .join(" \u0000 ")
    .toLocaleLowerCase("ru-RU");

  return haystack.includes(needle);
}

/* ------------------------------------------------------------------ */
/* Шаблон целиком: проверка полей карточки                             */
/* ------------------------------------------------------------------ */

export type ArmoryTemplateInput = {
  title: string;
  division: ArmoryDivision;
  specialtyCode: string | null;
  description: string | null;
  equipment: ArmoryEquipment;
  aceImportString: string;
  sqfCode: string;
  createdBy: string | null;
  isActive: boolean;
};

export type ArmoryTemplateBody = {
  id?: unknown;
  title?: unknown;
  division?: unknown;
  specialty_code?: unknown;
  specialtyCode?: unknown;
  description?: unknown;
  equipment_breakdown?: unknown;
  equipmentBreakdown?: unknown;
  ace_import_string?: unknown;
  aceImportString?: unknown;
  sqf_code?: unknown;
  sqfCode?: unknown;
  is_active?: unknown;
  isActive?: unknown;
};

/**
 * Разбор тела запроса в шаблон (POST /api/admin/armory).
 *
 * Принимаются оба написания полей — snake_case из ТЗ (так поля называются в API
 * и в выгрузке) и camelCase из интерфейса: форма отправляет camelCase, а внешние
 * интеграции — snake_case, и заставлять их угадывать не нужно. Значения по
 * умолчанию безопасные: неактивный шаблон лучше случайно опубликованного.
 */
export function validateArmoryTemplate(
  body: ArmoryTemplateBody,
  fallbackCreatedBy: string | null
): ArmoryValidation<ArmoryTemplateInput> {
  const title = clipText(body.title, ARMORY_TITLE_MAX);
  if (title.length < ARMORY_TITLE_MIN) {
    return { ok: false, error: `Название: минимум ${ARMORY_TITLE_MIN} символа` };
  }

  if (!isArmoryDivision(body.division)) {
    return {
      ok: false,
      error: `Подразделение: допустимы ${ARMORY_DIVISIONS.join(", ")}`,
    };
  }

  const equipment = validateEquipment(body.equipment_breakdown ?? body.equipmentBreakdown);
  if (!equipment.ok) return equipment;

  const ace = validateAceImportString(body.ace_import_string ?? body.aceImportString);
  if (!ace.ok) return ace;

  const sqf = validateSqfArray(body.sqf_code ?? body.sqfCode);
  if (!sqf.ok) return sqf;

  const rawActive = body.is_active ?? body.isActive;
  const isActive = rawActive === undefined || rawActive === null ? true : rawActive === true;

  return {
    ok: true,
    data: {
      title,
      division: body.division,
      specialtyCode: clipText(body.specialty_code ?? body.specialtyCode, ARMORY_CODE_MAX) || null,
      description:
        clipMultiline(body.description, ARMORY_DESCRIPTION_MAX) || null,
      equipment: equipment.data,
      aceImportString: ace.data,
      sqfCode: sqf.data,
      createdBy: fallbackCreatedBy,
      isActive,
    },
  };
}