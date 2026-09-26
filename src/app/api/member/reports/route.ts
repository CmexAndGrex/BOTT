/**
 * Рапорты бойца: подача (POST) и список своих рапортов (GET).
 *
 * Доступ только действующему составу (requireActiveMember): кабинет есть у
 * бойцов «в строю» и «в отпуске», значит и подавать рапорты может только этот
 * круг — кандидат со статусом pending ещё не в подразделении.
 *
 * Payload проверяется доменным валидатором (validateReportPayload): значения
 * уезжают в Google Таблицу и в роли Discord, поэтому произвольный текст здесь
 * недопустим. Проверка общая с ботом и панелью — правила не расходятся.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, serviceReports } from "@/db/schema";
import { requestIp, requireActiveMember } from "@/lib/member-auth";
import {
  buildReportEmbed,
  isServiceReportType,
  readReportPayload,
  reportTypeMeta,
  summarizeReport,
  validateReportPayload,
  type ServiceReportType,
} from "@/lib/reports";
import { publishReviewMessage, reportsChannelId } from "@/lib/review";
import { LoginThrottle } from "@/lib/recruits";
import { registerThrottle } from "@/lib/throttle-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Публикация в Discord может занять несколько секунд */
export const maxDuration = 30;

/**
 * Ограничитель подачи рапортов.
 *
 * Ключ — боец, а не IP: бойцы заходят из одного расположения и с одного
 * роутера, поэтому лимит по адресу заблокировал бы всё подразделение. Ошибки
 * валидации в лимит не идут — иначе опечатка в форме «съедала» бы попытку.
 */
const throttle = registerThrottle(new LoginThrottle(15, 10 * 60 * 1000));

type ReportBody = {
  type?: unknown;
  payload?: unknown;
};

export async function GET(req: NextRequest) {
  const auth = await requireActiveMember(req);
  if (!auth.ok) return auth.response;

  try {
    const rows = await db
      .select()
      .from(serviceReports)
      .where(eq(serviceReports.memberId, auth.member.id))
      .orderBy(desc(serviceReports.createdAt))
      .limit(50);

    return NextResponse.json({
      ok: true,
      reports: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        moderatorComment: row.moderatorComment,
        reviewedBy: row.reviewedBy,
        typeLabel: reportTypeMeta(row.type).label,
        typeIcon: reportTypeMeta(row.type).icon,
        payload: readReportPayload(row.type, row.payload),
      })),
    });
  } catch (e) {
    console.error("[reports] Не удалось получить рапорты бойца:", e);
    return NextResponse.json({ ok: false, error: "Ошибка БД" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireActiveMember(req);
  if (!auth.ok) return auth.response;

  const throttleKey = `reports:${auth.member.id}`;
  const state = throttle.check(throttleKey);
  if (state.locked) {
    return NextResponse.json(
      {
        ok: false,
        error: `Слишком много рапортов подряд. Повторите через ${state.retryAfterMinutes} мин.`,
      },
      { status: 429 }
    );
  }

  let body: ReportBody;
  try {
    body = (await req.json()) as ReportBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  if (!isServiceReportType(body.type)) {
    return NextResponse.json({ ok: false, error: "Неизвестный тип рапорта" }, { status: 400 });
  }
  const type: ServiceReportType = body.type;

  const validation = validateReportPayload(type, body.payload);
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
  }
  const payload = validation.payload;

  try {
    const [created] = await db
      .insert(serviceReports)
      .values({
        memberId: auth.member.id,
        // Позывной дублируем в записи: рапорт остаётся читаемым в журнале,
        // даже если бойца позже уберут из состава (строка ссылается на memberId)
        callsign: auth.member.callsign || `#${auth.member.id}`,
        type,
        payload: payload as unknown as Record<string, unknown>,
        status: "pending",
      })
      .returning();

    if (!created) {
      return NextResponse.json({ ok: false, error: "Не удалось создать рапорт" }, { status: 500 });
    }

    throttle.registerFailure(throttleKey);

    // Публикация в канале рапортов: ошибка Discord не отменяет рапорт —
    // он уже в БД и виден модератору в панели
    const channelId = await reportsChannelId();
    const published = await publishReviewMessage(
      channelId,
      "report",
      created.id,
      buildReportEmbed({
        id: created.id,
        type,
        callsign: created.callsign,
        unit: auth.member.unit,
        rank: auth.member.rank,
        payload,
        createdAt: created.createdAt,
        status: "pending",
      })
    );

    if (published.ok) {
      await db
        .update(serviceReports)
        .set({ discordMessageId: published.messageId, discordChannelId: published.channelId })
        .where(eq(serviceReports.id, created.id));
    } else {
      console.warn(`[reports] Рапорт #${created.id} не опубликован: ${published.error}`);
    }

    await db.insert(logs).values({
      category: "edit",
      author: auth.member.callsign || `#${auth.member.id}`,
      action: `подал рапорт: ${reportTypeMeta(type).label}`,
      details: {
        "Рапорт": `#${created.id}`,
        "Суть": summarizeReport(type, payload),
        "IP": requestIp(req),
        "Публикация": published.ok ? "в канал рапортов" : "только в панели",
      },
      kind: "system",
      title: "Новый рапорт",
      detail: `${created.callsign}: ${reportTypeMeta(type).label}`,
      ok: true,
    });

    return NextResponse.json({
      ok: true,
      id: created.id,
      published: published.ok,
      // Эта строка показывается, если канал не настроен: рапорт принят,
      // решение будет принято штабом в панели модерации
      notice: published.ok
        ? "Рапорт отправлен в канал рапортов"
        : "Рапорт принят и виден штабу в панели модерации",
    });
  } catch (e) {
    console.error("[reports] Не удалось создать рапорт:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}