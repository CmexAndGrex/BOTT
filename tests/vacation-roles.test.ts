/**
 * Тесты роли Discord «Отпуск» и её места в сверке ролей.
 *
 * Проверяется боевой код: правила src/lib/vacation-roles.ts (planVacationRole)
 * и дельта сверки src/lib/role-sync.ts (computeRoleDelta). Сеть и БД не нужны —
 * в runVacationRole подставляются подставные addRole/removeRole.
 *
 * Почему это важно: отпуск — единственное состояние службы, которое видно на
 * сервере ролью. Ошибка здесь означает либо бойца, который «в отпуске» навсегда,
 * либо доступ к закрытым каналам у того, кто вернулся.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planVacationRole,
  runVacationRole,
  type VacationRoleDeps,
} from "@/lib/vacation-roles.ts";
import { computeRoleDelta, type RoleSyncMember } from "@/lib/role-sync.ts";

const LEAVE_ROLE = "1084700000000000001";
const GUILD = "1070000000000000001";
const DISCORD = "1085141850966458519";

/** Настройки в том виде, в каком их видит модуль (Map) */
const settings = (patch: Record<string, string> = {}) =>
  new Map<string, string>(Object.entries({ guild_id: GUILD, ...patch }));

/** Боец в строю, годный для снятия ролей */
const memberShape = (patch: Partial<RoleSyncMember> = {}): RoleSyncMember => ({
  id: 1,
  name: "Петров П.П.",
  discordId: DISCORD,
  rank: "Рядовой",
  rankName: null,
  unit: "Танковая рота",
  post: null,
  status: "active",
  active: true,
  vacation: false,
  beretPassed: false,
  ...patch,
});

describe("planVacationRole — что делать с ролью «Отпуск»", () => {
  test("роль не настроена → пропуск с указанием, где её задать", () => {
    const plan = planVacationRole({
      leaveRoleId: "",
      discordId: DISCORD,
      vacation: true,
    });
    assert.equal(plan.action, "skip");
    assert.match(plan.reason, /leave_role_id/);
  });

  test("ID роли не число → пропуск (Discord ответил бы 400)", () => {
    const plan = planVacationRole({
      leaveRoleId: "отпуск",
      discordId: DISCORD,
      vacation: true,
    });
    assert.equal(plan.action, "skip");
    assert.match(plan.reason, /числовой ID/);
  });

  test("нет Discord ID → пропуск, роль не выдаётся «в пустоту»", () => {
    const plan = planVacationRole({
      leaveRoleId: LEAVE_ROLE,
      discordId: null,
      vacation: true,
    });
    assert.equal(plan.action, "skip");
    assert.match(plan.reason, /Discord ID/);
  });

  test("плейсхолдер вместо ID («manual») — тоже отсутствие ID", () => {
    const plan = planVacationRole({
      leaveRoleId: LEAVE_ROLE,
      discordId: "manual",
      vacation: true,
    });
    assert.equal(plan.action, "skip");
  });

  test("уход в отпуск → роль выдаётся", () => {
    const plan = planVacationRole({
      leaveRoleId: LEAVE_ROLE,
      discordId: DISCORD,
      vacation: true,
    });
    assert.equal(plan.action, "add");
    assert.equal(plan.roleId, LEAVE_ROLE);
  });

  test("возврат из отпуска → роль снимается", () => {
    const plan = planVacationRole({
      leaveRoleId: LEAVE_ROLE,
      discordId: DISCORD,
      vacation: false,
    });
    assert.equal(plan.action, "remove");
  });
});

/** Подставные зависимости с журналом вызовов */
function fakeDeps(options: {
  settings?: Map<string, string>;
  guildIds?: string[];
  fail?: Error;
} = {}) {
  const calls: string[] = [];
  const logs: { title: string; ok: boolean; error: string | null }[] = [];
  const deps: VacationRoleDeps = {
    loadSettings: async () => options.settings ?? settings({ leave_role_id: LEAVE_ROLE }),
    getBotGuildIds: async () => options.guildIds ?? [GUILD],
    addRole: async (guildId, discordId, roleId) => {
      calls.push(`add ${guildId} ${discordId} ${roleId}`);
      if (options.fail) throw options.fail;
    },
    removeRole: async (guildId, discordId, roleId) => {
      calls.push(`remove ${guildId} ${discordId} ${roleId}`);
      if (options.fail) throw options.fail;
    },
    saveLog: async (row) => {
      logs.push({ title: row.title, ok: row.ok, error: row.error });
    },
    log: () => {},
  };
  return { deps, calls, logs };
}

describe("runVacationRole — выдача и снятие роли через Discord", () => {
  test("уход в отпуск: роль выдаётся на сервер из настроек", async () => {
    const { deps, calls, logs } = fakeDeps();
    const result = await runVacationRole(deps, {
      discordId: DISCORD,
      vacation: true,
      memberName: "Скиф",
      source: "тест",
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "add");
    assert.deepEqual(calls, [`add ${GUILD} ${DISCORD} ${LEAVE_ROLE}`]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].ok, true);
  });

  test("возврат из отпуска: роль снимается", async () => {
    const { deps, calls } = fakeDeps();
    const result = await runVacationRole(deps, {
      discordId: DISCORD,
      vacation: false,
      memberName: "Скиф",
      source: "тест",
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "remove");
    assert.deepEqual(calls, [`remove ${GUILD} ${DISCORD} ${LEAVE_ROLE}`]);
  });

  test("ошибка Discord не бросается: возвращается точная причина и пишется журнал", async () => {
    // 50013 — Missing Permissions: именно её видит администратор, когда роль
    // бота стоит в иерархии ниже роли «Отпуск»
    const err = Object.assign(new Error("Discord API (403): Missing Permissions"), {
      status: 403,
      code: 50013,
    });
    const { deps, logs } = fakeDeps({ fail: err });

    const result = await runVacationRole(deps, {
      discordId: DISCORD,
      vacation: true,
      memberName: "Скиф",
      source: "тест",
    });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /Missing Permissions/);
    assert.match(String(result.error), /50013/);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].ok, false);
  });

  test("несколько серверов без guild_id → ошибка конфигурации, не «тихий» успех", async () => {
    const { deps, calls } = fakeDeps({
      settings: settings({ leave_role_id: LEAVE_ROLE }),
      guildIds: ["1", "2"],
    });
    // guild_id убираем: он есть в settings() по умолчанию
    deps.loadSettings = async () => new Map([["leave_role_id", LEAVE_ROLE]]);

    const result = await runVacationRole(deps, {
      discordId: DISCORD,
      vacation: true,
      source: "тест",
    });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /нескольких серверах/);
    assert.deepEqual(calls, []);
  });

  test("единственный сервер бота определяется автоматически", async () => {
    const { deps, calls } = fakeDeps({ guildIds: [GUILD] });
    deps.loadSettings = async () => new Map([["leave_role_id", LEAVE_ROLE]]);

    const result = await runVacationRole(deps, {
      discordId: DISCORD,
      vacation: true,
      source: "тест",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [`add ${GUILD} ${DISCORD} ${LEAVE_ROLE}`]);
  });

  test("dryRun: план считается, Discord не трогается", async () => {
    const { deps, calls } = fakeDeps();
    const result = await runVacationRole(deps, {
      discordId: DISCORD,
      vacation: true,
      source: "тест",
      dryRun: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "add");
    assert.deepEqual(calls, []);
  });

  test("сбой чтения настроек возвращается отчётом, а не исключением", async () => {
    const { deps } = fakeDeps();
    deps.loadSettings = async () => {
      throw new Error("нет соединения с БД");
    };

    const result = await runVacationRole(deps, {
      discordId: DISCORD,
      vacation: true,
      source: "тест",
    });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /нет соединения с БД/);
  });
});

describe("computeRoleDelta — роль «Отпуск» в сверке", () => {
  test("боец в отпуске получает роль «Отпуск»", () => {
    const delta = computeRoleDelta(
      memberShape({ vacation: true, status: "vacation" }),
      [],
      { leaveRoleId: LEAVE_ROLE }
    );
    assert.ok(delta.add.includes(LEAVE_ROLE), "роль должна быть выдана");
    assert.ok(!delta.remove.includes(LEAVE_ROLE));
  });

  test("алиас статуса «on_vacation» тоже считается отпуском", () => {
    // Строгое сравнение со строкой "vacation" не узнавало такой статус, и
    // сверка снимала роль у бойца, который на самом деле в отпуске
    const delta = computeRoleDelta(
      memberShape({ vacation: false, status: "on_vacation" }),
      [LEAVE_ROLE],
      { leaveRoleId: LEAVE_ROLE }
    );
    assert.ok(!delta.remove.includes(LEAVE_ROLE), "роль нельзя снимать у отпускника");
  });

  test("вернувшийся из отпуска теряет роль, даже если карточка неполная", () => {
    // Неполнота (нет звания и подразделения) блокирует снятие ЗВАНИЙ, но роль
    // «Отпуск» зависит только от состояния службы — она обязана уйти
    const delta = computeRoleDelta(
      memberShape({ vacation: false, status: "active", rank: null, unit: null }),
      [LEAVE_ROLE],
      { leaveRoleId: LEAVE_ROLE }
    );
    assert.equal(delta.incomplete, true);
    assert.ok(
      delta.remove.includes(LEAVE_ROLE),
      "снятие роли «Отпуск» не должно откладываться из-за неполной карточки"
    );
  });

  test("неполная карточка по-прежнему не снимает звание", () => {
    const rankRole = "1090320507288699020"; // Рядовой
    const delta = computeRoleDelta(
      memberShape({ rank: null, unit: null }),
      [rankRole],
      { leaveRoleId: LEAVE_ROLE }
    );
    assert.ok(!delta.remove.includes(rankRole), "звание без данных снимать нельзя");
  });

  test("исключённый боец теряет роль «Отпуск»", () => {
    const delta = computeRoleDelta(
      memberShape({ status: "dismissed", active: false, vacation: true }),
      [LEAVE_ROLE],
      { leaveRoleId: LEAVE_ROLE }
    );
    assert.ok(delta.remove.includes(LEAVE_ROLE));
  });

  test("неизвестный статус не считается отпуском (роль не выдаётся)", () => {
    const delta = computeRoleDelta(
      memberShape({ vacation: false, status: "какой-то текст" }),
      [],
      { leaveRoleId: LEAVE_ROLE }
    );
    assert.ok(!delta.add.includes(LEAVE_ROLE));
  });

  test("роль не настроена — в дельте её нет вовсе", () => {
    const delta = computeRoleDelta(
      memberShape({ vacation: true, status: "vacation" }),
      [],
      {}
    );
    assert.deepEqual(delta.add.filter((id) => id === LEAVE_ROLE), []);
  });
});
