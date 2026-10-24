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
import { requireCabinetMember } from "@/lib/member-auth";
import {
  columnExamFor,
  readReportPayload,
  summarizeReport,
  type ReportPayload,
} from "@/lib/reports";
import {
  reportStatusView,
  serviceStatus,
  serviceSummary,
  type DossierReportRow,
} from "@/lib/dossier";
import { getAvailableVehicles } from "@/lib/vehicles";
import { examMarksFromSheets } from "@/lib/gsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Что именно записал штаб в ШДС по этому рапорту — источник допусков */
function examsOf(report: DossierReportRow, payload: ReportPayload): string[] {
  if (report.type !== "exam") return [];
  const exams = (payload as { exams?: { exam_code?: unknown }[] }).exams;
  if (!Array.isArray(exams)) return [];
  return exams.map((item) => String(item?.exam_code ?? "")).filter(Boolean);
}

/**
 * Оценка экзаменатора из рапорта на экзамены.
 *
 * В рапорте оценок может быть несколько (пакетная подача), а в ШДС бот пишет
 * одну — первую из заполненных (то же правило в review.ts, applyReport).
 * Поэтому здесь берётся ровно она: иначе бейдж в разделе «Экзамены» показывал бы
 * не ту оценку, что стоит в таблице.
 */
function gradeOf(report: DossierReportRow, payload: ReportPayload): string | null {
  if (report.type !== "exam") return null;
  const exams = (payload as { exams?: { grade?: unknown }[] }).exams;
  if (!Array.isArray(exams)) return null;
  for (const item of exams) {
    const grade = String(item?.grade ?? "").trim();
    if (grade) return grade;
  }
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await requireCabinetMember(req);
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
    const payloads = new Map<number, ReportPayload>(
      rows.map((row) => [row.id, readReportPayload(row.type, row.payload)])
    );

    const reports: DossierReportRow[] = rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.createdAt,
      reviewedBy: row.reviewedBy,
      moderatorComment: row.moderatorComment,
      // Оценка достаётся из payload один раз здесь: раздел «Экзамены» показывает
      // её в бейдже вместе с датой решения по рапорту
      grade: gradeOf(row, payloads.get(row.id) ?? ({ exams: [] } as ReportPayload)),
    }));

    const summary = serviceSummary(reports, (report) =>
      examsOf(report, payloads.get(report.id) ?? { exams: [] } as ReportPayload)
    );

    /**
     * Мерж оценок из ШДС: три листа («Танковая рота», «Артиллерийский
     * дивизион» вместе с блоком запаса 44–78, «Запас»).
     *
     * Зачем: одобренные рапорты — не единственный источник. Боец, вернувшийся
     * из запаса, имеет ПУСТУЮ основную строку и сданные нормативы в запасе;
     * часть отметок штаб ставит прямо в таблице. Без мержа ЛК показывал
     * «не сдано» по реально сданным нормативам.
     *
     * Ошибка Google не ломает досье: examMarksFromSheets возвращает [] и ЛК
     * работает по рапортам (см. её try/catch).
     */
    const sheetMarks = member.unit
      ? await examMarksFromSheets({
          unit: member.unit,
          names: [member.name || "", member.callsign || ""].filter(Boolean),
        })
      : [];

    /**
     * Ключ слияния — код СТОЛБЦА листа подразделения, а не написание из
     * рапорта. Один норматив зовут по-разному («Уставы общие» в панели и
     * «Уставы (общевойсковые)» в шапке), и без приведения к общему коду боец
     * видел бы два бейджа одного норматива.
     */
    const canonical = (code: string) =>
      columnExamFor(member.unit, code)?.code ?? code.trim();

    // Слияние: рапорт даёт дату и оценку, лист — сам факт сдачи и оценку.
    // Приоритет у листа по оценке: там стоит то, что реально в таблице.
    const qualifications: Record<string, { code: string; grade: string | null; at: string | null }> =
      {};
    for (const item of summary.qualificationDetails) {
      const code = canonical(item.code);
      const existing = qualifications[code];
      // Первая запись — самая свежая (рапорты идут по убыванию даты)
      if (existing) continue;
      qualifications[code] = { code, grade: item.grade, at: item.at };
    }
    for (const mark of sheetMarks) {
      if (!mark.passed) continue;
      const code = canonical(mark.code);
      const existing = qualifications[code];
      if (!existing) {
        qualifications[code] = { code, grade: mark.grade, at: null };
        continue;
      }
      // Оценка из таблицы главнее: она выставлена экзаменатором в ШДС
      if (mark.grade) existing.grade = mark.grade;
    }
    const mergedDetails = Object.values(qualifications);
    const mergedQualifications = mergedDetails.map((item) => item.code);

    const status = serviceStatus({
      status: member.status,
      active: member.active,
      vacationUntil: member.vacationUntil,
    });

    // Допуск к технике: звание и подразделение из карточки, нормативы —
    // объединённые (рапорты + ШДС). Раньше брали только рапорты, и боец с
    // оценками в таблице не получал допуск к технике.
    const vehicles = getAvailableVehicles({
      rank: member.rank,
      unit: member.unit,
      qualifications: mergedQualifications,
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
        // Квалификации — объединённые: рапорты + ШДС (все три листа, с мержем
        // оценок из запаса). Именно по ним раздел «Экзамены» рисует бейджи и
        // считает допуски, поэтому источник должен быть один.
        qualifications: mergedQualifications,
        qualificationDetails: mergedDetails.map((item) => ({
          code: item.code,
          grade: item.grade,
          at: item.at,
        })),
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