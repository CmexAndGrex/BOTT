/**
 * Тесты полного цикла зачисления новобранца: выбор подразделения в форме,
 * звание при зачислении, настройки ролей/листов и права на кнопки в Discord.
 *
 * Проверяются боевые модули (src/lib/recruits.ts, settings.ts, validation.ts,
 * reports.ts), а не копии правил в тесте: расхождение «в тесте одно, на сайте
 * другое» здесь опаснее всего — по этим значениям выбирается лист ШДС и роль.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CORPS_ROLE_NAME,
  DEFAULT_SHEET_ART,
  DEFAULT_SHEET_TANK,
  isEnlistmentRank,
  isUnit,
  isUnassignedUnit,
  RECRUIT_RANK,
  UNITS,
  UNIT_LABELS,
  UNIT_ROLE_NAMES,
} from "../src/lib/recruits.ts";
import {
  DEFAULT_SETTINGS,
  DEFAULT_UNIT_SHEET_NAMES,
  ENLISTMENT_ROLE_SETTINGS,
  ROLE_ENV_FALLBACKS,
  UNIT_ROLE_SETTINGS,
  UNIT_SHEET_SETTINGS,
  unitRoleId,
  unitSheetName,
} from "../src/lib/settings.ts";
import {
  COMMAND_STAFF_FULL_NAMES,
  isCommandStaffIdentity,
  isCommandStaffRoleName,
} from "../src/lib/validation.ts";
import { buildRecruitApplicationMessage, buildRecruitEmbed } from "../src/lib/reports.ts";

describe("Подразделение заявки", () => {
  test("принимаются только два канонических значения", () => {
    assert.equal(isUnit("Танковая рота"), true);
    assert.equal(isUnit("Артиллерийский дивизион"), true);
    // Пробелы по краям не должны ломать валидацию: форма может прислать их
    assert.equal(isUnit("  Танковая рота  "), true);
  });

  test("произвольная строка подразделением не считается", () => {
    assert.equal(isUnit("Рота"), false);
    assert.equal(isUnit("танковая рота"), false);
    assert.equal(isUnit(""), false);
    assert.equal(isUnit(null), false);
    assert.equal(isUnit(undefined), false);
    assert.equal(isUnit(42), false);
  });

  test("подписи содержат официальные сокращения ТР/АД", () => {
    assert.match(UNIT_LABELS["Танковая рота"], /ТР/);
    assert.match(UNIT_LABELS["Артиллерийский дивизион"], /АД/);
    // Каждое подразделение имеет подпись — иначе в форме будет пустая карточка
    for (const unit of UNITS) assert.ok(UNIT_LABELS[unit]);
  });

  test("«не назначено» из ручных правок равно пустому полю", () => {
    assert.equal(isUnassignedUnit(null), true);
    assert.equal(isUnassignedUnit(undefined), true);
    assert.equal(isUnassignedUnit(""), true);
    assert.equal(isUnassignedUnit("   "), true);
    assert.equal(isUnassignedUnit("не назначено"), true);
    assert.equal(isUnassignedUnit("НЕ НАЗНАЧЕНО"), true);
    // Настоящее подразделение пустым не считается: иначе автоопределение
    // перезаписало бы его ролью Discord
    assert.equal(isUnassignedUnit("Танковая рота"), false);
    assert.equal(isUnassignedUnit("Артиллерийский дивизион"), false);
  });
});

describe("Звание при зачислении", () => {
  test("звание новобранца — Рядовой", () => {
    assert.equal(RECRUIT_RANK, "Рядовой");
  });

  test("«Курсант» и пустое значение считаются нераспределёнными", () => {
    assert.equal(isEnlistmentRank("Курсант"), true);
    assert.equal(isEnlistmentRank("курсант"), true);
    assert.equal(isEnlistmentRank(" Курсант "), true);
    assert.equal(isEnlistmentRank(""), true);
    assert.equal(isEnlistmentRank(null), true);
    assert.equal(isEnlistmentRank(undefined), true);
  });

  test("присвоенное звание не понижается повторным одобрением", () => {
    assert.equal(isEnlistmentRank("Ефрейтор"), false);
    assert.equal(isEnlistmentRank("Рядовой"), false);
    assert.equal(isEnlistmentRank("Капитан"), false);
  });
});

describe("Настройки зачисления: роли и листы ШДС", () => {
  test("ключи ролей и листов присутствуют в настройках по умолчанию", () => {
    for (const key of Object.values(ENLISTMENT_ROLE_SETTINGS)) {
      assert.ok(key in DEFAULT_SETTINGS, `нет ключа ${key} в DEFAULT_SETTINGS`);
      assert.equal(DEFAULT_SETTINGS[key], "");
    }
    for (const key of Object.values(UNIT_SHEET_SETTINGS)) {
      assert.ok(key in DEFAULT_SETTINGS, `нет ключа ${key} в DEFAULT_SETTINGS`);
      assert.equal(DEFAULT_SETTINGS[key], "");
    }
  });

  test("пустая настройка листа даёт название подразделения", () => {
    const empty = new Map<string, string>();
    assert.equal(unitSheetName("Танковая рота", empty), DEFAULT_SHEET_TANK);
    assert.equal(unitSheetName("Артиллерийский дивизион", empty), DEFAULT_SHEET_ART);
    assert.equal(unitSheetName("Танковая рота", empty), "Танковая рота");
    assert.equal(unitSheetName("Артиллерийский дивизион", empty), "Артиллерийский дивизион");
  });

  test("настроенное имя листа перекрывает значение по умолчанию", () => {
    const map = new Map<string, string>([
      ["shds_sheet_tank", "1-я танковая рота"],
      ["shds_sheet_art", "АД (основной)"],
    ]);
    assert.equal(unitSheetName("Танковая рота", map), "1-я танковая рота");
    assert.equal(unitSheetName("Артиллерийский дивизион", map), "АД (основной)");
  });

  test("пробельное значение настройки считается пустым", () => {
    const map = new Map<string, string>([["shds_sheet_tank", "   "]]);
    assert.equal(unitSheetName("Танковая рота", map), DEFAULT_UNIT_SHEET_NAMES["Танковая рота"]);
  });

  test("новая настройка роли приоритетнее прежней", () => {
    const both = new Map<string, string>([
      ["role_tank_id", "111111111111111111"],
      ["tank_role_id", "222222222222222222"],
    ]);
    assert.equal(unitRoleId("Танковая рота", both), "111111111111111111");

    // Старый ключ продолжает работать: установки, где его уже заполнили, не
    // должны потерять автоопределение подразделения после обновления
    const legacy = new Map<string, string>([["art_role_id", "333333333333333333"]]);
    assert.equal(unitRoleId("Артиллерийский дивизион", legacy), "333333333333333333");
  });

  test("без настроек роль подразделения ищется по имени", () => {
    assert.equal(UNIT_ROLE_NAMES["Танковая рота"], "Танковая рота");
    assert.equal(UNIT_ROLE_NAMES["Артиллерийский дивизион"], "Артиллерийский дивизион");
    assert.equal(CORPS_ROLE_NAME, "Артиллерийско-Танковый Корпус");
    assert.equal(unitRoleId("Танковая рота", new Map()), "");
  });

  test("прежние ключи ролей подразделений не потеряны", () => {
    assert.equal(UNIT_ROLE_SETTINGS["Танковая рота"].legacyKey, "tank_role_id");
    assert.equal(UNIT_ROLE_SETTINGS["Артиллерийский дивизион"].legacyKey, "art_role_id");
    // Роль модератора по-прежнему читается из окружения как запасной источник
    assert.equal(ROLE_ENV_FALLBACKS.moderator_role_id, "DISCORD_MODERATOR_ROLE_ID");
  });
});

describe("Права на решения по кнопкам в Discord", () => {
  test("высший комсостав по ФИО из официального списка", () => {
    assert.ok(COMMAND_STAFF_FULL_NAMES.includes("Волков Д. В."));
    assert.equal(isCommandStaffIdentity("Волков Д. В."), true);
    assert.equal(isCommandStaffIdentity("Волков Д.В."), true);
    assert.equal(isCommandStaffIdentity("  волков   д в  "), true);
    assert.equal(isCommandStaffIdentity("Иванов И. А."), true);
    assert.equal(isCommandStaffIdentity("Иванов К. М."), true);
  });

  test("ник в Discord без инициалов узнаётся по фамилии", () => {
    assert.equal(isCommandStaffIdentity("Волков"), true);
    assert.equal(isCommandStaffIdentity("Иванов"), true);
  });

  test("обычный боец прав не получает", () => {
    assert.equal(isCommandStaffIdentity("Добролюбов А. П."), false);
    assert.equal(isCommandStaffIdentity("Скиф"), false);
    assert.equal(isCommandStaffIdentity(""), false);
    assert.equal(isCommandStaffIdentity(null), false);
    assert.equal(isCommandStaffIdentity(undefined), false);
  });

  test("командирские роли распознаются по названию", () => {
    assert.equal(isCommandStaffRoleName("Командир роты"), true);
    assert.equal(isCommandStaffRoleName("Командир танковой роты"), true);
    assert.equal(isCommandStaffRoleName("Командир арт. дивизиона"), true);
    assert.equal(isCommandStaffRoleName("Зам. ком. дивизиона"), true);
    assert.equal(isCommandStaffRoleName("Зам.кмд. танковой роты"), true);
    assert.equal(isCommandStaffRoleName("Командир Корпуса"), true);
  });

  test("роли, не относящиеся к командованию, прав не дают", () => {
    assert.equal(isCommandStaffRoleName("Рядовой"), false);
    assert.equal(isCommandStaffRoleName("Танковая рота"), false);
    assert.equal(isCommandStaffRoleName("Друг АТК"), false);
    assert.equal(isCommandStaffRoleName("Модератор"), false);
    assert.equal(isCommandStaffRoleName(""), false);
    assert.equal(isCommandStaffRoleName(null), false);
  });
});

describe("Подразделение в карточке заявки", () => {
  const base = {
    id: 7,
    callsign: "Волк",
    discordTag: "volk",
    discordId: "1085141850966458519" as string | null,
    age: 24 as number | null,
    armaExperience: "3 года",
    about: "",
    createdAt: "2026-06-20T10:00:00.000Z",
    status: "pending" as const,
  };

  /**
   * Значение поля Embed по названию.
   *
   * `fields` в ReviewEmbed необязательное (у Discord это допустимо), поэтому
   * тип описан через undefined-safe доступ: иначе тест не собрался бы.
   */
  const fieldValue = (
    embed: { fields?: { name: string; value: string }[] },
    name: string
  ) => embed.fields?.find((field) => field.name === name)?.value;

  test("выбор кандидата выводится отдельным полем", () => {
    const tank = buildRecruitEmbed({ ...base, unit: "Танковая рота" });
    assert.equal(fieldValue(tank, "Подразделение"), "Танковая рота (ТР)");

    const art = buildRecruitEmbed({ ...base, unit: "Артиллерийский дивизион" });
    assert.equal(fieldValue(art, "Подразделение"), "Артиллерийский дивизион (АД)");
  });

  test("без выбора поле показывает честную пометку, а не догадку", () => {
    const nothing = buildRecruitEmbed({ ...base, about: "" });
    assert.equal(fieldValue(nothing, "Подразделение"), "определяет штаб");

    // Старые заявки: подсказка по тексту анкеты остаётся рабочей
    const hinted = buildRecruitEmbed({ ...base, about: "Хочу в танкисты" });
    assert.equal(fieldValue(hinted, "Подразделение"), "Танковая рота (ТР)");
  });

  test("текст заявки в канал берёт направление из выбора", () => {
    const text = buildRecruitApplicationMessage({
      fullName: "Иванов И.И.",
      callsign: "Волк",
      about: "хочу в артиллерию",
      age: 22,
      armaExperience: "600 часов",
      discordId: null,
      discordTag: null,
      unit: "Артиллерийский дивизион",
    });
    // Явный выбор важнее текста анкеты: лист ШДС определит именно он
    assert.match(text, /2\. Направление: Артиллерийский дивизион \(АД\)/);
  });

  test("без выбора направление берётся из анкеты", () => {
    const text = buildRecruitApplicationMessage({
      fullName: "Иванов И.И.",
      callsign: "Волк",
      about: "Хочу в танкисты",
      age: 22,
      armaExperience: "600 часов",
      discordId: null,
      discordTag: null,
    });
    assert.match(text, /2\. Направление: Танковая рота \(ТР\)/);
  });
});
