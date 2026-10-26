/**
 * Защита карточек командования корпуса от дефолтных значений автоматики.
 *
 * Зачем модуль существует: данные заместителя командира корпуса (Иванов И. А.)
 * «слетали» при каждой автоматической сверке. Причина — не один баг, а три
 * независимых источника записи:
 *   1. синхронизация состава rs-red.com (tasks.ts) перезаписывает должность и
 *      звание значением по умолчанию с сайта;
 *   2. сверка ШДС (sync-scheduler.ts) переносит звание и подразделение из
 *      таблицы, а в таблице строка командования может стоять в «Вакант»;
 *   3. одобрение рапорта (review.ts, admin/recruits) приводит «Курсант» к
 *      «Рядовой» и подставляет подразделение из заявки.
 *
 * ВАЖНО (изменение правила): звание, подразделение и должность НЕ фиксируются
 * константами. Командир корпуса повышает офицера (например, до «Капитан») и
 * меняет ему должность (например, на «КБМ») в любой момент — через панель или
 * лист «Командование АТК». Поэтому защита — это ФИЛЬТР ОТ ПУСТЫХ ДЕФОЛТОВ:
 * автоматический источник не имеет права затереть уже сохранённое значение
 * пустым, «Курсант», «Рядовой» или «не назначено». Явная правка (админ из
 * панели, значения из листа «Командование АТК») проходит без фильтра и
 * записывается в БД сразу.
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

/** Признак бойца: то, по чему его узнают внешние источники */
export type FighterIdentity = {
  discordId?: string | null;
  name?: string | null;
  callsign?: string | null;
};

/**
 * Текущее сохранённое состояние карточки.
 *
 * Передаётся фоновиками как «что уже записано в БД»: именно это значение
 * возвращается вместо дефолта, пришедшего из автоматического источника.
 */
export type ProfileSnapshot = {
  rank?: string | null;
  rankName?: string | null;
  unit?: string | null;
  post?: string | null;
};

/** Поля карточки, которые защищаются от дефолтных значений */
const GUARDED_FIELDS = ["rank", "rankName", "unit", "post"] as const;
type GuardedField = (typeof GUARDED_FIELDS)[number];

/** Ключ сравнения: без регистра, без «ё», без лишних пробелов */
function valueKey(value: unknown): string {
  return String(value ?? "")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Звание, которое автоматика ставит «по умолчанию».
 *
 * Пусто, «Курсант» (звание до присяги) и «Рядовой» (что приходит с rs-red.com
 * и из формы заявки у только что зачисленного) не являются назначением: для
 * офицера это признак того, что источник данных не знает настоящего звания.
 */
const DEFAULT_RANK_KEYS: ReadonlySet<string> = new Set(["", "курсант", "рядовой"]);

/** Значение звания — дефолт автоматического источника */
export function isDefaultRank(value: unknown): boolean {
  return DEFAULT_RANK_KEYS.has(valueKey(value));
}

/** Подразделение не назначено: null, пусто или служебная пометка */
const DEFAULT_UNIT_KEYS: ReadonlySet<string> = new Set([
  "",
  "не назначено",
  "не назначена",
  "нет",
]);

/** Значение подразделения — «не назначено» */
export function isDefaultUnit(value: unknown): boolean {
  return DEFAULT_UNIT_KEYS.has(valueKey(value));
}

/**
 * Должность, которую источник ставит «по умолчанию».
 *
 * Пусто, прочерк и «Рядовой» (rs-red.com иногда кладёт звание в колонку
 * должности) — не назначение должности.
 */
const DEFAULT_POST_KEYS: ReadonlySet<string> = new Set([
  "",
  "-",
  "—",
  "нет",
  "не назначено",
  "не назначена",
  "рядовой",
]);

/** Значение должности — дефолт автоматического источника */
export function isDefaultPost(value: unknown): boolean {
  return DEFAULT_POST_KEYS.has(valueKey(value));
}

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
export function isProtectedFighter(fighter: FighterIdentity): boolean {
  const id = String(fighter?.discordId ?? "").trim();
  if (id && id === PROTECTED_DISCORD_ID) return true;
  if (fighter?.name && nameKey(fighter.name) === PROTECTED_NAME_KEY) return true;
  // Позывной проверяем последним и только на полное совпадение: «Иванов» —
  // распространённая фамилия, и совпадение по одному слову защитило бы
  // случайного бойца.
  if (fighter?.callsign && nameKey(fighter.callsign) === PROTECTED_NAME_KEY) return true;
  return false;
}

/** Дефолт ли значение для конкретного поля карточки */
function isDefaultValue(field: GuardedField, value: unknown): boolean {
  if (field === "unit") return isDefaultUnit(value);
  if (field === "post") return isDefaultPost(value);
  return isDefaultRank(value);
}

/**
 * Сохранённое значение поля.
 *
 * Для `rankName` (звание в табеле rs-red.com) допускается запасной вариант из
 * `rank`: именно этот столбец показывается в панели, и если сайт прислал
 * «Рядовой», лучше показать присвоенное звание, чем дефолт вместе с потерянным.
 */
function storedValue(current: ProfileSnapshot | null, field: GuardedField): string {
  if (!current) return "";
  const direct = current[field];
  if (direct !== null && direct !== undefined && String(direct).trim()) {
    return String(direct).trim();
  }
  if (field === "rankName" && current.rank) return String(current.rank).trim();
  if (field === "rank" && current.rankName) return String(current.rankName).trim();
  return "";
}

/**
 * Правка карточки от АВТОМАТИЧЕСКОГО источника с учётом защиты.
 *
 * Возвращает исходный набор изменений, если боец не защищён. Для защищённой
 * карточки дефолтные значения (пусто, «Курсант»/«Рядовой», «не назначено»)
 * заменяются сохранёнными в БД; если сохранять нечего — поле убирается из
 * набора, чтобы UPDATE его вовсе не трогал. Осмысленное значение (например,
 * «Капитан» или «КБМ») проходит БЕЗ изменений: защита больше не блокирует
 * повышения и смену должности.
 *
 * Явные правки администратора и значения с листа «Командование АТК» эту
 * функцию не вызывают — они пишутся в БД напрямую.
 */
export function protectMemberUpdate<T extends Record<string, unknown>>(
  fighter: FighterIdentity,
  changes: T,
  current: ProfileSnapshot | null = null
): T {
  if (!isProtectedFighter(fighter)) return changes;

  const guarded: Record<string, unknown> = { ...changes };

  for (const field of GUARDED_FIELDS) {
    if (!(field in guarded)) continue;
    if (!isDefaultValue(field, guarded[field])) continue;
    const previous = storedValue(current, field);
    if (previous && !isDefaultValue(field, previous)) {
      guarded[field] = previous;
    } else {
      // Сохранять нечего: поле не должно попасть в UPDATE вовсе.
      delete guarded[field];
    }
  }

  return guarded as T;
}

/**
 * Разрешение пары «звание + подразделение» по автоматическому источнику
 * (лист подразделения ШДС).
 *
 * Для защищённой карточки источник игнорируется: в строке командования листа
 * подразделения может стоять «Рядовой» и чужое подразделение. Сохранённые в БД
 * значения имеют приоритет; если они пусты — берётся кандидат (затирать нечего).
 *
 * Изменять звание и должность офицера можно явно — из панели и с листа
 * «Командование АТК» (см. syncShdsRoster), эти пути сюда не заходят.
 */
export function resolveRankAndUnit(
  fighter: FighterIdentity,
  candidate: { rank: string; unit: string },
  current: ProfileSnapshot | null = null
): { rank: string; unit: string } {
  if (!isProtectedFighter(fighter)) return candidate;

  const storedRank = storedValue(current, "rank");
  const storedUnit = storedValue(current, "unit");

  return {
    rank: storedRank && !isDefaultRank(storedRank) ? storedRank : candidate.rank,
    unit: storedUnit && !isDefaultUnit(storedUnit) ? storedUnit : candidate.unit,
  };
}
