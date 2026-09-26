/**
 * Немедленная синхронизация с Google Таблицей (POST /api/admin/maintenance/sync).
 *
 * Отдельно от автосинхронизации состава: там обновляются часы онлайна с
 * rs-red.com, а здесь штаб сверяет звания и подразделения с живой таблицей ШДС —
 * например, сразу после того, как правки внесли руками.
 *
 * Неудача Google не является ошибкой сервера: роут отвечает 502 с причиной, а
 * приложение продолжает работу. Это же поведение проверяет тест изоляции ошибок.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireMaintenance } from "@/lib/maintenance-guard";
import { runSheetSync } from "@/lib/sync-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Чтение нескольких листов Google может занять время */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireMaintenance(req);
  if (!auth.ok) return auth.response;

  const result = await runSheetSync("manual");

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error || result.detail || "Ошибка синхронизации" },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Синхронизация с Google Таблицей завершена",
    sync: {
      updated: result.updated,
      sheets: result.sheets,
      detail: result.detail,
      status: result.status,
    },
  });
}