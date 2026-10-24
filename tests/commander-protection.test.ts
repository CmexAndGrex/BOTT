import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isCommanderFighter,
  isDeputyCommander,
  isCorpsCommander,
  isCompanyCommander,
  isDivisionCommander,
  commanderBadgeLabel,
  CORPS_COMMANDER_FULL_NAME,
} from "../src/lib/validation.ts";

describe("Командный состав корпуса", () => {
  test("Командир корпуса определяется по ФИО «Волков Д. В.»", () => {
    assert.equal(CORPS_COMMANDER_FULL_NAME, "Волков Д. В.");
    // Пробелы и точки в написании инициалов не важны: «Волков Д.В.» равнозначно
    assert.equal(isCorpsCommander({ name: "Волков Д. В." }), true);
    assert.equal(isCorpsCommander({ name: "Волков Д.В." }), true);
    assert.equal(isCorpsCommander({ name: "  волков   д. в.  " }), true);
    // Другой боец тем же приказом не признаётся командиром корпуса
    assert.equal(isCorpsCommander({ name: "Добролюбов А. П." }), false);
    // Позывной (краткая запись) командиром корпуса не делает
    assert.equal(isCorpsCommander({ name: "Волков" }), false);
  });

  test("Командир корпуса определяется по должности строго «Командир Корпуса»", () => {
    assert.equal(isCorpsCommander({ post: "Командир Корпуса" }), true);
    assert.equal(isCorpsCommander({ post: "командир корпуса" }), true);
    assert.equal(isCorpsCommander({ post: "  Командир   Корпуса " }), true);
    // Должности со словом «командир», но иного уровня — не корпус
    assert.equal(isCorpsCommander({ post: "Командир роты" }), false);
    assert.equal(isCorpsCommander({ post: "Командир отделения" }), false);
  });

  test("Младшие командиры НЕ являются высшим командованием", () => {
    // Именно эти должности ранее ошибочно получали плашку «★ КОМАНДИР»
    assert.equal(isCommanderFighter({ post: "Командир боевой машины ТР" }), false);
    assert.equal(isCommanderFighter({ post: "КБМ" }), false);
    assert.equal(isCommanderFighter({ post: "Командир отделения" }), false);
    assert.equal(isCommanderFighter({ post: "Командир расчёта" }), false);
    assert.equal(isCommanderFighter({ post: "Командир экипажа" }), false);
    // Стрелок и мехвод — тем более обычные бойцы
    assert.equal(isCommanderFighter({ post: "Стрелок" }), false);
    assert.equal(isCommanderFighter({ post: "Механик-водитель" }), false);
    assert.equal(isCommanderFighter({}), false);
  });

  test("Заместители командира защищены от предупреждений", () => {
    assert.equal(isDeputyCommander({ post: "Зам. ком. корпуса" }), true);
    assert.equal(isDeputyCommander({ post: "Зам. командира Корпуса" }), true);
    assert.equal(isDeputyCommander({ post: "Заместитель командира" }), true);
    assert.equal(isDeputyCommander({ post: "Заместитель командира роты" }), true);
    assert.equal(isDeputyCommander({ post: "Командир роты" }), false);
    assert.equal(isDeputyCommander({ post: "Рядовой" }), false);
    assert.equal(isCommanderFighter({ post: "Зам. ком. корпуса" }), true);
    assert.equal(isCommanderFighter({ post: "Заместитель командира" }), true);
  });

  test("Командиры рот и дивизионов получают бейджи уровней", () => {
    assert.equal(isCompanyCommander({ post: "Командир танковой роты" }), true);
    assert.equal(isCompanyCommander({ post: "Командир роты" }), true);
    assert.equal(isDivisionCommander({ post: "Командир арт. дивизиона" }), true);
    assert.equal(isDivisionCommander({ post: "Командир дивизиона" }), true);
    // Перекрёстно: ротный командир не командир дивизиона и наоборот
    assert.equal(isDivisionCommander({ post: "Командир роты" }), false);
    assert.equal(isCompanyCommander({ post: "Командир арт. дивизиона" }), false);
    // Оба уровня — командование, значит иммунитет
    assert.equal(isCommanderFighter({ post: "Командир танковой роты" }), true);
    assert.equal(isCommanderFighter({ post: "Командир арт. дивизиона" }), true);
  });

  test("commanderBadgeLabel возвращает бейдж по старшинству и null для бойца", () => {
    assert.equal(commanderBadgeLabel({ name: "Волков Д. В." }), "★ КОМАНДИР КОРПУСА");
    assert.equal(commanderBadgeLabel({ post: "Заместитель командира" }), "★ ЗАМ. КОМАНДИРА");
    assert.equal(commanderBadgeLabel({ post: "Командир танковой роты" }), "★ КОМ. РОТЫ");
    assert.equal(commanderBadgeLabel({ post: "Командир арт. дивизиона" }), "★ КОМ. ДИВИЗИОНА");
    // ФИО командира корпуса важнее любой его должности
    assert.equal(commanderBadgeLabel({ name: "Волков Д.В.", post: "Командир подразделения" }), "★ КОМАНДИР КОРПУСА");
    // Младший командир и обычный боец плашки не получают
    assert.equal(commanderBadgeLabel({ post: "Командир боевой машины ТР" }), null);
    assert.equal(commanderBadgeLabel({ post: "Стрелок" }), null);
    assert.equal(commanderBadgeLabel({}), null);
  });
});
