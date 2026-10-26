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
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import { requireActiveMember } from "@/lib/member-auth";
import { garrisonStatus, type RosterEntry, type SelfMember } from "@/lib/a2s";
import { MEMBER_STATUS } from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** UDP-обмен с двумя таймаутами по 3 секунды плюс запас на ответ */
export const maxDuration = 15;

/**
 * Состав для сопоставления: позывной, ФИО, звание, подразделение.
 *
 * Единственный фильтр — действующее членство в корпусе (status = active,
 * флаг active не снят). Фильтра по подразделению НЕТ: в списке дежурных
 * обязаны оказаться все — Танковая рота, Артиллерийский дивизион,
 * Командование корпуса и новобранцы без назначенного подразделения
 * (unit IS NULL). Фильтра текущего пользователя тоже нет: командир или
 * офицер на сервере виден в блоке присутствующих на ВЧ наравне с бойцами.
 */
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
    .where(
      and(
        eq(members.active, true),
        eq(members.status, MEMBER_STATUS.ACTIVE),
        // «В отпуске» боец на сервере не сидит, но и не уволен — оставляем в
        // табеле: если он всё же зашёл на ВЧ, его карточка должна найтись
        ne(members.status, MEMBER_STATUS.DISMISSED)
      )
    );

  return rows.map((row) => ({
    id: row.id,
    // Позывной — основной идентификатор в панели, но у бойцов из синхронизации
    // rs-red.com его может не быть: берём имя, иначе такой боец никогда не
    // «найдётся» на сервере.
    callsign: (row.callsign || row.name || "").trim(),
    // ФИО — второй ключ сопоставления: на сервере часто сидят под ФИО со
    // званием («Ряд. Волков Д.В.»), и позывной их там не написан
    name: (row.name || "").trim(),
    rank: row.rank || "",
    division: row.unit,
  }));
}

/**
 * Позывной бойца сессии для сопоставления с ником на сервере.
 *
 * Берётся из табеля (уже загруженного состава), а не из токена сессии: у бойцов
 * из синхронизации rs-red.com поле callsign пустое, и позывным становится имя.
 * С пустым значением боец не нашёлся бы на сервере никогда.
 *
 * Ошибка БД здесь не критична: состав уже получен, поэтому отсутствие своей
 * записи означает лишь «статус в бою не считаем», а не сбой виджета.
 */
async function loadSelfMember(id: number): Promise<SelfMember | null> {
  const [row] = await db
    .select({ id: members.id, callsign: members.callsign, name: members.name })
    .from(members)
    .where(eq(members.id, id));

  if (!row) return null;
  return {
    id: row.id,
    callsign: (row.callsign || row.name || "").trim(),
    // ФИО нужно для статуса «в бою»: боец может сидеть на сервере под ФИО
    name: (row.name || "").trim(),
  };
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

  // Боец сессии: позывной нужен, чтобы ответить на главный вопрос виджета —
  // «я сейчас на сервере?». Позывной берётся из табеля (loadSelfMember): в токене
  // сессии он может быть пустым, и тогда статус «в бою» не выдался бы никогда.
  // Если запись не прочиталась, виджет остаётся сводкой состава — без ошибки.
  let self: SelfMember | null = null;
  try {
    self = await loadSelfMember(auth.member.id);
  } catch (e) {
    console.error("[vch] Не удалось прочитать бойца сессии:", e);
  }

  try {
    const summary = await garrisonStatus(roster, { force, member: self });

    return NextResponse.json({
      ok: true,
      /** Сервер ответил */
      online: summary.online,
      /** Всего игроков на сервере */
      onlineCount: summary.onlineCount,
      maxPlayers: summary.maxPlayers,
      map: summary.map,
      /** Боец сессии найден среди игроков — зелёный бейдж «в бою» */
      selfOnline: summary.selfOnline,
      clanMembersOnline: summary.clanMembersOnline.map((entry) => ({
        id: entry.id,
        callsign: entry.callsign,
        // ФИО из табеля: карточка показывает официальное имя, позывной — рядом
        name: entry.name ?? null,
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
      /** Сервер не опрошен — «я в бою» утверждать нельзя */
      selfOnline: false,
      clanMembersOnline: [],
      clanOnlineCount: 0,
      notice: "Не удалось опросить сервер",
    });
  }
}