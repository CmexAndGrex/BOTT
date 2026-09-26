/**
 * Архив шаблона «Арсенала» (DELETE /api/admin/armory/[id]).
 *
 * Удаляем не строку, а снимаем признак is_active: комплект пропадает из каталога,
 * но остаётся в базе — по нему уже выдавали экипировку, и история нужна при
 * разборе. Восстановление — тем же роутом с `?restore=1` (шаблон возвращается в
 * каталог), это удобнее второго эндпоинта и не размножает правила доступа.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { armoryLoadouts, logs } from "@/db/schema";
import { requireStaff } from "@/lib/member-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const loadoutId = Number(id);
  if (!Number.isInteger(loadoutId) || loadoutId <= 0) {
    return NextResponse.json({ ok: false, error: "Некорректный ID шаблона" }, { status: 400 });
  }

  const restore = req.nextUrl.searchParams.get("restore") === "1";
  const author = auth.member.callsign
    ? `${auth.member.role === "admin" ? "Администратор" : "Командир"} ${auth.member.callsign}`
    : "Штаб";

  try {
    const [updated] = await db
      .update(armoryLoadouts)
      .set({ isActive: restore, updatedAt: new Date() })
      .where(eq(armoryLoadouts.id, loadoutId))
      .returning();

    if (!updated) {
      return NextResponse.json({ ok: false, error: "Шаблон не найден" }, { status: 404 });
    }

    await db.insert(logs).values({
      category: "edit",
      author,
      action: restore
        ? `вернул комплект «${updated.title}» из архива`
        : `убрал комплект «${updated.title}» в архив`,
      details: { Комплект: `#${updated.id}`, Подразделение: updated.division },
      kind: "system",
      title: "Арсенал",
      detail: updated.title,
      ok: true,
    });

    return NextResponse.json({ ok: true, id: updated.id, isActive: updated.isActive });
  } catch (e) {
    console.error("[armory] Не удалось изменить состояние шаблона:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}