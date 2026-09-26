/**
 * Проверка Google Таблицы ШДС (снимок состояния, только чтение).
 *
 * Зачем: после каждого теста бота нужно убедиться, что он сделал именно то,
 * что должен — боец встал в нужную строку, экзамены сохранились, лист «Запас»
 * заполнился, строки «Вакант» не закончились. Глазами по таблице это долго,
 * а номера строк легко перепутать.
 *
 * Скрипт НИЧЕГО не меняет: только читает листы и печатает отчёт. Ключи берутся
 * из настроек панели в БД, а если БД недоступна — из переменных окружения.
 *
 * Запуск:
 *   npm run verify:sheet                  # весь отчёт
 *   npm run verify:sheet -- --unit=TR     # только Танковая рота
 *   npm run verify:sheet -- --reserve     # только лист «Запас»
 *   npm run verify:sheet -- --json        # машинночитаемый вывод
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const ROOT = path.resolve(import.meta.dirname, "..");

/* ---------------------------- аргументы ---------------------------- */

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const onlyUnit = argValue("unit"); // TR | AD
const onlyReserve = hasFlag("reserve");
const asJson = hasFlag("json");

/* ---------------------------- настройки ---------------------------- */

/** Мини-парсер .env: dotenv в проект не тащим, читаем как есть */
function readEnvFile() {
  const file = path.join(ROOT, ".env");
  const out = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Значения настроек из БД панели; null — если БД недоступна */
async function settingsFromDb(databaseUrl) {
  if (!databaseUrl) return null;
  const { default: pg } = await import("pg").catch(() => ({ default: null }));
  if (!pg) return null;
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT key, value FROM bot_settings");
    return new Map(rows.map((r) => [r.key, r.value]));
  } catch (e) {
    console.warn(`[verify] БД недоступна (${e.message}) — беру ключи из окружения`);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/* ------------------------- раскладка листов ------------------------ */

/** Те же диапазоны, что в src/lib/gsheets.ts (LAYOUTS) — только для чтения */
const LAYOUTS = {
  TR: { title: "Танковая рота", nameCol: 2, top: 10, bottom: 56, addTop: 42, addBottom: 56 },
  AD: {
    title: "Артиллерийский дивизион",
    nameCol: 3,
    top: 12,
    bottom: 41,
    addTop: 32,
    addBottom: 41,
  },
};

const isVacant = (v) => String(v ?? "").trim().toLowerCase() === "вакант";
const cell = (sheet, row, col) => String(sheet.getCell(row - 1, col).value ?? "").trim();
const colLetter = (i) => String.fromCharCode(65 + i);

/* --------------------------- сбор отчёта --------------------------- */

async function inspectUnit(doc, key) {
  const layout = LAYOUTS[key];
  const sheet = Object.values(doc.sheetsById).find(
    (s) => (s.title || "").trim().toLowerCase() === layout.title.toLowerCase()
  );
  if (!sheet) {
    return { key, title: layout.title, found: false, members: [], vacantFree: null };
  }

  // Читаем только диапазон участников и колонку Discord ID
  await sheet.loadCells(`A${layout.top}:H${layout.bottom}`);

  const members = [];
  let vacantFree = 0;
  for (let row = layout.top; row <= layout.bottom; row++) {
    const name = cell(sheet, row, layout.nameCol);
    if (!name) continue;
    if (isVacant(name)) {
      vacantFree++;
      continue;
    }
    members.push({
      row,
      rank: cell(sheet, row, layout.nameCol - 1),
      name,
      post: cell(sheet, row, layout.nameCol + 1),
      steamId: cell(sheet, row, layout.nameCol + 2),
      discordId: cell(sheet, row, layout.nameCol + 3),
      inAddRange: row >= layout.addTop && row <= layout.addBottom,
    });
  }
  return { key, title: layout.title, found: true, members, vacantFree };
}

async function inspectReserve(doc, sheetName) {
  const sheet = Object.values(doc.sheetsById).find(
    (s) => (s.title || "").trim().toLowerCase() === sheetName.toLowerCase()
  );
  if (!sheet) return { title: sheetName, found: false, rows: [] };

  await sheet.loadCells();
  const rows = [];
  for (let r = 0; r < sheet.rowCount; r++) {
    // Служебные колонки листа запаса: U(20)=подразделение, V(21)=роли, W(22)=дата
    const unit = String(sheet.getCell(r, 20).value ?? "").trim();
    const roles = String(sheet.getCell(r, 21).value ?? "").trim();
    const date = String(sheet.getCell(r, 22).value ?? "").trim();
    // Ищем имя в A–D
    let name = "";
    let nameColFound = -1;
    for (let c = 0; c <= 3; c++) {
      const v = String(sheet.getCell(r, c).value ?? "").trim();
      if (v && !isVacant(v)) {
        name = v;
        nameColFound = c;
        break;
      }
    }
    if (!name && !unit) continue;
    rows.push({
      excelRow: r + 1,
      name: name || "(без имени)",
      nameCol: nameColFound >= 0 ? colLetter(nameColFound) : "—",
      unit: unit || "—",
      rolesCount: roles ? roles.split(",").filter(Boolean).length : 0,
      date: date || "—",
    });
  }
  return { title: sheetName, found: true, rows };
}

/* ------------------------------ вывод ------------------------------ */

function printUnit(u) {
  console.log(`\n=== ${u.title} ===`);
  if (!u.found) {
    console.log("  ✗ лист не найден в таблице");
    return;
  }
  console.log(
    `  бойцов в составе: ${u.members.length} | свободных «Вакант»: ${u.vacantFree}`
  );
  if (u.vacantFree === 0) {
    console.log("  ⚠️  Свободных строк нет — «Добавление в ШДС» упадёт с ошибкой");
  }
  console.log("  стр   звание           имя                    должность          Discord ID");
  for (const m of u.members) {
    const mark = m.inAddRange ? "◦" : " ";
    const warn = m.discordId ? "" : "  ← НЕТ Discord ID";
    console.log(
      `  ${mark}${String(m.row).padEnd(4)} ${m.rank.padEnd(16)} ${m.name.padEnd(22)} ${m.post.padEnd(18)} ${m.discordId || "—"}${warn}`
    );
  }
  console.log("  («◦» — строка входит в диапазон добавления)");
}

function printReserve(r) {
  console.log(`\n=== Лист «${r.title}» (запас) ===`);
  if (!r.found) {
    console.log("  лист ещё не создан (появится при первом уходе в запас)");
    return;
  }
  console.log(`  записей: ${r.rows.length}`);
  for (const x of r.rows) {
    console.log(
      `  стр ${String(x.excelRow).padEnd(4)} ${x.name.padEnd(22)} подразделение: ${x.unit.padEnd(22)} ролей сохранено: ${x.rolesCount}  ушёл: ${x.date}`
    );
  }
}

/* ------------------------------- main ------------------------------ */

async function main() {
  const env = readEnvFile();
  const dbUrl = env.DATABASE_URL || process.env.DATABASE_URL;
  const map = (await settingsFromDb(dbUrl)) || new Map();

  // Приоритет: настройки панели (БД) → .env переменные
  const spreadsheetId =
    (map.get("gsheet_spreadsheet_id") || "").trim() ||
    (process.env.GSHEET_SPREADSHEET_ID || "").trim();
  const serviceAccountRaw =
    (map.get("gsheet_service_account") || "").trim() ||
    (process.env.GSHEET_SERVICE_ACCOUNT || "").trim();
  const reserveSheetName = (map.get("reserve_sheet_name") || "Запас").trim() || "Запас";

  if (!spreadsheetId) {
    console.error(
      "[verify] Не найден ID таблицы.\n" +
        "  Заполните gsheet_spreadsheet_id в настройках панели или задайте GSHEET_SPREADSHEET_ID."
    );
    process.exit(1);
  }
  if (!serviceAccountRaw) {
    console.error(
      "[verify] Не найден «паспорт» сервисного аккаунта.\n" +
        "  Заполните gsheet_service_account в панели или задайте GSHEET_SERVICE_ACCOUNT (JSON)."
    );
    process.exit(1);
  }

  let creds;
  try {
    creds = JSON.parse(serviceAccountRaw);
  } catch {
    console.error("[verify] Не удалось разобрать JSON сервисного аккаунта.");
    process.exit(1);
  }

  const auth = new JWT({
    email: creds.client_email,
    key: String(creds.private_key || "").replace(/\\n/g, "\n"),
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });

  const doc = new GoogleSpreadsheet(spreadsheetId, auth);
  await doc.loadInfo();

  if (!asJson) {
    console.log(`Таблица: ${doc.title}`);
    console.log(`ID: ${spreadsheetId}`);
    console.log(`Лист запаса: «${reserveSheetName}»`);
    console.log(
      `Все листы: ${Object.values(doc.sheetsById).map((s) => s.title).join(", ")}`
    );
  }

  const result = { title: doc.title, spreadsheetId, units: [], reserve: null };

  if (!onlyReserve) {
    const keys = onlyUnit
      ? [/дивизион|артиллер/i.test(onlyUnit) || onlyUnit.toUpperCase() === "AD" ? "AD" : "TR"]
      : ["TR", "AD"];
    for (const key of keys) {
      const u = await inspectUnit(doc, key);
      result.units.push(u);
      if (!asJson) printUnit(u);
    }
  }

  if (!onlyUnit || onlyReserve) {
    const r = await inspectReserve(doc, reserveSheetName);
    result.reserve = r;
    if (!asJson) printReserve(r);
  }

  if (asJson) console.log(JSON.stringify(result, null, 2));
  else console.log("\n[verify] Готово. Скрипт только читает таблицу и ничего не меняет.");
}

main().catch((e) => {
  console.error("[verify] Ошибка:", e instanceof Error ? e.message : e);
  process.exit(1);
});