/**
 * Личное досье бойца: шапка, доступ к технике и история службы.
 *
 * Один запрос на страницу вместо трёх: кабинет открывается сразу после входа, и
 * лишние обращения к БД на каждый виджет давали бы «прыгающую» вёрстку. Роут
 * читает карточку бойца, его рапорты (они же — источник допусков) и считает
 * матрицу техники доменными правилами из vehicles.ts.
 *
 * Доступ: действующий состав (requireActiveMember). Неавторизованный — 401,
 * боец не в строю — 403: кандидат со статусом pending ещё не в подразделении, и
 * показывать ему допуски к технике нельзя.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { members, serviceReports } from "@/db/schema";
import { requireActiveMember } from "@/lib/member-auth";
import { readReportPayload, summarizeReport, type ReportPayload } from "@/lib/reports";
import {
  reportStatusView,
  serviceStatus,
  serviceSummary,
  type DossierReportRow,
} from "@/lib/dossier";
import { getAvailableVehicles } from "@/lib/vehicles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Что именно записал штаб в ШДС по этому рапорту — источник допусков */
function examsOf(report: DossierReportRow, payload: ReportPayload): string[] {
  if (report.type !== "exam") return [];
  const exams = (payload as { exams?: { exam_code?: unknown }[] }).exams;
  if (!Array.isArray(exams)) return [];
  return exams.map((item) => String(item?.exam_code ?? "")).filter(Boolean);
}

export async function GET(req: NextRequest) {
  const auth = await requireActiveMember(req);
  if (!auth.ok) return auth.response;

  try {
    const [member] = await db
      .select({
        id: members.id,
        callsign: members.callsign,
        name: members.name,
        rank: members.rank,
        unit: members.unit,
        post: members.post,
        status: members.status,
        role: members.role,
        active: members.active,
        vacation: members.vacation,
        vacationUntil: members.vacationUntil,
        discordId: members.discordId,
        avatarUrl: members.avatarUrl,
        hours: members.hours,
        warnings: members.warnings,
        createdAt: members.createdAt,
      })
      .from(members)
      .where(eq(members.id, auth.member.id));

    if (!member) {
      return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });
    }

    const rows = await db
      .select()
      .from(serviceReports)
      .where(eq(serviceReports.memberId, auth.member.id))
      .orderBy(desc(serviceReports.createdAt))
      .limit(50);

    // Payload читается тем же валидатором, что и в модерации: значения из jsonb
    // не считаются доверенными (их мог записать бот или старый код).
    const reports: DossierReportRow[] = rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.createdAt,
      reviewedBy: row.reviewedBy,
      moderatorComment: row.moderatorComment,
    }));

    const payloads = new Map<number, ReportPayload>(
      rows.map((row) => [row.id, readReportPayload(row.type, row.payload)])
    );

    const summary = serviceSummary(reports, (report) =>
      examsOf(report, payloads.get(report.id) ?? { exams: [] } as ReportPayload)
    );

    const status = serviceStatus({
      status: member.status,
      active: member.active,
      vacationUntil: member.vacationUntil,
    });

    // Допуск к технике: звание и подразделение из карточки, нормативы — из
    // одобренных рапортов (они и закрашивают столбцы ШДС)
    const vehicles = getAvailableVehicles({
      rank: member.rank,
      unit: member.unit,
      qualifications: summary.qualifications,
    });

    return NextResponse.json({
      ok: true,
      member: {
        id: member.id,
        callsign: member.callsign || member.name || "",
        rank: member.rank || "",
        unit: member.unit,
        post: member.post,
        status: member.status,
        statusLabel: status.label,
        role: member.role,
        avatarUrl: member.avatarUrl,
        discordId: member.discordId,
        hours: member.hours,
        warnings: member.warnings,
        createdAt: member.createdAt,
      },
      service: {
        status: status.status,
        label: status.label,
        tone: status.tone,
        badgeClass: status.badgeClass,
        untilLabel: status.untilLabel,
        until: status.until ? status.until.toISOString() : null,
        daysLeft: status.daysLeft,
        daysLabel: status.daysLabel,
        overdue: status.overdue,
      },
      serviceSummary: {
        total: summary.total,
        pending: summary.pending,
        approved: summary.approved,
        rejected: summary.rejected,
        firstAt: summary.firstAt ? summary.firstAt.toISOString() : null,
        lastAt: summary.lastAt ? summary.lastAt.toISOString() : null,
        qualifications: summary.qualifications,
      },
      vehicles,
      reports: rows.map((row) => {
        const payload = payloads.get(row.id) ?? ({ exams: [] } as ReportPayload);
        const view = reportStatusView(row.status);
        return {
          id: row.id,
          type: row.type,
          status: row.status,
          statusLabel: view.label,
          badgeClass: view.badgeClass,
          createdAt: row.createdAt,
          reviewedBy: row.reviewedBy,
          moderatorComment: row.moderatorComment,
          updatedAt: row.updatedAt,
          /** Суть рапорта: собирается общей функцией — она же используется в модерации */
          summary: summarizeReport(row.type, payload),
        };
      }),
    });
  } catch (e) {
    console.error("[dossier] Не удалось собрать досье бойца:", e);
    return NextResponse.json({ ok: false, error: "Ошибка БД" }, { status: 500 });
  }
}