/**
 * Google Таблица (ШДС) — клиент и алгоритмы из ТЗ.
 * Сервисный аккаунт («паспорт») берётся из настроек панели
 * (ключ gsheet_service_account — JSON-текст) либо из файла-паспорта
 * src/lib/google-service-account.json.
 */
import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from "google-spreadsheet";
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
} as const;

export type ShdsAction = (typeof SHDS_ACTIONS)[keyof typeof SHDS_ACTIONS];

/** Структура разобранной заявки (вебхук → текст) */
export type ParsedRequest = {
  raw: string;
  isVacation: boolean;
  shdsAction: ShdsAction | null;
  unit: string;          // «Подразделение» — имя листа
  userName: string;      // «Имя пользователя»
  rank: string;          // «Звание»
  steamId: string;       // «Steam ID»
  discordId: string;     // «Discord ID»
  отделение: string;     // «Отделение» (Артиллерийский дивизион)
  должность: string;     // «Должность»
  exams: string[];       // «Сданные экзамены»
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

  const unit = field("Подразделение");
  const userName = field("Имя пользователя");
  if (!unit || !userName) return null;

  const shdsRaw = field("Редакция ШДС");
  const vacationRaw = field("Тип заявки");
  const isVacation = !shdsRaw && /отпуск/i.test(vacationRaw);

  let shdsAction: ShdsAction | null = null;
  if (shdsRaw) {
    const low = shdsRaw.toLowerCase();
    if (low.includes("добавление")) shdsAction = SHDS_ACTIONS.ADD;
    else if (low.includes("звание")) shdsAction = SHDS_ACTIONS.RANK;
    else if (low.includes("должность")) shdsAction = SHDS_ACTIONS.POST;
    else if (low.includes("экзамен")) shdsAction = SHDS_ACTIONS.EXAM;
    else if (low.includes("убрать")) shdsAction = SHDS_ACTIONS.REMOVE;
  }

  const examsRaw = field("Сданные экзамены");
  const exams = examsRaw
    ? examsRaw.split(/[,;]/).map((x) => clean(x)).filter(Boolean)
    : [];

  return {
    raw: text,
    isVacation,
    shdsAction,
    unit,
    userName,
    rank: field("Звание"),
    steamId: field("Steam ID"),
    discordId: field("Discord ID").replace(/[^\d]/g, ""),
    отделение: field("Отделение"),
    должность: field("Должность"),
    exams,
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

/** Документ Google Таблицы по ID из настроек (с кэшем авторизации) */
export async function getDoc(): Promise<GoogleSpreadsheet> {
  const map = await getSettings();
  const id = (map.get("gsheet_spreadsheet_id") || "").trim();
  if (!id) throw new Error("Не задан ID Google-таблицы (настройка gsheet_spreadsheet_id)");
  if (cachedDoc && cachedDoc.id === id) return cachedDoc.doc;

  const creds = await loadServiceAccount();
  const doc = new GoogleSpreadsheet(id);
  await doc.useServiceAccountAuth(creds as never);
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
    dest.backgroundColor = src.backgroundColor ? { ...src.backgroundColor } : undefined;
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
      cell.backgroundColor = undefined;
    }
  }

  await sheet.saveUpdatedCells();
  return `${req.userName} переведён на «${req.должность}»: строка ${srcRow} → ${destRow} (лист «${sheet.title}»)`;
}

/** Сценарий Г: «Получение подтверждения об экзаменации» */
async function scenarioExam(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  if (!req.exams.length) throw new Error("В заявке не указаны сданные экзамены");

  await sheet.loadCells();
  const headerRow = layout.examHeaderRow;
  const maxCol = Math.min(sheet.columnCount, 40);

  // Столбцы экзаменов по точному совпадению названия
  const examCols: number[] = [];
  for (let c = 0; c < maxCol; c++) {
    const v = String(sheet.getCell(headerRow - 1, c).value ?? "").trim().toLowerCase();
    if (!v) continue;
    if (req.exams.some((e) => e.toLowerCase() === v)) examCols.push(c);
  }
  if (!examCols.length) {
    throw new Error(
      `Столбцы экзаменов не найдены в строке ${headerRow}: ${req.exams.join(", ")}`
    );
  }

  const row = findNameRow(sheet, layout, req.userName);
  if (!row) throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);

  for (const c of examCols) {
    sheet.getCell(row - 1, c).backgroundColor = { ...EXAM_GREEN };
  }

  await sheet.saveUpdatedCells();
  const titles = examCols.map((c) => String(sheet.getCell(headerRow - 1, c).value ?? "").trim());
  return `Отмечены экзамены (${titles.join(", ")}) для ${req.userName} (строка ${row})`;
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

