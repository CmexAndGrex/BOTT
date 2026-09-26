/**
 * Модуль выдачи/снятия ролей через Discord-бота (запросы ролей).
 *
 * Поддерживает:
 *  1. Команды вида «Выдать Игроман, снять Друг АТК» — несколько ролей и оба
 *     действия в одном сообщении (разделение по запятой, регистр не важен).
 *  2. «Составные» звания вида «Капитан ТР» / «Ст. Лейтенант АД»: по аналогии
 *     с «Рядовой ТР» выдают набор ролей — подразделение (ТР/АД) + корпус +
 *     категорию «Звания» + саму роль звания, а также снимают «Новобранец» и
 *     «Друг АТК». При снятии, если не осталось ролей подразделения, боец снова
 *     получает роль «Друг АТК».
 *  3. Обычные роли ищутся по имени на сервере (без учёта регистра).
 */
import type { Guild, GuildMember } from "discord.js";

/* ------------------------------------------------------------------ */
/* Константы ролей                                                     */
/* ------------------------------------------------------------------ */

/** ID роли «Рядовой» */
export const PRIVATE_ROLE_ID = "1090320507288699020";

/** Звания и их ID на сервере (Мл. Лейтенант — роли нет, пропущен) */
export const RANK_ROLE_IDS: Record<string, string> = {
  "Рядовой": PRIVATE_ROLE_ID,
  "Ефрейтор": "1090320811572875314",
  "Мл. Сержант": "1090320716869664779",
  "Сержант": "1090321078733246494",
  "Ст. Сержант": "1090321544707846165",
  "Старшина": "1090321774861889586",
  "Прапорщик": "1090321850388717618",
  "Ст. Прапорщик": "1090321912732860466",
  "Лейтенант": "1090321990004514836",
  "Ст. Лейтенант": "1090322073546661959",
  "Капитан": "1090322244242264086",
  "Майор": "1090322473674866819",
  "Подполковник": "1090322587491520592",
  "Полковник": "1090322648560582688",
};

/** Роли подразделений: суффикс (ТР/АД) → ID роли подразделения */
export const SUBDIV_ROLE_IDS: Record<string, string> = {
  "ТР": "1084414184600633345", // Танковая рота
  "АД": "1084414055088922634", // Артиллерийский дивизион
};

/** Общие системные роли клана */
export const COMMON_ROLE_IDS = {
  RECRUIT: "1500793747544215592", // Новобранец
  FRIEND: "1084735958399852544", // Друг АТК
  ATK_CORPS: "1392226832274948207", // Артиллерийско-Танковый Корпус
  RANKS_CATEGORY: "1089255012460417066", // категория «Звания»
} as const;

/**
 * Все роли клана (проверка «роли не сняты» для вышедших бойцов).
 * «Друг АТК» сюда НЕ входит — это роль бывшего бойца.
 */
export const CLAN_ROLE_IDS: Set<string> = new Set([
  ...Object.values(RANK_ROLE_IDS),
  ...Object.values(SUBDIV_ROLE_IDS),
  COMMON_ROLE_IDS.ATK_CORPS,
  COMMON_ROLE_IDS.RANKS_CATEGORY,
  COMMON_ROLE_IDS.RECRUIT,
]);

/** Роли, запрещённые к выдаче/снятию */
const PROTECTED_ROLE_NAMES = ["модератор", "администратор"];
/* ------------------------------------------------------------------ */
/* Парсинг команды запроса ролей                                        */
/* ------------------------------------------------------------------ */

export type RoleAction = "give" | "remove";

export type RoleOp = { action: RoleAction; name: string };

/**
 * Разбор командной строки на операции.
 * Элементы разделяются запятой. Каждый элемент может начинаться с "Выдать"
 * или "Снять" (регистр не важен) — последующие элементы наследуют
 * последнее действие.
 *
 * Примеры:
 *   "Выдать Капитан ТР, снять Друг АТК"
 *   "Выдать Игроман, Снять Друг АТК"
 *   "Выдать Игроман, Игломан2, Снять Звание"
 *   "Снять Рядовой ТР, Друг АТК"
 */
export function parseRoleCommand(line: string): RoleOp[] {
  const ops: RoleOp[] = [];
  let current: RoleAction | null = null;

  for (const raw of line.split(",")) {
    const segment = raw.trim();
    if (!segment) continue;

    // «роль» после действия — служебное слово, а не имя роли:
    // «Выдать роль Игроман» должно выдать «Игроман». Раньше здесь стоял
    // отрицательный lookahead, из-за которого такая строка не распознавалась
    // как действие вовсе и в имя роли попадало «Выдать роль Игроман».
    const actionMatch = segment.match(/^(Выдать|Снять)\s+(?:роль\s+)?(.*)$/i);
    let opName: string;
    if (actionMatch) {
      current = actionMatch[1].toLowerCase() === "выдать" ? "give" : "remove";
      opName = actionMatch[2].trim();
      if (opName) {
        opName = opName.replace(/^роль\s+/i, "").trim();
      }
    } else {
      opName = segment.replace(/^роль\s+/i, "").trim();
    }

    if (!opName) continue;
    if (!current) current = "give"; // первое слово без действия — по умолчанию выдаём
    ops.push({ action: current, name: opName });
  }
  return ops;
}

/* ------------------------------------------------------------------ */
/* Резолвер ролей                                                      */
/* ------------------------------------------------------------------ */

/** Находит ID звания по имени (без учёта регистра) */
function findRankId(name: string): string | null {
  const low = name.toLowerCase();
  for (const [rank, id] of Object.entries(RANK_ROLE_IDS)) {
    if (rank.toLowerCase() === low) return id;
  }
  return null;
}

/** Проверяет, является ли имя составным званием «Звание ТР/АД» (регистр не важен) */
function matchComposite(name: string): { rank: string; subdiv: string } | null {
  const lowName = name.toLowerCase();
  for (const subdiv of Object.keys(SUBDIV_ROLE_IDS)) {
    const suffix = ` ${subdiv}`.toLowerCase();
    if (!lowName.endsWith(suffix)) continue;
    const rank = name.slice(0, name.length - suffix.length).trim();
    if (findRankId(rank)) return { rank, subdiv };
  }
  return null;
}

/** Ищет обычную роль прямо на сервере по имени */
function findRole(guild: Guild, name: string) {
  const low = name.toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === low) || null;
}

export type RoleApplyResult = {
  ok: boolean;
  message: string;
  applied: { action: RoleAction; name: string }[];
  errors: string[];
};
/**
 * Применяет список операций к участнику. Валидирует ВСЕ роли заранее,
 * чтобы не применять частично: если хоть одна роль не найдена или
 * защищена — операция отклоняется целиком.
 */
export async function applyRoleCommand(
  guild: Guild,
  member: GuildMember,
  ops: RoleOp[]
): Promise<RoleApplyResult> {
  const errors: string[] = [];
  const applied: { action: RoleAction; name: string }[] = [];
  const toAdd = new Set<string>();
  const toRemove = new Set<string>();

  for (const op of ops) {
    const name = op.name.trim();
    if (!name) continue;

    const lowName = name.toLowerCase();
    if (PROTECTED_ROLE_NAMES.some((p) => lowName.includes(p))) {
      errors.push(`«${name}» — выдавать/снимать эту роль запрещено`);
      continue;
    }

    const composite = matchComposite(name);
    if (composite) {
      const subdivId = SUBDIV_ROLE_IDS[composite.subdiv];
      const rankId = findRankId(composite.rank);
      if (!subdivId || !rankId) {
        errors.push(`«${name}» — звание или подразделение не найдено`);
        continue;
      }

      if (op.action === "give") {
        // Капитан ТР → ТР + Корпус + «Звания» + звание; снимаем Новобранца и Друга АТК
        toAdd.add(subdivId);
        toAdd.add(COMMON_ROLE_IDS.ATK_CORPS);
        toAdd.add(COMMON_ROLE_IDS.RANKS_CATEGORY);
        toAdd.add(rankId);
        toRemove.add(COMMON_ROLE_IDS.RECRUIT);
        toRemove.add(COMMON_ROLE_IDS.FRIEND);
      } else {
        // Снять составное звание: убираем подразделение + звание.
        toRemove.add(subdivId);
        toRemove.add(rankId);
        // Если у бойца не остаётся ролей подразделений — снимаем корпус/категорию
        // и возвращаем «Друг АТК» (как в старом боте).
        const hasOtherSubdiv = member.roles.cache.some((r) =>
          Object.values(SUBDIV_ROLE_IDS).includes(r.id)
        );
        if (!hasOtherSubdiv) {
          toRemove.add(COMMON_ROLE_IDS.ATK_CORPS);
          toRemove.add(COMMON_ROLE_IDS.RANKS_CATEGORY);
          toAdd.add(COMMON_ROLE_IDS.FRIEND);
        }
      }
      applied.push({ action: op.action, name });
      continue;
    }

    // Обычная роль — ищем по имени на сервере
    const role = findRole(guild, name);
    if (!role) {
      errors.push(`«${name}» — роль не найдена на сервере`);
      continue;
    }
    if (op.action === "give") toAdd.add(role.id);
    else toRemove.add(role.id);
    applied.push({ action: op.action, name: role.name });
  }

  if (errors.length > 0) {
    return { ok: false, message: errors.join("; "), errors, applied };
  }

  if (toRemove.size) await member.roles.remove([...toRemove]);
  if (toAdd.size) await member.roles.add([...toAdd]);

  const summary =
    applied.length === 0
      ? "ничего не изменено"
      : applied
          .map(
            (a) => `${a.action === "give" ? "выдана" : "снята"} «${a.name}»`
          )
          .join(", ");

  return { ok: true, message: summary, errors: [], applied };
}

/* ------------------------------------------------------------------ */
/* Разбор сообщения заявки в канале ролей                                */
/* ------------------------------------------------------------------ */

export type RoleRequest = {
  recipientId: string;
  /** Экзаменатор может отсутствовать (заявки из Google-формы) */
  examinerId: string | null;
  ops: RoleOp[];
  line: string;
};

/**
 * Разбирает сообщение вида:
 *   <@получатель>
 *   <@экзаменатор>            ← необязательная строка
 *   Выдать Капитан ТР, Снять Друг АТК
 *
 * Лишние строки после команды считаются продолжением команды.
 * Если строки с экзаменатором нет (заявка из Google-формы), moderator
 * всё равно может подтвердить запрос.
 */
export function parseRoleRequest(content: string): RoleRequest | null {
  if (!content) return null;
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const recipientMatch = lines[0].match(/<@!?(\d+)>/);
  if (!recipientMatch) return null;

  // Ищем строки-упоминания между получателем и командой — это экзаменатор
  let examinerId: string | null = null;
  let commandIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(Выдать|Снять)/i.test(lines[i])) {
      commandIdx = i;
      break;
    }
    const m = lines[i].match(/^<@!?(\d+)>$/);
    if (m && !examinerId) examinerId = m[1];
  }
  if (commandIdx < 0) return null;

  // Строки команды склеиваем через запятую, а не через « | »: parseRoleCommand
  // разбирает строку именно по запятым, и при « | » вторая строка («| Снять X»)
  // не распознавалась как действие — она наследовала «Выдать» и превращалась
  // в несуществующую роль с именем «| Снять X».
  const commandLine = lines.slice(commandIdx).join(", ");

  return {
    recipientId: recipientMatch[1],
    examinerId,
    ops: parseRoleCommand(commandLine),
    line: commandLine,
  };
}