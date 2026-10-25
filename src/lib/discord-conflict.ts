/**
 * Правило разрешения конфликта Discord ID при ручной привязке.
 *
 * Раньше любое совпадение `division_members.discord_id` отвергалось ответом
 * 409 «Этот Discord ID уже привязан к другому бойцу». Живой сценарий ломался:
 * боец сменил ник на rs-red.com («Лектер Г.А.» → «Сопрано А.Д.»), старая
 * карточка осталась в табеле выбывшей и продолжала держать снежинку. Штаб не
 * мог привязать Discord действующему бойцу, пока вручную не найдёт и не
 * обнулит старую запись.
 *
 * Теперь конфликт делится на два вида:
 *   - снежинку держит НЕДЕЙСТВУЮЩАЯ запись (выбывший, исключённый, отклонённая
 *     заявка, «дубль» после переименования) — она освобождается автоматически,
 *     ID переходит действующему бойцу без ошибки;
 *   - снежинку держит ДРУГОЙ действующий боец — привязка отклоняется, и в тексте
 *     ошибки называется его имя, чтобы штаб видел, кого именно нужно развязать.
 *
 * Модуль намеренно не зависит ни от БД, ни от Next.js: правило проверяется
 * тестами напрямую (tests/discord-conflict.test.ts), а запросы живут в роутах.
 */
import { MEMBER_STATUS, normalizeMemberStatus } from "@/lib/recruits";

/**
 * Запись табеля, которая уже держит Discord ID.
 *
 * Полей ровно столько, сколько нужно правилу: идентификатор, имя для текста
 * ошибки и признаки действующего бойца (`active` + `status`).
 */
export type DiscordConflictOccupant = {
  id: number;
  name: string;
  active?: boolean | null;
  status?: unknown;
};

/** Итог разбора конфликта */
export type DiscordConflictDecision =
  /** Снежинка свободна (или принадлежит только правимой карточке) */
  | { kind: "free" }
  /**
   * Снежинку держат только недействующие записи: их `discord_id` нужно
   * обнулить и записать ID правимому бойцу.
   */
  | { kind: "release"; release: DiscordConflictOccupant[] }
  /**
   * Снежинку держит действующий боец: привязка отклоняется. `message` готов к
   * ответу API, `occupant` — виновник.
   */
  | { kind: "blocked"; occupant: DiscordConflictOccupant; message: string };

/** Текст ошибки с именем действующего бойца — одно и то же во всех роутах */
export function discordConflictMessage(name: string): string {
  return `Этот Discord ID уже привязан к активному бойцу: ${name}`;
}

/**
 * Держит ли запись снежинку «по праву».
 *
 * Здесь критерий строже, чем isRosterActive (правило отображения табеля):
 * снежинку защищает только боец, который реально служит — `status` равен
 * `active` или `vacation` и флаг `active` не снят. Карточка заявки (`pending`)
 * и любая запись с неизвестным статусом снежинку НЕ защищают: именно такие
 * строки остаются после смены ника на rs-red.com, и из-за них привязка
 * отвечала 409 «уже привязан к другому бойцу».
 */
function protectsSnowflake(occupant: DiscordConflictOccupant): boolean {
  if (occupant.active === false) return false;
  const status = normalizeMemberStatus(occupant.status);
  return status === MEMBER_STATUS.ACTIVE || status === MEMBER_STATUS.VACATION;
}

/**
 * Разбор конфликта Discord ID.
 *
 * `occupants` — все записи, у которых этот ID уже стоит, кроме правимой
 * (`memberId`). Порядок важен: сначала проверяются действующие бойцы, и лишь
 * если таких нет — освобождаются выбывшие. Так авто-перепривязка не может
 * «отобрать» снежинку у человека, который продолжает служить, даже если в
 * табеле есть ещё и старый дубль с тем же ID.
 *
 * `excludeMemberId` — карточка, которой ID присваивается: она не может
 * блокировать сама себя (повторное сохранение того же значения).
 */
export function decideDiscordConflict(
  occupants: readonly DiscordConflictOccupant[],
  excludeMemberId: number
): DiscordConflictDecision {
  const others = occupants.filter((occupant) => occupant.id !== excludeMemberId);
  if (!others.length) return { kind: "free" };

  const active = others.filter((occupant) => protectsSnowflake(occupant));
  if (active.length > 0) {
    // Несколько действующих с одним ID — аномалия; называем самого раннего,
    // чтобы сообщение было воспроизводимым (порядок выдачи из БД может гулять)
    const occupant = active.reduce((first, next) => (next.id < first.id ? next : first));
    return { kind: "blocked", occupant, message: discordConflictMessage(occupant.name) };
  }

  return { kind: "release", release: others };
}

/**
 * Нужно ли определить подразделение перед записью в ШДС.
 *
 * `unit` пустой или служебная пометка «не назначено» — лист таблицы неизвестен,
 * и запись в ШДС без него либо упадёт, либо попадёт не в тот лист. Правило
 * повторяет isUnassignedUnit, но оставлено здесь рядом с остальной логикой
 * привязки, чтобы роут не тянул лишние импорты ради одной строки.
 */
export function needsUnitLookup(unit: unknown): boolean {
  if (unit === null || unit === undefined) return true;
  const text = String(unit).trim().toLowerCase();
  return text === "" || text === "не назначено" || text === "не назначена";
}
