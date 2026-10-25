import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/member-auth";
import { seedOfficialOnlineReports, resetSeedFlag } from "@/lib/seed-official-reports";

/**
 * POST /api/seed-official-reports
 * Запускает засев эталонных данных за 3 недели октября 2026.
 * Идемпотентен при обычном запросе.
 *
 * Body: { force?: boolean } — если force=true, сбрасывает флаг и перезапускает засев.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const body = await req.json().catch(() => ({}));
    const force = Boolean(body?.force);

    if (force) {
      await resetSeedFlag();
    }

    const result = await seedOfficialOnlineReports();

    if (result.skipped) {
      return NextResponse.json({
        ok: true,
        message: "Засев уже был выполнен ранее. Передайте force=true для повторного запуска.",
        skipped: true,
      });
    }

    return NextResponse.json({
      ok: true,
      message: `Засев выполнен: ${result.matched}/${result.totalFighters} бойцов сопоставлено, ${result.updatedWarnings} предупреждений обновлено.`,
      ...result,
    });
  } catch (error) {
    console.error("[seed-official-reports] Ошибка:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ошибка сервера" },
      { status: 500 }
    );
  }
}
