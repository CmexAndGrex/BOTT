/**
 * Сверка ролей Discord с базой панели: сопоставление, дельта и применение.
 *
 * Задача модуля — ответить на один вопрос: «что именно нужно изменить бойцу на
 * сервере, чтобы его роли соответствовали данным панели». Логика разделена на
 * три независимые части:
 *
 *   1. СОПОСТАВЛЕНИЕ — что БД (division_members.rank/rank_name/unit/post/status)
 *      и справочник (roles.ts) означают в терминах ролей сервера. Здесь живёт
 *      разбор составных званий («Капитан ТР»), определение подразделения по
 *      названию («Танковая рота» → ТР) и должности → роль.
 *   2. ДЕЛЬТА — что добавить и что снять у конкретного участника. Самая опасная
 *      часть: лишнее снятие означает, что боец потерял звание, а лишняя выдача —
 *      что он получил права, которых не заслужил.
 *   3. ПРИМЕНЕНИЕ — вызовы Discord и запись в журнал, с внедряемыми
 *      зависимостями, чтобы всё это проверялось тестами без сервера и БД.
 *
 * Принципы, заложенные в дельту (проверены tests/role-sync.test.ts):
 *   - синхронизация НИКОГДА не снимает роли вне своего справочника. Кастомные
 *     роли клана («Игроман», «Модератор», «Член профсоюза») остаются как есть:
 *     иначе одна ошибка в данных вычистила бы бойцу всё;
 *   - роль @everyone и роли, управляемые интеграциями (managed), не трогаются
 *     никогда — Discord их не даст снять, а попытка считается ошибкой;
 *   - неизвестное звание («Мл. Лейтенант» — роли на сервере нет) или пустое
 *     подразделение НЕ приводят к снятию уже выданных ролей: такая карточка
 *     пропускается и попадает в отчёт. Данные бывают неполными, и «не знаю» не
 *     должно означать «снять»;
 *   - режим dry-run: план считается, но Discord не трогается.
 */
import {
  CLAN_ROLE_IDS,
  COMMON_ROLE_IDS,
  RANK_ROLE_IDS,
  SUBDIV_ROLE_IDS,
  resolveBeretRoleId,
} from "@/lib/roles";
import { normalizeMemberStatus } from "@/lib/recruits";

/* ------------------------------------------------------------------ */
/* Модель участника и контекст сервера                                  */
/* ------------------------------------------------------------------ */

/** Боец из базы панели — только то, что нужно для сверки ролей */
export type RoleSyncMember = {
  id: number;
  name: string;
  discordId: string;
  /** Звание из карточки панели (division_members.rank) */
  rank: string | null;
  /** Звание из табеля rs-red.com (division_members.rank_name) */
  rankName: string | null;
  /** Подразделение: «Танковая рота» / «Артиллерийский дивизион» */
  unit: string | null;
  /** Должность (division_members.post) */
  post: string | null;
  /** Статус учётной записи: pending / active / vacation / dismissed */
  status: string;
  /** Состоит в составе (false — вышел или переведён в запас) */
  active: boolean;
  /** Отпуск — роль «Отпуск» на время службы */
  vacation: boolean;
  /**
   * Сдан экзамен на берет (все четыре норматива).
   *
   * Признак считается по одобренным рапортам (isBeretPassed, см.
   * role-sync-runtime.ts), а не хранится в карточке: «Берет» — производный
   * норматив, отдельного поля в БД у него нет. Без него роль «Берет» не выдать.
   */
  beretPassed: boolean;
};

/** Роль сервера в объёме, нужном для сверки */
export type GuildRoleInfo = {
  id: string;
  name: string;
  /** Роль бота/интеграции: выдавать и снимать её нельзя */
  managed: boolean;
};

/** Всё, что нужно знать о сервере, чтобы посчитать план */
export type RoleSyncContext = {
  /** ID роли @everyone (совпадает с ID сервера) */
  everyoneRoleId?: string | null;
  /** Роли сервера по ID */
  roles?: Map<string, GuildRoleInfo>;
  /** Роль «Отпуск» из настроек */
  leaveRoleId?: string | null;
  /** Роль «Запас» из настроек */
  reserveRoleId?: string | null;
  /**
   * Роль «Берет»: выдаётся за сданный экзамен на берет и снимается, если экзамен
   * больше не подтверждён (например, строку ШДС зачистили). Пусто — роль на
   * сервере не настроена, и берет в сверке не участвует.
   */
  beretRoleId?: string | null;
  /**
   * Должность → ID роли: явное соответствие из настроек.
   * Должности ведёт командир («Механик-водитель», «Наводчик»), и угадывать их
   * по имени роли нельзя — в панели можно задать точное соответствие.
   */
  postRoleMap?: Map<string, string>;
  /** Дополнительные роли, которые синхронизация не трогает (например, модератор) */
  protectedRoleIds?: Iterable<string>;
  /**
   * Роли участника на сервере (на момент сверки).
   *
   * Нужны, чтобы отличить «в запасе» от «вышел из подразделения»: в базе оба
   * состояния выглядят одинаково (active = false), а роль «Запас» выдаётся
   * только тем, кто действительно в запасе. Без этого признака синхронизация
   * надела бы роль «Запас» на всех выбывших.
   */
  currentRoleIds?: Iterable<string>;
};

/** Канонические звания системы: у части из них есть роль на сервере */
const KNOWN_RANKS = [
  ...Object.keys(RANK_ROLE_IDS),
  "Курсант",
  // Роли на сервере нет — но звание известно, и это не «мусор в данных»
  "Мл. Лейтенант",
] as const;

/** Ключ сравнения имён: регистр, точки и лишние пробелы не важны */
export function normalizeKey(value: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.\s]+/g, " ")
    .trim();
}

/**
 * Развёрнутые написания званий, которые встречаются в приказах и в ШДС.
 *
 * Ключ — как это пишут люди, значение — каноническое звание из RANK_ROLE_IDS.
 * Без этой таблицы «Старший лейтенант» не находил роли на сервере
 * (в справочнике звание записано как «Ст. Лейтенант»), и боец с этим званием
 * оставался вообще без роли звания, а сверка каждый цикл писала «для звания
 * роли на сервере нет».
 */
const RANK_ALIASES: Record<string, string> = {
  "старший лейтенант": "Ст. Лейтенант",
  "ст лейтенант": "Ст. Лейтенант",
  "ст. лейтенант": "Ст. Лейтенант",
  "старший прапорщик": "Ст. Прапорщик",
  "старший сержант": "Ст. Сержант",
  "младший сержант": "Мл. Сержант",
};

/** Каноническое звание по любому написанию: «ст.лейтенант» → «Ст. Лейтенант» */
const RANK_BY_KEY = new Map<string, string>([
  ...KNOWN_RANKS.map((rank) => [normalizeKey(rank), rank] as const),
  ...Object.entries(RANK_ALIASES).map(([alias, rank]) => [normalizeKey(alias), rank] as const),
]);

/** «Курсант» — звание до выдачи роли; на сервере роли не имеет */
export const CADET_RANK = "Курсант";

/**
 * Разбор звания из базы: отделяем подразделение и приводим написание к
 * каноническому.
 *
 * В данных встречаются все варианты: «Капитан ТР», «Капитан», «капитан тр»,
 * «Ст.Лейтенант АД». Возвращаем каноническое звание и суффикс подразделения,
 * чтобы дальнейшее сопоставление не зависело от того, как именно это записали.
 */
export function parseRank(raw: string | null | undefined): {
  rank: string | null;
  subdiv: keyof typeof SUBDIV_ROLE_IDS | null;
} {
  const value = (raw || "").trim();
  if (!value) return { rank: null, subdiv: null };

  let subdiv: keyof typeof SUBDIV_ROLE_IDS | null = null;
  let rest = value;
  for (const key of Object.keys(SUBDIV_ROLE_IDS)) {
    const suffix = normalizeKey(key);
    if (normalizeKey(rest).endsWith(` ${suffix}`)) {
      subdiv = key;
      // Отрезаем суффикс именно от исходной строки, чтобы не потерять точки
      rest = rest.slice(0, rest.length - key.length).trim();
      break;
    }
  }

  const rank = RANK_BY_KEY.get(normalizeKey(rest)) || null;
  return { rank, subdiv };
}

/**
 * Подразделение по названию из БД или из формы.
 *
 * «Танковая рота» → ТР, «Артиллерийский дивизион» → АД. Если в строке уже
 * стоит суффикс (боец назвал себя «ТР»), он тоже распознаётся. Незнакомое
 * название — null: подставлять «первое попавшееся» подразделение нельзя,
 * боец оказался бы в чужой роте.
 */
export function subdivForUnit(
  unit: string | null | undefined
): keyof typeof SUBDIV_ROLE_IDS | null {
  const value = normalizeKey(unit || "");
  if (!value) return null;
  for (const key of Object.keys(SUBDIV_ROLE_IDS)) {
    if (value === normalizeKey(key) || value.includes(normalizeKey(key))) {
      return key as keyof typeof SUBDIV_ROLE_IDS;
    }
  }
  if (value.includes("танк")) return "ТР";
  if (value.includes("арт") || value.includes("дивизион")) return "АД";
  return null;
}

/** Роль должности: точное соответствие из настроек (регистр не важен) */
export function resolvePostRoleId(
  post: string | null | undefined,
  map: Map<string, string> | undefined
): string | null {
  const value = normalizeKey(post || "");
  if (!value || !map) return null;
  for (const [name, roleId] of map) {
    if (normalizeKey(name) === value) return roleId.trim() || null;
  }
  return null;
}

/**
 * Желаемый набор ролей бойца по данным панели.
 *
 * `complete: false` — карточка неполная (неизвестное звание, нет подразделения).
 * Это важно для вызывающего кода: по такой карточке можно ДОБАВИТЬ то, что
 * известно, но нельзя вычитать из неё снятия — «не знаю» не означает «снять».
 */
export type DesiredRoles = {
  add: Set<string>;
  /** Что явно не должно быть на бойце (только из справочника ролей клана) */
  remove: Set<string>;
  /**
   * Роли статуса службы: снимаются даже при неполной карточке.
   *
   * «Отпуск» и «Запас» — не звание и не должность: они зависят только от
   * состояния бойца (отпуск / запас), а не от заполненности звания и
   * подразделения. Держать их в общем `remove` нельзя: неполная карточка
   * блокирует все снятия, и боец, вернувшийся из отпуска без указанного
   * подразделения, остался бы с ролью «Отпуск» навсегда.
   */
  removeAlways: Set<string>;
  /** Человекочитаемое пояснение для журнала */
  notes: string[];
  /** Данные неполные: карточку нельзя использовать для снятия ролей */
  complete: boolean;
  /** Роль звания из справочника (для отчёта) */
  rankRoleId: string | null;
  subdiv: string | null;
};

/**
 * Собирает желаемый набор ролей.
 *
 * Логика повторяет applyRoleCommand (roles.ts) для составного звания — боец в
 * строю носит подразделение + корпус + категорию «Звания» + само звание и
 * лишается «Новобранца»/«Друга АТК», — но без разбора интерактивной команды:
 * данные приходят из БД, а не из сообщения в канале.
 */
export function desiredRoles(member: RoleSyncMember, context: RoleSyncContext = {}): DesiredRoles {
  const notes: string[] = [];
  const add = new Set<string>();
  const remove = new Set<string>();
  const removeAlways = new Set<string>();

  const dismissed = !member.active || member.status === "dismissed";
  // «В запасе» отличаем от «вышел» по роли, которая уже стоит на сервере: в
  // базе оба состояния одинаковы (active = false), и без этой проверки роль
  // «Запас» получили бы все выбывшие бойцы подряд.
  const currentRoles = new Set(context.currentRoleIds || []);
  const inReserve =
    dismissed && !!context.reserveRoleId && currentRoles.has(context.reserveRoleId as string);
  /**
   * Отпуск определяется по двум источникам, и оба обязательны.
   *
   * `member.vacation` — то, что ставит панель, бот и шедулер; `status` — то,
   * что видит вход в кабинет. Значения статуса приходят из разных систем
   * («vacation», «on_vacation», «В отпуске»), поэтому сравнение идёт через
   * normalizeMemberStatus: строгое `=== "vacation"` не узнавало алиасы, и
   * боец в отпуске, записанный как «on_vacation», терял роль «Отпуск» на
   * ближайшем цикле.
   *
   * Важно: нормализация применяется ТОЛЬКО к отпуску. Статус `pending` и
   * `dismissed` остаются строгими намеренно — там от признака зависит СНЯТИЕ
   * ролей клана, и «неизвестное значение» (normalizeMemberStatus сводит его к
   * pending) вычистило бы бойцу всё звание на первом же цикле. Ошибка в
   * сторону «ничего не снято» безопаснее, чем ошибка в сторону «снято всё».
   */
  const statusKind = normalizeMemberStatus(member.status);
  const onVacation = !dismissed && (member.vacation || statusKind === "vacation");
  const pending = member.status === "pending" || member.status === "new";

  // Роль «Отпуск» снимается по состоянию службы, а не по заполненности карточки
  const leaveId = (context.leaveRoleId || "").trim();

  if (pending) {
    // Рапорт на рассмотрении: боец ещё не в составе, поэтому утверждать можно
    // только одно — ролей клана быть не должно. «Новобранец» выдаётся отдельно
    // при одобрении заявки (review.ts) и здесь не трогается.
    notes.push("рапорт на рассмотрении — роли клана не выдаются");
    for (const id of CLAN_ROLE_IDS) remove.add(id);
    // Заявка не может быть «в отпуске»: если роль осталась от прежней службы,
    // её нужно снять — это состояние службы, оно известно доподлинно.
    if (leaveId) removeAlways.add(leaveId);
    return { add, remove, removeAlways, notes, complete: true, rankRoleId: null, subdiv: null };
  }

  if (inReserve) {
    notes.push("в запасе — роли клана сняты, выдана роль «Запас»");
    for (const id of CLAN_ROLE_IDS) remove.add(id);
    if (leaveId) removeAlways.add(leaveId);
    remove.delete(context.reserveRoleId as string);
    add.add(context.reserveRoleId as string);
    return { add, remove, removeAlways, notes, complete: true, rankRoleId: null, subdiv: null };
  }

  if (dismissed) {
    // Вышел из подразделения: клан-роли снимаются, боец остаётся «Друг АТК».
    notes.push("вне состава — роли клана сняты, выдана роль «Друг АТК»");
    for (const id of CLAN_ROLE_IDS) remove.add(id);
    if (leaveId) removeAlways.add(leaveId);
    if (context.reserveRoleId) remove.add(context.reserveRoleId);
    add.add(COMMON_ROLE_IDS.FRIEND);
    return { add, remove, removeAlways, notes, complete: true, rankRoleId: null, subdiv: null };
  }

  // Звание: карточка панели важнее табеля rs-red.com. В панели звание правит
  // штаб (например, сразу после присвоения), а rankName приходит из внешнего
  // источника и может отставать на часы.
  const fromCard = parseRank(member.rank);
  const fromRoster = parseRank(member.rankName);
  const rank = fromCard.rank ?? fromRoster.rank;
  const subdiv = subdivForUnit(member.unit) ?? fromCard.subdiv ?? fromRoster.subdiv;

  let complete = true;
  const rankRoleId = rank ? RANK_ROLE_IDS[rank] ?? null : null;

  if (!rank) {
    complete = false;
    notes.push(
      member.rank?.trim()
        ? `звание «${member.rank}» не распознано — роли звания не тронуты`
        : "звание не задано — роли звания не тронуты"
    );
  } else if (!rankRoleId) {
    complete = false;
    notes.push(`для звания «${rank}» роли на сервере нет — роли звания не тронуты`);
  }

  if (!subdiv) {
    complete = false;
    notes.push("подразделение не определено — роли подразделения не тронуты");
  }

  // Роли клана в строю: начисляем только то, что известно доподлинно
  if (rankRoleId) add.add(rankRoleId);
  if (subdiv) {
    add.add(SUBDIV_ROLE_IDS[subdiv]);
    add.add(COMMON_ROLE_IDS.ATK_CORPS);
    add.add(COMMON_ROLE_IDS.RANKS_CATEGORY);
    // Боец в строю носит составное звание — «Новобранец» и «Друг АТК» лишние
    remove.add(COMMON_ROLE_IDS.RECRUIT);
    remove.add(COMMON_ROLE_IDS.FRIEND);
  }

  // Звания-конкуренты: у бойца должно быть одно звание, а не два. Снимаем
  // остальные, но только если новое известно доподлинно — иначе «неизвестное
  // звание» вычистило бы вообще всё.
  if (rankRoleId && !rankIsCadet(rank)) {
    for (const [name, id] of Object.entries(RANK_ROLE_IDS)) {
      if (id !== rankRoleId && normalizeKey(name) !== normalizeKey(rank as string)) {
        remove.add(id);
      }
    }
  }
  if (subdiv) {
    for (const [key, id] of Object.entries(SUBDIV_ROLE_IDS)) {
      if (key !== subdiv) remove.add(id);
    }
  }

  // Должности: соответствие задаёт командир списком, значит все роли из этого
  // списка — наши, и прежнюю должность нужно снять. Иначе боец, переведённый с
  // «Механика-водителя» на «Наводчика», носил бы обе роли.
  const postRoleMap = context.postRoleMap;
  const postRoleId = resolvePostRoleId(member.post, postRoleMap);
  if (postRoleMap) {
    for (const [, roleId] of postRoleMap) {
      const id = (roleId || "").trim();
      if (!id || id === postRoleId) continue;
      remove.add(id);
    }
  }
  if (postRoleId) {
    add.add(postRoleId);
    notes.push(`должность «${member.post}» — роль назначена`);
  }

  // Отпуск: выдача зависит от состояния службы, снятие — тоже, поэтому снятие
  // идёт в removeAlways и не блокируется неполной карточкой.
  if (onVacation && leaveId) {
    add.add(leaveId);
    notes.push("в отпуске — выдана роль «Отпуск»");
  } else if (leaveId) {
    removeAlways.add(leaveId);
  }

  // Роль запаса в строю быть не должна
  if (context.reserveRoleId) remove.add(context.reserveRoleId);

  // «Берет»: выдаётся за сданный экзамен, снимается, если экзамен больше не
  // подтверждён. Роль ведёт автоматика — рапортом её не выдают, и вручную
  // снятая роль вернётся на следующем цикле (как и звание).
  if (context.beretRoleId) {
    if (member.beretPassed) {
      add.add(context.beretRoleId);
      notes.push("сдан экзамен на берет — роль «Берет» назначена");
    } else {
      remove.add(context.beretRoleId);
    }
  }

  return { add, remove, removeAlways, notes, complete, rankRoleId, subdiv };
}

/**
 * Роли, которыми управляет синхронизация: только их она имеет право снимать.
 *
 * Отдельный набор, а не CLAN_ROLE_IDS из roles.ts, потому что туда осознанно не
 * входит «Друг АТК» (роль бывшего бойца), а роли «Отпуск», «Запас» и должности
 * задаются настройками и вовсе не привязаны к клану. При этом снимать их нужно:
 * боец, поступивший в строй, обязан потерять «Друга АТК», вернувшийся из
 * отпуска — роль «Отпуск», а сменивший должность — прежнюю должность.
 *
 * Всё, что в этот набор не попало, синхронизация не тронет никогда: кастомные
 * роли клана («Игроман», «Модератор») ведут люди.
 */
export function managedRoleIds(context: RoleSyncContext = {}): Set<string> {
  const ids = new Set<string>(CLAN_ROLE_IDS);
  ids.add(COMMON_ROLE_IDS.FRIEND);
  if (context.leaveRoleId) ids.add(context.leaveRoleId);
  if (context.reserveRoleId) ids.add(context.reserveRoleId);
  // «Берет» ведёт автоматика: роль и выдаётся, и снимается по нормативам, поэтому
  // она обязана быть в наборе управляемых — иначе снятие не найдёт права
  if (context.beretRoleId) ids.add(context.beretRoleId);
  for (const [, roleId] of context.postRoleMap || []) {
    const id = (roleId || "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

/** Звание «Курсант»: роли на сервере нет, снимать нечего */
function rankIsCadet(rank: string | null): boolean {
  return normalizeKey(rank || "") === normalizeKey(CADET_RANK);
}

/* ------------------------------------------------------------------ */
/* Дельта ролей                                                        */
/* ------------------------------------------------------------------ */

export type RoleDelta = {
  /** ID ролей к выдаче */
  add: string[];
  /** ID ролей к снятию */
  remove: string[];
  /** Имена ролей для журнала (снятие разбирают по именам, а не по ID) */
  addNames: string[];
  removeNames: string[];
  /** Почему ничего не меняем (пустая строка — изменения есть) */
  skipReason: string;
  notes: string[];
  /** Данные неполные: карточку нельзя использовать как источник снятий */
  incomplete: boolean;
};

/**
 * Что изменить участнику, чтобы его роли совпали с данными панели.
 *
 * `currentRoleIds` — роли участника на сервере (уже без @everyone: её Discord
 * возвращает как ID самого сервера, и попытка снять её — ошибка).
 *
 * Пять защит, каждая из которых закрывает конкретный сценарий порчи данных:
 *   1. роль @everyone не трогается никогда;
 *   2. managed-роли (бота и интеграции) не выдаются и не снимаются — Discord
 *      откажет, а повторять отказ на каждом цикле бессмысленно;
 *   3. роли вне нашего справочника не снимаются: кастомные «Игроман»,
 *      «Модератор», «Член профсоюза» остаются как есть;
 *   4. явно защищённые роли (protectedRoleIds) исключаются даже если попали в
 *      справочник — это страховка от ошибочной настройки «модератор = Капитан»;
 *   5. неполная карточка не даёт снятий (см. desiredRoles) — иначе боец с
 *      незаполненным подразделением потерял бы звание на первом же цикле.
 */
export function computeRoleDelta(
  member: RoleSyncMember,
  currentRoleIds: Iterable<string>,
  context: RoleSyncContext = {}
): RoleDelta {
  const current = new Set(currentRoleIds);
  // Роли участника нужны и внутри desiredRoles: по ним различаются «в запасе» и
  // «вышел из подразделения» (в базе оба состояния выглядят одинаково).
  const desired = desiredRoles(member, { ...context, currentRoleIds: current });

  const roles = context.roles;
  const everyone = (context.everyoneRoleId || "").trim();
  const protectedIds = new Set(context.protectedRoleIds || []);

  const nameOf = (id: string): string => roles?.get(id)?.name || id;
  const isManaged = (id: string): boolean => roles?.get(id)?.managed === true;
  const isEveryone = (id: string): boolean => !!everyone && id === everyone;
  const isProtected = (id: string): boolean => protectedIds.has(id);
  // Право на снятие есть только у ролей под управлением синхронизации
  const managed = managedRoleIds(context);
  const inOurCatalog = (id: string): boolean => managed.has(id);

  const add: string[] = [];
  const remove: string[] = [];

  for (const id of desired.add) {
    if (!id) continue;
    if (isEveryone(id) || isManaged(id) || isProtected(id)) continue;
    // Уже висит — лишний запрос к Discord не нужен: сверка идёт по всему
    // составу, и «на всякий случай выдать» превратилось бы в тысячи запросов.
    if (current.has(id)) continue;
    add.push(id);
  }

  for (const id of desired.remove) {
    if (!id) continue;
    if (isEveryone(id) || isManaged(id) || isProtected(id)) continue;
    if (!inOurCatalog(id)) continue; // п.3: чужое не снимаем
    if (!current.has(id)) continue;
    remove.push(id);
  }

  /**
   * Роли состояния службы («Отпуск») снимаются независимо от полноты карточки.
   *
   * Неполная карточка блокирует снятие ЗВАНИЙ и должностей — данных нет, и
   * «не знаю» не означает «снять». Но отпуск к званию отношения не имеет:
   * если боец вернулся (vacation = false), роль «Отпуск» должна уйти даже при
   * пустом подразделении. Иначе боец, вернувшийся из отпуска без указанного
   * подразделения, оставался бы с ролью «Отпуск» навсегда, а сверка на каждом
   * цикле сообщала бы «данные неполные» вместо исправления.
   */
  const removeAlways: string[] = [];
  for (const id of desired.removeAlways) {
    if (!id) continue;
    if (isEveryone(id) || isManaged(id) || isProtected(id)) continue;
    if (!inOurCatalog(id)) continue;
    if (!current.has(id)) continue;
    if (remove.includes(id)) continue; // уже учтена обычным путём
    removeAlways.push(id);
  }

  // Неполная карточка: добавляем известное, но снимаем только состояние службы
  const incomplete = !desired.complete;
  const effectiveRemove = incomplete ? removeAlways : [...remove, ...removeAlways];
  const notes = [...desired.notes];

  if (incomplete && remove.length) {
    notes.push(
      `карточка неполная: снятие ${remove.length} рол(и) отложено до заполнения данных`
    );
  }

  const skipReason =
    !add.length && !effectiveRemove.length
      ? incomplete
        ? "данные неполные"
        : "роли соответствуют данным"
      : "";

  return {
    add: add.sort(),
    remove: effectiveRemove.sort(),
    addNames: add.map(nameOf).sort(),
    removeNames: effectiveRemove.map(nameOf).sort(),
    skipReason,
    notes,
    incomplete,
  };
}

/* ------------------------------------------------------------------ */
/* План сверки и его применение                                        */
/* ------------------------------------------------------------------ */

/** Результат сверки по одному бойцу */
export type RoleSyncPlanEntry = {
  memberId: number;
  name: string;
  discordId: string;
  delta: RoleDelta;
  /** Сколько ролей у бойца на сервере (0 — участник не найден) */
  currentCount: number;
  /** Ошибка чтения ролей: участник вышел с сервера, нет прав и т. п. */
  error: string | null;
};

export type RoleSyncCounters = {
  /** Сколько карточек проверено */
  checked: number;
  /** У скольких есть расхождения */
  changed: number;
  /** Сколько ролей выдано/снято */
  added: number;
  removed: number;
  /** Записи, которые не удалось обработать (нет Discord ID, ошибка чтения) */
  skipped: number;
  /** Сколько изменений не применилось из-за ошибок Discord */
  failed: number;
  /** Карточки с неполными данными */
  incomplete: number;
};

export function summarizePlan(entries: RoleSyncPlanEntry[]): RoleSyncCounters {
  const counters: RoleSyncCounters = {
    checked: entries.length,
    changed: 0,
    added: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    incomplete: 0,
  };

  for (const entry of entries) {
    if (entry.error) counters.skipped++;
    if (entry.delta.incomplete) counters.incomplete++;
    if (entry.delta.add.length || entry.delta.remove.length) {
      counters.changed++;
      counters.added += entry.delta.add.length;
      counters.removed += entry.delta.remove.length;
    }
  }
  return counters;
}

/**
 * Считает план сверки, ничего не меняя на сервере.
 *
 * Порядок обхода — по имени: в журнале и в отчёте план читается человеком, и
 * «вперемешку» (как отдаёт БД) он выглядел бы случайным набором строк. Ошибка
 * чтения ролей одного бойца не срывает план остальных: у каждого участника своя
 * запись, и отчёт показывает, кого именно не удалось проверить.
 */
export async function planRoleSync(
  members: RoleSyncMember[],
  deps: {
    getMemberRoles: (discordId: string) => Promise<string[] | null>;
    context: RoleSyncContext;
  }
): Promise<RoleSyncPlanEntry[]> {
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const entries: RoleSyncPlanEntry[] = [];

  for (const member of sorted) {
    if (!member.discordId) {
      entries.push({
        memberId: member.id,
        name: member.name,
        discordId: "",
        currentCount: 0,
        error: "не указан Discord ID — сверка невозможна",
        delta: computeRoleDelta(member, [], deps.context),
      });
      continue;
    }

    const current = await deps.getMemberRoles(member.discordId);
    if (current === null) {
      entries.push({
        memberId: member.id,
        name: member.name,
        discordId: member.discordId,
        currentCount: 0,
        error: "участник не найден на сервере или роли недоступны",
        delta: computeRoleDelta(member, [], deps.context),
      });
      continue;
    }

    entries.push({
      memberId: member.id,
      name: member.name,
      discordId: member.discordId,
      currentCount: current.length,
      error: null,
      delta: computeRoleDelta(member, current, deps.context),
    });
  }

  return entries;
}

/** Итог применения плана */
export type ApplyPlanResult = {
  applied: number;
  failed: number;
  /** Строки для журнала: кто изменён и как */
  changes: string[];
  errors: string[];
};

/**
 * Применяет план: выдаёт и снимает роли через переданные функции.
 *
 * Изменения идут по одному бойцу (сначала снятие, потом выдача) и не
 * прерываются на ошибке: если Discord отказал по одному участнику — обычно
 * из-за его выхода с сервера или позиции роли выше роли бота, — остальные
 * должны быть обработаны. Иначе одна «плохая» карточка останавливала бы
 * синхронизацию всего состава.
 */
export async function applyPlan(
  entries: RoleSyncPlanEntry[],
  deps: {
    addRole: (discordId: string, roleId: string) => Promise<void>;
    removeRole: (discordId: string, roleId: string) => Promise<void>;
    onApplied?: (entry: RoleSyncPlanEntry) => void | Promise<void>;
    onError?: (entry: RoleSyncPlanEntry, error: unknown) => void | Promise<void>;
  }
): Promise<ApplyPlanResult> {
  const result: ApplyPlanResult = { applied: 0, failed: 0, changes: [], errors: [] };

  for (const entry of entries) {
    const { add, remove } = entry.delta;
    if (!add.length && !remove.length) continue;
    if (entry.error || !entry.discordId) continue;

    try {
      // Порядок важен: сначала снимаем «Новобранец» и прочее лишнее, потом
      // выдаём звание. Если делать наоборот, у бойца на мгновение окажутся две
      // роли звания — а на это завязаны другие проверки (и это видно в аудите).
      for (const roleId of remove) {
        await deps.removeRole(entry.discordId, roleId);
      }
      for (const roleId of add) {
        await deps.addRole(entry.discordId, roleId);
      }

      result.applied++;
      result.changes.push(
        `${entry.name}: ${
          [
            add.length ? `+${entry.delta.addNames.join(", +")}` : "",
            remove.length ? `−${entry.delta.removeNames.join(", −")}` : "",
          ]
            .filter(Boolean)
            .join(" ")
        }`
      );
      await deps.onApplied?.(entry);
    } catch (e) {
      result.failed++;
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push(`${entry.name}: ${message}`);
      await deps.onError?.(entry, e);
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Запись изменений в журнал панели                                    */
/* ------------------------------------------------------------------ */

/** Строка журнала для bot_logs: категория edit — значимая, не обрезается */
export type RoleSyncLogRow = {
  kind: string;
  title: string;
  detail: string;
  ok: boolean;
  category: string;
  author: string;
  action: string;
  /** Значения — строки, числа или списки строк: так их читает панель журнала */
  details: Record<string, string | number | string[]>;
  error: string | null;
};

/**
 * Собирает запись журнала о применённых изменениях.
 *
 * Пишем по одной записи на цикл, а не по записи на бойца: массовая сверка
 * задевает десятки человек, и журнал, забитый отдельными строками, перестаёт
 * читаться. Исключение — ошибки: они перечисляются в поле error, потому что
 * именно их ищут при разборе «почему у бойца не сменилось звание».
 *
 * Персональные данные: имена бойцов попадают в аудит осознанно — это трейл,
 * доступный только в панели, и без имён разбор инцидента невозможен (та же
 * логика, что в обработчике запросов ролей в bot.ts). В консоль, наоборот,
 * уходят только обезличенные ссылки.
 */
export function buildRoleSyncLog(input: {
  source: string;
  dryRun: boolean;
  counters: RoleSyncCounters;
  changes: string[];
  errors: string[];
  durationMs: number;
}): RoleSyncLogRow {
  const { counters } = input;
  const changed = counters.changed > 0;

  const title = input.dryRun
    ? "Сверка ролей (проверка без изменений)"
    : changed
      ? "Роли Discord синхронизированы"
      : "Сверка ролей: расхождений нет";

  const detail =
    `Проверено бойцов: ${counters.checked}. ` +
    `Требуют изменений: ${counters.changed} (выдать ${counters.added}, снять ${counters.removed}). ` +
    `Пропущено: ${counters.skipped}, с неполными данными: ${counters.incomplete}` +
    (counters.failed ? `, ошибок применения: ${counters.failed}` : "") +
    `. Источник: ${input.source}, ${input.durationMs} мс.`;

  // Список изменений ограничен: одна строка журнала не должна превращаться в
  // многокилобайтный дамп, а первые двадцать записей уже показывают характер
  // правок (например, «у всего состава не распознано подразделение»).
  const limited = input.changes.slice(0, 20);
  const tail =
    input.changes.length > limited.length
      ? `…и ещё ${input.changes.length - limited.length}`
      : "";

  return {
    kind: "roles",
    title,
    detail,
    // Ошибки применения — не «успех»: строка должна быть заметна в журнале
    ok: input.errors.length === 0,
    category: "edit",
    author: "Discord-бот (сверка ролей)",
    action: input.dryRun
      ? `проверил роли ${counters.checked} бойцов`
      : `синхронизировал роли: изменено ${counters.changed}, выдано ${counters.added}, снято ${counters.removed}`,
    details: {
      "Проверено": String(counters.checked),
      "Изменено": String(counters.changed),
      "Выдано ролей": String(counters.added),
      "Снято ролей": String(counters.removed),
      "Изменения": limited.length ? [...limited, tail].filter(Boolean) : ["—"],
    },
    error: input.errors.length ? input.errors.slice(0, 20).join("; ") : null,
  };
}

/* ------------------------------------------------------------------ */
/* Параметры синхронизации из настроек                                 */
/* ------------------------------------------------------------------ */

/** Ключ настроек: когда последний раз сверяли роли (внутренний, не в UI) */
export const LAST_ROLE_SYNC_KEY = "_last_role_sync";

/** Разбор карты «должность = ID роли» из настроек (по строке на пару) */
export function parsePostRoleMap(raw: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of (raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.includes("=") ? "=" : trimmed.includes(":") ? ":" : null;
    if (!separator) continue;
    const index = trimmed.indexOf(separator);
    const post = trimmed.slice(0, index).trim();
    const roleId = trimmed.slice(index + 1).trim();
    // Роль задаётся ID: имя роли командир поменять может, и соответствие
    // «должность → имя» ломалось бы при каждом переименовании.
    if (!post || !/^\d{5,}$/.test(roleId)) continue;
    map.set(post, roleId);
  }
  return map;
}

/** Включена ли фоновая сверка и как часто её запускать */
export function roleSyncSchedule(map: Map<string, string>): {
  enabled: boolean;
  intervalMin: number;
  dryRun: boolean;
} {
  const raw = Number.parseInt((map.get("role_sync_interval_min") || "").trim(), 10);
  return {
    enabled: (map.get("role_sync_enabled") || "false").trim() === "true",
    // Нижняя граница — 5 минут: чаще сверять весь состав бессмысленно (данные
    // приходят из ШДС раз в час), а лимиты Discord расходует именно она.
    intervalMin: Number.isFinite(raw) ? Math.min(24 * 60, Math.max(5, raw)) : 30,
    // Отсутствие настройки означает «проверка», а не «менять»: fail-safe в
    // сторону «ничего не изменено» — если ключа нет (старая база до обновления
    // настроек), бот обязан сначала показать отчёт, а не править роли.
    dryRun: (map.get("role_sync_dry_run") || "true").trim() === "true",
  };
}

/* ------------------------------------------------------------------ */
/* Запуск сверки                                                       */
/* ------------------------------------------------------------------ */

/**
 * Внешние зависимости сверки.
 *
 * Все они внедряются: сам оркестратор не знает ни про drizzle, ни про Discord
 * REST API. Благодаря этому тест прогоняет полный цикл — включая записи в
 * журнал и ошибки применения — без базы и без сети, а боевой код остаётся ровно
 * тем же, что и в production.
 */
export type RoleSyncDeps = {
  loadSettings: () => Promise<Map<string, string>>;
  loadMembers: () => Promise<RoleSyncMember[]>;
  getGuildRoles: (guildId: string) => Promise<GuildRoleInfo[]>;
  getMemberRoles: (guildId: string, discordId: string) => Promise<string[] | null>;
  addRole: (guildId: string, discordId: string, roleId: string) => Promise<void>;
  removeRole: (guildId: string, discordId: string, roleId: string) => Promise<void>;
  saveLog: (row: RoleSyncLogRow) => Promise<void>;
  saveState: (iso: string) => Promise<void>;
  /**
   * Список серверов бота: нужен только когда в настройках не задан guild_id.
   * Внедряется, чтобы тест не ходил в сеть за определением сервера.
   */
  getBotGuildIds?: () => Promise<string[]>;
  /** Внедряемые часы: в тестах не нужно реального времени */
  now?: () => number;
  log?: (message: string) => void;
};

export type RoleSyncSummary = {
  ok: boolean;
  /** Сверка выполнена в режиме проверки: Discord не менялся */
  dryRun: boolean;
  counters: RoleSyncCounters;
  /** Сообщение для интерфейса и журнала */
  message: string;
  /** Ошибка, из-за которой цикл не выполнен вовсе (нет сервера, нет токена) */
  error?: string;
  /** Строки изменений (для панели: первые N показываются целиком) */
  changes: string[];
  /** Диагностика: сколько запросов ушло на повтор из-за лимитов */
  rateLimitRetries: number;
};

/** Настройка «должность = роль»: строкой, как её вводит командир */
export const POST_ROLE_MAP_KEY = "post_role_map";

/**
 * Определяет сервер, к которому применяются роли.
 *
 * Тот же принцип, что и в остальном проекте: ID из настроек, а если его нет —
 * только единственный сервер бота. При нескольких серверах угадывать нельзя:
 * роли уехали бы не туда (см. grantRecruitRole в review.ts).
 */
async function resolveGuildId(
  map: Map<string, string>,
  deps: Pick<RoleSyncDeps, "getBotGuildIds" | "log">
): Promise<string | null> {
  const explicit = (map.get("guild_id") || "").trim();
  if (explicit) return explicit;

  // Без guild_id сервер определяем только при единственном сервере бота: при
  // нескольких угадывать нельзя — роли уехали бы не туда (та же логика, что в
  // grantRecruitRole из review.ts).
  try {
    const ids = deps.getBotGuildIds
      ? await deps.getBotGuildIds()
      : await (async () => {
          const { getBotGuildIds } = await import("@/lib/discord");
          return getBotGuildIds();
        })();
    if (ids.length === 1) return ids[0];
    deps.log?.(
      `[role-sync] guild_id не задан, бот на ${ids.length} серверах — сверка пропущена`
    );
    return null;
  } catch (e) {
    deps.log?.(`[role-sync] не удалось получить список серверов: ${String(e)}`);
    return null;
  }
}

/**
 * Полный цикл сверки: читает данные панели, считает план, применяет его и пишет
 * результат в журнал.
 *
 * Функция НИКОГДА не бросает исключение: она вызывается из фонового таймера и из
 * роута панели, а необработанная ошибка в фоновой задаче роняет процесс вместе с
 * веб-сервером (та же причина, по которой так устроен runMaintenanceCycle).
 */
export async function runRoleSync(
  deps: RoleSyncDeps,
  options: { source?: string; dryRun?: boolean; memberId?: number } = {}
): Promise<RoleSyncSummary> {
  const source = options.source || "schedule";
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const empty: RoleSyncCounters = {
    checked: 0,
    changed: 0,
    added: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    incomplete: 0,
  };

  try {
    const map = await deps.loadSettings();
    const schedule = roleSyncSchedule(map);
    // Режим проверки: либо включён глобально, либо запрошен вызывающим кодом
    const dryRun = options.dryRun ?? schedule.dryRun;

    const guildId = await resolveGuildId(map, deps);
    if (!guildId) {
      const error =
        "не задан guild_id, а бот состоит не на одном сервере — сверка ролей невозможна";
      await deps.saveLog(
        buildRoleSyncLog({
          source,
          dryRun,
          counters: empty,
          changes: [],
          errors: [error],
          durationMs: now() - startedAt,
        })
      );
      return {
        ok: false,
        dryRun,
        counters: empty,
        message: error,
        error,
        changes: [],
        rateLimitRetries: 0,
      };
    }

    // Роли сервера нужны и для имён в журнале, и для защиты managed-ролей
    const guildRoles = await deps.getGuildRoles(guildId);
    const roles = new Map(guildRoles.map((r) => [r.id, r]));

    // @everyone — роль с ID сервера; снимать её нельзя ни при каких условиях
    const everyoneRoleId = (map.get("everyone_role_id") || "").trim() || guildId;

    // Защищённые роли: модератор, командирский состав, запас. Их выдачи и
    // снятия ведёт штаб руками, и автоматика не должна их задевать.
    const protectedRoleIds = new Set<string>(
      [map.get("moderator_role_id"), map.get("command_role_id"), map.get("reserve_role_id")]
        .map((v) => (v || "").trim())
        .filter(Boolean)
    );

    const all = await deps.loadMembers();
    const members = options.memberId ? all.filter((m) => m.id === options.memberId) : all;

    const context: RoleSyncContext = {
      everyoneRoleId,
      roles,
      leaveRoleId: (map.get("leave_role_id") || "").trim() || null,
      reserveRoleId: (map.get("reserve_role_id") || "").trim() || null,
      // «Берет»: явная настройка, иначе роль ищется по имени среди ролей сервера.
      // Роль ведут по нормативам, поэтому она обязана попасть в управляемые —
      // иначе боец получит её, но повторная сверка не сможет снять лишнюю
      beretRoleId: resolveBeretRoleId(map.get("beret_role_id"), guildRoles),
      postRoleMap: parsePostRoleMap(map.get(POST_ROLE_MAP_KEY)),
      protectedRoleIds,
    };

    const plan = await planRoleSync(members, {
      getMemberRoles: (discordId) => deps.getMemberRoles(guildId, discordId),
      context,
    });

    // Режим проверки не должен трогать Discord вообще: иначе «проверка» меняла бы
    // роли, и администратор не смог бы безопасно посмотреть, что будет.
    const applyResult = dryRun
      ? { applied: 0, failed: 0, changes: [] as string[], errors: [] as string[] }
      : await applyPlan(plan, {
          addRole: (discordId, roleId) => deps.addRole(guildId, discordId, roleId),
          removeRole: (discordId, roleId) => deps.removeRole(guildId, discordId, roleId),
          onError: (entry, error) =>
            deps.log?.(
              `[role-sync] ${entry.name}: роли не изменены — ${
                error instanceof Error ? error.message : String(error)
              }`
            ),
        });

    const counters: RoleSyncCounters = {
      ...summarizePlan(plan),
      failed: applyResult.failed,
    };

    // Что было бы сделано: в режиме проверки это единственный результат, и
    // именно он нужен штабу, чтобы решиться включить боевой режим.
    const planned = plan
      .filter((e) => !e.error && (e.delta.add.length || e.delta.remove.length))
      .map((e) =>
        [
          `${e.name}:`,
          e.delta.add.length ? `+${e.delta.addNames.join(", +")}` : "",
          e.delta.remove.length ? `−${e.delta.removeNames.join(", −")}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      );

    const changes = dryRun ? planned : applyResult.changes;
    const errors = applyResult.errors;

    await (async () => {
      try {
        await deps.saveLog(
          buildRoleSyncLog({
            source,
            dryRun,
            counters,
            changes,
            errors,
            durationMs: now() - startedAt,
          })
        );
      } catch (e) {
        // Сбой журнала не отменяет уже применённые изменения: роли на сервере
        // выставлены, и объявлять цикл неудачным значило бы соврать в отчёте.
        deps.log?.(
          `[role-sync] журнал недоступен: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    })();

    // Дата последнего цикла: чтобы после перезапуска контейнера фоновая задача
    // не пересчитывала весь состав раньше настроенного интервала.
    try {
      await deps.saveState(new Date(now()).toISOString());
    } catch {
      // Настройки недоступны — цикл всё равно выполнен, отметку перечитают позже
    }

    const message = dryRun
      ? `Проверка без изменений: расхождений ${counters.changed}, было бы выдано ${counters.added}, снято ${counters.removed}.`
      : counters.changed
        ? `Синхронизировано: бойцов изменено ${counters.changed}, выдано ролей ${counters.added}, снято ${counters.removed}.`
        : "Расхождений нет: роли соответствуют данным панели.";

    deps.log?.(
      `[role-sync] ${message} Проверено ${counters.checked}, пропущено ${counters.skipped}, ошибок ${counters.failed}`
    );

    return {
      ok: errors.length === 0,
      dryRun,
      counters,
      message,
      changes,
      rateLimitRetries: 0,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.log?.(`[role-sync] цикл сверки не выполнен: ${message}`);

    // Ошибку тоже фиксируем в журнале: молчаливый сбой сверки хуже громкого —
    // состав расходится с ролями, а штаб об этом не знает.
    try {
      await deps.saveLog(
        buildRoleSyncLog({
          source,
          dryRun: options.dryRun ?? false,
          counters: empty,
          changes: [],
          errors: [message],
          durationMs: now() - startedAt,
        })
      );
    } catch {
      /* журнал недоступен — процесс всё равно не должен падать */
    }

    return {
      ok: false,
      dryRun: options.dryRun ?? false,
      counters: empty,
      message: `Сверка ролей не выполнена: ${message}`,
      error: message,
      changes: [],
      rateLimitRetries: 0,
    };
  }
}