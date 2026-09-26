/**
 * Управление шаблонами «Арсенала» (POST /api/admin/armory).
 *
 * Создание и правка пресета. Доступ — командир или администратор: шаблон видит
 * весь состав, и «случайная» правка выкладки ушла бы людям в игру. Проверка идёт
 * доменным валидатором (validateArmoryTemplate): он же применяется формой, чтобы
 * формулировки ошибок совпадали с ответом API.
 *
 * Правки пишутся в журнал (bot_logs) — по нему видно, кто менял выкладку, что
 * важно при разборе «почему у бойца не тот БК».
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { armoryLoadouts, logs } from "@/db/schema";
import { requireStaff } from "@/lib/member-auth";
import { validateArmoryTemplate, type ArmoryTemplateBody } from "@/lib/armory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (!auth.ok) return auth.response;

  let body: ArmoryTemplateBody;
  try {
    body = (await req.json()) as ArmoryTemplateBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const author = auth.member.callsign
    ? `${auth.member.role === "admin" ? "Администратор" : "Командир"} ${auth.member.callsign}`
    : "Штаб";

  const validation = validateArmoryTemplate(body, author);
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
  }
  const template = validation.data;

  /**
   * Идентификатор необязателен: без него создаётся новый шаблон. Проверяем его
   * строго — иначе «id: abc» превратился бы в NaN и упал бы в роуте обновления.
   */
  const rawId = body.id;
  const id = rawId === undefined || rawId === null || rawId === "" ? null : Number(rawId);
  if (id !== null && (!Number.isInteger(id) || id <= 0)) {
    return NextResponse.json({ ok: false, error: "Некорректный ID шаблона" }, { status: 400 });
  }

  try {
    const values = {
      title: template.title,
      division: template.division,
      specialtyCode: template.specialtyCode,
      description: template.description,
      equipmentBreakdown: template.equipment,
      aceImportString: template.aceImportString,
      sqfCode: template.sqfCode,
      createdBy: template.createdBy,
      isActive: template.isActive,
      updatedAt: new Date(),
    };

    if (id === null) {
      const [created] = await db.insert(armoryLoadouts).values(values).returning();
      if (!created) {
        return NextResponse.json({ ok: false, error: "Не удалось создать шаблон" }, { status: 500 });
      }

      await db.insert(logs).values({
        category: "edit",
        author,
        action: `создал комплект «${created.title}»`,
        details: {
          Комплект: `#${created.id}`,
          Подразделение: created.division,
          Выкладка: created.aceImportString.slice(0, 120),
        },
        kind: "system",
        title: "Арсенал",
        detail: created.title,
        ok: true,
      });

      return NextResponse.json({ ok: true, id: created.id, created: true });
    }

    const [updated] = await db
      .update(armoryLoadouts)
      .set(values)
      .where(eq(armoryLoadouts.id, id))
      .returning();
    if (!updated) {
      return NextResponse.json({ ok: false, error: "Шаблон не найден" }, { status: 404 });
    }

    await db.insert(logs).values({
      category: "edit",
      author,
      action: `обновил комплект «${updated.title}»`,
      details: {
        Комплект: `#${updated.id}`,
        Подразделение: updated.division,
        Статус: updated.isActive ? "действует" : "в архиве",
      },
      kind: "system",
      title: "Арсенал",
      detail: updated.title,
      ok: true,
    });

    return NextResponse.json({ ok: true, id: updated.id, created: false });
  } catch (e) {
    console.error("[armory] Не удалось сохранить шаблон:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}