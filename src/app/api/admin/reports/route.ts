/**
 * Рапорты и заявки для панели модерации (/admin/reports).
 *
 * Отдаёт обе очереди сразу: рапорты действующего состава и заявки на
 * вступление. Доступ — только командирам и администраторам (requireStaff),
 * как и у раздела рапортов новобранцев: здесь видны персональные данные.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { members, recruitApplications, serviceReports } from "@/db/schema";
import { requireStaff } from "@/lib/member-auth";
import {
  approveRecruitApplication,
  approveServiceReport,
  rejectRecruitApplication,
  rejectServiceReport,
} from "@/lib/review";
import {
  isReviewStatus,
  isServiceReportType,
  readReportPayload,
  reportTypeMeta,
  summarizeReport,
  type ReviewStatus,
  type ServiceReportType,
} from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  // Фильтры: статус (по умолчанию — очередь) и тип рапорта
  const statusRaw = req.nextUrl.searchParams.get("status") || "pending";
  const status: ReviewStatus | "all" = isReviewStatus(statusRaw) ? statusRaw : "all";
  const typeRaw = req.nextUrl.searchParams.get("type") || "";
  const type: ServiceReportType | null = isServiceReportType(typeRaw) ? typeRaw : null;

  try {
    // Условия собираем массивом: статус «all» и пустой тип означают «без фильтра»
    const reportFilters = [
      status === "all" ? null : eq(serviceReports.status, status),
      type ? eq(serviceReports.type, type) : null,
    ].filter((f) => f !== null);

    const reportsQuery = db
      .select({
        id: serviceReports.id,
        memberId: serviceReports.memberId,
        callsign: serviceReports.callsign,
        type: serviceReports.type,
        payload: serviceReports.payload,
        status: serviceReports.status,
        moderatorComment: serviceReports.moderatorComment,
        reviewedBy: serviceReports.reviewedBy,
        createdAt: serviceReports.createdAt,
        updatedAt: serviceReports.updatedAt,
        unit: members.unit,
        rank: members.rank,
        discordId: members.discordId,
      })
      .from(serviceReports)
      .leftJoin(members, eq(members.id, serviceReports.memberId))
      .orderBy(desc(serviceReports.createdAt))
      .limit(200);

    const reportRows = reportFilters.length ? await reportsQuery.where(and(...reportFilters)) : await reportsQuery;

    const recruitsQuery = db
      .select()
      .from(recruitApplications)
      .orderBy(desc(recruitApplications.createdAt))
      .limit(200);

    const recruitRows =
      status === "all"
        ? await recruitsQuery
        : await recruitsQuery.where(eq(recruitApplications.status, status));

    return NextResponse.json({
      ok: true,
      status,
      type,
      reports: reportRows.map((row) => ({
        id: row.id,
        memberId: row.memberId,
        callsign: row.callsign,
        type: row.type,
        typeLabel: reportTypeMeta(row.type).label,
        typeIcon: reportTypeMeta(row.type).icon,
        status: row.status,
        summary: summarizeReport(row.type, readReportPayload(row.type, row.payload)),
        moderatorComment: row.moderatorComment,
        reviewedBy: row.reviewedBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        unit: row.unit,
        rank: row.rank,
        discordId: row.discordId,
      })),
      recruits: recruitRows.map((row) => ({
        id: row.id,
        memberId: row.memberId,
        callsign: row.callsign,
        discordTag: row.discordTag,
        discordId: row.discordId,
        age: row.age,
        armaExperience: row.armaExperience,
        about: row.about,
        status: row.status,
        reviewedBy: row.reviewedBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  } catch (e) {
    console.error("[admin/reports] Не удалось получить очередь:", e);
    return NextResponse.json({ ok: false, error: "Ошибка БД" }, { status: 500 });
  }
}

type DecisionBody = {
  scope?: unknown;
  action?: unknown;
  id?: unknown;
  comment?: unknown;
};

/**
 * Решение штаба из веб-панели.
 *
 * Вызываются те же функции, что и кнопки Discord (src/lib/review.ts): рапорт
 * применяется к ШДС и ролям ровно так же, а сообщение в канале обновляется
 * синхронно («перекрашивается» в зелёный/красный, кнопки отключаются).
 * Копии правил в веб-интерфейсе нет — иначе решения из сайта и из Discord
 * разошлись бы.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  let body: DecisionBody;
  try {
    body = (await req.json()) as DecisionBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const scope = body.scope === "recruit" || body.scope === "report" ? body.scope : null;
  if (!scope) {
    return NextResponse.json({ ok: false, error: "Неизвестная область решения" }, { status: 400 });
  }

  const action = body.action === "approve" || body.action === "reject" ? body.action : null;
  if (!action) {
    return NextResponse.json({ ok: false, error: "Неизвестное действие" }, { status: 400 });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "Некорректный ID записи" }, { status: 400 });
  }

  const comment = typeof body.comment === "string" ? body.comment : "";
  const reviewer = auth.member.callsign || (auth.member.role === "admin" ? "Администратор" : "Командир");

  try {
    const result =
      scope === "recruit"
        ? action === "approve"
          ? await approveRecruitApplication(id, reviewer)
          : await rejectRecruitApplication(id, reviewer, comment)
        : action === "approve"
          ? await approveServiceReport(id, reviewer)
          : await rejectServiceReport(id, reviewer, comment);

    if (!result.ok) {
      // «Решение уже принято» — конфликт состояния, а не ошибка ввода:
      // интерфейс по 409 просто перезагружает очередь
      const conflict = result.error === "Решение по этой записи уже принято";
      return NextResponse.json(
        { ok: false, error: result.message, code: result.error ?? null },
        { status: conflict ? 409 : 400 }
      );
    }

    return NextResponse.json({ ok: true, message: result.message, scope, action, id });
  } catch (e) {
    console.error("[admin/reports] Ошибка решения:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}