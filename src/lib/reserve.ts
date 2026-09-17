/**
 * Запас — перевод бойца в запас и возврат.
 *
 * «Уйти в запас»: СТРОКА БОЙЦА ЦЕЛИКОМ (колонки A–T, включая заливки
 * сданных экзаменов и форматирование) копируется на лист «Запас», на листе
 * подразделения затирается шаблоном «Вакант». Служебные данные (подразделение,
 * Discord-роли для восстановления, дата ухода) пишутся в колонки U–W листа
 * «Запас». В Discord снимаются все роли и выдаётся роль «Запас».
 *
 * «Вернуться из запаса»: строка целиком возвращается на лист подразделения
 * (первая свободная «Вакант»-строка) со ВСЕМИ отметками об экзаменах, строка
 * на листе «Запас» очищается. Роли восстанавливаются, роль «Запас» снимается.
 */
import { GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { getSettings } from "@/lib/settings";
import {
  getDoc,
  getSheet,
  findNameRow,
  findVacantRow,
  copyRow,
  resolveLayout,
  type UnitLayout,
} from "@/lib/gsheets";

/** Служебные колонки листа «Запас» (после снапшота строки A–T) */
const META_COL = {
  unit: 20,  // U — подразделение (имя листа)
  roles: 21, // V — сохранённые Discord-роли через запятую
  date: 22,  // W — дата ухода
} as const;

/** Границы копируемого снапшота строки */
const SNAP_COLS = 20; // A–T

export type ReserveResult = { ok: true; message: string } | { ok: false; error: string };

/** Название листа запаса из настроек */
async function reserveSheetName(): Promise<string> {
  const map = await getSettings();
  return (map.get("reserve_sheet_name") || "Запас").trim() || "Запас";
}

/** Получить (или создать) лист запаса */
async function getReserveSheet(
  doc: Awaited<ReturnType<typeof getDoc>>
): Promise<GoogleSpreadsheetWorksheet> {
  const name = await reserveSheetName();
  const sheets = Object.values(doc.sheetsById) as GoogleSpreadsheetWorksheet[];
  const existing = sheets.find(
    (s) => (s.title || "").trim().toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing;

  const headers: string[] = new Array(SNAP_COLS).fill("");
  headers[META_COL.unit] = "Подразделение";
  headers[META_COL.roles] = "Discord-роли (служебное)";
  headers[META_COL.date] = "Дата ухода";
  return doc.addSheet({ title: name, headerValues: headers });
}

/**
 * Копирование строки МЕЖДУ листами: значения + шрифты + заливки + выравнивание.
 * Именно заливки сохраняют зелёные отметки сданных экзаменов.
 */
function copyRowBetween(
  srcSheet: GoogleSpreadsheetWorksheet,
  srcRow: number,
  destSheet: GoogleSpreadsheetWorksheet,
  destRow: number
) {
  for (let c = 0; c < SNAP_COLS; c++) {
    const src = srcSheet.getCell(srcRow - 1, c);
    const dest = destSheet.getCell(destRow - 1, c);
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

/** Первая свободная строка на листе запаса (нет имени и нет подразделения) */
function nextReserveRow(sheet: GoogleSpreadsheetWorksheet): number {
  for (let r = 2; r <= Math.max(sheet.rowCount, 200); r++) {
    let empty = true;
    for (let c = 0; c <= META_COL.date; c++) {
      if (String(sheet.getCell(r - 1, c).value ?? "").trim()) {
        empty = false;
        break;
      }
    }
    if (empty) return r;
  }
  return Math.max(sheet.rowCount, 200) + 1;
}

/**
 * Поиск строки бойца на листе запаса: имя ищем в той же колонке, где оно
 * лежит на листе подразделения (по сохранённому в U подразделению).
 */
function findReserveRow(
  sheet: GoogleSpreadsheetWorksheet,
  name: string
): { row: number; unit: string; layout: UnitLayout } | null {
  const target = name.trim().toLowerCase();
  for (let r = 2; r <= sheet.rowCount; r++) {
    const unit = String(sheet.getCell(r - 1, META_COL.unit).value ?? "").trim();
    if (!unit) continue;
    let layout: UnitLayout;
    try {
      layout = resolveLayout(unit);
    } catch {
      continue;
    }
    const nameColIdx = layout.nameCol.charCodeAt(0) - 65;
    const v = String(sheet.getCell(r - 1, nameColIdx).value ?? "").trim().toLowerCase();
    if (v && v === target) return { row: r, unit, layout };
  }
  return null;
}

/** Затереть строку запаса (снапшот + служебные колонки) */
async function clearReserveRow(sheet: GoogleSpreadsheetWorksheet, row: number) {
  for (let c = 0; c <= META_COL.date; c++) {
    const cell = sheet.getCell(row - 1, c);
    cell.value = "";
    // v5: очистка формата выполняется методом (setters не принимают undefined)
    cell.clearAllFormatting();
  }
  await sheet.saveUpdatedCells();
}

/**
 * НИЖНЯЯ свободная строка («Вакант») в блоке должности бойца — чтобы при
 * возврате из запаса он встал на своё место по должности, не мешая другим.
 * Блок определяем по сохранённой в снапшоте должности (колонка рядом с именем).
 */
function findBottomVacantRowInPostBlock(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  resRowSnapshot: { post: string; отделение: string }
): number | null {
  // 1. Определяем целевой блок по должности/отделению
  const haystacks = [resRowSnapshot.post, resRowSnapshot.отделение].filter(Boolean);
  let range: { top: number; bottom: number } | null = null;
  for (const r of layout.postRanges) {
    if (haystacks.some((h) => r.match.test(h))) {
      range = r;
      break;
    }
  }
  if (!range) range = layout.addRange;

  // 2. Ищем «Вакант» СВЕРХУ ВНИЗ и берём ПОСЛЕДНЮЮ (нижнюю) свободную строку
  let bottomRow: number | null = null;
  for (let row = range.top; row <= range.bottom; row++) {
    const v = sheet.getCell(row - 1, layout.nameCol.charCodeAt(0) - 65).value;
    if (String(v ?? "").trim().toLowerCase() === "вакант") bottomRow = row;
  }

  // 3. Если в блоке должности мест нет — ищем нижнюю свободную в общем диапазоне
  if (!bottomRow) {
    for (let row = layout.overall.top; row <= layout.overall.bottom; row++) {
      const v = sheet.getCell(row - 1, layout.nameCol.charCodeAt(0) - 65).value;
      if (String(v ?? "").trim().toLowerCase() === "вакант") bottomRow = row;
    }
  }
  return bottomRow;
}

/** Перевести бойца в запас (ШДС) */
export async function moveToReserve(req: {
  userName: string;
  unit: string;
  rank?: string;
  steamId?: string;
  discordId?: string;
  post?: string;
  roles?: string[];
}): Promise<ReserveResult> {
  try {
    const doc = await getDoc();
    const layout = resolveLayout(req.unit);
    const unitSheet = await getSheet(req.unit);

    // 1. Находим строку бойца на листе подразделения
    await unitSheet.loadCells();
    const srcRow = findNameRow(unitSheet, layout, req.userName);
    if (!srcRow) throw new Error(`Боец ${req.userName} не найден на листе «${req.unit}»`);

    // 2. Копируем строку ЦЕЛИКОМ (с заливками экзаменов) на лист запаса
    const reserveSheet = await getReserveSheet(doc);
    await reserveSheet.loadCells();
    const destRow = nextReserveRow(reserveSheet);

    copyRowBetween(unitSheet, srcRow, reserveSheet, destRow);

    // Служебные данные для возврата
    reserveSheet.getCell(destRow - 1, META_COL.unit).value = req.unit;
    reserveSheet.getCell(destRow - 1, META_COL.roles).value = (req.roles || []).join(",");
    reserveSheet.getCell(destRow - 1, META_COL.date).value = new Date()
      .toISOString()
      .slice(0, 10);
    await reserveSheet.saveUpdatedCells();

    // 3. Затирка строки на листе подразделения шаблоном «Вакант»
    const range =
      layout.postRanges.find((r) => srcRow >= r.top && srcRow <= r.bottom) || layout.overall;
    const templateRow = findVacantRow(unitSheet, layout, range.top, range.bottom, srcRow);
    if (templateRow) {
      copyRow(unitSheet, templateRow, srcRow);
    } else {
      // Шаблона нет — чистим вручную, имя заменяем на «Вакант»
      const nameColIdx = layout.nameCol.charCodeAt(0) - 65;
      for (let c = 0; c < SNAP_COLS; c++) {
        const cell = unitSheet.getCell(srcRow - 1, c);
        cell.value = c === nameColIdx ? "Вакант" : "";
        // v5: очистка заливки выполняется методом (setters не принимают undefined)
        cell.clearAllFormatting();
      }
    }
    await unitSheet.saveUpdatedCells();

    const resName = await reserveSheetName();
    return {
      ok: true,
      message: `${req.userName} переведён в запас: строка ${srcRow} (лист «${req.unit}») → строка ${destRow} (лист «${resName}»), отметки экзаменов сохранены`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Вернуть бойца из запаса (ШДС) */
export async function returnFromReserve(req: {
  userName: string;
  unit?: string;
  rank?: string;
  steamId?: string;
  discordId?: string;
  post?: string;
}): Promise<ReserveResult & { roles?: string[] }> {
  try {
    const doc = await getDoc();
    const reserveSheet = await getReserveSheet(doc);
    await reserveSheet.loadCells();

    // 1. Находим строку бойца на листе запаса
    const found = findReserveRow(reserveSheet, req.userName);
    if (!found) throw new Error(`Боец ${req.userName} не найден на листе запаса`);
    const { row: resRow, unit, layout } = found;

    // 2. Сохранённые Discord-роли для восстановления
    const rolesRaw = String(reserveSheet.getCell(resRow - 1, META_COL.roles).value ?? "").trim();
    const roles = rolesRaw ? rolesRaw.split(",").map((r) => r.trim()).filter(Boolean) : [];

    // 3. Возвращаем строку ЦЕЛИКОМ (с экзаменами) на лист подразделения —
    //    в НИЖНЮЮ свободную строку блока прежней должности, чтобы не мешать другим
    const unitSheet = await getSheet(unit);
    await unitSheet.loadCells();
    const nameColIdx = layout.nameCol.charCodeAt(0) - 65;
    const savedPost = String(
      reserveSheet.getCell(resRow - 1, nameColIdx + 1).value ?? ""
    ).trim();
    const destRow = findBottomVacantRowInPostBlock(unitSheet, layout, {
      post: savedPost,
      отделение: "",
    });
    if (!destRow) throw new Error(`На листе «${unit}» нет свободных строк («Вакант»)`);

    copyRowBetween(reserveSheet, resRow, unitSheet, destRow);
    await unitSheet.saveUpdatedCells();

    // 4. Затирка строки на листе запаса
    await clearReserveRow(reserveSheet, resRow);

    const resName = await reserveSheetName();
    return {
      ok: true,
      message: `${req.userName} возвращён из запаса (лист «${resName}», строка ${resRow}) в «${unit}», строка ${destRow}${savedPost ? ` (блок должности «${savedPost}»)` : ""}. Отметки экзаменов восстановлены.`,
      roles,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
