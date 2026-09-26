/**
 * Состояние обслуживания системы (GET /api/admin/maintenance).
 *
 * Отдаёт всё, что нужно карточкам панели: итог последней синхронизации ШДС,
 * время последней копии, срок хранения, список файлов и занятое место.
 *
 * Доступ — только администратор (requireMaintenance): роут раскрывает пути к
 * дампам и состояние базы, то есть служит разведкой для чужого. GET не меняет
 * состояние, поэтому CSRF-проверка источника к нему не применяется — она нужна
 * на POST-кнопках.
 */
import { NextRequest, NextResponse } from "next/server";
import { getMaintenanceHealth } from "@/lib/maintenance";
import { requireMaintenance } from "@/lib/maintenance-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireMaintenance(req);
  if (!auth.ok) return auth.response;

  const health = await getMaintenanceHealth();
  return NextResponse.json({ ok: true, health });
}