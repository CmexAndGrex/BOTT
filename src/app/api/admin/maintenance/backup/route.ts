/**
 * Ручной съём резервной копии (POST /api/admin/maintenance/backup).
 *
 * Администратор жмёт кнопку, когда собирается делать что-то рискованное
 * (правка состава, миграция) и не хочет ждать ночного автосейва.
 *
 * Ответ 502 при неудаче, а не 500: это не сбой сервера, а неудачная операция,
 * и панель показывает администратору причину из поля error.
 */
import { NextRequest, NextResponse } from "next/server";
import { createDatabaseBackup } from "@/lib/backup";
import { maintenanceAuthor, requireMaintenance } from "@/lib/maintenance-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Дамп большой базы через pg_dump может занять десятки секунд */
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const auth = await requireMaintenance(req);
  if (!auth.ok) return auth.response;

  const result = await createDatabaseBackup();

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error || "Ошибка при создании копии",
        // Автор нужен журналу панели: кто именно нажал кнопку
        author: maintenanceAuthor(auth.username),
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Резервная копия успешно создана",
    backup: {
      fileName: result.fileName,
      sizeMb: result.sizeMb,
      createdAt: result.createdAt,
      mode: result.mode,
      tables: result.tables,
      durationMs: result.durationMs,
    },
  });
}