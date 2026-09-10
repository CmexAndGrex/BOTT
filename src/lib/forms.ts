/**
 * Google-форма заявок.
 *
 * Бот опрашивает лист с ответами формы (из того же документа ШДС) и публикует
 * каждый новый ответ как заявку в соответствующий Discord-канал. Дальше работает
 * существующий механизм: модератор ставит реакцию ✅/❌, бот выполняет заявку.
 *
 * Опрос идёт по заголовкам столбцов (порядок не важен), новые строки отслеживаются
 * через настройку _form_last_row.
 */
import { GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { getSettings, setSettingQuiet } from "@/lib/settings";
import { getDoc } from "@/lib/gsheets";
import { sendChannelMessage } from "@/lib/discord";

export type FormResponse = {
  timestamp: string;
  userName: string;
  discordId: string;
  requestType: string;
  unit: string;
  rank: string;
  steamId: string;
  role: string;
  vacationDates: string;
  reason: string;
};

/** Названия столбцов формы (регистр не важен) */
const COLUMN_ALIASES: Record<string, string[]> = {
  timestamp: ["отметка времени", "timestamp", "время"],
  userName: ["имя пользователя", "имя", "никнейм", "ник"],
  discordId: ["discord id", "discord_id", "дискорд id", "id дискорда"],
  requestType: ["тип заявки", "тип", "заявка"],
  unit: ["подразделение", "дивизион", "рота", "куда добавить"],
  rank: ["звание"],
  steamId: ["steam id", "steam_id", "стим id", "steam"],
  role: ["роль", "какую роль"],
  vacationDates: ["даты отпуска", "даты", "период"],
  reason: ["причина", "комментарий", "доп. информация"],
};

/** Построение карты «поле → индекс столбца» по заголовкам листа */
function mapColumns(sheet: GoogleSpreadsheetWorksheet): Record<string, number> {
  const map: Record<string, number> = {};
  const maxCol = Math.min(sheet.columnCount, 30);
  for (let c = 0; c < maxCol; c++) {
    const raw = String(sheet.getCell(0, c).value ?? "")
      .trim()
      .toLowerCase();
    if (!raw) continue;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some((a) => raw === a || raw.includes(a))) {
        map[field] = c;
      }
    }
  }
  return map;
}

function cellStr(sheet: GoogleSpreadsheetWorksheet, row: number, col: number): string {
  if (col < 0) return "";
  const v = sheet.getCell(row, col).value;
  return v == null ? "" : String(v).trim();
}

/** Разбор одной строки ответа в структурированный вид */
export function parseRow(
  sheet: GoogleSpreadsheetWorksheet,
  row: number,
  colMap: Record<string, number>
): FormResponse | null {
  const userName = cellStr(sheet, row, colMap.userName);
  const requestType = cellStr(sheet, row, colMap.requestType);
  if (!userName && !requestType) return null;

  return {
    timestamp: cellStr(sheet, row, colMap.timestamp),
    userName,
    discordId: cellStr(sheet, row, colMap.discordId).replace(/[^\d]/g, ""),
    requestType,
    unit: cellStr(sheet, row, colMap.unit),
    rank: cellStr(sheet, row, colMap.rank),
    steamId: cellStr(sheet, row, colMap.steamId),
    role: cellStr(sheet, row, colMap.role),
    vacationDates: cellStr(sheet, row, colMap.vacationDates),
    reason: cellStr(sheet, row, colMap.reason),
  };
}

/** Подготовка сообщения для Discord по ответу формы */
export function buildRequestMessage(
  resp: FormResponse,
  map: Map<string, string>
): { channelKey: string; content: string } | null {
  const type = resp.requestType.toLowerCase();
  const discordId = resp.discordId;

  // 1) Роль: выдать / снять → канал запросов ролей
  if (type.includes("выдать") || type.includes("снять")) {
    const channelId = map.get("roles_channel_id");
    if (!channelId || !discordId) return null;
    const action = type.includes("снять") ? "Снять" : "Выдать";
    const roleName = resp.role || "не указана";
    const content = [
      `<@${discordId}>`,
      "Заявка из Google-формы",
      `${action} ${roleName}`,
    ].join("\n");
    return { channelKey: "roles_channel_id", content };
  }

  // 2) Отпуск → канал отпусков
  if (type.includes("отпуск")) {
    const channelId = map.get("vacation_channel_id");
    if (!channelId || !discordId) return null;
    const lines = [
      "Тип заявки: Отпуск",
      `Имя пользователя: ${resp.userName}`,
      `Discord ID: ${discordId}`,
    ];
    if (resp.vacationDates) lines.push(`Даты отпуска: ${resp.vacationDates}`);
    if (resp.reason) lines.push(`Причина: ${resp.reason}`);
    return { channelKey: "vacation_channel_id", content: lines.join("\n") };
  }

  // 3) ШДС: добавить → канал ШДС
  if (type.includes("добавление") || type.includes("шдс") || type.includes("добавить")) {
    const channelId = map.get("shds_channel_id");
    if (!channelId) return null;
    const unit = resp.unit || "Танковая рота";
    const lines = [
      `Подразделение: ${unit}`,
      "Редакция ШДС: Добавление в ШДС",
      `Имя пользователя: ${resp.userName}`,
      `Звание: ${resp.rank}`,
      `Steam ID: ${resp.steamId}`,
      `Discord ID: ${resp.discordId}`,
    ];
    if (resp.reason) lines.push(`Причина: ${resp.reason}`);
    return { channelKey: "shds_channel_id", content: lines.join("\n") };
  }

  // 4) Запас: уйти / вернуться → канал ШДС
  if (type.includes("запас")) {
    const channelId = map.get("shds_channel_id");
    if (!channelId) return null;
    const unit = resp.unit || "Танковая рота";
    const action =
      type.includes("вернуться") || type.includes("возврат")
        ? "Возврат из запаса"
        : "Уход в запас";
    const lines = [
      `Подразделение: ${unit}`,
      `Редакция ШДС: ${action}`,
      `Имя пользователя: ${resp.userName}`,
      `Звание: ${resp.rank}`,
      `Steam ID: ${resp.steamId}`,
      `Discord ID: ${resp.discordId}`,
    ];
    if (resp.reason) lines.push(`Причина: ${resp.reason}`);
    return { channelKey: "shds_channel_id", content: lines.join("\n") };
  }

  return null;
}

export type PollResult = {
  ok: boolean;
  posted: number;
  skipped: number;
  errors: number;
  detail: string;
};

/** Опрос листа с ответами формы и публикация новых заявок в Discord */
export async function pollGoogleForm(): Promise<PollResult> {
  const map = await getSettings(true);
  if (map.get("form_enabled") !== "true") {
    return { ok: true, posted: 0, skipped: 0, errors: 0, detail: "Опрос формы выключен" };
  }

  const result: PollResult = { ok: true, posted: 0, skipped: 0, errors: 0, detail: "" };

  try {
    const doc = await getDoc();
    const sheetName = (map.get("form_response_sheet") || "Ответы на форму 1").trim();
    const sheets = Object.values(doc.sheetsById) as GoogleSpreadsheetWorksheet[];
    const sheet = sheets.find(
      (s) => (s.title || "").trim().toLowerCase() === sheetName.toLowerCase()
    );
    if (!sheet) {
      result.detail = `Лист «${sheetName}» не найден в таблице`;
      result.ok = false;
      return result;
    }

    await sheet.loadCells();
    const colMap = mapColumns(sheet);

    const lastRow = parseInt(map.get("_form_last_row") || "1", 10) || 1;
    const totalRows = sheet.rowCount;

    for (let r = lastRow; r < totalRows; r++) {
      const resp = parseRow(sheet, r, colMap);
      if (!resp) {
        result.skipped++;
        continue;
      }
      const built = buildRequestMessage(resp, map);
      if (!built) {
        result.skipped++;
        continue;
      }
      const channelId = map.get(built.channelKey);
      if (!channelId) {
        result.skipped++;
        continue;
      }
      try {
        await sendChannelMessage(channelId, {
          content: built.content,
          allowed_mentions: { parse: [], users: [], roles: [] },
        });
        result.posted++;
      } catch (e) {
        result.errors++;
        console.error(`[forms] Ошибка публикации строки ${r + 1}:`, e);
      }
      await setSettingQuiet("_form_last_row", String(r + 1));
    }

    result.detail = `Форма: опубликовано ${result.posted}, пропущено ${result.skipped}, ошибок ${result.errors}`;
    return result;
  } catch (e) {
    result.ok = false;
    result.detail = `Ошибка опроса формы: ${e instanceof Error ? e.message : String(e)}`;
    return result;
  }
}