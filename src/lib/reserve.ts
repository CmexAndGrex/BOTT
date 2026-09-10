/**
 * Запас — перевод бойца в запас и возврат.
 *
 * «Уйти в запас»: строка бойца копируется на лист «Запас», на листе
 * подразделения затёрвается шаблоном «Вакант». В Discord снимаются роли
 * подразделения/звания и выдаётся роль «Запас».
 *
 * «Вернуться из запаса»: строка копируется обратно на лист подразделения
 * (первая свободная «Вакант»-строка), на листе «Запас» затёрвается. Роли
 * восстанавливаются, роль «Запас» снимается.
 */
import { GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { getSettings } from "@/lib/settings";
import { getDoc, getSheet, findNameRow, findVacantRow, copyRow, resolveLayout } from "@/lib/gsheets";

/** Лист «Запас» — фиксированные колонки */
const RESERVE_COL = {
  name: "A",
  rank: "B",
  unit: "C",
  steam: "D",
  discord: "E",
  post: "F",
  date: "G",
} as const;

export type ReserveResult = { ok: true; message: string } | { ok: false; error: string };

/** Название листа запаса из настроек */
async function reserveSheetName(): Promise<string> {
  const map = await getSettings();
  return (map.get("reserve_sheet_name") || "Запас").trim() || "Запас";
}

/** Получить (или создать) лист запаса */
async function getReserveSheet(doc: Awaited<ReturnType<typeof getDoc>>): Promise<GoogleSpreadsheetWorksheet> {
  const name = await reserveSheetName();
  const sheets = Object.values(doc.sheetsById) as GoogleSpreadsheetWorksheet[];
  const existing = sheets.find((s) => (s.title || "").trim().toLowerCase() === name.toLowerCase());
  if (existing) return existing;

  const created = await doc.addSheet({
    title: name,
    headerValues: ["Имя", "Звание", "Подразделение", "Steam ID", "Discord ID", "Должность", "Дата ухода"],
  });
  return created;
}

/** Следующая свободная строка на листе запаса (где имя пустое) */
async function nextReserveRow(sheet: GoogleSpreadsheetWorksheet): Promise<number> {
  await sheet.loadCells();
  for (let r = 2; r <= Math.max(sheet.rowCount, 1000); r++) {
    const v = String(sheet.getCell(r - 1, 0).value ?? "").trim();
    if (!v) return r;
  }
  return 2;
}

/** Поиск строки бойца на листе запаса по имени */
async function findReserveRow(sheet: GoogleSpreadsheetWorksheet, name: string): Promise<number | null> {
  await sheet.loadCells();
  const target = name.trim().toLowerCase();
  for (let r = 2; r <= sheet.rowCount; r++) {
    const v = String(sheet.getCell(r - 1, 0).value ?? "").trim().toLowerCase();
    if (v === target) return r;
  }
  return null;
}

/** Затереть строку запаса (очистить ячейки) */
async function clearReserveRow(sheet: GoogleSpreadsheetWorksheet, row: number) {
  for (let c = 0; c < 8; c++) {
    const cell = sheet.getCell(row - 1, c);
    cell.value = "";
    cell.textFormat = undefined;
    cell.backgroundColor = undefined;
  }
  await sheet.saveUpdatedCells();
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
    const srcRow = await findNameRow(unitSheet, layout, req.userName);
    if (!srcRow) throw new Error(`Боец ${req.userName} не найден на листе «${req.unit}»`);

    // 2. Копируем данные на лист запаса
    const reserveSheet = await getReserveSheet(doc);
    const destRow = await nextReserveRow(reserveSheet);
    await reserveSheet.loadCells();

    const setCell = (col: string, value: string) => {
      const colIdx = col.charCodeAt(0) - 65;
      const cell = reserveSheet.getCell(destRow - 1, colIdx);
      cell.value = value;
    };
    setCell(RESERVE_COL.name, req.userName);
    setCell(RESERVE_COL.rank, req.rank || "");
    setCell(RESERVE_COL.unit, req.unit);
    setCell(RESERVE_COL.steam, req.steamId || "");
    setCell(RESERVE_COL.discord, req.discordId || "");
    setCell(RESERVE_COL.post, req.post || "");
    setCell(RESERVE_COL.date, new Date().toISOString().slice(0, 10));
    // Сохраняем роли для восстановления (колонка H = индекс 7)
    if (req.roles?.length) {
      const colIdx = 7;
      const cell = reserveSheet.getCell(destRow - 1, colIdx);
      cell.value = req.roles.join(",");
    }
    await reserveSheet.saveUpdatedCells();

    // 3. Затирка строки на листе подразделения шаблоном «Вакант»
    const range = layout.postRanges.find((r) => srcRow >= r.top && srcRow <= r.bottom) || layout.overall;
    const templateRow = await findVacantRow(unitSheet, layout, range.top, range.bottom, srcRow);
    if (templateRow) {
      await copyRow(unitSheet, templateRow, srcRow);
      await unitSheet.saveUpdatedCells();
    }

    return { ok: true, message: `${req.userName} переведён в запас (лист «${await reserveSheetName()}»)` };
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

    // 1. Находим строку на листе запаса
    const resRow = await findReserveRow(reserveSheet, req.userName);
    if (!resRow) throw new Error(`Боец ${req.userName} не найден на листе запаса`);

    // 2. Читаем сохранённые данные
    await reserveSheet.loadCells();
    const read = (col: string) => {
      const colIdx = col.charCodeAt(0) - 65;
      return String(reserveSheet.getCell(resRow - 1, colIdx).value ?? "").trim();
    };
    const unit = read(RESERVE_COL.unit) || req.unit || "Танковая рота";
    const rank = read(RESERVE_COL.rank) || req.rank || "";
    const steam = read(RESERVE_COL.steam) || req.steamId || "";
    const discord = read(RESERVE_COL.discord) || req.discordId || "";
    const post = read(RESERVE_COL.post) || req.post || "";
    // Роли для восстановления (колонка H = индекс 7)
    const rolesRaw = String(reserveSheet.getCell(resRow - 1, 7).value ?? "").trim();
    const roles = rolesRaw ? rolesRaw.split(",").map((r) => r.trim()).filter(Boolean) : [];

    // 3. Возвращаем на лист подразделения
    const layout = resolveLayout(unit);
    const unitSheet = await getSheet(unit);
    await unitSheet.loadCells();
    const destRow = await findVacantRow(unitSheet, layout, layout.addRange.top, layout.addRange.bottom);
    if (!destRow) throw new Error(`На листе «${unit}» нет свободных строк («Вакант»)`);

    const nameCol = layout.nameCol.charCodeAt(0) - 65;
    const setCell = (colIdx: number, value: string) => {
      const cell = unitSheet.getCell(destRow - 1, colIdx);
      cell.value = value;
    };
    setCell(nameCol - 1, rank);
    setCell(nameCol, req.userName);
    setCell(nameCol + 2, steam);
    setCell(nameCol + 3, discord);
    await unitSheet.saveUpdatedCells();

    // 4. Затирка строки запаса
    await clearReserveRow(reserveSheet, resRow);

    return { ok: true, message: `${req.userName} возвращён из запаса в «${unit}» (строка ${destRow})`, roles };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}