import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MEMBER_ACTIONS,
  CORPS_COMMANDER_DISCORD_ID,
  isMemberAction,
  isProtectedLifecycleTarget,
  checkLifecycleTarget,
  statusAfterAction,
  unitAfterAction,
  memberActionLabel,
} from "../src/lib/member-lifecycle.ts";
import { planLifecycleRoles, lifecycleManagedRoleIds } from "../src/lib/member-lifecycle-roles.ts";
import {
  MEMBER_STATUS,
  normalizeMemberStatus,
  isRosterActive,
  STATUS_LABELS,
} from "../src/lib/recruits.ts";
import { statusTrackingFields } from "../src/lib/roles-monitor.ts";
import {
  RANK_ROLE_IDS,
  SUBDIV_ROLE_IDS,
  COMMON_ROLE_IDS,
  CLAN_ROLE_IDS,
} from "../src/lib/roles.ts";

describe("Жизненный цикл бойца: защита целей", () => {
  test("Командир корпуса (Волков Д. В.) защищён по Discord ID", () => {
    assert.equal(CORPS_COMMANDER_DISCORD_ID, "588629880002969600");
    assert.equal(
      isProtectedLifecycleTarget({ discordId: "588629880002969600", name: "Кто-то" }),
      true
    );
  });

  test("Командир корпуса защищён по ФИО и должности", () => {
    assert.equal(isProtectedLifecycleTarget({ name: "Волков Д. В." }), true);
    assert.equal(isProtectedLifecycleTarget({ name: "Волков Д.В." }), true);
    assert.equal(isProtectedLifecycleTarget({ post: "Командир Корпуса" }), true);
    // Обычный боец защитой не накрывается
    assert.equal(isProtectedLifecycleTarget({ name: "Добролюбов А. П." }), false);
    assert.equal(isProtectedLifecycleTarget({ post: "Стрелок" }), false);
    assert.equal(isProtectedLifecycleTarget({}), false);
  });

  test("Заместители командира корпуса (Иванов И. А., Иванов К. М.) защищены", () => {
    assert.equal(isProtectedLifecycleTarget({ name: "Иванов И. А." }), true);
    assert.equal(isProtectedLifecycleTarget({ name: "Иванов К. М." }), true);
    assert.equal(isProtectedLifecycleTarget({ post: "Зам. ком. корпуса" }), true);
  });

  test("checkLifecycleTarget запрещает увольнение командира корпуса", () => {
    const decision = checkLifecycleTarget(MEMBER_ACTIONS.DISMISS, {
      id: 1,
      name: "Волков Д. В.",
      post: "Командир Корпуса",
      discordId: "588629880002969600",
    }, 99);
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.match(decision.reason, /защищено/i);
    }
  });

  test("checkLifecycleTarget запрещает «самострел»", () => {
    const decision = checkLifecycleTarget(MEMBER_ACTIONS.RESERVE, {
      id: 42,
      name: "Скиф",
    }, 42);
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.match(decision.reason, /самому себе|самого себя/i);
    }
    // Другой боец — можно
    assert.equal(
      checkLifecycleTarget(MEMBER_ACTIONS.RESERVE, { id: 42, name: "Скиф" }, 7).ok,
      true
    );
  });

  test("checkLifecycleTarget отклоняет повторное увольнение", () => {
    const decision = checkLifecycleTarget(MEMBER_ACTIONS.DISMISS, {
      id: 5,
      name: "Гром",
      status: "dismissed",
    }, 1);
    assert.equal(decision.ok, false);
    // А перевод в запас уже уволенного — допустим (смена формулировки выбытия)
    assert.equal(
      checkLifecycleTarget(MEMBER_ACTIONS.RESERVE, { id: 5, name: "Гром", status: "dismissed" }, 1).ok,
      true
    );
  });

  test("isMemberAction распознаёт только два действия", () => {
    assert.equal(isMemberAction("reserve"), true);
    assert.equal(isMemberAction("dismiss"), true);
    assert.equal(isMemberAction("DISMISS"), true);
    assert.equal(isMemberAction("delete"), false);
    assert.equal(isMemberAction(""), false);
    assert.equal(isMemberAction(null), false);
    assert.equal(isMemberAction(42), false);
  });
});

describe("Жизненный цикл бойца: смена статусов", () => {
  test("statusAfterAction: reserve → «в запасе», dismiss → «исключён»", () => {
    assert.equal(statusAfterAction(MEMBER_ACTIONS.RESERVE), MEMBER_STATUS.RESERVE);
    assert.equal(statusAfterAction(MEMBER_ACTIONS.DISMISS), MEMBER_STATUS.DISMISSED);
  });

  test("Статус reserve нормализуется и закрывает доступ к кабинету", () => {
    assert.equal(normalizeMemberStatus("reserve"), MEMBER_STATUS.RESERVE);
    assert.equal(normalizeMemberStatus("В запасе"), MEMBER_STATUS.RESERVE);
    // Кабинет закрыт: reserve входит в DISMISSED_LIKE
    assert.equal(normalizeMemberStatus("reserve") === MEMBER_STATUS.DISMISSED, false);
    assert.equal(isRosterActive({ active: false, status: "reserve" }), false);
    assert.equal(isRosterActive({ active: true, status: "reserve" }), false);
  });

  test("STATUS_LABELS различает «В резерве» и «Отклонён»", () => {
    assert.equal(STATUS_LABELS[MEMBER_STATUS.RESERVE], "В резерве");
    assert.equal(STATUS_LABELS[MEMBER_STATUS.DISMISSED], "Отклонён");
  });

  test("unitAfterAction: запас сохраняет подразделение, увольнение очищает", () => {
    assert.equal(unitAfterAction(MEMBER_ACTIONS.RESERVE, "Танковая рота"), "Танковая рота");
    assert.equal(unitAfterAction(MEMBER_ACTIONS.DISMISS, "Танковая рота"), null);
    assert.equal(unitAfterAction(MEMBER_ACTIONS.RESERVE, null), null);
  });

  test("statusTrackingFields фиксирует момент выбытия для reserve и dismissed", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const reserve = statusTrackingFields(MEMBER_STATUS.RESERVE, "active", now);
    assert.equal(reserve.dismissedAt?.getTime(), now.getTime());
    assert.equal(reserve.rolesAlertSentAt, null);

    const dismissed = statusTrackingFields(MEMBER_STATUS.DISMISSED, "active", now);
    assert.equal(dismissed.dismissedAt?.getTime(), now.getTime());

    // Возврат в строй снимает момент
    const back = statusTrackingFields(MEMBER_STATUS.ACTIVE, "reserve", now);
    assert.equal(back.dismissedAt, null);
    assert.equal(back.rolesAlertSentAt, null);
  });

  test("memberActionLabel: подписи для журнала", () => {
    assert.equal(memberActionLabel(MEMBER_ACTIONS.RESERVE), "Перевод в запас");
    assert.equal(memberActionLabel(MEMBER_ACTIONS.DISMISS), "Увольнение");
  });
});

describe("Жизненный цикл бойца: план ролей Discord", () => {
  test("Запас: роль «Запас» выдана, боевые роли сняты, звание сохранено", () => {
    const plan = planLifecycleRoles({
      action: MEMBER_ACTIONS.RESERVE,
      reserveRoleId: "111",
      leaveRoleId: "222",
      beretRoleId: "333",
      postRoleIds: ["444"],
    });

    assert.deepEqual(plan.add, ["111"]);
    // Сняты: подразделения, категория званий, новобранец, должность, берет, отпуск
    assert.ok(plan.remove.includes(SUBDIV_ROLE_IDS["ТР"]));
    assert.ok(plan.remove.includes(SUBDIV_ROLE_IDS["АД"]));
    assert.ok(plan.remove.includes(COMMON_ROLE_IDS.RANKS_CATEGORY));
    assert.ok(plan.remove.includes(COMMON_ROLE_IDS.RECRUIT));
    assert.ok(plan.remove.includes("222"));
    assert.ok(plan.remove.includes("333"));
    assert.ok(plan.remove.includes("444"));
    // Звание НЕ снимается — запасник сохраняет звание
    for (const id of Object.values(RANK_ROLE_IDS)) {
      assert.ok(!plan.remove.includes(id), `роль звания ${id} не должна сниматься`);
    }
    // Корпус не снимается — доступ к общим каналам сохраняется
    assert.ok(!plan.remove.includes(COMMON_ROLE_IDS.ATK_CORPS));
  });

  test("Запас без настроенной роли честно предупреждает", () => {
    const plan = planLifecycleRoles({
      action: MEMBER_ACTIONS.RESERVE,
      reserveRoleId: "",
      leaveRoleId: null,
    });
    assert.deepEqual(plan.add, []);
    assert.ok(plan.notes.some((n) => n.includes("не задана")));
  });

  test("Увольнение: сняты все служебные роли, выдан «Друг АТК»", () => {
    const plan = planLifecycleRoles({
      action: MEMBER_ACTIONS.DISMISS,
      reserveRoleId: "111",
      leaveRoleId: "222",
      beretRoleId: "333",
      postRoleIds: ["444"],
    });

    assert.deepEqual(plan.add, [COMMON_ROLE_IDS.FRIEND]);
    // Сняты звания, подразделения, корпус, категория, новобранец, запас, отпуск
    for (const id of Object.values(RANK_ROLE_IDS)) {
      assert.ok(plan.remove.includes(id));
    }
    for (const id of Object.values(SUBDIV_ROLE_IDS)) {
      assert.ok(plan.remove.includes(id));
    }
    assert.ok(plan.remove.includes(COMMON_ROLE_IDS.ATK_CORPS));
    assert.ok(plan.remove.includes(COMMON_ROLE_IDS.RANKS_CATEGORY));
    assert.ok(plan.remove.includes(COMMON_ROLE_IDS.RECRUIT));
    assert.ok(plan.remove.includes("111"));
    assert.ok(plan.remove.includes("222"));
    assert.ok(plan.remove.includes("333"));
    assert.ok(plan.remove.includes("444"));
  });

  test("lifecycleManagedRoleIds: кастомные роли клана не трогаются", () => {
    const managed = lifecycleManagedRoleIds({
      reserveRoleId: "111",
      leaveRoleId: "222",
      postRoleIds: ["444"],
    });
    // Справочник клана и настроенные роли — управляемые
    for (const id of CLAN_ROLE_IDS) {
      assert.ok(managed.has(id));
    }
    assert.ok(managed.has("111"));
    assert.ok(managed.has("222"));
    assert.ok(managed.has("444"));
    // Чужая роль — не управляемая: снимать её план не имеет права
    assert.ok(!managed.has("999999999"));
  });
});
