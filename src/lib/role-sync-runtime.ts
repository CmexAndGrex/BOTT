/**
 * Обвязка сверки ролей: база панели, Discord REST и журнал.
 *
 * Отдельно от src/lib/role-sync.ts намеренно. Там — правила (что считать
 * расхождением и что можно снять), здесь — провода: запросы к PostgreSQL, вызовы
 * Discord и запись в bot_logs. Тесты проверяют правила, подставляя подставные
 * зависимости, поэтому ни база, ни сеть им не нужны; подключение к ним живёт в
 * одном месте, и его нельзя случайно «занести» в тест импортом.
 *
 * Модуль не бросает исключений наружу: цикл вызывается из фонового таймера, а
 * необработанная ошибка в фоне уронила бы процесс вместе с веб-сервером.
 */
import { isNotNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { logs, members, serviceReports } from "@/db/schema";
import { addGuildMemberRole, getBotGuildIds, getGuildMemberRoles, getGuildRoles, removeGuildMemberRole } from "@/lib/discord";
import { getSettings, setSettingQuiet } from "@/lib/settings";
import { isBeretPassed } from "@/lib/exams";
import { readReportPayload, type ExamPayload } from "@/lib/reports";
import {
  LAST_ROLE_SYNC_KEY,
  runRoleSync,
  type RoleSyncMember,
  type RoleSyncSummary,
} from "@/lib/role-sync";

/**
 * Сданные нормативы по бойцам: нужен один признак — закрыт ли берет.
 *
 * Считается из одобренных рапортов на экзамены тем же правилом, что и раздел
 * «Экзамены» (isBeretPassed): «Берет» производный, отдельного поля в БД нет.
 * Читается одним запросом на весь состав — сверка идёт по всем бойцам сразу, и
 * запрос на каждого превратился бы в сотни обращений к БД.
 *
 * Сбой чтения не срывает сверку: без берета роль просто не выдаётся (и не
 * снимается), остальные роли синхронизируются как обычно.
 */
async function loadBeretPassed(memberIds: number[]): Promise<Set<number>> {
  const passed = new Set<number>();
  if (memberIds.length === 0) return passed;

  try {
    const rows = await db
      .select({
        memberId: serviceReports.memberId,
        type: serviceReports.type,
        payload: serviceReports.payload,
        status: serviceReports.status,
      })
      .from(serviceReports)
      .where(inArray(serviceReports.memberId, memberIds));

    // Собираем нормативы по каждому бойцу и проверяем берет его же правилом
    const byMember = new Map<number, string[]>();
    for (const row of rows) {
      if (row.type !== "exam" || !row.memberId) continue;
      // Только одобренные: рапорт на рассмотрении — ещё не сдача
      if (row.status !== "approved") continue;
      const payload = readReportPayload(row.type, row.payload) as ExamPayload;
      const list = byMember.get(row.memberId) ?? [];
      for (const exam of payload.exams ?? []) {
        if (exam.exam_code) list.push(exam.exam_code);
      }
      byMember.set(row.memberId, list);
    }

    for (const [memberId, codes] of byMember) {
      if (isBeretPassed(codes.map((code) => ({ code })))) passed.add(memberId);
    }
  } catch (e) {
    console.error("[role-sync] Не удалось прочитать нормативы состава:", e);
  }

  return passed;
}

/** Загружает бойцов, у которых есть Discord ID: без него сверять нечего */
async function loadMembers(): Promise<RoleSyncMember[]> {
  const rows = await db
    .select({
      id: members.id,
      name: members.name,
      discordId: members.discordId,
      rank: members.rank,
      rankName: members.rankName,
      unit: members.unit,
      post: members.post,
      status: members.status,
      active: members.active,
      vacation: members.vacation,
    })
    .from(members)
    .where(isNotNull(members.discordId));

  const beret = await loadBeretPassed(rows.map((row) => row.id));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    discordId: (row.discordId || "").trim(),
    rank: row.rank,
    rankName: row.rankName,
    unit: row.unit,
    post: row.post,
    status: row.status,
    active: row.active,
    vacation: row.vacation,
    beretPassed: beret.has(row.id),
  }));
}

/** Запись строки журнала в bot_logs */
async function saveLog(row: {
  kind: string;
  title: string;
  detail: string;
  ok: boolean;
  category: string;
  author: string;
  action: string;
  details: unknown;
  error: string | null;
}): Promise<void> {
  await db.insert(logs).values({
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    ok: row.ok,
    category: row.category,
    author: row.author,
    action: row.action,
    details: row.details,
    error: row.error,
  });
}

/**
 * Боевые зависимости сверки.
 *
 * Обратите внимание на обработку ошибок чтения ролей участника: выдача роли
 * может упасть по «нормальной» причине (роль выше роли бота, участник вышел с
 * сервера), и это не повод считать весь цикл сломанным — такие случаи копятся в
 * отчёте и попадают в журнал поимённо.
 */
export function productionRoleSyncDeps() {
  return {
    loadSettings: () => getSettings(true),
    loadMembers,
    getGuildRoles: async (guildId: string) =>
      (await getGuildRoles(guildId)).map((role) => ({
        id: role.id,
        name: role.name,
        managed: role.managed,
      })),
    getMemberRoles: (guildId: string, discordId: string) =>
      getGuildMemberRoles(guildId, discordId),
    addRole: async (guildId: string, discordId: string, roleId: string) => {
      await addGuildMemberRole(guildId, discordId, roleId);
    },
    removeRole: async (guildId: string, discordId: string, roleId: string) => {
      await removeGuildMemberRole(guildId, discordId, roleId);
    },
    saveLog,
    saveState: (iso: string) => setSettingQuiet(LAST_ROLE_SYNC_KEY, iso),
    getBotGuildIds: () => getBotGuildIds(),
    log: (message: string) => console.log(message),
  };
}

/**
 * Сверка ролей боевого состава.
 *
 * Точка входа для фонового планировщика и для кнопки в панели. Никогда не
 * бросает: даже сбой настроек возвращается как отчёт с ошибкой.
 */
export async function syncGuildRoles(options: {
  source?: string;
  dryRun?: boolean;
  memberId?: number;
} = {}): Promise<RoleSyncSummary> {
  try {
    return await runRoleSync(productionRoleSyncDeps(), options);
  } catch (e) {
    // Страховка на случай ошибки вне самого цикла (например, недоступен
    // модуль БД): отчёт должен вернуться в любом случае.
    const message = e instanceof Error ? e.message : String(e);
    console.error("[role-sync] сбой запуска сверки:", message);
    return {
      ok: false,
      dryRun: options.dryRun ?? false,
      counters: {
        checked: 0,
        changed: 0,
        added: 0,
        removed: 0,
        skipped: 0,
        failed: 0,
        incomplete: 0,
      },
      message: `Сверка ролей не запущена: ${message}`,
      error: message,
      changes: [],
      rateLimitRetries: 0,
    };
  }
}