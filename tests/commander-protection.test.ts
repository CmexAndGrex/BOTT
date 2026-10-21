import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isCommanderFighter, isDeputyCommander, COMMANDER_MEMBER_IDS } from "../src/lib/validation";

describe("Защита командирского состава", () => {
  test("COMMANDER_MEMBER_IDS содержит 8, 12, 17, 30", () => {
    assert.deepEqual(COMMANDER_MEMBER_IDS, [8, 12, 17, 30]);
  });

  test("isCommanderFighter по id комсостава", () => {
    assert.equal(isCommanderFighter({ id: 8 }), true);
    assert.equal(isCommanderFighter({ id: 12 }), true);
    assert.equal(isCommanderFighter({ id: 17 }), true);
    assert.equal(isCommanderFighter({ id: 30 }), true);
    assert.equal(isCommanderFighter({ id: 99, post: "Механик-водитель" }), false);
  });

  test("isCommanderFighter по должности командира/заместителя (регистронезависимо)", () => {
    assert.equal(isCommanderFighter({ post: "Командир подразделения" }), true);
    assert.equal(isCommanderFighter({ post: "командир роты" }), true);
    assert.equal(isCommanderFighter({ post: "КОМАНДИР БОЕВОЙ МАШИНЫ ТР" }), true);
    assert.equal(isCommanderFighter({ post: "Заместитель командира" }), true);
    assert.equal(isCommanderFighter({ post: "зам. командира корпуса" }), true);
    assert.equal(isCommanderFighter({ post: "Стрелок" }), false);
  });

  test("isDeputyCommander определяет заместителя командира", () => {
    assert.equal(isDeputyCommander({ post: "Заместитель командира роты" }), true);
    assert.equal(isDeputyCommander({ post: "Зам. командира Корпуса" }), true);
    assert.equal(isDeputyCommander({ post: "Командир роты" }), false);
    assert.equal(isDeputyCommander({ post: "Рядовой" }), false);
  });
});
