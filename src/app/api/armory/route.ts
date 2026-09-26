/**
 * Каталог «Арсенала» (GET /api/armory).
 *
 * Отдаёт действующие шаблоны выкладок с фильтром по разделу и поиском. Доступ —
 * любому вошедшему (боец из кабинета либо сотрудник панели): комплекты не
 * содержат персональных данных, а каталог нужен именно бойцу перед выездом.
 *
 * Наружу уходит строго перечисленный набор полей плюс вычисленные на сервере
 * строки (текстовый табель и SQF для Eden): собирать их в браузере значило бы
 * продублировать правила форматирования — они живут в src/lib/armory.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { armoryLoadouts } from "@/db/schema";
import { getAuthUser } from "@/lib/api-auth";
import { getSessionMember } from "@/lib/member-auth";
import {
  buildTextChecklist,
  canManageArmory,
  canViewArmory,
  isArmoryDivision,
  matchesQuery,
  readEquipment,
  sqfForEden,
  type ArmoryDivision,
} from "@/lib/armory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const [user, member] = await Promise.all([getAuthUser(req), getSessionMember(req)]);
  const allowed = canViewArmory({
    memberRole: member?.role,
    memberStatus: member?.status,
    panelRole: user?.role,
  });
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: "Нет доступа: войдите в личный кабинет или панель" },
      { status: 401 }
    );
  }

  // Фильтры: раздел (по умолчанию — все) и поиск по названию/выкладке
  const divisionRaw = req.nextUrl.searchParams.get("division") || "";
  const division: ArmoryDivision | null = isArmoryDivision(divisionRaw) ? divisionRaw : null;
  const query = req.nextUrl.searchParams.get("q") || "";
  // Штабу доступен архив, бойцу — только действующие комплекты
  const withArchived =
    req.nextUrl.searchParams.get("archived") === "1" &&
    canManageArmory({
      memberRole: member?.role,
      memberStatus: member?.status,
      panelRole: user?.role,
    });

  try {
    const filters = [withArchived ? null : eq(armoryLoadouts.isActive, true), division ? eq(armoryLoadouts.division, division) : null].filter(
      (f) => f !== null
    );

    const baseQuery = db
      .select()
      .from(armoryLoadouts)
      .orderBy(asc(armoryLoadouts.division), asc(armoryLoadouts.title))
      .limit(300);

    const rows = filters.length ? await baseQuery.where(and(...filters)) : await baseQuery;

    // Поиск выполняем в модуле домена, а не в SQL: правило одно для сервера и
    // интерфейса, и оно ищет по разобранной выкладке (jsonb в ILIKE не разложить)
    const loadouts = rows
      .map((row) => {
        const equipment = readEquipment(row.equipmentBreakdown);
        return {
          id: row.id,
          title: row.title,
          division: row.division,
          specialtyCode: row.specialtyCode,
          description: row.description,
          equipment,
          aceImportString: row.aceImportString,
          sqfCode: row.sqfCode,
          sqfEden: sqfForEden(row.sqfCode),
          checklist: buildTextChecklist({
            title: row.title,
            division: row.division,
            specialtyCode: row.specialtyCode,
            description: row.description,
            equipment,
          }),
          createdBy: row.createdBy,
          isActive: row.isActive,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      })
      .filter((row) =>
        matchesQuery(
          { title: row.title, specialtyCode: row.specialtyCode, description: row.description, equipment: row.equipment },
          query
        )
      );

    return NextResponse.json({
      ok: true,
      division,
      query,
      archived: withArchived,
      canManage: canManageArmory({
        memberRole: member?.role,
        memberStatus: member?.status,
        panelRole: user?.role,
      }),
      loadouts,
    });
  } catch (e) {
    console.error("[armory] Не удалось получить каталог:", e);
    return NextResponse.json({ ok: false, error: "Ошибка БД" }, { status: 500 });
  }
}