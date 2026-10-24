import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { DEFAULT_SETTINGS, ensureCookieSyncKey, getSettings, maskCookie, setSettingQuiet, setSettings } from "@/lib/settings";
import { requireRole } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET_KEYS = new Set(["rs_cookie", "discord_token", "gsheet_service_account"]);

/**
 * Ключи, зафиксированные в коде и потому отбрасываемые из PUT.
 *
 * Раньше это были обычные настройки, теперь их значения заданы константами:
 *   * rs_base_url — адрес сайта подразделения (см. RS_RED_BASE_URL);
 *   * discord_rate_concurrency / discord_rate_interval_ms /
 *     discord_rate_attempts — лимиты Discord API (см. DEFAULT_QUEUE_OPTIONS);
 *   * discord_queue_max_concurrent / discord_queue_pause_ms /
 *     discord_queue_max_retries — прежние названия тех же лимитов.
 *
 * Обратная совместимость: такой PUT не считается ошибкой — лишние поля просто
 * игнорируются, остальные настройки сохраняются как обычно. Иначе устаревшая
 * вкладка (открытая в браузере до обновления страницы) получала бы 400 на любую
 * правку, и администратор не понял бы причину.
 *
 * form_enabled («опрос Google-формы») здесь НЕТ намеренно: из интерфейса поле
 * убрано как рудимент, но сама задача опроса формы жива (см. src/lib/forms.ts).
 * Ключ остаётся рабочим — его можно выставить напрямую в базе, не ломая модуль.
 */
const REMOVED_KEYS = new Set([
  "rs_base_url",
  "discord_rate_concurrency",
  "discord_rate_interval_ms",
  "discord_rate_attempts",
  "discord_queue_max_concurrent",
  "discord_queue_pause_ms",
  "discord_queue_max_retries",
]);

const SETTING_NAMES: Record<string, string> = {
  norm_hours: "норму часов", weekly_time: "время проверки онлайн", timezone: "часовой пояс",
  discord_channel_id: "ID канала Discord", discord_role_id: "ID роли Discord",
  rs_subdiv_id: "ID подразделения", op_enabled: "статус задачи пингов", weekly_enabled: "статус проверки онлайн",
  op_times: "время пингов", weekly_days: "дни проверки онлайн", op_texts: "тексты для операций",
  op_gifs: "гифки для операций", rs_cookie: "куки rs-red", discord_token: "токен Discord бота",
  shds_channel_id: "ID канала заявок ШДС", vacation_channel_id: "ID канала заявок на отпуск",
  roles_channel_id: "ID канала запросов ролей",
  moderator_role_id: "ID роли модератора заявок", leave_role_id: "ID роли «Отпуск»",
  beret_role_id: "ID роли «Берет»",
  tank_role_id: "ID роли «Танковая рота»",
  art_role_id: "ID роли «Артиллерийский дивизион»",
  // Зачисление и роли (вкладка «Зачисление и роли»)
  role_corps_id: "ID роли «Артиллерийско-Танковый Корпус»",
  role_tank_id: "ID роли «Танковая рота» при вступлении",
  role_art_id: "ID роли «Артиллерийский дивизион» при вступлении",
  role_recruit_rank_id: "ID роли начального звания",
  shds_sheet_tank: "название листа ШДС Танковой роты",
  shds_sheet_art: "название листа ШДС Артиллерийского дивизиона",
  command_role_id: "ID роли «Командирский состав»",
  left_members_check: "контроль вышедших из подразделения", left_check_channel_id: "канал пинга о вышедших",
  roles_monitor_enabled: "контроль снятия ролей у исключённых", roles_monitor_channel_id: "канал уведомлений о неснятых ролях",
  roles_monitor_delay_hours: "срок ожидания снятия ролей (часов)",
  gsheet_spreadsheet_id: "ID Google-таблицы (ШДС)", gsheet_service_account: "паспорт сервисного аккаунта Google",
  snapshot_enabled: "статус задачи снимка статистики", snapshot_time: "время снимка статистики",
  logs_retention_days: "срок хранения логов (дней)",
  form_response_sheet: "лист с ответами формы",
  reserve_role_id: "ID роли «Запас»", reserve_sheet_name: "название листа «Запас»",
  guild_id: "ID сервера Discord",
  allowed_webhook_ids: "разрешённые вебхуки заявок",
  role_sync_enabled: "фоновую сверку ролей Discord",
  role_sync_dry_run: "режим проверки сверки ролей",
  role_sync_interval_min: "интервал сверки ролей",
  post_role_map: "соответствие «должность = роль»",
};

export async function GET(req: NextRequest) {
  // Настройки содержат ключ синхронизации расширения и внутренние ID —
  // отдаём их только администратору (раньше роут был анонимным).
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

  const map = await getSettings(true);
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = map.get(key) ?? "";
    out[key] = SECRET_KEYS.has(key) ? maskCookie(value) : value;
  }
  const cookieSyncKey = await ensureCookieSyncKey();
  return NextResponse.json({
    settings: out, cookieSyncKey, cookieUpdatedAt: map.get("_cookie_updated_at") || null,
    env: { hasToken: !!(process.env.DISCORD_BOT_TOKEN || "").trim(), hasCookie: !!(process.env.RS_RED_COOKIE || "").trim() },
  });
}

export async function PUT(req: NextRequest) {
  // Изменение настроек — только администратор
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try { body = await req.json(); } 
  catch { return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 }); }

  if (String(body.regenerate_key) === "true") {
    const cookieSyncKey = randomBytes(18).toString("hex");
    await setSettingQuiet("_cookie_sync_key", cookieSyncKey);
    return NextResponse.json({ ok: true, cookieSyncKey });
  }

  const oldMap = await getSettings(true);
  const patch: Record<string, string> = {};
  const changedKeys: string[] = [];
  const detailsObj: Record<string, string> = {};

  // Явно перечисляем отброшенные поля — для журнала и чтобы поведение не
  // зависело от того, попадёт ли устаревший ключ в DEFAULT_SETTINGS.
  for (const key of REMOVED_KEYS) {
    if (key in body) delete body[key];
  }

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const raw = body[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();

    if (value.length > 20000) return NextResponse.json({ ok: false, error: `Текст в настройке "${key}" слишком длинный` }, { status: 400 });

    const humanName = SETTING_NAMES[key] || `настройку "${key}"`;

    if (SECRET_KEYS.has(key)) {
      if (!value || value.includes("••")) continue;
      const oldValue = oldMap.get(key) ?? "";
      if (value !== oldValue) {
        patch[key] = value; changedKeys.push(humanName); detailsObj[humanName] = "Обновлено (скрыто)";
      }
      continue;
    }
    if (key === "op_enabled" || key === "weekly_enabled" || key === "snapshot_enabled") {
      const valBool = value === "true" ? "true" : "false";
      const oldValue = oldMap.get(key) ?? "false";
      if (valBool !== oldValue) {
        patch[key] = valBool; changedKeys.push(humanName);
        detailsObj[humanName] = `было: "${oldValue === "true" ? "Включено" : "Выключено"}" ➔ стало: "${valBool === "true" ? "Включено" : "Выключено"}"`;
      }
      continue;
    }
    if ((key === "weekly_time" || key === "snapshot_time") && /^\d{1,2}:\d{2}$/.test(value)) {
      const [h, m] = value.split(":");
      const formattedTime = `${h.padStart(2, "0")}:${m}`;
      const oldValue = oldMap.get(key) ?? "";
      if (formattedTime !== oldValue) {
        patch[key] = formattedTime; changedKeys.push(humanName);
        detailsObj[humanName] = `было: "${oldValue || "пусто"}" ➔ стало: "${formattedTime}"`;
      }
      continue;
    }
    const oldValue = oldMap.get(key) ?? "";
    if (value !== oldValue) {
      patch[key] = value; changedKeys.push(humanName);
      detailsObj[humanName] = `было: "${oldValue || "пусто"}" ➔ стало: "${value}"`;
    }
  }

  if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true });
  await setSettings(patch);

  let authorFormatted = "Командир";
  if (auth.user.username) {
    const roleRu = auth.user.role === "admin" ? "Администратор" : "Командир";
    authorFormatted = `${roleRu} ${auth.user.username}`;
  }

  await db.insert(logs).values({
    category: "edit", author: authorFormatted, action: `изменил ${changedKeys.join(", ")}`,
    details: detailsObj, kind: "system", title: "Изменение настроек", detail: "Обновлены конфигурации системы", ok: true,
  });

  return NextResponse.json({ ok: true });
}
