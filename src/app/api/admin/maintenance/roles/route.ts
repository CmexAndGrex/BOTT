/**
 * Сверка ролей Discord с базой панели (POST /api/admin/maintenance/roles).
 *
 * Два режима, и выбор делается сознательно:
 *   - проверка (`mode=dry`): считает расхождения и пишет отчёт, но роли НЕ
 *     меняет. Это режим по умолчанию: администратор сначала смотрит, что было
 *     бы сделано, и только потом включает боевой режим;
 *   - применение (`mode=apply`): меняет роли на сервере.
 *
 * Только администратор (requireMaintenance): операция массово меняет права на
 * Discord, то есть по последствиям это не «обновить статистику», а изменение
 * доступа живых людей.
 *
 * Неудача синхронизации — 502, а не 500: это не сбой сервера, и панель покажет
 * причину из поля error (то же решение, что в соседних роутах обслуживания).
 */
import { NextRequest, NextResponse } from "next/server";
import { maintenanceAuthor, requireMaintenance } from "@/lib/maintenance-guard";
import { syncGuildRoles } from "@/lib/role-sync-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Сверка всего состава: сотни запросов к Discord с паузами после 429 */
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = await requireMaintenance(req);
  if (!auth.ok) return auth.response;

  // Режим по умолчанию — проверка. Ошибиться в сторону «ничего не менялось»
  // безопасно, в обратную сторону — нет.
  const mode = (req.nextUrl.searchParams.get("mode") || "dry").toLowerCase();
  const dryRun = mode !== "apply";

  const memberIdRaw = Number.parseInt(req.nextUrl.searchParams.get("member") || "", 10);
  const memberId = Number.isFinite(memberIdRaw) && memberIdRaw > 0 ? memberIdRaw : undefined;

  const result = await syncGuildRoles({
    source: `manual:${auth.username || "—"}`,
    dryRun,
    memberId,
  });

  if (!result.ok && result.error) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        author: maintenanceAuthor(auth.username),
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    mode: result.dryRun ? "dry" : "apply",
    message: result.message,
    author: maintenanceAuthor(auth.username),
    sync: {
      counters: result.counters,
      // Панель показывает первые изменения целиком и не тонет в тысяче строк
      changes: result.changes.slice(0, 30),
      changesTotal: result.changes.length,
    },
  });
}