/**
 * Google Таблица (ШДС) — клиент и алгоритмы из ТЗ.
 * Сервисный аккаунт («паспорт») берётся из настроек панели
 * (ключ gsheet_service_account — JSON-текст) либо из файла-паспорта
 * src/lib/google-service-account.json.
 */
import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { getSettings } from "@/lib/settings";
// Справочник секций и проверка требований ступени живут в домене рапортов
// (reports.ts): там же их читает форма подачи, поэтому «секция рапорта» и
// «блок строк листа» не могут разойтись. Обратной зависимости нет — reports.ts
// не импортирует gsheets.ts, цикла не возникает.
import {
  examColumnTokens,
  missingSectionExams,
  type ShdsSection,
  POSITION_SECTIONS,
  examCatalog,
} from "@/lib/reports";
import { normalizePersonName } from "@/lib/recruits";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Названия операций поля «Редакция ШДС» */
export const SHDS_ACTIONS = {
  ADD: "Добавление в ШДС",
  RANK: "Изменение звания",
  POST: "Перенос и зачистка (должность)",
  EXAM: "Получение подтверждения об экзаменации",
  REMOVE: "Убрать из таблицы",
  RESERVE_GO: "Уход в запас",
  RESERVE_BACK: "Возврат из запаса",
} as const;

export type ShdsAction = (typeof SHDS_ACTIONS)[keyof typeof SHDS_ACTIONS];

/** Структура разобранной заявки (вебхук → текст) */
export type ParsedRequest = {
  raw: string;
  isVacation: boolean;
  vacationRemove: boolean; // «Снять отпуск» вместо выдачи
  shdsAction: ShdsAction | null;
  unit: string;          // «Подразделение» — имя листа
  userName: string;      // «Имя пользователя»
  rank: string;          // «Звание»
  steamId: string;       // «Steam ID»
  discordId: string;     // «Discord ID»
  отделение: string;     // «Отделение» (Артиллерийский дивизион)
  должность: string;     // «Должность»
  exams: string[];       // «Сданные экзамены»
  grade: string;         // «Оценка» (КМБТ — без оценки)
  /**
   * Оценка КАЖДОГО норматива рапорта: {code, grade} из payload рапорта.
   *
   * Нужно потому, что панель позволяет указать свою оценку каждому нормативу
   * (пакетный рапорт на экзамены), а поле «Оценка» одно. Без этого списка одна
   * оценка уезжала бы во все столбцы блока: закрасили пять нормативов — и все
   * пять получили «Отлично». Пустой список — работаем по полю `grade`.
   */
  examGrades?: { code: string; grade?: string }[];
  examiner: string;      // «Экзаменатор» (Фамилия И.О.)
  rolesGive: string;     // «Роли выдать» (через запятую)
  rolesRemove: string;   // «Роли снять» (через запятую)
  vacationDates: string; // «Даты отпуска»
  reason: string;        // «Причина»
};

/** Разбор текста вебхук-заявки на поля */
export function parseRequestText(text: string): ParsedRequest | null {
  const clean = (s: string) => (s || "").trim();
  const field = (name: string): string => {
    const m = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "im"));
    return m ? clean(m[1]) : "";
  };

  const userName = field("Имя пользователя");
  if (!userName) return null;

  const unit = field("Подразделение");
  const shdsRaw = field("Редакция ШДС");
  const vacationRaw = field("Тип заявки");
  const vacationAll = `${shdsRaw} ${vacationRaw}`;
  const isVacation = /отпуск/i.test(vacationAll) && !/запас/i.test(shdsRaw);
  // «Снять отпуск» / «Окончание отпуска» / «Выход из отпуска» — снятие статуса
  const vacationRemove =
    isVacation && /снять|снятие|отмен|окончан|выход|заверш/i.test(vacationAll);

  let shdsAction: ShdsAction | null = null;
  if (shdsRaw) {
    const low = shdsRaw.toLowerCase();
    if (/возврат|вернуться|вернуть/i.test(low) && /запас/.test(low)) shdsAction = SHDS_ACTIONS.RESERVE_BACK;
    else if (low.includes("запас")) shdsAction = SHDS_ACTIONS.RESERVE_GO;
    else if (low.includes("добавление")) shdsAction = SHDS_ACTIONS.ADD;
    // Стеммы, а не полные слова: в заявках эти операции пишут в родительном
    // падеже («Изменение зван-ия», «Изменение должност-и»), поэтому поиск
    // подстрок «звание»/«должность» не находил совпадения и заявка молча
    // оставалась без действия (shdsAction = null).
    else if (low.includes("звани")) shdsAction = SHDS_ACTIONS.RANK;
    else if (low.includes("должност")) shdsAction = SHDS_ACTIONS.POST;
    else if (low.includes("экзамен")) shdsAction = SHDS_ACTIONS.EXAM;
    else if (low.includes("убрать")) shdsAction = SHDS_ACTIONS.REMOVE;
  }

  // Для операций с таблицей подразделение обязательно (это имя листа)
  if (shdsAction && !unit) return null;

  const examsRaw = field("Сданные экзамены");
  const exams = examsRaw
    ? examsRaw.split(/[,;]/).map((x) => clean(x)).filter(Boolean)
    : [];

  return {
    raw: text,
    isVacation,
    vacationRemove,
    shdsAction,
    unit,
    userName,
    rank: field("Звание"),
    steamId: field("Steam ID"),
    discordId: field("Discord ID").replace(/[^\d]/g, ""),
    отделение: field("Отделение"),
    должность: field("Должность"),
    exams,
    grade: field("Оценка"),
    examiner: field("Экзаменатор"),
    rolesGive: field("Роли выдать"),
    rolesRemove: field("Роли снять"),
    vacationDates: field("Даты отпуска"),
    reason: field("Причина"),
  };
}

/* ------------------------------------------------------------------ */
/* Авторизация и доступ к таблице                                      */
/* ------------------------------------------------------------------ */

/** Читаем «паспорт» сервисного аккаунта из настроек или файла */
async function loadServiceAccount(): Promise<Record<string, unknown>> {
  const map = await getSettings();
  const raw = (map.get("gsheet_service_account") || "").trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Не удалось разобрать JSON сервисного аккаунта из настроек");
    }
  }
  try {
    const p = path.join(process.cwd(), "src", "lib", "google-service-account.json");
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error(
      "Не найден «паспорт» сервисного аккаунта: заполните настройку gsheet_service_account или создайте файл src/lib/google-service-account.json"
    );
  }
}

let cachedDoc: { id: string; doc: GoogleSpreadsheet } | null = null;

/**
 * Области доступа сервисного аккаунта: таблицы (чтение и запись).
 * drive.file нужен только для операций с файлом (метаданные/шаринг) и
 * запрашивается отдельно, чтобы не расширять права без необходимости.
 */
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

/**
 * Собирает авторизацию для Google API из «паспорта» сервисного аккаунта.
 * В google-spreadsheet v5 метод useServiceAccountAuth удалён — вместо него
 * передаётся google-auth-library JWT прямо в конструктор документа.
 */
function buildServiceAccountAuth(creds: Record<string, unknown>): JWT {
  const email =
    typeof creds.client_email === "string" ? creds.client_email.trim() : "";
  const key = typeof creds.private_key === "string" ? creds.private_key : "";
  if (!email || !key) {
    throw new Error(
      "В «паспорте» сервисного аккаунта отсутствует client_email или private_key"
    );
  }
  // В настройках панели и .env переносы строк ключа иногда экранированы как \n
  return new JWT({
    email,
    key: key.replace(/\\n/g, "\n"),
    scopes: GOOGLE_SCOPES,
  });
}

/** Документ Google Таблицы по ID из настроек (с кэшем авторизации) */
export async function getDoc(): Promise<GoogleSpreadsheet> {
  const map = await getSettings();
  const id = (map.get("gsheet_spreadsheet_id") || "").trim();
  if (!id) throw new Error("Не задан ID Google-таблицы (настройка gsheet_spreadsheet_id)");
  if (cachedDoc && cachedDoc.id === id) return cachedDoc.doc;

  const creds = await loadServiceAccount();
  const auth = buildServiceAccountAuth(creds);
  // v5: авторизация передаётся вторым аргументом конструктора
  const doc = new GoogleSpreadsheet(id, auth);
  await doc.loadInfo();
  cachedDoc = { id, doc };
  return doc;
}

/** Лист по названию подразделения (название листа = «Подразделение») */
export async function getSheet(unit: string): Promise<GoogleSpreadsheetWorksheet> {
  const doc = await getDoc();
  const target = unit.trim().toLowerCase();
  const sheets = Object.values(doc.sheetsById) as GoogleSpreadsheetWorksheet[];
  const sheet = sheets.find((s) => (s.title || "").trim().toLowerCase() === target);
  if (!sheet) throw new Error(`Лист «${unit}» не найден в таблице`);
  return sheet;
}

/* ------------------------------------------------------------------ */
/* Константы раскладки ШДС (по ТЗ)                                     */
/* ------------------------------------------------------------------ */

/**
 * Блок строк листа с одной должностью.
 *
 * `post` — значение, которое обязано стоять в колонке «Должность» (D у роты,
 * E у дивизиона) у строк ЭТОГО блока. Нужно в двух местах: при зачислении
 * (если боец не указал должность, пишется штатная должность секции) и при
 * зачистке освободившейся строки (вместо пустой ячейки возвращается дефолт).
 */
export type PostBlock = {
  /** Границы блока (1-based, включительно) */
  top: number;
  bottom: number;
  /** Должность блока: она же дефолт для освободившихся строк */
  post: string;
};

export type UnitLayout = {
  key: "TR" | "AD";
  nameCol: string;                              // колонка имени / «Вакант»
  overall: { top: number; bottom: number };     // общий диапазон поиска имени
  addRange: { top: number; bottom: number };    // «Добавление в ШДС»
  postRanges: { match: RegExp; top: number; bottom: number }[]; // «Изменение должности»
  /**
   * Должности по блокам строк, включая те, что не назначаются рапортом бойца
   * (командирские). Используются для дефолтной должности при зачислении и при
   * возврате строки в состояние «Вакант».
   */
  defaultPosts: PostBlock[];
  examHeaderRow: number;                        // строка с названиями экзаменов
  /**
   * Первая колонка блока оценок листа.
   *
   * У роты блок экзаменов начинается с «H», у дивизиона — с «I»: служебных
   * столбцов слева у листов разное число, и общая константа на оба листа
   * сдвигала бы оценки на колонку (оценка уезжала бы в чужой столбец, а
   * «сдан» появлялся бы у соседнего норматива).
   */
  examStartCol: string;
  /**
   * Последняя колонка блока оценок — она же конец «строки целиком».
   *
   * У роты это «AE» (24 столбца экзаменов), у дивизиона «AG» (25). Границы
   * нужны и для закраски, и для переноса строки: всё, что правее, в листе
   * относится к служебным пометкам и копированию не подлежит.
   */
  examEndCol: string;
};

const LAYOUTS: Record<"TR" | "AD", UnitLayout> = {
  // Танковая рота (колонка C)
  TR: {
    key: "TR",
    nameCol: "C",
    /**
     * Поиск идёт до 100-й строки: строки ниже учебного отделения тоже относятся
     * к листу, и обрезка по 56-й теряла бойца, добавленного вручную ниже блока
     * (ошибка «Боец … не найден» при существующей строке).
     */
    overall: { top: 10, bottom: 100 },
    addRange: { top:  42, bottom: 56 },
    postRanges: [
      { match: /логист|снабжен/i, top: 42, bottom: 56 },
      { match: /мех.?водител/i, top: 28, bottom: 40 },
      { match: /наводчик/i, top: 21, bottom: 26 },
      { match: /командир/i, top: 10, bottom: 19 },
    ],
    defaultPosts: [
      // Учебное отделение и логисты: строки 42–56 по ТЗ. Должность составная —
      // «Логист-снабженец/резерв»: боец зачисляется в резерв отделения
      { top: 42, bottom: 56, post: "Логист-снабженец/резерв" },
      { top: 28, bottom: 41, post: "Специалист Мех.водитель" },
      { top: 20, bottom: 27, post: "Специалист Наводчик-Оператор" },
      { top: 10, bottom: 19, post: "КБМ" },
      { top:  6, bottom:  9, post: "Командование" },
    ],
    examHeaderRow: 6,
    // Блок оценок роты: столбцы H–AE (24 норматива — от КМБТ до «Берет»)
    examStartCol: "H",
    examEndCol: "AE",
  },
  // Артиллерийский дивизион (колонка C — та же раскладка, что у роты)
  AD: {
    key: "AD",
    nameCol: "C",
    /**
     * Общий диапазон поиска — до 100-й строки, а не до 41-й.
     *
     * Раньше здесь стоял bottom: 41 (блок снабжения), и всё, что ниже, лист
     * просто не читал: боец, чья строка оказалась дальше (ручная правка,
     * добавленные отделения), не находился — «Боец Розгов А.В. не найден».
     * Блоки для зачисления по-прежнему ограничены postRanges/defaultPosts,
     * поэтому расширение поиска не даёт зачислять в чужие секции.
     */
    overall: { top: 12, bottom: 100 },
    addRange: { top: 32, bottom: 41 },
    postRanges: [
      { match: /снабжен/i, top: 32, bottom: 41 },
      { match: /1\s*оов/i, top: 12, bottom: 20 },
      { match: /2\s*оов/i, top: 22, bottom: 30 },
    ],
    defaultPosts: [
      // Строки 32–41 — блок снабжения дивизиона (диапазон добавления по ТЗ)
      { top: 32, bottom: 41, post: "Логист-снабженец" },
      { top: 12, bottom: 20, post: "1 ООВ" },
      { top: 22, bottom: 30, post: "2 ООВ" },
    ],
    examHeaderRow: 8,
    // Блок оценок дивизиона: столбцы I–AG (25 нормативов — от КМБТ до «Берет»)
    examStartCol: "I",
    examEndCol: "AG",
  },
};

/**
 * Штатная должность блока, в котором стоит строка.
 *
 * Пустая строка — блок не описан в раскладке: подставлять «на глаз» чужую
 * должность нельзя, иначе освободившаяся строка получит должность соседнего
 * отделения и следующий зачисленный боец встанет не туда.
 */
export function defaultPostFor(layout: UnitLayout, row: number): string {
  const block = layout.defaultPosts.find((b) => row >= b.top && row <= b.bottom);
  return block?.post ?? "";
}

/**
 * Звание для записи в лист.
 *
 * «Курсант» — звание до принятия присяги: в ШДС его не пишут, вместо него
 * ставится «Рядовой». Пустое звание из формы по той же причине не оставляет
 * ячейку пустой — иначе строка выглядит незаполненной.
 */
export function sheetRank(rank: unknown): string {
  const value = String(rank ?? "").trim();
  if (!value || /^курсант$/i.test(value)) return DEFAULT_SHEET_RANK;
  return value;
}

/** Раскладка подразделения по названию листа */
export function resolveLayout(unit: string): UnitLayout {
  const u = unit.toLowerCase();
  if (/танк/.test(u)) return LAYOUTS.TR;
  if (/дивизион|артиллер/.test(u)) return LAYOUTS.AD;
  throw new Error(
    `Неизвестное подразделение «${unit}»: ожидались «Танковая рота» или «Артиллерийский дивизион»`
  );
}

/** Первая колонка строки ШДС: границы «строки целиком» начинаются с A */
const ROW_START_COL = "A";

/**
 * Последняя колонка ПОЛНОЙ строки ШДС — «AG» (индекс 32, всего 33 колонки A..AG).
 *
 * Почему не конец блока оценок листа: у роты оценки кончаются на «AE», у
 * дивизиона — на «AG», и обрезка снапшота по блоку оценок ТЕРЯЛА хвост строки
 * (у роты это последние нормативы — уставы, ПВО, БПЛА, береты). Снапшот строки
 * бойца при переводе в запас обязан забирать строку целиком, поэтому его
 * правая граница — общая для обоих листов колонка «AG», а не examEndCol.
 *
 * Копирование строки ВНУТРИ листа (copyRow) по-прежнему идёт по examEndCol:
 * правее блока оценок у листа лежат служебные пометки, и переносить их вместе
 * со строкой бойца нельзя.
 */
export const FULL_ROW_END_COL = "AG";

/** Индекс колонки «AG» (0-based): 32 */
export const FULL_ROW_END_INDEX = colIndex(FULL_ROW_END_COL);

/** Длина полной строки ШДС в колонках: A..AG — 33 */
export const FULL_ROW_COL_COUNT = FULL_ROW_END_INDEX + 1;

/**
 * Гарантирует, что у листа есть хотя бы `minColumns` колонок.
 *
 * Зачем: лист «Запас» пишет строку бойца целиком (A..AG) и служебные колонки
 * AH..AJ, а свежесозданный лист Google даёт всего 26 колонок. Без расширения
 * сетки `getCell` падал бы с «Out of bounds», и перевод в запас ломался бы на
 * первом же бойце. Уже существующий лист со старым (узким) снапшотом
 * расширяется здесь же — данные при этом не теряются.
 */
export async function ensureColumnCount(
  sheet: GoogleSpreadsheetWorksheet,
  minColumns: number
): Promise<void> {
  if (sheet.columnCount >= minColumns) return;
  await sheet.resize({ rowCount: sheet.rowCount, columnCount: minColumns });
}

/**
 * Блок оценок листа: с какой колонки начинаются экзамены и на какой кончаются.
 *
 * Границы берутся из РАСКЛАДКИ листа (examStartCol / examEndCol в LAYOUTS), а не
 * из общей константы: у роты блок идёт с «H» по «AE» (24 столбца), у дивизиона —
 * с «I» по «AG» (25). Общая константа сдвигала бы оценки на колонку, и «сдано»
 * появлялось бы у соседнего норматива, а оценка уезжала бы в чужой столбец.
 *
 * Раскладка строки (одинаковая у роты и дивизиона):
 *   * A — служебная;
 *   * B — Звание (строго слева от фамилии);
 *   * C — Фамилия И. О. / позывной;
 *   * D — Должность;
 *   * E — Steam ID;
 *   * F — Discord ID;
 *   * G — «Для пометок» / «Заметки»;
 *   * далее (H/I)..AE/AG — сданные экзамены: оценка в ячейке и зелёная заливка.
 *
 * Отсюда же берётся и колонка имени (nameCol в LAYOUTS = «C») у ОБОИХ листов:
 * у дивизиона она раньше была «D», и всё, что писалось рядом (должность, Steam,
 * Discord), уезжало на колонку вправо — заявка «одобрялась», а в таблице данные
 * вставали не в свои столбцы.
 */
export function examBounds(layout: UnitLayout): { start: number; end: number } {
  return { start: colIndex(layout.examStartCol), end: colIndex(layout.examEndCol) };
}

/**
 * Цвет имени бойца в строю (колонка C): стандартный зелёный Google Sheets #6aa84f.
 * Эталон — строка 43 «Петров М. С.» листа «Танковая рота».
 */
const NAME_GREEN = { red: 0.4157, green: 0.6588, blue: 0.3098, alpha: 1 };

/**
 * Цвет сданного экзамена и берета: ярко-зелёный #00ff00.
 * Используется для всех ячеек блока оценок (H..AE / I..AG) и столбца «Берет».
 */
const EXAM_GREEN = { red: 0, green: 1, blue: 0, alpha: 1 };

/** Белая заливка освободившейся строки: фон «Вакант» */
const VACANT_WHITE = { red: 1, green: 1, blue: 1, alpha: 1 };

/** Серая заливка неприменимых/закрытых дисциплин: светло-серый #d9d9d9 */
const DISABLED_GRAY = { red: 0.85, green: 0.85, blue: 0.85, alpha: 1 };

/** Звание по умолчанию для листа: «Курсант» в ШДС не пишется */
const DEFAULT_SHEET_RANK = "Рядовой";

/**
 * Сплошная тонкая чёрная линия.
 *
 * Стиль задан явно, а не «как в соседней строке»: при copyPaste формата рамки
 * переносятся, но стоит одному блоку потерять их (ручная правка, вставка строк
 * из другого файла) — и разделители исчезают по всему диапазону, потому что
 * каждая следующая строка копирует формат предыдущей.
 */
const SOLID_BLACK_BORDER = {
  style: "SOLID" as const,
  color: { red: 0, green: 0, blue: 0 },
  width: 1,
};

/** Цвет заливки в формате Google Sheets */
type CellColor = { red: number; green: number; blue: number; alpha?: number };

/* ------------------------------------------------------------------ */
/* Помощники работы с ячейками                                         */
/* ------------------------------------------------------------------ */

/** Индекс колонки: A=0, B=1, ... */
function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Буква колонки по индексу (0 → A) */
function colLetter(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type Cell = ReturnType<GoogleSpreadsheetWorksheet["getCell"]>;

/** Ячейка по номеру строки (1-based) и букве колонки */
function cellAt(sheet: GoogleSpreadsheetWorksheet, row: number, col: string): Cell {
  return sheet.getCell(row - 1, colIndex(col));
}

/** Стандартный формат ШДС: Times New Roman, жирный, 12, по центру */
function applyStdFormat(cell: Cell) {
  cell.textFormat = { fontFamily: "Times New Roman", bold: true, fontSize: 12 };
  cell.horizontalAlignment = "CENTER";
}

/**
 * Индекс колонки по букве (A → 0).
 *
 * Экспортируется для модулей, которым нужно прочитать ячейку известной
 * колонки листа: у них не должно быть своей копии алфавита и своих букв —
 * раскладка ШДС описана здесь (LAYOUTS).
 */
export function columnIndexOf(letter: string): number {
  return colIndex(letter);
}

/** Свободная строка — значение «Вакант» */
function isVacant(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "вакант";
}

/**
 * Первая строка листа: там начинаются объединённые заголовки ШДС.
 *
 * Область поиска расширена до неё намеренно — и заголовки («Фамилия»), и
 * командование листа стоят выше `overall.top`, и обрезка по `overall.top`
 * делала бойца из командования ненаходимым.
 */
const SEARCH_TOP_ROW = 1;

/** Последняя строка шапки — строка перед таблицей участников */
function headerScanBottom(layout: UnitLayout): number {
  return Math.max(SEARCH_TOP_ROW, layout.overall.top - 1);
}

/**
 * Загрузить область строк целиком (по границы блока экзаменов этого листа).
 *
 * Читается не только запрошенный диапазон, но и всё, что ВЫШЕ него, до первой
 * строки листа: там лежит шапка (по её заголовкам поиск уточняет колонку ФИО)
 * и командование (у дивизиона строки 1–11 при таблице с 12-й). Один и тот же
 * запрос — отдельного обращения к API это не стоит.
 */
async function loadArea(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  top: number,
  bottom: number
) {
  const from = Math.min(top, SEARCH_TOP_ROW);
  await sheet.loadCells(`${ROW_START_COL}${from}:${layout.examEndCol}${bottom}`);
}

/** Первая строка со значением «Вакант» в диапазоне колонки имени */
export function findVacantRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  top: number,
  bottom: number,
  excludeRow?: number
): number | null {
  for (let row = top; row <= bottom; row++) {
    if (excludeRow && row === excludeRow) continue;
    if (isVacant(cellAt(sheet, row, layout.nameCol).value)) return row;
  }
  return null;
}

/** Текст ячейки строки (1-based) по индексу колонки; "" — пусто или не загружено */
function readRowText(sheet: GoogleSpreadsheetWorksheet, row: number, col: number): string {
  try {
    return String(sheet.getCell(row - 1, col).value ?? "")
      .replace(/\u00A0/g, " ")
      .trim();
  } catch {
    // Ячейка вне загруженного диапазона — для поиска это «нет значения»,
    // а не повод падать с «This cell has not been loaded yet»
    return "";
  }
}

/**
 * «Грубый» ключ ФИО: только буквы и цифры, без точек, дефисов и пробелов.
 *
 * normalizePersonName сводит «А. В.» к «А.В.», но точку в ячейке могли и не
 * поставить — «Розгов А.В» или «Розгов А В». Для поиска это одно и то же ФИО,
 * поэтому дополнительно сравнивается ключ без разделителей.
 * Принимает уже нормализованную строку (normalizePersonName).
 */
function looseNameKey(normalized: string): string {
  return normalized.replace(/[^a-zа-я0-9]+/g, "");
}

/** Заголовок колонки с ФИО в шапке листа */
const NAME_HEADER_RE = /фамили|фио|ф\.?\s*и\.?\s*о/i;

/**
 * Похожа ли колонка на колонку ФИО по её содержимому.
 *
 * Одного слова «Фамилия» в шапке мало: лист начинается с объединённых
 * заголовков («Штатно-должностной список…»), и такое слово может оказаться в
 * колонке A, где данных нет вовсе. Колонка принимается только если в ней
 * реально стоят имена — есть хотя бы одна непустая строка, кроме «Вакант».
 */
function columnLooksLikeNames(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  col: number
): boolean {
  for (let row = layout.overall.top; row <= layout.overall.bottom; row++) {
    const text = readRowText(sheet, row, col);
    if (text && !isVacant(text)) return true;
  }
  return false;
}

/** Колонка ФИО по заголовку шапки (0-based) или null, если шапка её не называет */
function headerNameColumn(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout): number | null {
  const lastCol = Math.min(colIndex(layout.nameCol) + 1, 5);
  for (let row = SEARCH_TOP_ROW; row <= headerScanBottom(layout); row++) {
    // Колонка A служебная (там же объединённые заголовки листа): слово
    // «Фамилия» в них ещё не значит, что имена лежат в A
    for (let col = 1; col <= lastCol; col++) {
      const text = readRowText(sheet, row, col);
      if (!text || !NAME_HEADER_RE.test(text)) continue;
      if (columnLooksLikeNames(sheet, layout, col)) return col;
    }
  }
  return null;
}

/**
 * Колонки, в которых ищется ФИО.
 *
 * Первой идёт колонка, найденная по заголовку шапки (если шапка прочитана),
 * затем C — колонка ФИО по ТЗ, затем B: строку могли сдвинуть вручную, и имя
 * оказывается там, где по раскладке стоит звание. Проверять только C нельзя —
 * именно из-за этого рапорт отвечал «Боец Розгов А.В. не найден», хотя строка
 * на листе есть.
 */
function nameColumnsFor(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout): number[] {
  const base = colIndex(layout.nameCol);
  const columns: number[] = [];
  const byHeader = headerNameColumn(sheet, layout);
  if (byHeader != null) columns.push(byHeader);
  for (const col of [base, base - 1]) {
    if (col >= 0 && !columns.includes(col)) columns.push(col);
  }
  return columns;
}

/**
 * Проход по строкам: сначала точное совпадение ключа ФИО, затем вхождение.
 *
 * Поиск идёт с ПЕРВОЙ строки листа, а не с `overall.top`: командование стоит
 * выше таблицы участников (у дивизиона строки 1–11 при overall.top = 12), и
 * обрезка по overall.top делала такого бойца ненаходимым — рапорт на смену
 * должности отвечал «не найден», хотя строка на листе есть. В строках выше
 * overall.top принимается только СТРОГОЕ совпадение: там лежит шапка, и поиск
 * по вхождению мог бы зацепиться за заголовок.
 *
 * Точное совпадение важнее частичного и в самой таблице: пометка «(отпуск)» в
 * одной строке не должна перебивать чистую запись того же ФИО в другой.
 */
function scanNameRows(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  target: string,
  targetLoose: string,
  columns: readonly number[],
  excludeRow?: number
): number | null {
  let partial: number | null = null;
  for (let row = SEARCH_TOP_ROW; row <= layout.overall.bottom; row++) {
    if (excludeRow && row === excludeRow) continue;
    // Строки шапки/командования выше overall.top: только точное совпадение
    const isAboveTable = row < layout.overall.top;
    for (const col of columns) {
      const raw = readRowText(sheet, row, col);
      // Свободная строка — не боец: «Вакант» не должен совпасть с искомым именем
      if (!raw || isVacant(raw)) continue;
      const key = normalizePersonName(raw);
      if (!key) continue;
      const loose = looseNameKey(key);
      // Пометка в скобках или приписка не должны ломать поиск
      if (key === target || (targetLoose && loose === targetLoose)) return row;
      if (
        !isAboveTable &&
        partial === null &&
        (key.includes(target) || (targetLoose && loose.includes(targetLoose)))
      ) {
        partial = row;
      }
    }
  }
  return partial;
}

/**
 * Строка бойца по имени в общем диапазоне подразделения.
 *
 * Сравнение идёт по ключу normalizePersonName (recruits.ts), а не по сырой
 * строке: в листе ФИО записано как угодно — «Розгов А.В.», «Розгов А. В.»,
 * с неразрывным пробелом из Google Таблиц или с латинской «A» в инициалах.
 * Точное совпадение из-за этого отвечало «Боец не найден», хотя строка есть.
 *
 * Дополнительно:
 *   * ячейки с ФИО проверяются не только в колонке C, но и в B и в колонке,
 *     названной «Фамилия» в шапке — раскладку листа правят руками, и имя
 *     оказывается не там, где стоит по ТЗ;
 *   * сравнивается ещё и «грубый» ключ без точек и пробелов, поэтому
 *     «Розгов А.В» и «Розгов А. В.» находят одну и ту же строку.
 *
 * Сначала ищется точное совпадение ключа, затем — вхождение (на случай
 * «Розгов А.В. (отпуск)» в ячейке): так поиск не теряет бойца из-за пометки,
 * но и не склеивает двух разных людей с похожими ФИО.
 */
export function findNameRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  name: string,
  excludeRow?: number
): number | null {
  const target = normalizePersonName(name);
  if (!target) return null;
  const targetLoose = looseNameKey(target);
  if (!targetLoose) return null;
  return scanNameRows(sheet, layout, target, targetLoose, nameColumnsFor(sheet, layout), excludeRow);
}

/**
 * Диагностика неудачного поиска бойца.
 *
 * В лог попадают первые 10–15 прочитанных ячеек ФИО вместе с их
 * нормализованным ключом: сразу видно, чем запись в листе отличается от
 * искомого имени (опечатка, латиница в инициалах, сдвинутая колонка), и не
 * нужно открывать таблицу, чтобы это выяснить.
 */
function warnMissingSoldier(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  names: readonly string[]
): void {
  const columns = nameColumnsFor(sheet, layout);
  const sample: string[] = [];
  for (let row = SEARCH_TOP_ROW; row <= layout.overall.bottom && sample.length < 15; row++) {
    for (const col of columns) {
      const raw = readRowText(sheet, row, col);
      if (!raw) continue;
      sample.push(`${colLetter(col)}${row}="${raw}"→"${normalizePersonName(raw)}"`);
      break; // одна колонка ФИО на строку
    }
  }
  const byHeader = columns.length > 0 && columns[0] !== colIndex(layout.nameCol);
  const where = columns.map((c) => colLetter(c)).join("/");
  const tail = sample.length ? `: ${sample.join("; ")}` : " — колонки не прочитаны";
  console.warn(
    `[gsheets] Боец не найден на листе «${sheet.title}»` +
      (byHeader ? ` (ФИО по шапке в колонке ${colLetter(columns[0])})` : "") +
      `; ищем ${names.map((n) => `«${n}»→«${normalizePersonName(n)}»`).join(", ")}` +
      `; колонки ${where}, прочитано ${sample.length} ячеек${tail}`
  );
}

/* ------------------------------------------------------------------ */
/* Оформление строки: границы, шрифты, заливки                         */
/* ------------------------------------------------------------------ */

/** Диапазон строки по колонкам (индексы Google: конец диапазона не включается) */
type GridRangeLike = {
  sheetId?: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
};

/** Спецификация одной линии рамки */
type BorderSpec = { style: "SOLID"; color: { red: number; green: number; blue: number }; width: number };

/** Запрос batchUpdate, который умеет собирать этот модуль */
type SheetRequest =
  | {
      copyPaste: {
        source: GridRangeLike;
        destination: GridRangeLike;
        pasteType: "PASTE_FORMAT";
        pasteOrientation: "NORMAL";
      };
    }
  | {
      updateBorders: {
        range: GridRangeLike;
        top: BorderSpec;
        bottom: BorderSpec;
        left: BorderSpec;
        right: BorderSpec;
        innerHorizontal: BorderSpec;
        innerVertical: BorderSpec;
      };
    }
  | {
      repeatCell: {
        range: GridRangeLike;
        cell: { userEnteredFormat: { backgroundColor: CellColor } };
        fields: string;
      };
    };

/** Диапазон одной строки в указанных колонках */
function rowRange(
  sheetId: number,
  row: number,
  fromCol: string,
  toCol: string
): GridRangeLike {
  return {
    sheetId,
    startRowIndex: row - 1,
    // Конец диапазона не включается: строка занимает ровно одну строку таблицы
    endRowIndex: row,
    startColumnIndex: colIndex(fromCol),
    endColumnIndex: colIndex(toCol) + 1,
  };
}

/**
 * Выполнение набора запросов ОДНИМ batchUpdate.
 *
 * Почему пакетом: «формат + границы + заливка» — одна логическая операция.
 * Разнеси мы её по отдельным вызовам — между ними строка успела бы показаться
 * с полуприменённым оформлением, а часть запросов могла бы не дойти при сбое.
 *
 * `_makeBatchUpdateRequest` в библиотеке помечен внутренним, но именно он
 * отправляет несколько запросов за одно обращение к API (публичные copyPaste и
 * updateBorders шлют по запросу каждый). Если в сборке метода не окажется
 * (обновление зависимости), набор выполняется поштучно публичными методами:
 * медленнее, но результат тот же.
 */
async function runBatch(sheet: GoogleSpreadsheetWorksheet, requests: SheetRequest[]): Promise<void> {
  const batch = (
    sheet as unknown as { _makeBatchUpdateRequest?: (r: unknown[]) => Promise<void> }
  )._makeBatchUpdateRequest;

  if (typeof batch === "function") {
    await batch.call(sheet, requests);
    return;
  }

  for (const request of requests) {
    if ("copyPaste" in request) {
      const { source, destination, pasteType } = request.copyPaste;
      await sheet.copyPaste(source, destination, pasteType);
    } else if ("updateBorders" in request) {
      const { range, ...borders } = request.updateBorders;
      await sheet.updateBorders(range, borders);
    } else {
      const { range, cell, fields } = request.repeatCell;
      await sheet.repeatCell(range, cell, fields);
    }
  }
}

/**
 * Сжатие списка колонок в непрерывные диапазоны.
 *
 * Заливка ставится запросом на диапазон, поэтому 20 подряд идущих колонок
 * выгоднее покрасить одним запросом, чем двадцатью: у Google есть лимит на
 * размер batchUpdate, и «по запросу на ячейку» он упирается в него на больших
 * строках.
 */
function toRanges(columns: readonly number[]): { from: number; to: number }[] {
  const sorted = [...new Set(columns)].sort((a, b) => a - b);
  const ranges: { from: number; to: number }[] = [];
  for (const column of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && column === last.to + 1) last.to = column;
    else ranges.push({ from: column, to: column });
  }
  return ranges;
}

/** Запрос заливки диапазона колонок строки */
function fillRequest(
  sheet: GoogleSpreadsheetWorksheet,
  row: number,
  from: number,
  to: number,
  color: CellColor
): SheetRequest {
  return {
    repeatCell: {
      range: rowRange(sheet.sheetId, row, colLetter(from), colLetter(to)),
      cell: { userEnteredFormat: { backgroundColor: color } },
      // Только цвет: рамки и шрифт ячейки запрос не трогает
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

/**
 * Колонки блока оценок, закрашенные «сдано».
 *
 * Снимается с исходной строки ПЕРЕД переносом: copyPaste формата затирает
 * заливки всего диапазона, и без этого снимка зелёные отметки бойца
 * заменились бы фоном строки-образца (то есть отметками другого человека).
 */
function readExamGreens(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  row: number
): number[] {
  const { start, end } = examBounds(layout);
  const columns: number[] = [];
  for (let c = start; c <= end; c++) {
    if (isExamGreen(sheet.getCell(row - 1, c).backgroundColor)) columns.push(c);
  }
  return columns;
}

/**
 * Определение неприменимых колонок экзаменов для данной должности.
 *
 * Серыми закрашиваются столбцы, которые для этой специальности не нужны:
 * например, у логиста-снабженца (учебное отделение) серыми идут все блоки
 * специализаций (мехвод, наводчик, сержант), а у мехвода — блоки наводчика,
 * сержанта и спецкурсов, кроме самого блока мехвода.
 *
 * Логика: ищем секцию по должности бойца → берём её required → все столбцы,
 * чей group НЕ входит в группы required нормативов, закрашиваем серым.
 */
function disabledExamColumns(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  post: string
): number[] {
  const unit = layout.key === "TR" ? "Танковая рота" : "Артиллерийский дивизион";

  // Находим секцию по должности
  const section = POSITION_SECTIONS.find(
    (s: { unit: string; post: string }) =>
      s.unit === unit && s.post.toLowerCase() === post.toLowerCase()
  );

  if (!section || !section.required || section.required.length === 0) {
    // Нет секции или нет требований: серые не ставятся (либо это командир, либо
    // должность неизвестна — не угадываем, какие столбцы закрыть)
    return [];
  }

  // Группы нормативов, которые НУЖНЫ бойцу этой специальности
  const requiredGroups = new Set<string>();
  for (const req of section.required) {
    const exam = examCatalog(unit).exams.find(
      (e: { code: string }) => e.code === req.code
    );
    if (exam?.group) requiredGroups.add(exam.group);
  }

  const headerRow = layout.examHeaderRow;
  const { start: examFrom, end: examTo } = examBounds(layout);
  const disabled: number[] = [];

  // Читаем шапку и проверяем группу каждого столбца
  for (let c = examFrom; c <= examTo; c++) {
    const title = String(sheet.getCell(headerRow - 1, c).value ?? "").trim();
    if (!title) continue;

    const exam = examCatalog(unit).exams.find(
      (e: { code: string }) => canonicalExamTitle(e.code) === canonicalExamTitle(title)
    );

    // Если норматив найден, но его группы НЕТ в required, закрашиваем серым
    if (exam?.group && !requiredGroups.has(exam.group)) {
      disabled.push(c);
    }
  }

  return disabled;
}

/**
 * Приведение строки к формату ШДС: шрифт эталонной строки, сплошные границы,
 * заливка колонки имени и восстановление заливок блока оценок.
 *
 * `templateRow` — строка, с которой копируется формат (шрифты, выравнивание,
 * размеры). Не задана — границы и заливки всё равно выставляются: строка без
 * рамок выбивается из таблицы, а именно это и было жалобой («разделители строк
 * и столбцов исчезают»).
 *
 * Почему copyPaste PASTE_FORMAT, а не перенос присваиванием: значения ячеек
 * библиотека шлёт отдельным запросом, и при копировании «вручную» легко
 * затереть содержимое или потерять часть формата. PASTE_FORMAT меняет ТОЛЬКО
 * оформление.
 *
 * Почему заливки оценок ставятся ПОСЛЕ копирования: PASTE_FORMAT переносит и
 * фон ячеек строки-образца. У занятой строки образца в блоке оценок зелёные
 * ячейки — значит, они появились бы и у цели (у нового бойца «сдано» то, чего
 * он не сдавал; на «Вакант» — зачёт несуществующего бойца). Поэтому блок
 * экзаменов (H..AE у роты, I..AG у дивизиона) сначала гасится белым, а затем
 * закрашиваются только сданные нормативы (`examGreenColumns`), а неприменимые
 * дисциплины — серым (`examDisabledColumns`).
 */
async function applyRowFormat(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  targetRow: number,
  options: {
    /** Строка-образец формата (обычно соседняя оформленная строка секции) */
    templateRow?: number | null;
    /** Колонка имени: её заливка выставляется явно */
    nameCol?: string;
    /** Цвет заливки колонки имени (зелёный у бойца, белый у «Вакант») */
    nameFill?: CellColor | null;
    /** Колонки блока оценок, которые нужно закрасить зелёным (сданные) */
    examGreenColumns?: readonly number[];
    /** Колонки блока оценок, которые нужно закрасить серым (неприменимые) */
    examDisabledColumns?: readonly number[];
  } = {}
): Promise<void> {
  const { templateRow, nameCol, nameFill, examGreenColumns = [], examDisabledColumns = [] } = options;
  const lastCol = layout.examEndCol;
  const target = rowRange(sheet.sheetId, targetRow, ROW_START_COL, lastCol);
  const requests: SheetRequest[] = [];

  if (templateRow && templateRow !== targetRow) {
    requests.push({
      copyPaste: {
        source: rowRange(sheet.sheetId, templateRow, ROW_START_COL, lastCol),
        destination: target,
        pasteType: "PASTE_FORMAT",
        pasteOrientation: "NORMAL",
      },
    });
  }

  // Границы накладываются ПОСЛЕ копирования формата: у эталонной строки
  // рамки могли быть потеряны, а разделители нужны в каждой строке блока
  requests.push({
    updateBorders: {
      range: target,
      top: SOLID_BLACK_BORDER,
      bottom: SOLID_BLACK_BORDER,
      left: SOLID_BLACK_BORDER,
      right: SOLID_BLACK_BORDER,
      // Вертикальные разделители МЕЖДУ ячейками строки: без них столбцы
      // внутри строки сливаются, даже когда внешняя рамка на месте
      innerHorizontal: SOLID_BLACK_BORDER,
      innerVertical: SOLID_BLACK_BORDER,
    },
  });

  // Блок оценок: сначала фон без зачётов, затем — закраска неприменимых
  // дисциплин серым и сданных нормативов зелёным
  const { start: examFrom, end: examTo } = examBounds(layout);
  requests.push(fillRequest(sheet, targetRow, examFrom, examTo, VACANT_WHITE));

  // Серые ячейки (неприменимые дисциплины) ставятся ПЕРЕД зелёными: если
  // столбец попал в оба списка (ошибка логики), зелёный перебивает серый
  for (const range of toRanges(examDisabledColumns)) {
    requests.push(fillRequest(sheet, targetRow, range.from, range.to, DISABLED_GRAY));
  }

  for (const range of toRanges(examGreenColumns)) {
    requests.push(fillRequest(sheet, targetRow, range.from, range.to, EXAM_GREEN));
  }

  if (nameCol && nameFill) {
    requests.push(fillRequest(sheet, targetRow, colIndex(nameCol), colIndex(nameCol), nameFill));
  }

  await runBatch(sheet, requests);
}

/**
 * Эталонная строка для копирования формата.
 *
 * Приоритет: занятая строка того же блока (в ней виден формат отделения) →
 * вакантная строка блока (её формат тоже стандартный) → занятая строка листа.
 * Пусто — формат копировать не с чего: строка получит только границы и заливку.
 */
function pickFormatRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  top: number,
  bottom: number,
  excludeRow?: number
): number | null {
  for (let row = top; row <= bottom; row++) {
    if (excludeRow && row === excludeRow) continue;
    const value = String(cellAt(sheet, row, layout.nameCol).value ?? "").trim();
    if (value && !isVacant(value)) return row;
  }
  const vacant = findVacantRow(sheet, layout, top, bottom, excludeRow);
  if (vacant) return vacant;

  for (let row = layout.overall.top; row <= layout.overall.bottom; row++) {
    if (excludeRow && row === excludeRow) continue;
    const value = String(cellAt(sheet, row, layout.nameCol).value ?? "").trim();
    if (value && !isVacant(value)) return row;
  }
  return null;
}

/**
 * Возврат строки в состояние «Вакант».
 *
 * Используется при переносе бойца и при «Убрать из таблицы»: освободившаяся
 * строка обязана выглядеть как свободная — «Вакант» с белым фоном в колонке
 * имени, штатная должность секции в колонке «Должность», пустые Steam/Discord,
 * стёртые оценки экзаменов и восстановленные границы.
 *
 * Должность секции возвращается не «пусто», а значением блока: по колонке
 * «Должность» потом ищется блок для зачисления, и пустая ячейка сдвинула бы
 * поиск в чужое отделение.
 */
async function clearRowToVacant(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  row: number,
  templateRow?: number | null
): Promise<void> {
  const nameColIdx = colIndex(layout.nameCol);
  const rankCol = colLetter(nameColIdx - 1);
  const steamCol = colLetter(nameColIdx + 2);
  const discordCol = colLetter(nameColIdx + 3);

  cellAt(sheet, row, rankCol).value = DEFAULT_SHEET_RANK;
  cellAt(sheet, row, layout.nameCol).value = "Вакант";
  cellAt(sheet, row, colLetter(nameColIdx + 1)).value = defaultPostFor(layout, row);
  cellAt(sheet, row, steamCol).value = "";
  cellAt(sheet, row, discordCol).value = "";

  // Экзамены и оценки: блок экзаменов листа. Заливки сбрасываются форматом
  // ниже — «зелёный сдан» на свободной строке читался бы как сдавший боец.
  const { start: examFrom, end: examTo } = examBounds(layout);
  for (let c = examFrom; c <= examTo; c++) {
    sheet.getCell(row - 1, c).value = "";
  }

  await sheet.saveUpdatedCells();

  // Блок оценок остаётся пустым: колонки для закраски не передаются, поэтому
  // applyRowFormat гасит его белым и сбрасывает зелёные отметки бойца
  await applyRowFormat(sheet, layout, row, {
    templateRow: templateRow ?? null,
    nameCol: layout.nameCol,
    nameFill: VACANT_WHITE,
  });
}

/**
 * Копирование строки целиком: значения + шрифты + заливки + выравнивание.
 *
 * Конец диапазона — конец блока экзаменов ЭТОГО листа: у роты «AE», у дивизиона
 * «AG». Всё правее в листе относится к служебным пометкам и переносу не
 * подлежит.
 */
export function copyRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  srcRow: number,
  destRow: number
) {
  const start = colIndex(ROW_START_COL);
  const end = examBounds(layout).end;
  for (let c = start; c <= end; c++) {
    const src = sheet.getCell(srcRow - 1, c);
    const dest = sheet.getCell(destRow - 1, c);
    dest.value = src.value;
    dest.textFormat = {
      fontFamily: src.textFormat?.fontFamily,
      bold: src.textFormat?.bold,
      fontSize: src.textFormat?.fontSize,
      italic: src.textFormat?.italic,
      underline: src.textFormat?.underline,
      strikethrough: src.textFormat?.strikethrough,
      foregroundColor: src.textFormat?.foregroundColor,
    };
    // В google-spreadsheet v5 сеттеры формата не принимают undefined,
    // поэтому заливку переносим только когда она есть у источника.
    if (src.backgroundColor) dest.backgroundColor = { ...src.backgroundColor };
    dest.horizontalAlignment = src.horizontalAlignment;
    dest.verticalAlignment = src.verticalAlignment;
  }
}

/* ------------------------------------------------------------------ */
/* Сценарии А–Д (по ТЗ)                                                */
/* ------------------------------------------------------------------ */

/**
 * Запись бойца в строку листа по раскладке ШДС.
 *
 * Колонки заданы ОТНОСИТЕЛЬНО колонки имени (nameCol), а не выписаны буквами:
 *   B — Звание (строго слева от фамилии), C — Фамилия/позывной, D — Должность,
 *   E — Steam ID, F — Discord ID, G — Для пометок.
 * Раскладка одна у обоих листов, поэтому относительный сдвиг одинаков и не
 * ломается, если у листа когда-нибудь поменяется колонка имени.
 *
 * Должность: если боец её не указал (заявка «Добавление в ШДС» без поля), в
 * колонку пишется штатная должность секции — по ней потом ищется блок строки.
 * Пустая ячейка выглядела бы как незаполненная строка и ломала поиск блока при
 * зачистке.
 *
 * Колонка G (пометок) очищается принудительно: старые записи «Запас», «Отпуск»
 * или технические заметки не должны оставаться при зачислении.
 */
function writeSoldierRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  row: number,
  data: { rank: string | null; name: string | null; post: string; steamId: string | null; discordId: string | null }
) {
  const nameCol = colIndex(layout.nameCol);
  const rankCell = cellAt(sheet, row, colLetter(nameCol - 1));
  const nameCell = cellAt(sheet, row, layout.nameCol);
  const postCell = cellAt(sheet, row, colLetter(nameCol + 1));
  const steamCell = cellAt(sheet, row, colLetter(nameCol + 2));
  const discordCell = cellAt(sheet, row, colLetter(nameCol + 3));
  const notesCell = cellAt(sheet, row, colLetter(nameCol + 4));

  rankCell.value = sheetRank(data.rank);
  nameCell.value = data.name || "";
  postCell.value = data.post || defaultPostFor(layout, row);
  steamCell.value = data.steamId || "";
  discordCell.value = data.discordId || "";
  notesCell.value = ""; // Очистка колонки «Для пометок»

  applyStdFormat(rankCell);
  applyStdFormat(nameCell);
  applyStdFormat(postCell);
  applyStdFormat(steamCell);
  applyStdFormat(discordCell);
  applyStdFormat(notesCell);
}

/** Сценарий А: «Добавление в ШДС» */
async function scenarioAdd(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout, layout.addRange.top, layout.addRange.bottom);
  const row = findVacantRow(sheet, layout, layout.addRange.top, layout.addRange.bottom);
  if (!row) throw new Error("В диапазоне добавления нет свободных строк («Вакант»)");

  writeSoldierRow(sheet, layout, row, {
    rank: req.rank,
    name: req.userName,
    // Поле «Должность» в заявке на добавление может быть пустым — тогда
    // колонка D получает штатную должность секции (для учебного отделения
    // роты это «Логист-снабженец/резерв», для дивизиона — «Логист-снабженец»)
    post: req.должность,
    steamId: req.steamId,
    discordId: req.discordId,
  });

  await sheet.saveUpdatedCells();

  // Должность бойца: если не указана, берётся штатная должность секции
  const finalPost = req.должность || defaultPostFor(layout, row);

  // Блок оценок очищается явно: старая строка могла содержать оценки и заливки
  const { start: examFrom, end: examTo } = examBounds(layout);
  for (let c = examFrom; c <= examTo; c++) {
    sheet.getCell(row - 1, c).value = "";
  }
  await sheet.saveUpdatedCells();

  // Формат: шрифт берётся с оформленной строки того же блока, границы
  // накладываются сплошные, имя заливается зелёным — как «боец в строю».
  // Неприменимые дисциплины (не входящие в required секции) закрашиваются серым.
  const formatRow = pickFormatRow(sheet, layout, layout.addRange.top, layout.addRange.bottom, row);
  await sheet.loadCells(); // Загружаем шапку для disabledExamColumns
  const disabledColumns = disabledExamColumns(sheet, layout, finalPost);
  await applyRowFormat(sheet, layout, row, {
    templateRow: formatRow,
    nameCol: layout.nameCol,
    nameFill: NAME_GREEN,
    // Новобранец приходит без сданных нормативов: блок оценок остаётся белым
    examGreenColumns: [],
    examDisabledColumns: disabledColumns,
  });

  return `Боец ${req.userName} добавлен в строку ${row} (лист «${sheet.title}», звание «${sheetRank(
    req.rank
  )}», должность «${finalPost}»)`;
}

/** Сценарий Б: «Изменение звания» */
async function scenarioRank(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);
  const row = findNameRow(sheet, layout, req.userName);
  if (!row) {
    warnMissingSoldier(sheet, layout, [req.userName]);
    throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);
  }

  const rankCell = cellAt(sheet, row, colLetter(colIndex(layout.nameCol) - 1));
  rankCell.value = req.rank;
  applyStdFormat(rankCell);

  await sheet.saveUpdatedCells();
  return `Звание бойца ${req.userName} изменено на «${req.rank}» (строка ${row})`;
}

/** Выбор целевого диапазона для «Изменение должности» по ТЗ */
function pickPostRange(layout: UnitLayout, req: ParsedRequest) {
  const haystacks = [req.должность, req.отделение].filter(Boolean);
  for (const r of layout.postRanges) {
    for (const hay of haystacks) {
      if (r.match.test(hay)) return r;
    }
  }
  return null;
}

/** Сценарий В: «Изменение должности» — система «Перенос и зачистка» */
async function scenarioPost(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);
  const srcRow = findNameRow(sheet, layout, req.userName);
  if (!srcRow) {
    warnMissingSoldier(sheet, layout, [req.userName]);
    throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);
  }

  // 1. Обновляем должность в соседней правой ячейке
  const postCell = cellAt(sheet, srcRow, colLetter(colIndex(layout.nameCol) + 1));
  if (req.должность) {
    postCell.value = req.должность;
    applyStdFormat(postCell);
  }

  // 2. Определяем целевой диапазон по должности/отделению
  const target = pickPostRange(layout, req);
  if (!target) {
    throw new Error(
      `Не удалось определить диапазон по должности «${req.должность}» / отделению «${req.отделение}»`
    );
  }

  // Снимок сданных нормативов: заливки блока оценок копирование формата затирает
  const greenColumns = readExamGreens(sheet, layout, srcRow);

  // 3. Ищем свободную строку «Вакант» в целевом диапазоне
  if (srcRow >= target.top && srcRow <= target.bottom) {
    // Боец остаётся в своём диапазоне — просто обновляем должность.
    // Формат строки всё равно выравнивается: должность могла удлиниться,
    // а границы блока — разойтись при ручной правке листа
    await sheet.saveUpdatedCells();
    await sheet.loadCells(); // Для disabledExamColumns
    const disabledColumns = disabledExamColumns(sheet, layout, req.должность);
    await applyRowFormat(sheet, layout, srcRow, {
      templateRow: pickFormatRow(sheet, layout, target.top, target.bottom, srcRow),
      nameCol: layout.nameCol,
      nameFill: NAME_GREEN,
      examGreenColumns: greenColumns,
      examDisabledColumns: disabledColumns,
    });
    return `Должность ${req.userName} обновлена на «${req.должность}» (строка ${srcRow})`;
  }
  const destRow = findVacantRow(sheet, layout, target.top, target.bottom, srcRow);
  if (!destRow) throw new Error("В целевом диапазоне нет свободных строк («Вакант»)");

  // 4. Переносим бойца на новое место вместе с отметками экзаменов
  copyRow(sheet, layout, srcRow, destRow);
  await sheet.saveUpdatedCells();
  await sheet.loadCells(); // Для disabledExamColumns
  const disabledColumns = disabledExamColumns(sheet, layout, req.должность);
  await applyRowFormat(sheet, layout, destRow, {
    templateRow: pickFormatRow(sheet, layout, target.top, target.bottom, destRow),
    nameCol: layout.nameCol,
    nameFill: NAME_GREEN,
    examGreenColumns: greenColumns,
    examDisabledColumns: disabledColumns,
  });

  // 5. Зачищаем старое место: «Вакант», белый фон, штатная должность секции
  const oldRange =
    layout.postRanges.find((r) => srcRow >= r.top && srcRow <= r.bottom) || layout.overall;
  await clearRowToVacant(
    sheet,
    layout,
    srcRow,
    pickFormatRow(sheet, layout, oldRange.top, oldRange.bottom, srcRow)
  );

  return `${req.userName} переведён на «${req.должность}»: строка ${srcRow} → ${destRow} (лист «${sheet.title}»)`;
}

/**
 * Перенос бойца между секциями ШДС по рапорту о должности.
 *
 * Механика (по ТЗ):
 *   1. найти строку бойца на листе;
 *   2. найти первую свободную строку «Вакант» в целевой секции;
 *   3. скопировать в неё Звание (B), Фамилию (C), новую Должность (D),
 *      Steam ID (E), Discord ID (F) и ВСЕ отметки сданных экзаменов
 *      (блок оценок листа: H..AE у роты, I..AG у дивизиона);
 *   4. наложить на новую строку полные границы и формат секции;
 *   5. вернуть прежнюю строку в состояние «Вакант»: «Рядовой» / «Вакант» с
 *      белым фоном / штатная должность секции / очищенные E–F и оценки.
 *
 * Почему шаги идут именно так: строка сначала появляется в новой секции, и
 * только потом зачищается старая. Обратный порядок означал бы, что при сбое на
 * середине боец исчез бы из таблицы совсем — «Вакант» на старом месте уже
 * стоит, а на новом его нет.
 *
 * Требования секции (сданные экзамены) проверяются ЗДЕСЬ, а не в валидаторе
 * payload: тот работает и в браузере, где истории сданных рапортов нет, и
 * «одобренный» перевод без экзаменов всё равно не должен двигать строку.
 */
export async function transferShdsPosition(params: {
  /** Подразделение бойца: оно же название листа */
  unit: string;
  /** Кандидаты имени в таблице (позывной и ФИО: панель и лист зовут по-разному) */
  names: readonly string[];
  /** Целевая секция из справочника reports.ts (POSITION_SECTIONS) */
  section: ShdsSection;
  /** Сданные бойцом нормативы: по ним проверяются требования секции */
  passedExams?: readonly { code: string }[];
}): Promise<ShdsResult> {
  const unit = params.unit.trim();
  if (!unit) {
    return { ok: false, error: "Бойцу не назначено подразделение — неизвестно, в какой лист писать" };
  }
  const names = params.names.map((n) => (n || "").trim()).filter(Boolean);
  if (!names.length) {
    return { ok: false, error: "Неизвестно имя бойца для поиска строки в таблице" };
  }

  // Требования ступени: без обязательных нормативов строка не двигается
  const missing = missingSectionExams(params.section, params.passedExams ?? []);
  if (missing.length) {
    return {
      ok: false,
      error: `Для должности «${params.section.title}» не сданы: ${missing.join(", ")}`,
    };
  }

  try {
    const sheet = await getSheet(unit);
    const layout = resolveLayout(unit);
    await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);

    let srcRow: number | null = null;
    for (const name of names) {
      srcRow = findNameRow(sheet, layout, name);
      if (srcRow) break;
    }
    if (!srcRow) {
      warnMissingSoldier(sheet, layout, names);
      throw new Error(`Боец «${names.join("» / «")}» не найден на листе «${sheet.title}»`);
    }

    const nameColIdx = colIndex(layout.nameCol);
    const read = (row: number, col: number) => {
      const value = sheet.getCell(row - 1, col).value;
      if (value == null) return null;
      const trimmed = String(value).trim();
      return trimmed === "" ? null : trimmed;
    };

    // Звание и персональные данные СНИМАЮТСЯ до перезаписи строк: после
    // зачистки старого места их взять уже негде
    const rank = read(srcRow, nameColIdx - 1);
    const steamId = read(srcRow, nameColIdx + 2);
    const discordId = read(srcRow, nameColIdx + 3);

    // Снимок сданных нормативов: заливки блока оценок копирование формата
    // затирает, и без него боец потерял бы все зелёные отметки
    const greenColumns = readExamGreens(sheet, layout, srcRow);

    // Строка уже в целевой секции: переносить нечего, меняем только должность
    if (srcRow >= params.section.rows.top && srcRow <= params.section.rows.bottom) {
      cellAt(sheet, srcRow, colLetter(nameColIdx + 1)).value = params.section.post;
      await sheet.saveUpdatedCells();
      await sheet.loadCells(); // Для disabledExamColumns
      const disabledColumns = disabledExamColumns(sheet, layout, params.section.post);
      await applyRowFormat(sheet, layout, srcRow, {
        templateRow: pickFormatRow(
          sheet,
          layout,
          params.section.rows.top,
          params.section.rows.bottom,
          srcRow
        ),
        nameCol: layout.nameCol,
        nameFill: NAME_GREEN,
        examGreenColumns: greenColumns,
        examDisabledColumns: disabledColumns,
      });
      return {
        ok: true,
        message: `${params.section.title}: боец уже в секции, должность подтверждена (строка ${srcRow})`,
      };
    }

    // 1. Первая свободная строка «Вакант» в целевой секции
    const destRow = findVacantRow(
      sheet,
      layout,
      params.section.rows.top,
      params.section.rows.bottom,
      srcRow
    );
    if (!destRow) {
      throw new Error(
        `В секции «${params.section.title}» нет свободных строк («Вакант», строки ${params.section.rows.top}–${params.section.rows.bottom})`
      );
    }

    // 2. Отметки экзаменов (блок оценок листа): значения оценок и зелёные
    //    заливки. Копируется ДО записи персональных данных: copyRow переносит
    //    строку целиком, и запись «поверх» гарантирует колонки B–F.
    copyRow(sheet, layout, srcRow, destRow);
    writeSoldierRow(sheet, layout, destRow, {
      rank: sheetRank(rank),
      name: read(srcRow, nameColIdx),
      post: params.section.post,
      steamId,
      discordId,
    });
    await sheet.saveUpdatedCells();

    // 3. Оформление новой строки: формат секции, сплошные границы, зелёное имя
    //    и ВОССТАНОВЛЕННЫЕ отметки экзаменов бойца (снимок со старой строки).
    //    Неприменимые дисциплины закрашиваются серым.
    await sheet.loadCells(); // Для disabledExamColumns
    const disabledColumns = disabledExamColumns(sheet, layout, params.section.post);
    await applyRowFormat(sheet, layout, destRow, {
      templateRow: pickFormatRow(
        sheet,
        layout,
        params.section.rows.top,
        params.section.rows.bottom,
        destRow
      ),
      nameCol: layout.nameCol,
      nameFill: NAME_GREEN,
      examGreenColumns: greenColumns,
      examDisabledColumns: disabledColumns,
    });

    // 4. Освободившаяся строка возвращается в «Вакант»
    const oldRange =
      layout.postRanges.find((r) => srcRow! >= r.top && srcRow! <= r.bottom) || layout.overall;
    await clearRowToVacant(
      sheet,
      layout,
      srcRow,
      pickFormatRow(sheet, layout, oldRange.top, oldRange.bottom, srcRow)
    );

    return {
      ok: true,
      message: `${names[0]} переведён на «${params.section.title}»: строка ${srcRow} → ${destRow} (лист «${sheet.title}», отметки экзаменов сохранены)`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Нормализация названия экзамена для сопоставления.
 * Приводим регистр, неразрывные пробелы и «ё» — иначе «Миномётное дело» из
 * формы не найдёт столбец «Минометное дело» в таблице.
 */
function normalizeExamTitle(value: string): string {
  return String(value ?? "")
    .replace(/\u00A0/g, " ") // неразрывный пробел из Google Таблиц
    .replace(/[«»"'']/g, "") // кавычки-ёлочки и лапки на значимость не влияют
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",") // «а , б» → «а,б»
    .trim();
}
/**
 * Прочие внешние кавычки шапок ШДС: типографские («“Топография”») и обратные.
 *
 * Название берета в листе записано именно так, и без снятия этих кавычек столбец
 * «Топография» не находился: рапорт одобрялся, а отметки в таблице не было.
 * Символы заданы escape-последовательностями, чтобы не путать похожие начертания.
 */
const EXTRA_TITLE_QUOTES = /[\u0022\u0027\u0060\u2018\u2019\u201C\u201D\u201E\u201F\u2032]/g;

/**
 * Зарегистрированные алиасы названий: написание → канонический заголовок листа.
 *
 * Ключи и значения — уже в том виде, который даёт нормализация (нижний регистр,
 * «е» вместо «ё»). Соответствие ОДНОЗНАЧНОЕ и направленное: «Миномётное дело» без
 * уточнения — это экзамен, а не обучение. Иначе пара столбцов
 * «(обучение)»/«(Экзамен)» закрашивалась бы одним рапортом, и обучение
 * оказывалось бы «сдано» само по себе.
 */
const EXAM_TITLE_ALIASES: Record<string, string> = {
  // Уставы: в роте слово напечатано с опечаткой («общевоисковые»), в дивизионе —
  // «общевойсковые», а в панели норматив зовут «Уставы общие»
  "уставы общие": "уставы (общевойсковые)",
  "уставы (общевоисковые)": "уставы (общевойсковые)",

  // Миномётное дело: экзамен и обучение — разные столбцы
  "минометное дело": "минометное дело (экзамен)",

  // Артиллерийское дело: то же разделение, плюс сокращение «Арт. дело» из ТЗ
  "арт. дело": "артиллерийское дело (экзамен)",
  "арт дело": "артиллерийское дело (экзамен)",
  "арт. дело (экзамен)": "артиллерийское дело (экзамен)",
  "арт дело (экзамен)": "артиллерийское дело (экзамен)",
  "артиллерийское дело": "артиллерийское дело (экзамен)",
  "арт. дело (обучение)": "артиллерийское дело (обучение)",
  "арт дело (обучение)": "артиллерийское дело (обучение)",
  "арт. дело обучение": "артиллерийское дело (обучение)",
  "арт дело обучение": "артиллерийское дело (обучение)",

  // Сдача на мехвода: в листах роты и дивизиона три написания одного норматива
  "сдача на мех. водителя": "сдача на мехвода",
  "сдача на мехводителя": "сдача на мехвода",

  // Прочие сокращения из ТЗ и форм
  "тест по теории": "прохождение теста по теории",
  "прохождение теста": "прохождение теста по теории",
};

/**
 * Заголовок норматива в каноническом виде — для сопоставления со столбцом листа.
 *
 * Дополнительно к normalizeExamTitle снимаются внешние кавычки шапки (в листе
 * берет записан как «“Топография”»), внешние скобки, а опечатка
 * «Артиллирийское» из ТЗ приводится к корректному написанию: она стоит и в шапке
 * дивизиона, и в написании норматива панелью.
 *
 * Скобки ВНУТРИ названия сохраняются осознанно: иначе «ТТХ (Часть 1)» и
 * «ТТХ (Часть 2)» слились бы в один столбец и один рапорт закрасил бы оба.
 */
function canonicalExamTitle(value: string): string {
  let title = normalizeExamTitle(value)
    .replace(EXTRA_TITLE_QUOTES, "")
    .replace(/\s+/g, " ")
    .trim();

  // Внешние скобки: «(Топография)» → «Топография»
  while (/^\(.*\)$/.test(title)) title = title.slice(1, -1).trim();

  title = title.replace(/артиллирийское/g, "артиллерийское");
  return EXAM_TITLE_ALIASES[title] ?? title;
}

/**
 * Части названия для сопоставления.
 *
 * Google Формы склеивают выбранные флажки через запятую, поэтому название
 * «Снаряжение, обслуживание техники» приходит двумя кусками: сравнение целых
 * строк столбец не находило и заявка падала с «Столбцы экзаменов не найдены».
 */
function canonicalExamParts(value: string): string[] {
  return canonicalExamTitle(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export type ExamMatchResult = {
  /** Индексы столбцов шапки (0-based), которые нужно закрасить */
  columns: number[];
  /** Части ответа, которые не удалось сопоставить ни с одним столбцом */
  unmatched: string[];
};

/**
 * Сопоставление экзаменов из заявки со столбцами шапки листа ШДС.
 *
 * Почему не простое сравнение строк: Google Формы склеивают выбранные флажки
 * через запятую, а название экзамена, которое САМО содержит запятую
 * («Снаряжение, обслуживание техники»), при разборе заявки разъезжается на два
 * куска. Сравнение кусков с заголовком по отдельности столбец не находило, и
 * заявка падала с ошибкой «Столбцы экзаменов не найдены».
 *
 * Поэтому заголовок каждого столбца тоже делится по запятой, и столбец
 * считается найденным, если ВСЕ его части присутствуют среди кусков ответа.
 * Столбцы из нескольких частей проверяются первыми: иначе одиночный кусок
 * «Снаряжение» успел бы «съесть» себя раньше, чем составное название получит
 * свою вторую часть.
 *
 * Имена приводятся к каноническому виду (canonicalExamTitle): снимаются внешние
 * кавычки шапки («“Топография”»), регистр и «ё» не важны, а зарегистрированные
 * алиасы (EXAM_TITLE_ALIASES) сводят написания панели, ТЗ и листа к одному.
 */
export function matchExamColumns(
  headers: string[],
  requested: string[]
): ExamMatchResult {
  const tokens = requested.flatMap((raw) =>
    canonicalExamParts(raw).map((norm) => ({ raw, norm }))
  );
  const used = new Array(tokens.length).fill(false);
  const columns: number[] = [];

  const candidates = headers
    .map((title, index) => ({ index, parts: canonicalExamParts(title) }))
    .filter((h) => h.parts.length > 0)
    // Сначала заголовки из нескольких частей — они самые «жадные»
    .sort((a, b) => b.parts.length - a.parts.length);

  for (const header of candidates) {
    const picked: number[] = [];
    let matched = true;
    for (const part of header.parts) {
      const at = tokens.findIndex(
        (t, i) => !used[i] && !picked.includes(i) && t.norm === part
      );
      if (at === -1) {
        matched = false;
        break;
      }
      picked.push(at);
    }
    if (!matched) continue;
    for (const i of picked) used[i] = true;
    columns.push(header.index);
  }

  // Порядок столбцов — как в шапке, а не как отсортировали кандидатов
  columns.sort((a, b) => a - b);

  return {
    columns,
    // Повтор одного названия не должен выглядеть как несколько несопоставленных
    unmatched: [...new Set(tokens.filter((_, i) => !used[i]).map((t) => t.raw))],
  };
}

/**
 * Конвертация оценки в цифру для записи в ячейку.
 *
 * Оценки в таблице пишутся строго цифрами (5, 4, 3), а не словами. Панель и старые
 * заявки могли присылать «Отлично» / «Хорошо» / «Удовлетворительно», поэтому
 * конвертация обязательна — иначе в ячейке появляется слово вместо цифры.
 */
function gradeToNumber(grade: string): string {
  const normalized = grade.trim().toLowerCase();
  if (/^отл|^5$/i.test(normalized)) return "5";
  if (/^хор|^4$/i.test(normalized)) return "4";
  if (/^уд|^3$/i.test(normalized)) return "3";
  // Неизвестная оценка → по умолчанию 5
  return "5";
}

/** Сценарий Г: «Получение подтверждения об экзаменации» */
async function scenarioExam(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  if (!req.exams.length) throw new Error("В заявке не указаны сданные экзамены");

  await sheet.loadCells();
  const headerRow = layout.examHeaderRow;
  const { start: examFrom, end: examTo } = examBounds(layout);

  /**
   * Заголовки читаются от начала листа до конца БЛОКА ОЦЕНОК этого листа.
   *
   * matchExamColumns возвращает индексы прочитанного массива, и они же
   * используются как индексы колонок — поэтому массив обязан начинаться с
   * колонки A. Границей служит конец блока экзаменов (AE у роты, AG у
   * дивизиона): читать «до 40-й колонки» значило бы заглядывать в служебные
   * столбцы за шапкой, а обрезать по началу блока — сдвинуть оценку на колонку.
   */
  const headers: string[] = [];
  for (let c = 0; c <= examTo; c++) {
    headers.push(String(sheet.getCell(headerRow - 1, c).value ?? "").trim());
  }

  const { columns: matched, unmatched } = matchExamColumns(headers, req.exams);

  // Совпадение вне блока оценок — это не наш столбец: в служебных колонках листа
  // могут стоять слова, совпадающие с названием норматива, и закраска уехала бы
  // в «Заметки» или в чужую служебную ячейку
  const examCols = matched.filter((c) => c >= examFrom && c <= examTo);

  if (!examCols.length) {
    throw new Error(
      `Столбцы экзаменов не найдены в строке ${headerRow}: ${req.exams.join(", ")}`
    );
  }

  const row = findNameRow(sheet, layout, req.userName);
  if (!row) {
    warnMissingSoldier(sheet, layout, [req.userName]);
    throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);
  }

  /**
   * Оценки по столбцам: индекс колонки → оценка рапорта.
   *
   * Каждый норматив с оценкой сопоставляется СО СВОИМ столбцом отдельным
   * вызовом matchExamColumns. Раскладывать оценки по общему результату нельзя:
   * функция возвращает столбцы в порядке ШАПКИ, а рапорт перечисляет нормативы
   * как их выбрал боец, — при обратном порядке оценка встала бы в чужую ячейку
   * (например, «Отлично» за огневую подготовку попало бы в ТТХ).
   */
  const gradesByColumn = new Map<number, string>();
  for (const item of req.examGrades ?? []) {
    const grade = String(item.grade ?? "").trim();
    if (!grade || !item.code) continue;
    const { columns } = matchExamColumns(headers, examColumnTokens([item.code]));
    for (const column of columns) {
      if (column < examFrom || column > examTo) continue;
      // Оценка КМБТ не пишется: базовый экзамен сдаётся без неё
      const title = String(sheet.getCell(headerRow - 1, column).value ?? "").trim();
      if (/кмбт/i.test(title)) continue;
      gradesByColumn.set(column, grade);
    }
  }

  const isKmbtOnly = examCols.every((c) =>
    /кмбт/i.test(String(sheet.getCell(headerRow - 1, c).value ?? ""))
  );

  for (const c of examCols) {
    const cell = sheet.getCell(row - 1, c);
    cell.backgroundColor = { ...EXAM_GREEN };
    const title = String(sheet.getCell(headerRow - 1, c).value ?? "").trim();
    // КМБТ и Берет — базовые экзамены: закрашиваются, но оценки не получают
    if (/кмбт|берет/i.test(title)) {
      cell.value = "";
      continue;
    }
    // Своя оценка норматива из пакетного рапорта, иначе — общая «Оценка» заявки
    const grade = gradesByColumn.get(c) || req.grade;
    if (grade) cell.value = gradeToNumber(grade);
  }

  await sheet.saveUpdatedCells();

  // Проверка автоматического получения берета: если после закраски новых экзаменов
  // у бойца оказались сданы все 4 базовых норматива берета, закрашиваем столбец «Берет»
  const beretGranted = await checkAndGrantBeret(sheet, layout, row, headers, examFrom, examTo);
  if (beretGranted) {
    await sheet.saveUpdatedCells();
  }
  const titles = examCols.map((c) => String(sheet.getCell(headerRow - 1, c).value ?? "").trim());
  const graded = examCols
    .map((c) => ({ title: String(sheet.getCell(headerRow - 1, c).value ?? "").trim(), grade: gradesByColumn.get(c) }))
    .filter((item) => item.grade);
  const gradeStr = graded.length
    ? `, оценки: ${graded.map((item) => `${item.title} — ${item.grade}`).join(", ")}`
    : req.grade && !isKmbtOnly
      ? `, оценка «${req.grade}»`
      : "";
  const examinerStr = req.examiner ? `, экзаменатор: ${req.examiner}` : "";
  // Часть названий могла не найтись (опечатка в форме или переименованный
  // столбец) — раньше об этом молчали, и модератор считал заявку полностью
  // выполненной. Теперь несовпавшие перечисляются явным предупреждением.
  const missedStr = unmatched.length
    ? `. ВНИМАНИЕ: не найдены в таблице — ${unmatched.join(", ")}`
    : "";
  return `Отмечены экзамены (${titles.join(", ")}) для ${req.userName} (строка ${row})${gradeStr}${examinerStr}${missedStr}`;
}

/**
 * Проверка и автоматическое присвоение берета.
 *
 * Если у бойца закрашены все 4 базовых норматива берета (Топография, Связь,
 * Строевая подготовка, Должностные лица), автоматически закрашивается столбец
 * «Берет» ярко-зелёным цветом.
 *
 * Возвращает true, если столбец «Берет» был закрашен (требуется saveUpdatedCells).
 */
async function checkAndGrantBeret(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  row: number,
  headers: string[],
  examFrom: number,
  examTo: number
): Promise<boolean> {
  // 4 базовых норматива берета (из BERET_EXAM_CODES в reports.ts)
  const beretRequirements = [
    "топография",
    "связь",
    "строевая подготовка",
    "должностные лица",
  ];

  // Проверяем, сданы ли все 4 норматива
  const passedBeretExams: string[] = [];
  for (let c = examFrom; c <= examTo; c++) {
    const title = String(sheet.getCell(layout.examHeaderRow - 1, c).value ?? "").trim();
    const canonical = canonicalExamTitle(title);
    if (beretRequirements.includes(canonical)) {
      if (isExamGreen(sheet.getCell(row - 1, c).backgroundColor)) {
        passedBeretExams.push(canonical);
      }
    }
  }

  // Если сданы все 4, закрашиваем столбец «Берет»
  if (passedBeretExams.length === beretRequirements.length) {
    for (let c = examFrom; c <= examTo; c++) {
      const title = String(sheet.getCell(layout.examHeaderRow - 1, c).value ?? "").trim();
      const canonical = canonicalExamTitle(title);
      if (canonical === "берет") {
        const beretCell = sheet.getCell(row - 1, c);
        beretCell.backgroundColor = { ...EXAM_GREEN };
        beretCell.value = ""; // Столбец «Берет» закрашивается без текста
        return true;
      }
    }
  }
  return false;
}

/** Сценарий Д: «Убрать из таблицы» */
async function scenarioRemove(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);
  const srcRow = findNameRow(sheet, layout, req.userName);
  if (!srcRow) {
    warnMissingSoldier(sheet, layout, [req.userName]);
    throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);
  }

  const range =
    layout.postRanges.find((r) => srcRow >= r.top && srcRow <= r.bottom) || layout.overall;

  // Строка сбрасывается в «Вакант» не копированием шаблона, а тем же
  // приведением, что и при переносе: должность секции возвращается на место,
  // оценки и заливки сбрасываются, границы восстанавливаются. Копирование
  // строки-шаблона переносило и её значения — в колонке должности оказывалось
  // содержимое чужой строки, а границы зависели от того, как оформлен шаблон.
  await clearRowToVacant(
    sheet,
    layout,
    srcRow,
    pickFormatRow(sheet, layout, range.top, range.bottom, srcRow)
  );

  return `${req.userName} убран из таблицы (строка ${srcRow} возвращена в «Вакант»)`;
}

/* ------------------------------------------------------------------ */
/* Диспетчер обработки заявок                                          */
/* ------------------------------------------------------------------ */

export type ShdsResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Выполняет заявку ШДС в Google Таблице.
 * Вызывается из бота при одобрении (зелёный круг / :ATK:).
 */
export async function applyShdsRequest(req: ParsedRequest): Promise<ShdsResult> {
  try {
    if (req.isVacation) {
      return { ok: false, error: "Заявка на отпуск обрабатывается не в таблице" };
    }
    if (!req.shdsAction) {
      return { ok: false, error: "Неизвестный тип «Редакция ШДС»" };
    }
    if (
      req.shdsAction === SHDS_ACTIONS.RESERVE_GO ||
      req.shdsAction === SHDS_ACTIONS.RESERVE_BACK
    ) {
      return {
        ok: false,
        error: "Заявки запаса обрабатываются в модуле reserve.ts (бот вызывает их напрямую)",
      };
    }

    const sheet = await getSheet(req.unit);
    const layout = resolveLayout(req.unit);

    let message: string;
    switch (req.shdsAction) {
      case SHDS_ACTIONS.ADD:
        message = await scenarioAdd(sheet, layout, req);
        break;
      case SHDS_ACTIONS.RANK:
        message = await scenarioRank(sheet, layout, req);
        break;
      case SHDS_ACTIONS.POST:
        message = await scenarioPost(sheet, layout, req);
        break;
      case SHDS_ACTIONS.EXAM:
        message = await scenarioExam(sheet, layout, req);
        break;
      case SHDS_ACTIONS.REMOVE:
        message = await scenarioRemove(sheet, layout, req);
        break;
      default:
        return { ok: false, error: "Сценарий не реализован" };
    }

    await logSheetsEvent(req, message, true, null);
    return { ok: true, message };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await logSheetsEvent(req, "Ошибка обработки заявки", false, error).catch(() => {});
    return { ok: false, error };
  }
}

/** Запись в журнал сайта о работе с Google Таблицей */
async function logSheetsEvent(
  req: ParsedRequest,
  message: string,
  ok: boolean,
  error: string | null
) {
  try {
    const { db } = await import("@/db");
    const { logs } = await import("@/db/schema");
    await db.insert(logs).values({
      category: "edit",
      author: "Discord-бот",
      action: `${req.shdsAction || "Заявка"} · ${req.unit} · ${req.userName}`,
      details: {
        "Подразделение": req.unit,
        "Боец": req.userName,
        "Итог": message,
      },
      kind: "system",
      title: ok ? "Google Таблица: заявка выполнена" : "Google Таблица: ошибка заявки",
      detail: error ? `${message}: ${error}` : message,
      ok,
    });
  } catch (e) {
    console.error("[gsheets] Не удалось записать журнал:", e);
  }
}


/* ------------------------------------------------------------------ */
/* Правка состава панелью: колонка Discord ID                          */
/* ------------------------------------------------------------------ */

/**
 * Обновление ячейки Discord ID на листе подразделения без заявки ШДС.
 *
 * Зачем отдельная функция, а не вызов applyShdsRequest: тот принимает
 * ParsedRequest («Редакция ШДС», звание, экзамены…) и выполняет сценарий
 * целиком — например «Добавление в ШДС» кладёт бойца в свободную строку
 * «Вакант» и заливает имя. Для правки одного столбца это неверно: боец уже
 * стоит в таблице, менять надо ровно одну ячейку.
 *
 * Колонка та же, что у сценария А (три столбца правее колонки имени) —
 * сверено со scripts/verify-sheet.mjs, который читает её так же.
 */
export async function syncDiscordIdToSheet(params: {
  /** Подразделение бойца: оно же название листа («Танковая рота» / «Артиллерийский дивизион») */
  unit: string;
  /**
   * Кандидаты имени бойца в таблице.
   *
   * Список, а не одно имя: в табеле панели боец записан ФИО из rs-red.com, а в
   * ШДС нередко стоит позывной (и наоборот — сценарий «Добавление в ШДС» пишет
   * туда именно callsign). Перебор двух вариантов избавляет штаб от ошибки
   * «боец не найден» там, где панель и таблица зовут человека по-разному.
   */
  names: readonly string[];
  /** Новый Discord ID; пустая строка очищает ячейку */
  discordId: string;
}): Promise<ShdsResult> {
  const unit = params.unit.trim();
  if (!unit) {
    return { ok: false, error: "Бойцу не назначено подразделение — неизвестно, в какой лист писать" };
  }
  const names = params.names.map((n) => (n || "").trim()).filter(Boolean);
  if (!names.length) {
    return { ok: false, error: "Неизвестно имя бойца для поиска строки в таблице" };
  }

  try {
    const sheet = await getSheet(unit);
    const layout = resolveLayout(unit);
    await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);

    let row: number | null = null;
    for (const name of names) {
      row = findNameRow(sheet, layout, name);
      if (row) break;
    }
    if (!row) {
      warnMissingSoldier(sheet, layout, names);
      throw new Error(`Боец «${names.join("» / «")}» не найден на листе «${sheet.title}»`);
    }

    const discordCell = cellAt(sheet, row, colLetter(colIndex(layout.nameCol) + 3));
    discordCell.value = params.discordId;
    applyStdFormat(discordCell);
    await sheet.saveUpdatedCells();

    return {
      ok: true,
      message: params.discordId
        ? `Discord ID записан в лист «${sheet.title}» (строка ${row})`
        : `Discord ID очищен в листе «${sheet.title}» (строка ${row})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Чтение сданных нормативов бойца со листа                            */
/* ------------------------------------------------------------------ */

/**
 * Сданные нормативы бойца по состоянию листа ШДС.
 *
 * Читается закраска колонок блока оценок ЭТОГО листа (H..AE у роты, I..AG у
 * дивизиона): зелёная заливка ячейки — это и есть отметка «сдал». Заголовки
 * берутся из строки шапки (examHeaderRow), а столбец норматива — по позиции
 * заголовка в шапке: список названий и список колонок идут от одной и той же
 * границы, поэтому оценка не может «съехать» на соседний норматив.
 *
 * Зачем это нужно в панели, а не только в боте: требование ступени при переводе
 * по должности проверяется по СДАННЫМ нормативам, а отметка могла появиться
 * правкой таблицы, без рапорта через панель. Смотри мы только рапорты — боец с
 * реально закрашенными экзаменами получал бы отказ «не сданы».
 *
 * Ошибка чтения не считается отказом перевода: возвращается пустой список, и
 * проверка требований идёт по истории рапортов. Иначе недоступный Google API
 * блокировал бы работу штаба целиком.
 */
export async function examsFromSheet(params: {
  unit: string;
  /** Кандидаты имени в таблице (позывной и ФИО) */
  names: readonly string[];
}): Promise<string[]> {
  const unit = params.unit.trim();
  const names = params.names.map((n) => (n || "").trim()).filter(Boolean);
  if (!unit || !names.length) return [];

  try {
    const sheet = await getSheet(unit);
    const layout = resolveLayout(unit);
    await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);

    let row: number | null = null;
    for (const name of names) {
      row = findNameRow(sheet, layout, name);
      if (row) break;
    }
    if (!row) return [];

    // Шапка экзаменов: заголовки могут лежать выше общего диапазона участников,
    // поэтому строка читается отдельно — от начала листа до конца блока оценок
    const { start: examFrom, end: examTo } = examBounds(layout);
    await sheet.loadCells(`${ROW_START_COL}${layout.examHeaderRow}:${layout.examEndCol}${layout.examHeaderRow}`);

    const headerRow = layout.examHeaderRow;
    const passed: string[] = [];
    // Заголовок и закраска читаются в ОДНОМ цикле по одной и той же колонке:
    // два прохода по разным границам (как было раньше) разъезжались на колонку
    // у дивизиона, и «сдано» приписывалось соседнему нормативу
    for (let c = examFrom; c <= examTo; c++) {
      const title = String(sheet.getCell(headerRow - 1, c).value ?? "").trim();
      if (!title) continue;
      if (isExamGreen(sheet.getCell(row - 1, c).backgroundColor)) passed.push(title);
    }
    return passed;
  } catch (e) {
    console.warn("[gsheets] Не удалось прочитать сданные нормативы с листа:", e);
    return [];
  }
}

/**
 * Зелёная заливка ячейки.
 *
 * Сравнивается не «точное равенство цвета», а доминирование зелёного канала:
 * в таблице встречаются оттенки одного и того же зачёта (светло-зелёный от
 * условного форматирования, зелёный EXAM_GREEN), и строгое сравнение пропускало
 * бы половину отметок.
 */
function isExamGreen(color: CellColor | undefined | null): boolean {
  if (!color) return false;
  const { red = 0, green = 0, blue = 0 } = color;
  return green > 0.5 && green - red > 0.15 && green - blue > 0.15;
}