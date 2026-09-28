/**
 * Правка Discord ID бойца из табеля «Состав» (PATCH /api/admin/roster/[id]/discord-id).
 *
 * Только администратор: изменение меняет не только базу панели, но и Google
 * Таблицу ШДС — по колонке Discord ID штаб сверяет состав с таблицей, а бот
 * упоминает человека. Командиру доступна прежняя правка через
 * PATCH /api/members/[id] (база панели); запись в ШДС оставлена администратору
 * как операция с внешним документом.
 *
 * Порядок действий намеренный:
 *   1. проверка роли и формата (общий валидатор validateRosterDiscordId —
 *      тот же, что показывает требование в интерфейсе);
 *   2. запись в PostgreSQL (division_members.discord_id);
 *   3. обновление ячейки в Google Таблице и запись в журнал.
 *
 * Если Google недоступен, правка в базе НЕ откатывается: штаб уже принял
 * решение, и терять его нельзя. Ответ содержит поле sheets со статусом
 * синхронизации, панель показывает предупреждение вместо ложного успеха.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, members } from "@/db/schema";
import { requireRole } from "@/lib/api-auth";
import { isCrossSiteRequest, isUnsafeMethod } from "@/lib/csrf";
import { validateRosterDiscordId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Запись в Google Таблицу может занять несколько секунд */
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** Статус синхронизации с листом ШДС */
type SheetStatus = { ok: boolean; message?: string; error?: string };

/**
 * Запись ячейки на листе подразделения.
 *
 * Импорт динамический: модуль таблицы читает «паспорт» сервисного аккаунта и
 * настройки панели, и незачем нагружать этим каждый запрос к роуту.
 */
async function syncSheet(
  member: { unit: string | null; callsign: string | null; name: string },
  discordId: string
): Promise<SheetStatus> {
  if (!member.unit) {
    return {
      ok: false,
      error: "У бойца не назначено подразделение — лист ШДС не определён",
    };
  }
  try {
    const { syncDiscordIdToSheet } = await import("@/lib/gsheets");
    return await syncDiscordIdToSheet({
      unit: member.unit,
      // Два кандидата имени: в панели боец может быть записан ФИО с rs-red.com,
      // а в ШДС — позывным (см. syncDiscordIdToSheet)
      names: [member.callsign ?? "", member.name],
      discordId,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  // Администратор — всегда допущен (requireRole пропускает его к любому набору)
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

  // Проверка источника дублируется намеренно: middleware — не единственный
  // барьер (его matcher может быть сужен), а запрос меняет внешний документ
  if (isUnsafeMethod(req.method) && isCrossSiteRequest(req)) {
    return NextResponse.json(
      { ok: false, error: "Запрос с чужого источника отклонён" },
      { status: 403 }
    );
  }

  const { id } = await params;
  const memberId = Number.parseInt(id, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return NextResponse.json({ ok: false, error: "Некорректный ID бойца" }, { status: 400 });
  }

  let body: { discordId?: unknown };
  try {
    body = (await req.json()) as { discordId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  // Пустая строка — осознанная очистка привязки, а не ошибка
  const validated = validateRosterDiscordId(body.discordId);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }
  const discordId = validated.value;

  const [member] = await db.select().from(members).where(eq(members.id, memberId));
  if (!member) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  const before = member.discordId ?? null;
  const [updated] = await db
    .update(members)
    .set({ discordId, updatedAt: new Date() })
    .where(eq(members.id, memberId))
    .returning();
  if (!updated) return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });

  const sheets = await syncSheet(updated, discordId ?? "");

  // Журнал пишется всегда: даже при сбое Google правка в базе уже состоялась,
  // и штаб должен видеть это в истории, а не узнавать по факту расхождения
  const sheetNote = sheets.ok
    ? ""
    : ` · ШДС: ${sheets.error || "не обновлена"}`;

  await db.insert(logs).values({
    category: "edit",
    author: auth.user.username ? `Администратор ${auth.user.username}` : "Администратор",
    action: discordId
      ? `изменил Discord ID на "${discordId}" бойцу ${member.name}`
      : `снял Discord ID бойцу ${member.name}`,
    details: {
      "Боец": member.name,
      "Позывной": member.callsign ?? "—",
      "Discord ID": discordId ?? "не указан",
      "Было": before ?? "не указан",
      "Лист ШДС": member.unit ?? "не назначено",
      "Итог": sheets.ok ? sheets.message ?? "обновлено" : sheets.error ?? "ошибка",
    },
    kind: "system",
    title: "Правка Discord ID",
    detail: `Discord ID бойца ${member.name}: ${before ?? "пусто"} → ${discordId ?? "пусто"}${sheetNote}`,
    ok: sheets.ok,
    error: sheets.ok ? null : sheets.error ?? null,
  });

  return NextResponse.json({
    ok: true,
    member: updated,
    sheets,
    // Предупреждение для панели: правка сохранена, но таблица отстала
    warning: sheets.ok
      ? null
      : `ID сохранён в панели, но Google Таблица не обновлена: ${sheets.error ?? "ошибка"}`,
  });
}