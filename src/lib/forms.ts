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
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
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
  role: string;       // одиночная роль (старый вариант формы)
  roleGive: string;   // «Роль (выдать)» — можно несколько через запятую
  roleRemove: string; // «Роль (снять)» — можно несколько через запятую
  exam: string;       // «Экзамен»
  grade: string;      // «Оценка» (КМБТ — без оценки)
  examiner: string;   // «Экзаменатор» (Фамилия И.О.)
  otdelenie: string;  // «Отделение» (1 ООВ / 2 ООВ для артдивизиона)
  vacationDates: string;
  reason: string;
};

/** Названия столбцов формы (регистр не важен).
 *  Таблица сопоставления: заголовок листа ответов → поле заявки. */
export const COLUMN_ALIASES: Record<string, string[]> = {
  timestamp: ["отметка времени", "timestamp", "время"],
  userName: ["имя пользователя", "имя", "никнейм", "ник"],
  discordId: ["discord id", "discord_id", "дискорд id", "id дискорда"],
  requestType: ["тип заявки", "тип", "заявка"],
  unit: ["подразделение", "дивизион", "рота", "куда добавить"],
  otdelenie: ["отделение"],
  rank: ["звание"],
  steamId: ["steam id", "steam_id", "стим id", "steam"],
  roleGive: ["роль (выдать)", "роли (выдать)", "роли выдать", "какие роли выдать"],
  roleRemove: ["роль (снять)", "роли (снять)", "роли снять", "какие роли снять"],
  role: ["роль", "какую роль"],
  exam: ["экзамен", "какой экзамен", "сданные экзамены"],
  grade: ["оценка", "оценку", "балл"],
  examiner: ["экзаменатор"],
  vacationDates: ["даты отпуска", "даты", "период"],
  reason: ["причина", "комментарий", "доп. информация"],
};

/** Построение карты «поле → индекс столбца» по заголовкам листа.
 *  По этой карте видно, какие заголовки формы бот распознал, а какие нет
 *  (без этого непонятно, почему заявка не публикуется). */
export function mapColumns(sheet: GoogleSpreadsheetWorksheet): Record<string, number> {
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
    roleGive: cellStr(sheet, row, colMap.roleGive),
    roleRemove: cellStr(sheet, row, colMap.roleRemove),
    exam: cellStr(sheet, row, colMap.exam),
    grade: cellStr(sheet, row, colMap.grade),
    examiner: cellStr(sheet, row, colMap.examiner),
    otdelenie: cellStr(sheet, row, colMap.otdelenie),
    vacationDates: cellStr(sheet, row, colMap.vacationDates),
    reason: cellStr(sheet, row, colMap.reason),
  };
}

/**
 * Если боец не указал Discord ID (или выбрал себя из списка) — ищем его:
 * 1) в БД панели по имени; 2) в Google Таблице ШДС на листе подразделения
 *    (колонка Discord ID = nameCol+3).
 */
export async function enrichDiscordId(resp: FormResponse): Promise<void> {
  if (resp.discordId || !resp.userName) return;

  // 1. База панели
  try {
    const rows = await db
      .select({ discordId: members.discordId })
      .from(members)
      .where(eq(members.name, resp.userName));
    const found = rows.find((r) => r.discordId);
    if (found?.discordId) {
      resp.discordId = found.discordId;
      return;
    }
  } catch (e) {
    console.error("[forms] Не удалось найти Discord ID в БД:", e);
  }

  // 2. Таблица ШДС (колонка Discord ID рядом с именем)
  try {
    const doc = await getDoc();
    const sheets = Object.values(doc.sheetsById) as GoogleSpreadsheetWorksheet[];
    const unitTitles = resp.unit
      ? [resp.unit]
      : ["Танковая рота", "Артиллерийский дивизион"];
    for (const title of unitTitles) {
      const sheet = sheets.find(
        (s) => (s.title || "").trim().toLowerCase() === title.trim().toLowerCase()
      );
      if (!sheet) continue;
      await sheet.loadCells();
      const nameCol = /дивизион|артиллер/i.test(title) ? 3 : 2; // D или C
      for (let r = 1; r < sheet.rowCount; r++) {
        const v = String(sheet.getCell(r, nameCol).value ?? "").trim().toLowerCase();
        if (v && v === resp.userName.trim().toLowerCase()) {
          const d = String(sheet.getCell(r, nameCol + 3).value ?? "").replace(/[^\d]/g, "");
          if (d) {
            resp.discordId = d;
            return;
          }
        }
      }
    }
  } catch (e) {
    console.error("[forms] Не удалось найти Discord ID в ШДС:", e);
  }
}

/** Подготовка сообщения для Discord по ответу формы */
export function buildRequestMessage(
  resp: FormResponse,
  map: Map<string, string>
): { channelKey: string; content: string } | null {
  const type = resp.requestType.toLowerCase();
  const discordId = resp.discordId;
  const isVacationType = type.includes("отпуск");
  const isVacationRemove =
    isVacationType && /снять|снятие|отмен|окончан|выход|заверш/.test(type);
  const isExamType = /экзамен/.test(type);

  // 1) Отпуск (выдать/снять) → канал отпусков.
  //    Проверяется ПЕРЕД ролями, т.к. «Снять отпуск» содержит слово «снять».
  if (isVacationType) {
    const channelId = map.get("vacation_channel_id");
    if (!channelId) return null;
    const lines = [
      `Тип заявки: ${isVacationRemove ? "Снятие отпуска" : "Отпуск"}`,
      `Имя пользователя: ${resp.userName}`,
    ];
    if (discordId) lines.push(`Discord ID: ${discordId}`);
    if (resp.unit) lines.push(`Подразделение: ${resp.unit}`);
    if (resp.vacationDates) lines.push(`Даты отпуска: ${resp.vacationDates}`);
    if (resp.reason) lines.push(`Причина: ${resp.reason}`);
    return { channelKey: "vacation_channel_id", content: lines.join("\n") };
  }

  // 2) Экзамен → канал ШДС (сценарий «Получение подтверждения об экзаменации»)
  if (isExamType) {
    const channelId = map.get("shds_channel_id");
    if (!channelId) return null;
    const unit = resp.unit || "Танковая рота";
    const exam = resp.exam || resp.role || "не указан";
    const lines = [
      `Подразделение: ${unit}`,
      "Редакция ШДС: Получение подтверждения об экзаменации",
      `Имя пользователя: ${resp.userName}`,
      `Discord ID: ${discordId}`,
      `Сданные экзамены: ${exam}`,
    ];
    if (resp.grade) lines.push(`Оценка: ${resp.grade}`);
    if (resp.otdelenie) lines.push(`Отделение: ${resp.otdelenie}`);
    if (resp.examiner) lines.push(`Экзаменатор: ${resp.examiner}`);
    if (resp.reason) lines.push(`Причина: ${resp.reason}`);
    return { channelKey: "shds_channel_id", content: lines.join("\n") };
  }

  // 2.5) Удаление из ШДС → канал ШДС (одобряет только Командирский состав).
  //      ВАЖНО: проверяется ПЕРЕД «добавлением», т.к. «Убрать из ШДС»
  //      содержит слово «шдс».
  if (/убрать|удалить|исключить|отчислить/.test(type)) {
    const channelId = map.get("shds_channel_id");
    if (!channelId) return null;
    const unit = resp.unit || "Танковая рота";
    const commandRole = (map.get("command_role_id") || "").trim();
    const lines = [
      commandRole ? `<@&${commandRole}>` : "",
      `Подразделение: ${unit}`,
      "Редакция ШДС: Убрать из таблицы",
      `Имя пользователя: ${resp.userName}`,
      `Discord ID: ${resp.discordId}`,
      "⚠️ Одобрить может ТОЛЬКО Командирский состав. При одобрении боец удаляется из ШДС (со всеми экзаменами), с него снимаются все роли и выдаётся «Друг АТК».",
    ].filter(Boolean);
    if (resp.reason) lines.push(`Причина: ${resp.reason}`);
    return { channelKey: "shds_channel_id", content: lines.join("\n") };
  }

  // 3) ШДС: добавить → канал ШДС (+ роли к выдаче, если боец их выбрал)
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
    if (resp.roleGive) lines.push(`Роли выдать: ${resp.roleGive}`);
    if (resp.roleRemove) lines.push(`Роли снять: ${resp.roleRemove}`);
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

  // 5) Роли: выдать и/или снять одним запросом → канал запросов ролей.
  //    Формат совместим с parseRoleRequest: 1-я строка — получатель,
  //    далее — команды «Выдать …» / «Снять …» (экзаменатор не обязателен).
  if (type.includes("выдать") || type.includes("снять") || resp.roleGive || resp.roleRemove) {
    const channelId = map.get("roles_channel_id");
    if (!channelId || !discordId) return null;

    // Команда: два списка (выдать/снять) либо одиночная роль + тип заявки
    const parts: string[] = [];
    if (resp.roleGive) parts.push(`Выдать ${resp.roleGive}`);
    if (resp.roleRemove) parts.push(`Снять ${resp.roleRemove}`);
    if (!parts.length) {
      const action = type.includes("снять") ? "Снять" : "Выдать";
      parts.push(`${action} ${resp.role || "не указана"}`);
    }

    const content = [
      `<@${discordId}>`,
      `Заявка из Google-формы: ${resp.userName}`,
      parts.join(", "),
    ].join("\n");
    return { channelKey: "roles_channel_id", content };
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
      // Боец мог не указать Discord ID (выбрал себя из списка) — ищем сами
      await enrichDiscordId(resp);
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
        // Не двигаем курсор — строка будет повторена на следующем опросе,
        // чтобы заявка не потерялась при сбое Discord API
        break;
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