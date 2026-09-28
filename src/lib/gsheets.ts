/**
 * Google Таблица (ШДС) — клиент и алгоритмы из ТЗ.
 * Сервисный аккаунт («паспорт») берётся из настроек панели
 * (ключ gsheet_service_account — JSON-текст) либо из файла-паспорта
 * src/lib/google-service-account.json.
 */
import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { getSettings } from "@/lib/settings";
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

export type UnitLayout = {
  key: "TR" | "AD";
  nameCol: string;                              // колонка имени / «Вакант»
  overall: { top: number; bottom: number };     // общий диапазон поиска имени
  addRange: { top: number; bottom: number };    // «Добавление в ШДС»
  postRanges: { match: RegExp; top: number; bottom: number }[]; // «Изменение должности»
  examHeaderRow: number;                        // строка с названиями экзаменов
};

const LAYOUTS: Record<"TR" | "AD", UnitLayout> = {
  // Танковая рота (колонка C)
  TR: {
    key: "TR",
    nameCol: "C",
    overall: { top: 10, bottom: 56 },
    addRange: { top:  42, bottom: 56 },
    postRanges: [
      { match: /логист|снабжен/i, top: 42, bottom: 56 },
      { match: /мех.?водител/i, top: 28, bottom: 40 },
      { match: /наводчик/i, top: 21, bottom: 26 },
      { match: /командир/i, top: 10, bottom: 19 },
    ],
    examHeaderRow: 6,
  },
  // Артиллерийский дивизион (колонка D)
  AD: {
    key: "AD",
    nameCol: "D",
    overall: { top: 12, bottom: 41 },
    addRange: { top: 32, bottom: 41 },
    postRanges: [
      { match: /снабжен/i, top: 32, bottom: 41 },
      { match: /1\s*оов/i, top: 12, bottom: 20 },
      { match: /2\s*оов/i, top: 22, bottom: 30 },
    ],
    examHeaderRow: 8,
  },
};

/** Раскладка подразделения по названию листа */
export function resolveLayout(unit: string): UnitLayout {
  const u = unit.toLowerCase();
  if (/танк/.test(u)) return LAYOUTS.TR;
  if (/дивизион|артиллер/.test(u)) return LAYOUTS.AD;
  throw new Error(
    `Неизвестное подразделение «${unit}»: ожидались «Танковая рота» или «Артиллерийский дивизион»`
  );
}

/** Границы копирования «строки целиком» (включая заливки экзаменов) */
const ROW_START_COL = "A";
const ROW_END_COL = "T";

/** Зелёная заливка сданного экзамена */
const EXAM_GREEN = { red: 0.37, green: 0.77, blue: 0.42, alpha: 1 };

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

/** Свободная строка — значение «Вакант» */
function isVacant(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "вакант";
}

/** Загрузить область строк целиком */
async function loadArea(sheet: GoogleSpreadsheetWorksheet, top: number, bottom: number) {
  await sheet.loadCells(`${ROW_START_COL}${top}:${ROW_END_COL}${bottom}`);
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

/** Строка бойца по имени в общем диапазоне подразделения */
export function findNameRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  name: string,
  excludeRow?: number
): number | null {
  const target = name.trim().toLowerCase();
  for (let row = layout.overall.top; row <= layout.overall.bottom; row++) {
    if (excludeRow && row === excludeRow) continue;
    const v = String(cellAt(sheet, row, layout.nameCol).value ?? "").trim().toLowerCase();
    if (v && v === target) return row;
  }
  return null;
}

/** Копирование строки целиком: значения + шрифты + заливки + выравнивание */
export function copyRow(sheet: GoogleSpreadsheetWorksheet, srcRow: number, destRow: number) {
  const start = colIndex(ROW_START_COL);
  const end = colIndex(ROW_END_COL);
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

/** Сценарий А: «Добавление в ШДС» */
async function scenarioAdd(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout.addRange.top, layout.addRange.bottom);
  const row = findVacantRow(sheet, layout, layout.addRange.top, layout.addRange.bottom);
  if (!row) throw new Error("В диапазоне добавления нет свободных строк («Вакант»)");

  const nameCol = colIndex(layout.nameCol);
  const rankCell = cellAt(sheet, row, colLetter(nameCol - 1));
  const nameCell = cellAt(sheet, row, layout.nameCol);
  const steamCell = cellAt(sheet, row, colLetter(nameCol + 2));
  const discordCell = cellAt(sheet, row, colLetter(nameCol + 3));

  rankCell.value = req.rank;
  nameCell.value = req.userName;
  steamCell.value = req.steamId;
  discordCell.value = req.discordId;

  applyStdFormat(rankCell);
  applyStdFormat(nameCell);
  applyStdFormat(steamCell);
  applyStdFormat(discordCell);

  // Зелёная заливка имени (колонка C) — признак занятой строки
  nameCell.backgroundColor = { ...EXAM_GREEN };

  await sheet.saveUpdatedCells();
  return `Боец ${req.userName} добавлен в строку ${row} (лист «${sheet.title}»)`;
}

/** Сценарий Б: «Изменение звания» */
async function scenarioRank(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout.overall.top, layout.overall.bottom);
  const row = findNameRow(sheet, layout, req.userName);
  if (!row) throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);

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
  await loadArea(sheet, layout.overall.top, layout.overall.bottom);
  const srcRow = findNameRow(sheet, layout, req.userName);
  if (!srcRow) throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);

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

  // 3. Ищем свободную строку «Вакант» в целевом диапазоне
  let destRow: number | null = null;
  if (srcRow >= target.top && srcRow <= target.bottom) {
    // Боец остаётся в своём диапазоне — просто обновляем должность
    await sheet.saveUpdatedCells();
    return `Должность ${req.userName} обновлена на «${req.должность}» (строка ${srcRow})`;
  }
  destRow = findVacantRow(sheet, layout, target.top, target.bottom, srcRow);
  if (!destRow) throw new Error("В целевом диапазоне нет свободных строк («Вакант»)");

  // 4. Переносим бойца на новое место
  copyRow(sheet, srcRow, destRow);

  // 5. Зачищаем старое место строкой-шаблоном «Вакант» из того же диапазона
  const oldRange =
    layout.postRanges.find((r) => srcRow >= r.top && srcRow <= r.bottom) || layout.overall;
  const templateRow = findVacantRow(sheet, layout, oldRange.top, oldRange.bottom, srcRow);
  if (templateRow) {
    copyRow(sheet, templateRow, srcRow);
    // после копирования шаблона старая ячейка имени снова «Вакант»
  } else {
    // Шаблона нет — чистим вручную значения и заливки строки
    for (let c = colIndex(ROW_START_COL); c <= colIndex(ROW_END_COL); c++) {
      const cell = sheet.getCell(srcRow - 1, c);
      cell.value = c === colIndex(layout.nameCol) ? "Вакант" : "";
      // v5: полная очистка формата делается методом, а не присваиванием undefined
      cell.clearAllFormatting();
    }
  }

  await sheet.saveUpdatedCells();
  return `${req.userName} переведён на «${req.должность}»: строка ${srcRow} → ${destRow} (лист «${sheet.title}»)`;
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

/** Сценарий Г: «Получение подтверждения об экзаменации» */
async function scenarioExam(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  if (!req.exams.length) throw new Error("В заявке не указаны сданные экзамены");

  await sheet.loadCells();
  const headerRow = layout.examHeaderRow;
  const maxCol = Math.min(sheet.columnCount, 40);

  const headers: string[] = [];
  for (let c = 0; c < maxCol; c++) {
    headers.push(String(sheet.getCell(headerRow - 1, c).value ?? "").trim());
  }

  const { columns: examCols, unmatched } = matchExamColumns(headers, req.exams);

  if (!examCols.length) {
    throw new Error(
      `Столбцы экзаменов не найдены в строке ${headerRow}: ${req.exams.join(", ")}`
    );
  }

  const row = findNameRow(sheet, layout, req.userName);
  if (!row) throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);

  const isKmbt = req.exams.some((e) => /кмбт/i.test(e));
  for (const c of examCols) {
    const cell = sheet.getCell(row - 1, c);
    cell.backgroundColor = { ...EXAM_GREEN };
    // Оценка записывается в ячейку (КМБТ — базовый экзамен, без оценки)
    if (req.grade && !isKmbt) cell.value = req.grade;
  }

  await sheet.saveUpdatedCells();
  const titles = examCols.map((c) => String(sheet.getCell(headerRow - 1, c).value ?? "").trim());
  const gradeStr = req.grade && !isKmbt ? `, оценка «${req.grade}»` : "";
  const examinerStr = req.examiner ? `, экзаменатор: ${req.examiner}` : "";
  // Часть названий могла не найтись (опечатка в форме или переименованный
  // столбец) — раньше об этом молчали, и модератор считал заявку полностью
  // выполненной. Теперь несовпавшие перечисляются явным предупреждением.
  const missedStr = unmatched.length
    ? `. ВНИМАНИЕ: не найдены в таблице — ${unmatched.join(", ")}`
    : "";
  return `Отмечены экзамены (${titles.join(", ")}) для ${req.userName} (строка ${row})${gradeStr}${examinerStr}${missedStr}`;
}

/** Сценарий Д: «Убрать из таблицы» */
async function scenarioRemove(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout.overall.top, layout.overall.bottom);
  const srcRow = findNameRow(sheet, layout, req.userName);
  if (!srcRow) throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);

  const range =
    layout.postRanges.find((r) => srcRow >= r.top && srcRow <= r.bottom) || layout.overall;
  const templateRow = findVacantRow(sheet, layout, range.top, range.bottom, srcRow);
  if (!templateRow) throw new Error("Не найдена строка-шаблон «Вакант» для зачистки");

  copyRow(sheet, templateRow, srcRow);
  await sheet.saveUpdatedCells();
  return `${req.userName} убран из таблицы (строка ${srcRow} сброшена шаблоном «Вакант»)`;
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
    await loadArea(sheet, layout.overall.top, layout.overall.bottom);

    let row: number | null = null;
    for (const name of names) {
      row = findNameRow(sheet, layout, name);
      if (row) break;
    }
    if (!row) {
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