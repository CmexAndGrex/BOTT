/**
 * Ручная очистка устаревших данных (POST /api/admin/maintenance/prune).
 *
 * Удаляет сессии бойцов с истёкшим сроком, незначительные записи журнала старше
 * срока хранения и протухшие записи ограничителей входа в память процесса.
 * Права на вход в панель (категории auth/login/edit) не удаляются никогда —
 * иначе администратор стёр бы сам аудит своих же действий.
 */
import { NextRequest, NextResponse } from "next/server";
import { pruneExpiredSessionsAndLogs } from "@/lib/maintenance";
import { maintenanceAuthor, requireMaintenance } from "@/lib/maintenance-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireMaintenance(req);
  if (!auth.ok) return auth.response;

  const result = await pruneExpiredSessionsAndLogs();

  return NextResponse.json({
    ok: result.ok,
    author: maintenanceAuthor(auth.username),
    message: result.ok
      ? "Очистка устаревших сессий завершена"
      : "Очистка выполнена частично",
    prune: {
      sessions: result.sessions,
      logs: result.logs,
      throttles: result.throttles,
      retentionDays: result.retentionDays,
      ranAt: result.ranAt,
    },
    ...(result.error ? { error: result.error } : {}),
  });
}