/**
 * Защищённые карточки командования.
 *
 * Зачем модуль существует: данные заместителя командира корпуса (Иванов И. А.)
 * «слетали» при каждой автоматической сверке. Причина — не один баг, а три
 * независимых источника записи:
 *   1. синхронизация состава rs-red.com (tasks.ts) перезаписывает должность и
 *      помечает выбывшим того, кого нет на сайте;
 *   2. сверка ШДС (sync-scheduler.ts) переносит звание и подразделение из
 *      таблицы, а в таблице строка командования может стоять в «Вакант» или
 *      быть заполнена по шаблону;
 *   3. одобрение рапорта (review.ts, admin/recruits) приводит «Курсант» к
 *      «Рядовой» и подставляет подразделение из заявки.
 *
 * Каждый источник по отдельности выглядит разумно, вместе они понижали зама
 * корпуса до рядового и переводили в артиллерийский дивизион. Поэтому правило
 * живёт в одном чистом модуле и вызывается в каждом месте записи — не копией
 * условия, а одной функцией.
 *
 * Модуль намеренно не зависит от БД и Next.js: его проверяют тесты напрямую,
 * и он используется и в серверных задачах, и в роутах.
 */

/** Discord ID заместителя командира корпуса (Иванов И. А.) */
export const PROTECTED_DISCORD_ID = "1394327098801389762";

/**
 * ФИО защищённого бойца в написании, которое приходит из ШДС, rs-red.com и
 * заявок. Сравнение идёт по «жёсткому» ключу (без регистра, точек и пробелов),
 * как в validation.ts: «Иванов И.А», «Иванов И. А.» и «иванов и а» — одно лицо.
 */
export const PROTECTED_FULL_NAME = "Иванов И. А.";

/**
 * Постоянные данные защищённой карточки.
 *
 * Звание записано канонически («Ст. Лейтенант» — как в RANKS и в ролях
 * Discord), потому что именно это значение уходит в сверку ролей: написание
 * «Старший лейтенант» роли не находит и боец остаётся без звания. Алиас
 * «Старший лейтенант» распознаётся в role-sync.ts (RANK_ALIASES).
 */
export const PROTECTED_PROFILE = {
  rank: "Ст. Лейтенант",
  unit: "Танковая рота",
  post: "Заместитель командира корпуса",
} as const;

/** Ключ ФИО для сравнения: без регистра, «ё»→«е», без разделителей */
function nameKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]/g, "");
}

const PROTECTED_NAME_KEY = nameKey(PROTECTED_FULL_NAME);

/**
 * Боец — защищённая карточка командования.
 *
 * Признак один из двух: точный Discord ID (самый надёжный — ФИО в табеле
 * правят руками) ИЛИ ФИО, совпавшее по жёсткому ключу. Проверять только ID
 * нельзя: у строк синхронизации rs-red.com он пуст, и защита не сработала бы
 * как раз до первой привязки Discord.
 */
export function isProtectedFighter(fighter: {
  discordId?: string | null;
  name?: string | null;
  callsign?: string | null;
}): boolean {
  const id = String(fighter?.discordId ?? "").trim();
  if (id && id === PROTECTED_DISCORD_ID) return true;
  if (fighter?.name && nameKey(fighter.name) === PROTECTED_NAME_KEY) return true;
  // Позывной проверяем последним и только на полное совпадение: «Иванов» —
  // распространённая фамилия, и совпадение по одному слову защитило бы
  // случайного бойца.
  if (fighter?.callsign && nameKey(fighter.callsign) === PROTECTED_NAME_KEY) return true;
  return false;
}

/**
 * Правка карточки с учётом защиты.
 *
 * Возвращает исходный набор изменений, если боец не защищён. Для защищённой
 * карточки звание, подразделение и должность принудительно возвращаются к
 * постоянным значениям — даже если вызывающий код пытался их изменить.
 *
 * `active`/`status` не трогаются: защита данных — это не «вечный строй»,
 * увольнение и отпуск остаются возможными, но звание при них не сбрасывается.
 */
export function protectMemberUpdate<T extends Record<string, unknown>>(
  fighter: { discordId?: string | null; name?: string | null; callsign?: string | null },
  changes: T
): T {
  if (!isProtectedFighter(fighter)) return changes;

  const guarded: Record<string, unknown> = { ...changes };
  // Записываем только те поля, которые вызывающий действительно менял: иначе
  // синхронизация состава начала бы «обновлять» звание на каждом проходе и
  // забивать журнал записями об одном и том же бойце.
  if ("rank" in guarded) guarded.rank = PROTECTED_PROFILE.rank;
  if ("rankName" in guarded) guarded.rankName = PROTECTED_PROFILE.rank;
  if ("unit" in guarded) guarded.unit = PROTECTED_PROFILE.unit;
  if ("post" in guarded) guarded.post = PROTECTED_PROFILE.post;
  return guarded as T;
}

/**
 * Звание защищённой карточки вместо вычисленного.
 *
 * Отдельная функция нужна местам, где звание не «правится», а присваивается
 * заново: одобрение рапорта подставляет RECRUIT_RANK, запись в ШДС приводит
 * «Курсант» к «Рядовой». Возвращает null, если боец не защищён.
 */
export function protectedRankFor(fighter: {
  discordId?: string | null;
  name?: string | null;
  callsign?: string | null;
}): string | null {
  return isProtectedFighter(fighter) ? PROTECTED_PROFILE.rank : null;
}

/**
 * Разрешение пары «звание + подразделение» по одному источнику (таблица ШДС,
 * сайт, заявка).
 *
 * Если карточка защищена, источник игнорируется целиком: брать из него
 * подразделение и не брать звание (или наоборот) — это как раз тот
 * «половинчатый» результат, из-за которого зам корпуса оказывался в дивизионе
 * со званием роты.
 */
export function resolveRankAndUnit(
  fighter: { discordId?: string | null; name?: string | null },
  candidate: { rank: string; unit: string }
): { rank: string; unit: string } {
  if (isProtectedFighter(fighter)) {
    return { rank: PROTECTED_PROFILE.rank, unit: PROTECTED_PROFILE.unit };
  }
  return candidate;
}
