/**
 * Запас — перевод бойца в запас и возврат.
 *
 * «Уйти в запас»: СТРОКА БОЙЦА ЦЕЛИКОМ (колонки A–AG, включая заливки
 * сданных экзаменов и форматирование) копируется на лист «Запас», на листе
 * подразделения затирается шаблоном «Вакант». Служебные данные (подразделение,
 * Discord-роли для восстановления, дата ухода) пишутся в колонки AH–AJ листа
 * «Запас». В Discord снимаются все роли и выдаётся роль «Запас».
 *
 * Почему A–AG, а не прежние A–T: у роты блок оценок кончается на «AE», у
 * дивизиона — на «AG», и снапшот A–T обрезал последние нормативы (уставы, ПВО,
 * БПЛА, береты). Боец, ушедший в запас и вернувшийся, терял эти отметки —
 * возвращался с пустыми (белыми) колонками хвоста.
 *
 * «Вернуться из запаса»: строка целиком (A–AG) возвращается на лист
 * подразделения (нижняя свободная «Вакант»-строка блока прежней должности) со
 * ВСЕМИ отметками об экзаменах, строка на листе «Запас» очищается. Роли
 * восстанавливаются, роль «Запас» снимается.
 */
import { GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { getSettings } from "@/lib/settings";
import { normalizePersonName } from "@/lib/recruits";
import {
  getDoc,
  getSheet,
  findNameRow,
  findVacantRow,
  copyRow,
  resolveLayout,
  ensureColumnCount,
  FULL_ROW_COL_COUNT,
  type UnitLayout,
} from "@/lib/gsheets";

/**
 * Служебные колонки листа «Запас» после снапшота строки A–AG.
 *
 * AH(33) — подразделение (имя листа), AI(34) — сохранённые Discord-роли через
 * запятую, AJ(35) — дата ухода. Раньше метаданные лежали в U–W, но снапшот
 * расширился до AG и накрыл бы их собой: строка бойца затирала бы служебные
 * значения, и возврат из запаса терял бы подразделение и роли.
 */
const META_COL = {
  unit: 33,  // AH — подразделение (имя листа)
  roles: 34, // AI — сохранённые Discord-роли через запятую
  date: 35,  // AJ — дата ухода
} as const;

/**
 * Старые координаты метаданных (U–W) — только для ЧТЕНИЯ.
 *
 * Обратная совместимость: строки, положенные в «Запас» до расширения снапшота,
 * лежат на 20–22-й колонке, и переносить их руками никто не будет. При чтении
 * смотрим на ширину ЗАНЯТОЙ части строки (occupiedWidth): у старой строки
 * правее прежних 23 колонок пусто, у новой занята как минимум колонка AH
 * (подразделение) — 34 колонки. Порог и есть NEW_META_MIN_COLS.
 */
const LEGACY_META_COL = {
  unit: 20,  // U
  roles: 21, // V
  date: 22,  // W
} as const;

/** Границы копируемого снапшота строки: A–AG (33 колонки A..AG) */
const SNAP_COLS = FULL_ROW_COL_COUNT;

/**
 * Ширина строки, после которой метаданные считаются НОВЫМИ (AH–AJ).
 *
 * Порог 34 — колонка AH: у строки с метаданными в AH..AJ обязательно заполнена
 * AH (подразделение), и длина непустой части такой строки не меньше 34. У
 * старых строк правее W ничего нет, поэтому длина остаётся 20–22.
 */
const NEW_META_MIN_COLS = LEGACY_META_COL.date + 12; // 34 → колонка AH

/** Последняя колонка служебного блока листа «Запас» */
const META_LAST_COL = META_COL.date;

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
  if (existing) {
    // Лист со старым (узким) снапшотом расширяем: правее прежних 26–30 колонок
    // должен поместиться хвост строки (A..AG) и служебный блок AH..AJ
    await ensureColumnCount(existing, META_LAST_COL + 1);
    return existing;
  }

  // Шапка строится на всю ширину снапшота и служебного блока: пустые заголовки
  // допустимы (библиотека проверяет уникальность только непустых)
  const headers: string[] = new Array(META_LAST_COL + 1).fill("");
  headers[META_COL.unit] = "Подразделение";
  headers[META_COL.roles] = "Discord-роли (служебное)";
  headers[META_COL.date] = "Дата ухода";
  const sheet = await doc.addSheet({
    title: name,
    headerValues: headers,
    // Google по умолчанию даёт 26 колонок — на них служебный блок AH..AJ не
    // помещается, и запись метаданных упала бы с «Out of bounds»
    gridProperties: { columnCount: META_LAST_COL + 1 },
  });
  return sheet;
}

/**
 * Ширина занятой части строки листа «Запас»: индекс последней непустой ячейки + 1.
 *
 * Нужна для обратной совместимости чтения метаданных: по ней отличаем строку
 * нового формата (снапшот A..AG + метаданные AH..AJ) от старой (снапшот A–T +
 * метаданные U–W).
 */
function occupiedWidth(sheet: GoogleSpreadsheetWorksheet, row: number): number {
  const last = Math.min(META_LAST_COL, sheet.columnCount - 1);
  for (let c = last; c >= 0; c--) {
    if (String(sheet.getCell(row - 1, c).value ?? "").trim()) return c + 1;
  }
  return 0;
}

/**
 * Колонки метаданных по ширине занятой части строки.
 *
 * Новый формат (ширина ≥ 34, то есть занята колонка AH) — AH..AJ; старый
 * (ширина меньше 34) — U–W. Вынесено отдельной чистой функцией, чтобы правило
 * обратной совместимости проверялось тестом, а не только чтением живого листа.
 */
export function metaColumnsForWidth(
  width: number
): { unit: number; roles: number; date: number } {
  return width >= NEW_META_MIN_COLS ? META_COL : LEGACY_META_COL;
}

/**
 * Колонки метаданных для КОНКРЕТНОЙ строки листа «Запас».
 *
 * Строки, положенные до расширения снапшота, остаются читаемыми: их никто не
 * переносит руками, а подразделение и роли им всё ещё нужны — без них боец не
 * найдётся и вернётся без прежних ролей Discord.
 */
function metaColumnsFor(
  sheet: GoogleSpreadsheetWorksheet,
  row: number
): { unit: number; roles: number; date: number } {
  return metaColumnsForWidth(occupiedWidth(sheet, row));
}

/**
 * Копирование строки МЕЖДУ листами: значения + шрифты + заливки + выравнивание.
 * Именно заливки сохраняют зелёные отметки сданных экзаменов.
 *
 * Копируется ПОЛНАЯ строка A..AG (а не только блок оценок листа): у роты
 * экзамены кончаются на «AE», и хвост строки (уставы, ПВО, БПЛА, береты)
 * оставался на месте, пока боец в запасе. Ширина ограничивается сеткой ЛИСТОВ
 * (у старого листа запаса могло быть всего 26 колонок) — за границей сетки
 * `getCell` бросает «Out of bounds».
 */
function copyRowBetween(
  srcSheet: GoogleSpreadsheetWorksheet,
  srcRow: number,
  destSheet: GoogleSpreadsheetWorksheet,
  destRow: number
) {
  const cols = Math.min(SNAP_COLS, srcSheet.columnCount, destSheet.columnCount);
  for (let c = 0; c < cols; c++) {
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

/**
 * Первая свободная строка на листе запаса.
 *
 * Проверяется ВЕСЬ диапазон A..AJ, а не только блок нового формата: он накрывает
 * и снапшот (A..AG), и новый служебный блок (AH..AJ), и старые метаданные U–W.
 * Иначе строка со старыми метаданными (они правее прежнего снапшота A–T, но
 * левее AH) выглядела бы «пустой», и следующего бойца положили бы поверх неё —
 * потеряв и его данные, и возможность вернуть прежнего.
 */
function nextReserveRow(sheet: GoogleSpreadsheetWorksheet): number {
  const lastCol = Math.min(META_LAST_COL, sheet.columnCount - 1);
  const lastRow = Math.max(sheet.rowCount, 200);
  for (let r = 2; r <= lastRow; r++) {
    let empty = true;
    for (let c = 0; c <= lastCol; c++) {
      if (String(sheet.getCell(r - 1, c).value ?? "").trim()) {
        empty = false;
        break;
      }
    }
    if (empty) return r;
  }
  return lastRow + 1;
}

/**
 * Поиск строки бойца на листе запаса: имя ищем в той же колонке, где оно
 * лежит на листе подразделения (по сохранённому подразделению).
 *
 * Подразделение читается с учётом формата строки: у старых строк оно лежит в U,
 * у новых — в AH (см. metaColumnsFor).
 */
function findReserveRow(
  sheet: GoogleSpreadsheetWorksheet,
  name: string
): { row: number; unit: string; layout: UnitLayout } | null {
  /**
   * Сравнение по ключу normalizePersonName, а не по сырой строке: на листе
   * «Запас» ФИО лежит ровно так, как было в снапшоте — с неразрывными пробелами,
   * другим регистром или с латинской буквой в инициалах. Точное совпадение
   * из-за этого не находило строку, и возврат из запаса отвечал «боец не найден».
   */
  const target = normalizePersonName(name);
  if (!target) return null;

  for (let r = 2; r <= sheet.rowCount; r++) {
    const meta = metaColumnsFor(sheet, r);
    const unit = String(sheet.getCell(r - 1, meta.unit).value ?? "").trim();
    if (!unit) continue;
    let layout: UnitLayout;
    try {
      layout = resolveLayout(unit);
    } catch {
      continue;
    }
    const nameColIdx = layout.nameCol.charCodeAt(0) - 65;
    const v = normalizePersonName(sheet.getCell(r - 1, nameColIdx).value);
    if (v && v === target) return { row: r, unit, layout };
  }
  return null;
}

/**
 * Затереть строку запаса: снапшот A..AG и ОБА варианта служебных колонок
 * (U–W старого формата и AH..AJ нового). Чистить только текущий блок мало —
 * у строки со старыми метаданными в U–W они остались бы «висеть» правее
 * снапшота, и nextReserveRow считал бы такую строку занятой.
 */
async function clearReserveRow(sheet: GoogleSpreadsheetWorksheet, row: number) {
  const lastCol = Math.min(META_LAST_COL, sheet.columnCount - 1);
  for (let c = 0; c <= lastCol; c++) {
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

/**
 * Удалить строку бойца с листа «Запас» (увольнение запасника).
 *
 * Боец, уже числившийся в запасе, при увольнении убирается и оттуда: строка
 * затирается целиком (снапшот A..AG и оба варианта служебных колонок —
 * U..W старого формата и AH..AJ нового), иначе nextReserveRow считал бы её
 * занятой, а метаданные «висели» бы правее пустой строки.
 *
 * Возврат: ok=false с причиной, если боец на листе запаса не найден —
 * это не ошибка для увольнения (мог не числиться в запасе), а подсказка.
 */
export async function removeReserveRow(req: {
  userName: string;
}): Promise<ReserveResult> {
  try {
    const doc = await getDoc();
    const reserveSheet = await getReserveSheet(doc);
    await reserveSheet.loadCells();

    const found = findReserveRow(reserveSheet, req.userName);
    if (!found) {
      return { ok: false, error: `Боец ${req.userName} не найден на листе запаса` };
    }

    await clearReserveRow(reserveSheet, found.row);

    const resName = await reserveSheetName();
    return {
      ok: true,
      message: `${req.userName} удалён из листа «${resName}» (строка ${found.row})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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

    // 1. Находим строку бойца на листе подразделения.
    //    Перед чтением строка расширяется до полной ширины A..AG: у листа могло
    //    быть меньше колонок, и хвост блока оценок (у дивизиона это «AF»–«AG»)
    //    остался бы не скопированным — боец вернулся бы без части отметок
    await ensureColumnCount(unitSheet, FULL_ROW_COL_COUNT);
    await unitSheet.loadCells();
    const srcRow = findNameRow(unitSheet, layout, req.userName);
    if (!srcRow) throw new Error(`Боец ${req.userName} не найден на листе «${req.unit}»`);

    // 2. Копируем строку ЦЕЛИКОМ (A..AG, с заливками экзаменов) на лист запаса.
    //    Сетку листа запаса расширяем до служебного блока: у существующего листа
    //    колонок могло быть меньше, и хвост строки (уставы, ПВО, БПЛА, береты)
    //    обрезался бы или запись метаданных падала бы с «Out of bounds»
    const reserveSheet = await getReserveSheet(doc);
    await reserveSheet.loadCells();
    const destRow = nextReserveRow(reserveSheet);

    copyRowBetween(unitSheet, srcRow, reserveSheet, destRow);

    // Служебные данные для возврата — AH..AJ листа «Запас»
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
      // Раскладка листа передаётся явно: конец копирования — блок оценок ИМЕННО
      // этого листа (AE у роты, AG у дивизиона), иначе хвост шапки не копировался
      copyRow(unitSheet, layout, templateRow, srcRow);
    } else {
      // Шаблона нет — чистим вручную, имя заменяем на «Вакант».
      // Границы — по сетке ЛИСТА подразделения: колонок могло быть меньше
      // полной строки, и обход до AG упал бы с «Out of bounds»
      const nameColIdx = layout.nameCol.charCodeAt(0) - 65;
      const cols = Math.min(SNAP_COLS, unitSheet.columnCount);
      for (let c = 0; c < cols; c++) {
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

    // 2. Сохранённые Discord-роли для восстановления.
    //    Колонки метаданных зависят от формата строки: новые записи держат их в
    //    AH..AJ, положенные до расширения снапшота — в U–W (обратная совместимость)
    const meta = metaColumnsFor(reserveSheet, resRow);
    const rolesRaw = String(reserveSheet.getCell(resRow - 1, meta.roles).value ?? "").trim();
    const roles = rolesRaw ? rolesRaw.split(",").map((r) => r.trim()).filter(Boolean) : [];

    // 3. Возвращаем строку ЦЕЛИКОМ (A..AG, с экзаменами) на лист подразделения —
    //    в НИЖНЮЮ свободную строку блока прежней должности, чтобы не мешать другим
    const unitSheet = await getSheet(unit);
    await ensureColumnCount(unitSheet, FULL_ROW_COL_COUNT);
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
