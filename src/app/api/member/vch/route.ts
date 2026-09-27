/**
 * «Кто на ВЧ» — живой список бойцов подразделения на сервере Arma 3.
 *
 * Доступ только действующему составу (requireActiveMember): адрес сервера и
 * состав игроков — внутренняя информация подразделения, и гостю здесь делать
 * нечего. Неавторизованный запрос получает 401, боец без статуса «в строю» —
 * 403 (это разные ситуации, и интерфейс различает их по коду).
 *
 * Роут никогда не отдаёт 500 «из-за сервера игры»: UDP-таймаут — штатный
 * результат, и виджет покажет «никого нет». Иначе выключенный игровой сервер
 * ронял бы страницу кабинета.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import { requireActiveMember } from "@/lib/member-auth";
import { garrisonStatus, type RosterEntry } from "@/lib/a2s";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** UDP-обмен с двумя таймаутами по 3 секунды плюс запас на ответ */
export const maxDuration = 15;

/** Состав для сопоставления: позывной, звание, подразделение */
async function loadRoster(): Promise<RosterEntry[]> {
  const rows = await db
    .select({
      id: members.id,
      callsign: members.callsign,
      name: members.name,
      rank: members.rank,
      unit: members.unit,
    })
    .from(members)
    .where(eq(members.active, true));

  return rows.map((row) => ({
    id: row.id,
    // Позывной — основной идентификатор в панели, но у бойцов из синхронизации
    // rs-red.com его может не быть: берём имя, иначе такой боец никогда не
    // «найдётся» на сервере.
    callsign: (row.callsign || row.name || "").trim(),
    rank: row.rank || "",
    division: row.unit,
  }));
}

export async function GET(req: NextRequest) {
  const auth = await requireActiveMember(req);
  if (!auth.ok) return auth.response;

  let roster: RosterEntry[] = [];
  try {
    roster = await loadRoster();
  } catch (e) {
    console.error("[vch] Не удалось получить состав для сопоставления:", e);
    return NextResponse.json(
      { ok: false, error: "Ошибка БД: состав недоступен" },
      { status: 500 }
    );
  }

  // force: кнопка «обновить» в кабинете — осознанное действие бойца, оно должно
  // перебивать кэш. Без параметра работает TTL 60 секунд (защита сервера от флуда).
  const force = req.nextUrl.searchParams.get("force") === "1";

  try {
    const summary = await garrisonStatus(roster, { force });

    return NextResponse.json({
      ok: true,
      /** Сервер ответил */
      online: summary.online,
      /** Всего игроков на сервере */
      onlineCount: summary.onlineCount,
      maxPlayers: summary.maxPlayers,
      map: summary.map,
      clanMembersOnline: summary.clanMembersOnline.map((entry) => ({
        id: entry.id,
        callsign: entry.callsign,
        rank: entry.rank,
        division: entry.division,
      })),
      /** Сколько своих на сервере — для бейджа виджета */
      clanOnlineCount: summary.clanMembersOnline.length,
      /** Причина отсутствия данных (сервер не настроен / не ответил) */
      notice: summary.error ?? null,
    });
  } catch (e) {
    // Сюда попадаем только при внутренней ошибке (например, недоступен сокет
    // процесса): сетевые сбои уже превращены в «online: false» внутри
    // garrisonStatus, и виджету достаточно пустой сводки, а не 500.
    console.error("[vch] Сбой опроса сервера:", e);
    return NextResponse.json({
      ok: true,
      online: false,
      onlineCount: 0,
      maxPlayers: 0,
      map: null,
      clanMembersOnline: [],
      clanOnlineCount: 0,
      notice: "Не удалось опросить сервер",
    });
  }
}