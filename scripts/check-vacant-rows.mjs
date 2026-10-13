import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "..", ".env") });

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { getSettings } from "../src/lib/settings.js";
import { readFileSync } from "node:fs";
import path from "node:path";

async function loadServiceAccount() {
  const map = await getSettings();
  const raw = (map.get("gsheet_service_account") || "").trim();
  if (raw) return JSON.parse(raw);
  const p = path.join(process.cwd(), "src", "lib", "google-service-account.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

async function main() {
  const map = await getSettings();
  const id = (map.get("gsheet_spreadsheet_id") || "").trim();
  const creds = await loadServiceAccount();
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key.replace(/\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const doc = new GoogleSpreadsheet(id, auth);
  await doc.loadInfo();

  const sheet = Object.values(doc.sheetsById).find(
    (s) => s.title.toLowerCase() === "танковая рота"
  );

  if (!sheet) {
    console.log("❌ Лист 'Танковая рота' не найден");
    return;
  }

  await sheet.loadCells();
  console.log("Проверка строк 42-56 (диапазон добавления):\n");

  for (let row = 42; row <= 56; row++) {
    const nameCell = sheet.getCell(row - 1, 2); // Колонка C
    const value = String(nameCell.value ?? "").trim();
    const status = value.toLowerCase() === "вакант" ? "✓ ВАКАНТ" : `✗ ${value || "(пусто)"}`;
    console.log(`Строка ${row}: ${status}`);
  }
}

main().catch(console.error);
