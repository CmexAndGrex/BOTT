import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isCommanderFighter,
  isDeputyCommander,
  isCorpsCommander,
  isCompanyCommander,
  isDeputyCompanyCommander,
  isDivisionCommander,
  isDeputyDivisionCommander,
  commanderBadgeLabel,
  CORPS_COMMANDER_FULL_NAME,
  CORPS_DEPUTY_FULL_NAMES,
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
    // Заместитель командира корпуса — не сам командир корпуса
    assert.equal(isCorpsCommander({ name: "Иванов К. М." }), false);
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
    // Плашки у младших командиров быть не должно — у них обычные кнопки предупреждений
    assert.equal(commanderBadgeLabel({ post: "КБМ" }), null);
    assert.equal(commanderBadgeLabel({ post: "Командир отделения" }), null);
  });

  test("Заместители командира корпуса защищены от предупреждений", () => {
    assert.equal(CORPS_DEPUTY_FULL_NAMES.length, 2);
    assert.equal(isDeputyCommander({ post: "Зам. ком. корпуса" }), true);
    assert.equal(isDeputyCommander({ post: "Зам. командира Корпуса" }), true);
    assert.equal(isDeputyCommander({ post: "Заместитель командира" }), true);
    assert.equal(isDeputyCommander({ post: "Заместитель командира роты" }), true);
    assert.equal(isDeputyCommander({ post: "Командир роты" }), false);
    assert.equal(isDeputyCommander({ post: "Рядовой" }), false);
    assert.equal(isCommanderFighter({ post: "Зам. ком. корпуса" }), true);
    assert.equal(isCommanderFighter({ post: "Заместитель командира" }), true);
  });

  test("Заместители корпуса из официального списка и с припиской «по ВиСПР»", () => {
    // ФИО из официального списка заместителей
    assert.equal(isDeputyCommander({ name: "Иванов И. А." }), true);
    assert.equal(isDeputyCommander({ name: "Иванов К. М." }), true);
    assert.equal(isDeputyCommander({ name: "иванов  к.м." }), true);
    // Отчёт: Иванов К.М. — «Зам. Ком. Корпуса по ВиСПР» (слетал из-за приписки)
    assert.equal(isDeputyCommander({ name: "Иванов К. М.", post: "Зам. Ком. Корпуса по ВиСПР" }), true);
    assert.equal(isCommanderFighter({ name: "Иванов К. М.", post: "Зам. Ком. Корпуса по ВиСПР" }), true);
    assert.equal(
      commanderBadgeLabel({ name: "Иванов К. М.", post: "Зам. Ком. Корпуса по ВиСПР" }),
      "★ ЗАМ. КОМАНДИРА"
    );
    // Заместитель, но не командир корпуса
    assert.equal(isCorpsCommander({ name: "Иванов И. А.", post: "Заместитель командира корпуса" }), false);
  });

  test("Командиры рот и дивизионов получают бейджи уровней", () => {
    // Брюханов Е. Д. — командир танковой роты
    assert.equal(isCompanyCommander({ post: "Командир танковой роты" }), true);
    assert.equal(isCompanyCommander({ post: "Командир роты" }), true);
    assert.equal(commanderBadgeLabel({ post: "Командир танковой роты" }), "★ КОМ. РОТЫ");
    // Милорадович М. Н. — командир арт. дивизиона
    assert.equal(isDivisionCommander({ post: "Командир арт. дивизиона" }), true);
    assert.equal(isDivisionCommander({ post: "Командир дивизиона" }), true);
    assert.equal(commanderBadgeLabel({ post: "Командир арт. дивизиона" }), "★ КОМ. ДИВИЗИОНА");
    // Перекрёстно: ротный командир не командир дивизиона и наоборот
    assert.equal(isDivisionCommander({ post: "Командир роты" }), false);
    assert.equal(isCompanyCommander({ post: "Командир арт. дивизиона" }), false);
    // Оба уровня — командование, значит иммунитет
    assert.equal(isCommanderFighter({ post: "Командир танковой роты" }), true);
    assert.equal(isCommanderFighter({ post: "Командир арт. дивизиона" }), true);
  });

  test("Заместители командиров рот и дивизионов распознаются по «зам.кмд.»", () => {
    // Отчёт: Осипов Г. А. — «Зам.кмд. танковой роты» (слетал из-за сокращения «Зам.кмд.»)
    assert.equal(isDeputyCompanyCommander({ post: "Зам.кмд. танковой роты" }), true);
    assert.equal(isDeputyCompanyCommander({ post: "зам кмд танковой роты" }), true);
    assert.equal(isDeputyCompanyCommander({ post: "Зам. командира танковой роты" }), true);
    // Заместитель роты — НЕ командир роты, но комсостав с бейджем «★ ЗАМ. КОМ. РОТЫ»
    assert.equal(isCompanyCommander({ post: "Зам.кмд. танковой роты" }), false);
    assert.equal(isCommanderFighter({ post: "Зам.кмд. танковой роты" }), true);
    assert.equal(commanderBadgeLabel({ post: "Зам.кмд. танковой роты" }), "★ ЗАМ. КОМ. РОТЫ");

    // Отчёт: Грипповский Д. А. — «Зам.кмд. арт. дивизиона» (слетал из-за «Зам.кмд.»)
    assert.equal(isDeputyDivisionCommander({ post: "Зам.кмд. арт. дивизиона" }), true);
    assert.equal(isDeputyDivisionCommander({ post: "Зам. командира арт. дивизиона" }), true);
    // Заместитель дивизиона — НЕ командир дивизиона, но комсостав
    assert.equal(isDivisionCommander({ post: "Зам.кмд. арт. дивизиона" }), false);
    assert.equal(isCommanderFighter({ post: "Зам.кмд. арт. дивизиона" }), true);
    assert.equal(commanderBadgeLabel({ post: "Зам.кмд. арт. дивизиона" }), "★ ЗАМ. КОМ. ДИВИЗИОНА");

    // Боец без признака «зам» заместителем не признаётся
    assert.equal(isDeputyCompanyCommander({ post: "Командир танковой роты" }), false);
    assert.equal(isDeputyDivisionCommander({ post: "Командир арт. дивизиона" }), false);
    assert.equal(isDeputyCompanyCommander({ post: "Стрелок" }), false);
  });

  test("commanderBadgeLabel возвращает бейдж по старшинству и null для бойца", () => {
    assert.equal(commanderBadgeLabel({ name: "Волков Д. В." }), "★ КОМАНДИР КОРПУСА");
    assert.equal(commanderBadgeLabel({ name: "Иванов К. М." }), "★ ЗАМ. КОМАНДИРА");
    assert.equal(commanderBadgeLabel({ post: "Заместитель командира" }), "★ ЗАМ. КОМАНДИРА");
    assert.equal(commanderBadgeLabel({ post: "Командир танковой роты" }), "★ КОМ. РОТЫ");
    assert.equal(commanderBadgeLabel({ post: "Зам.кмд. танковой роты" }), "★ ЗАМ. КОМ. РОТЫ");
    assert.equal(commanderBadgeLabel({ post: "Командир арт. дивизиона" }), "★ КОМ. ДИВИЗИОНА");
    assert.equal(commanderBadgeLabel({ post: "Зам.кмд. арт. дивизиона" }), "★ ЗАМ. КОМ. ДИВИЗИОНА");
    // ФИО командира корпуса важнее любой его должности
    assert.equal(commanderBadgeLabel({ name: "Волков Д.В.", post: "Командир подразделения" }), "★ КОМАНДИР КОРПУСА");
    // Младший командир и обычный боец плашки не получают
    assert.equal(commanderBadgeLabel({ post: "Командир боевой машины ТР" }), null);
    assert.equal(commanderBadgeLabel({ post: "Стрелок" }), null);
    assert.equal(commanderBadgeLabel({}), null);
  });
});
