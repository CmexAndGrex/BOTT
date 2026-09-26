/**
 * Тесты модуля «Арсенал» (src/lib/armory.ts).
 *
 * Проверяется боевой модуль, а не копия правил в тесте: если в src/ изменят
 * структуру выкладки, санитизацию экспортных строк или проверку SQF, тест упадёт.
 * Это критично, потому что строки из каталога уезжают бойцу прямо в игру:
 * незакрытая скобка в шаблоне — это «Error: Missing ]» в Eden уже на операции, а
 * незамеченный невидимый символ в класснейме — молча не найденный предмет.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ARMORY_DIVISIONS,
  ARMORY_DIVISION_META,
  ARMORY_ITEM_COUNT_MAX,
  ARMORY_LIST_MAX,
  ARMORY_TITLE_MAX,
  buildTextChecklist,
  canManageArmory,
  canViewArmory,
  emptyEquipment,
  equipmentPositionCount,
  equipmentSummary,
  isArmoryDivision,
  matchesQuery,
  normalizeQuery,
  readEquipment,
  sanitizeAceImportString,
  sanitizeSqfCode,
  scanSqfSource,
  sqfForEden,
  sqfForUnit,
  sqfString,
  sqfStringArray,
  validateAceImportString,
  validateArmoryTemplate,
  validateEquipment,
  validateSqfArray,
  type ArmoryEquipment,
} from "../src/lib/armory.ts";

/** Корректная выкладка для тестов: механик-водитель Т-90А */
function sampleEquipment(overrides: Partial<ArmoryEquipment> = {}): ArmoryEquipment {
  return {
    uniform: "rhs_uniform_6b45",
    vest: "rhs_6b45_rifleman",
    helmet: "rhs_6b47",
    backpack: "rhs_tortila_black",
    primary_weapon: "rhs_weap_ak74m",
    secondary_weapon: null,
    medical: [
      { name: "ACE_fieldDressing", count: 10 },
      { name: "ACE_tourniquet", count: 4 },
    ],
    magazines: [{ name: "rhs_30Rnd_545x39_AK", count: 8 }],
    misc: ["Radio", "NVG", "Map"],
    ...overrides,
  };
}

/** Тело запроса на создание шаблона */
function sampleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Механик-водитель Т-90А",
    division: "Танковая рота",
    specialty_code: "МВ-Т90А",
    description: "Требуется допуск КМБТ.",
    equipment_breakdown: sampleEquipment(),
    ace_import_string: '["rhs_uniform_6b45", ["rhs_6b45_rifleman"]]',
    sqf_code: '["rhs_uniform_6b45", "rhs_6b45_rifleman"]',
    ...overrides,
  };
}

describe("Арсенал: подразделения каталога", () => {
  test("четыре раздела, включая «Общий» и учебную часть", () => {
    assert.deepEqual(
      [...ARMORY_DIVISIONS],
      ["Танковая рота", "Артиллерийский дивизион", "Учебная часть", "Общий"]
    );
  });

  test("«Танковая рота» и «Артиллерийский дивизион» совпадают с названиями листов ШДС", () => {
    // Значения переиспользуются в recruits.UNITS (листы Google Таблицы):
    // переименование здесь сломало бы и каталог, и синхронизацию состава
    assert.ok(ARMORY_DIVISIONS.includes("Танковая рота"));
    assert.ok(ARMORY_DIVISIONS.includes("Артиллерийский дивизион"));
  });

  test("неизвестный раздел не проходит проверку", () => {
    assert.equal(isArmoryDivision("Танковая рота"), true);
    assert.equal(isArmoryDivision("Морская пехота"), false);
    assert.equal(isArmoryDivision(undefined), false);
    assert.equal(isArmoryDivision(42), false);
  });

  test("у каждого раздела есть краткая подпись и акцент для бейджа", () => {
    for (const division of ARMORY_DIVISIONS) {
      const meta = ARMORY_DIVISION_META[division];
      assert.ok(meta.short.length > 0, `нет подписи для «${division}»`);
      assert.ok(["green", "amber", "blue", "red"].includes(meta.accent));
    }
  });
});

describe("Арсенал: структура выкладки в JSONB", () => {
  test("корректная выкладка проходит проверку без изменений", () => {
    const result = validateEquipment(sampleEquipment());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.uniform, "rhs_uniform_6b45");
    assert.equal(result.data.medical.length, 2);
    assert.equal(result.data.medical[0].count, 10);
    assert.deepEqual(result.data.misc, ["Radio", "NVG", "Map"]);
  });

  test("ключи выкладки соответствуют внешнему контракту", () => {
    // Ключи jsonb читают инструменты помимо панели: переименование в camelCase
    // «по красоте» тихо сломало бы тех, кто уже разбирает эти данные
    assert.deepEqual(Object.keys(emptyEquipment()).sort(), [
      "backpack",
      "helmet",
      "magazines",
      "medical",
      "misc",
      "primary_weapon",
      "secondary_weapon",
      "uniform",
      "vest",
    ]);
  });

  test("пустые слоты СИБЗ отклоняются: форма, разгрузка и шлем обязательны", () => {
    for (const field of ["uniform", "vest", "helmet"] as const) {
      const result = validateEquipment(sampleEquipment({ [field]: "" }));
      assert.equal(result.ok, false, `поле «${field}» должно быть обязательным`);
      if (!result.ok) assert.match(result.error, /Экипировка/);
    }
  });

  test("необязательные слоты пустеют в null, а не в пустую строку", () => {
    const result = validateEquipment(
      sampleEquipment({ backpack: "   ", primary_weapon: "", secondary_weapon: undefined })
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.backpack, null);
    assert.equal(result.data.primary_weapon, null);
    assert.equal(result.data.secondary_weapon, null);
  });

  test("медицина и БК: количество проверяется строго", () => {
    const bad = [0, -3, 1.5, ARMORY_ITEM_COUNT_MAX + 1, "abc"];
    for (const count of bad) {
      const result = validateEquipment(
        sampleEquipment({ medical: [{ name: "ACE_fieldDressing", count: count as number }] })
      );
      assert.equal(result.ok, false, `количество ${String(count)} должно отклоняться`);
      if (!result.ok) assert.match(result.error, /количество/i);
    }
  });

  test("количество строкой из формы принимается (поле ввода присылает текст)", () => {
    const result = validateEquipment(
      sampleEquipment({ medical: [{ name: "ACE_fieldDressing", count: "10" as unknown as number }] })
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.medical[0].count, 10);
  });

  test("позиция без названия и «не-объект» в списке отклоняются", () => {
    const noName = validateEquipment(sampleEquipment({ magazines: [{ name: "  ", count: 1 }] }));
    assert.equal(noName.ok, false);

    const weird = validateEquipment(
      sampleEquipment({ magazines: ["rhs_30Rnd_545x39_AK"] as unknown as { name: string; count: number }[] })
    );
    assert.equal(weird.ok, false);
    if (!weird.ok) assert.match(weird.error, /\{ name, count \}/);
  });

  test("переполнение списков отклоняется", () => {
    const many = Array.from({ length: ARMORY_LIST_MAX + 1 }, (_, i) => ({ name: `item_${i}`, count: 1 }));
    const result = validateEquipment(sampleEquipment({ medical: many }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, new RegExp(String(ARMORY_LIST_MAX)));
  });
});

describe("Арсенал: разбор jsonb из БД", () => {
  test("нечитаемое значение разбирается в пустую выкладку без падения", () => {
    // Так выглядят старые записи, ручные правки в psql и мусор после миграции
    for (const value of [null, undefined, "строка", 42, [], { uniform: 42 }]) {
      const equipment = readEquipment(value);
      assert.equal(typeof equipment.uniform, "string");
      assert.deepEqual(equipment.medical, []);
      assert.deepEqual(equipment.misc, []);
    }
  });

  test("readEquipment обрезает мусор и приводит количество к целому", () => {
    const equipment = readEquipment({
      uniform: "  rhs_uniform_6b45  ",
      vest: null,
      helmet: "rhs_6b47",
      medical: [{ name: "CAT", count: "4" }, { name: "", count: 1 }, { count: 5 }],
      magazines: "не массив",
      misc: ["Radio", 7, "Radio"],
    });
    assert.equal(equipment.uniform, "rhs_uniform_6b45");
    assert.equal(equipment.vest, "");
    assert.deepEqual(equipment.medical, [{ name: "CAT", count: 4 }]);
    assert.deepEqual(equipment.magazines, []);
    assert.deepEqual(equipment.misc, ["Radio"]);
  });

  test("управляющие символы и переносы внутри слота не сохраняются", () => {
    const result = validateEquipment(sampleEquipment({ uniform: "rhs_6b45\u0000\n\t rhs_6b45" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.uniform, "rhs_6b45 rhs_6b45");
  });

  test("сводка и счётчик позиций считают то, что видно на карточке", () => {
    const equipment = sampleEquipment();
    assert.equal(equipmentPositionCount(equipment), 2 + 1 + 3);
    assert.match(equipmentSummary(equipment), /rhs_weap_ak74m/);
    assert.match(equipmentSummary(equipment), /rhs_uniform_6b45/);
    assert.equal(
      equipmentSummary(sampleEquipment({ primary_weapon: null })),
      "без основного оружия · rhs_uniform_6b45 · rhs_6b45_rifleman"
    );
  });

  test("спецсредства: пустая позиция отклоняется, а не тихо выбрасывается", () => {
    // Молчаливое выбрасывание означало бы, что офицер заполнил строку, сохранил
    // шаблон и не увидел своей правки — ошибка должна быть явной
    const result = validateEquipment(sampleEquipment({ misc: ["Radio", "  ", "NVG"] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /misc/);
  });

  test("спецсредства не массивом отклоняются", () => {
    const result = validateEquipment(sampleEquipment({ misc: "Radio" as unknown as string[] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /misc/);
  });

  test("дубли спецсредств снимает разбор из БД (в шаблоне они не мешают)", () => {
    const equipment = readEquipment({ misc: ["Radio", "Radio", "NVG"] });
    assert.deepEqual(equipment.misc, ["Radio", "NVG"]);
  });
});

describe("Арсенал: санитизация строки ACE Arsenal", () => {
  test("нормальная строка экспорта сохраняется дословно", () => {
    const source = '["rhs_uniform_6b45", ["rhs_6b45_rifleman", []], ["ACE_fieldDressing", 10]]';
    const result = validateAceImportString(source);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data, source);
  });

  test("переносы строк и табуляция схлопываются: экспорт из игры однострочный", () => {
    const result = validateAceImportString('["rhs_6b45",\n\t"rhs_6b47"]');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data, '["rhs_6b45", "rhs_6b47"]');
    assert.ok(!result.data.includes("\n"));
  });

  test("невидимые маркеры убираются: иначе предмет молча не находится в игре", () => {
    // U+200B, U+FEFF и мягкий перенос на глаз неотличимы, а класснейм ломают
    const dirty = '["rhs_6b45\u200b", "\ufeffrhs_6b47", "rhs_\u00adtortila"]';
    const result = validateAceImportString(dirty);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data, '["rhs_6b45", "rhs_6b47", "rhs_tortila"]');
  });

  test("угловые скобки убираются: строка попадает в выгрузки и чаты", () => {
    assert.equal(sanitizeAceImportString('<script>alert(1)</script>') , "scriptalert(1)/script");
    assert.ok(!sanitizeAceImportString("[\"<img src=x onerror=1>\"]").includes("<"));
  });

  test("NUL-символы заменяются пробелом, строка не рвётся", () => {
    assert.equal(sanitizeAceImportString('["rhs\u0000_6b45"]'), '["rhs _6b45"]');
  });

  test("длина ограничена: «роман» в буфере обмена подвесил бы вставку", () => {
    const huge = `["${"a".repeat(12000)}"]`;
    assert.equal(sanitizeAceImportString(huge).length, 8000);
  });

  test("пустое значение и не-строка отклоняются", () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
      const result = validateAceImportString(value);
      assert.equal(result.ok, false);
    }
  });

  test("строка без массива экспортом не считается", () => {
    const result = validateAceImportString("rhs_uniform_6b45");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /\[/);
  });

  test("несбалансированные скобки и незакрытая кавычка отклоняются", () => {
    const cases = [
      '["rhs_6b45"',
      '["rhs_6b45"]]',
      '["rhs_6b45, "rhs_6b47"]',
    ];
    for (const value of cases) {
      const result = validateAceImportString(value);
      assert.equal(result.ok, false, `строка «${value}» должна отклоняться`);
    }
  });

  test("скобки внутри строки не считаются структурой (экранирование удвоением)", () => {
    const result = validateAceImportString('["[[]]", "rhs_6b45"]');
    assert.equal(result.ok, true);
  });

  test("не-строка на входе даёт пустую строку, а не исключение", () => {
    assert.equal(sanitizeAceImportString(undefined), "");
    assert.equal(sanitizeAceImportString({ toString: () => "[]" }), "");
  });
});

describe("Арсенал: SQF без синтаксических ошибок", () => {
  test("корректный массив принимается как есть", () => {
    const code = '["rhs_uniform_6b45", ["rhs_6b45_rifleman", ["ACE_fieldDressing", 10]]]';
    const result = validateSqfArray(code);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data, code);
  });

  test("готовый код с оператором принимается: штаб вставляет строку из Eden", () => {
    const result = validateSqfArray('player setUnitLoadout ["rhs_6b45"];');
    assert.equal(result.ok, true);
  });

  test("многострочный код с комментариями принимается, переносы сохраняются", () => {
    const code = [
      "player setUnitLoadout [",
      '    "rhs_uniform_6b45",   // форма',
      '    "rhs_6b47"            // шлем',
      "];",
    ].join("\n");
    const result = validateSqfArray(code);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.data.includes("\n"));
    assert.equal(sanitizeSqfCode(code).endsWith("];"), true);
  });

  test("незакрытая скобка, лишняя скобка и незакрытая кавычка отклоняются", () => {
    const cases: [string, RegExp][] = [
      ['["rhs_6b45"', /незакрытая скобка/],
      ['["rhs_6b45"]]', /лишняя закрывающая/],
      ['["rhs_6b45]', /незакрытая кавычка/],
      ["setUnitLoadout 42;", /нет массива/],
    ];
    for (const [value, pattern] of cases) {
      const result = validateSqfArray(value);
      assert.equal(result.ok, false, `код «${value}» должен отклоняться`);
      if (!result.ok) assert.match(result.error, pattern);
    }
  });

  test("скобки в комментарии не влияют на проверку", () => {
    const result = validateSqfArray('["rhs_6b45"] // ]]] незакрытая на вид скобка');
    assert.equal(result.ok, true);
  });

  test("русские названия в строках не ломают проверку", () => {
    const result = validateSqfArray('["rhs_6b45", "Форма механика-водителя Т-90А"]');
    assert.equal(result.ok, true);
  });

  test("посторонние символы вне строк и комментариев отклоняются", () => {
    const cases = [
      '["rhs_6b45"] { go };',
      '["rhs_6b45"] ```',
      '["rhs_6b45"] А;',
      '["rhs_6b45"] «цитата»',
    ];
    const bad = cases.filter((value) => !validateSqfArray(value).ok);
    assert.equal(bad.length, cases.length, "мусорные символы должны отклоняться");
  });

  test("неразрывный пробел нормализуется, а не ломает вставку", () => {
    // U+00A0 с виду неотличим от пробела, но в SQF-строке ломает класснейм
    assert.equal(sanitizeSqfCode('["rhs_6b45\u00a0", "rhs_6b47"]'), '["rhs_6b45 ", "rhs_6b47"]');
    assert.equal(validateSqfArray('["rhs_6b45\u00a0"]').ok, true);
  });

  test("пустое значение отклоняется, не-строка не бросает исключение", () => {
    assert.equal(validateSqfArray("   ").ok, false);
    assert.equal(validateSqfArray(null).ok, false);
    assert.equal(sanitizeSqfCode(42), "");
  });

  test("обёртки Eden и выдачи напарнику не дублируют оператор", () => {
    const bare = '["rhs_6b45"]';
    assert.equal(sqfForEden(bare), 'player setUnitLoadout ["rhs_6b45"];');
    assert.equal(sqfForEden('player setUnitLoadout ["rhs_6b45"];'), 'player setUnitLoadout ["rhs_6b45"];');
    assert.equal(sqfForUnit(bare), '[_unit, ["rhs_6b45"]] call ace_arsenal_fnc_setLoadout;');
    assert.equal(sqfForEden(""), "");
    assert.equal(sqfForUnit(""), "");
  });

  test("кавычка и обратный слэш экранируются по правилам SQF", () => {
    assert.equal(sqfString('6Б45 "Ратник"'), '"6Б45 ""Ратник"""');
    assert.equal(sqfString("C:\\mods"), '"C:\\\\mods"');
  });

  test("массив строк сохраняет позиции: пустые слоты становятся nil", () => {
    assert.equal(sqfStringArray(["rhs_6b45", null, ""]), '["rhs_6b45", nil, nil]');
    assert.equal(sqfStringArray([]), "[]");
  });

  test("собранный массив строк проходит собственную проверку", () => {
    // Регрессия: sqfStringArray и validateSqfArray обязаны быть согласованы,
    // иначе «Собрать заготовку SQF» положит в шаблон отклоняемую строку
    const built = `player setUnitLoadout ${sqfStringArray(["rhs_6b45", 'Каска "Ратник"', null])};`;
    const result = validateSqfArray(built);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
  });

  test("scanSqfSource сообщает причину отказа, а не просто false", () => {
    assert.deepEqual(scanSqfSource('["a"]'), { ok: true });
    const broken = scanSqfSource('["a"');
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.ok(broken.error.length > 0);
  });
});

describe("Арсенал: доступ по ролям", () => {
  test("каталог видят боец в строю, командир, администратор и панель", () => {
    assert.equal(canViewArmory({ memberRole: "member", memberStatus: "active" }), true);
    assert.equal(canViewArmory({ memberRole: "member", memberStatus: "vacation" }), true);
    assert.equal(canViewArmory({ memberRole: "officer", memberStatus: "active" }), true);
    assert.equal(canViewArmory({ memberRole: "admin", memberStatus: "active" }), true);
    assert.equal(canViewArmory({ panelRole: "officer" }), true);
    assert.equal(canViewArmory({ panelRole: "admin" }), true);
  });

  test("гость, непринятый рапорт и исключённый боец каталог не видят", () => {
    assert.equal(canViewArmory({}), false);
    assert.equal(canViewArmory({ memberRole: "guest" }), false);
    assert.equal(canViewArmory({ memberRole: "member", memberStatus: "pending" }), false);
    assert.equal(canViewArmory({ memberRole: "member", memberStatus: "dismissed" }), false);
    assert.equal(canViewArmory({ panelRole: "guest" }), false);
  });

  test("правка шаблонов закрыта бойцу и новобранцу, открыта штабу", () => {
    assert.equal(canManageArmory({ memberRole: "member", memberStatus: "active" }), false);
    assert.equal(canManageArmory({ memberRole: "recruit", memberStatus: "active" }), false);
    assert.equal(canManageArmory({ memberRole: "officer", memberStatus: "active" }), true);
    assert.equal(canManageArmory({ memberRole: "admin", memberStatus: "vacation" }), true);
    assert.equal(canManageArmory({ panelRole: "officer" }), true);
    assert.equal(canManageArmory({ panelRole: "admin" }), true);
  });

  test("командир с непринятым или отклонённым рапортом не правит шаблоны", () => {
    // Роль в БД могла остаться от прежнего аккаунта: статус сильнее роли
    assert.equal(canManageArmory({ memberRole: "officer", memberStatus: "pending" }), false);
    assert.equal(canManageArmory({ memberRole: "officer", memberStatus: "dismissed" }), false);
  });

  test("мусор в роли трактуется как «доступа нет», а не как разрешение", () => {
    assert.equal(canManageArmory({ memberRole: "superuser", memberStatus: "active" }), false);
    assert.equal(canViewArmory({ memberRole: "superuser", memberStatus: "active" }), false);
    assert.equal(canManageArmory({ panelRole: "root" }), false);
  });

  test("сессия панели даёт доступ независимо от статуса рапорта", () => {
    // У администратора рапорта может не быть вовсе — требовать кабинет абсурдно
    assert.equal(canViewArmory({ panelRole: "admin", memberStatus: "pending" }), true);
    assert.equal(canManageArmory({ panelRole: "admin", memberStatus: "pending" }), true);
  });
});

describe("Арсенал: поиск по каталогу", () => {
  const loadout = {
    title: "Механик-водитель Т-90А",
    specialtyCode: "МВ-Т90А",
    description: "Требуется допуск КМБТ",
    equipment: sampleEquipment(),
  };

  test("пустой запрос совпадает со всем", () => {
    assert.equal(matchesQuery(loadout, ""), true);
    assert.equal(matchesQuery(loadout, "   "), true);
    assert.equal(matchesQuery(loadout, undefined), true);
  });

  test("ищет по названию без учёта регистра", () => {
    assert.equal(matchesQuery(loadout, "механик"), true);
    assert.equal(matchesQuery(loadout, "МЕХАНИК"), true);
    assert.equal(matchesQuery(loadout, "наводчик-оператор"), false);
  });

  test("ищет по предметам выкладки: боец помнит класснейм, а не название комплекта", () => {
    assert.equal(matchesQuery(loadout, "6b45"), true);
    assert.equal(matchesQuery(loadout, "ACE_tourniquet"), true);
    assert.equal(matchesQuery(loadout, "ace_tourniquet"), true);
    assert.equal(matchesQuery(loadout, "Radio"), true);
    assert.equal(matchesQuery(loadout, "rhs_weap_ak74m"), true);
  });

  test("ищет по коду специальности", () => {
    assert.equal(matchesQuery(loadout, "МВ-Т90А"), true);
  });

  test("строка ACE в поиск не входит: иначе совпадение было бы случайным", () => {
    // В экспортной строке есть все класснеймы сразу, и поиск по ней «находил» бы
    // любой комплект по любому предмету
    const withAce = { ...loadout, aceImportString: '["rhs_uniform_6b45", "редчайший_предмет"]' };
    assert.equal(matchesQuery(withAce, "редчайший_предмет"), false);
  });

  test("нормализация запроса сжимает пробелы и режет длину", () => {
    assert.equal(normalizeQuery("  Т-90А   мехвод  "), "т-90а мехвод");
    assert.equal(normalizeQuery(42), "");
    assert.equal(normalizeQuery("a".repeat(200)).length, 80);
  });

  test("части разных полей не склеиваются: поиск идёт по целым значениям", () => {
    // Разделитель между полями не даёт запросу совпасть «на стыке»
    const edge = {
      title: "Танк",
      specialtyCode: null,
      description: null,
      equipment: sampleEquipment({ uniform: "rhs_uniform" }),
    };
    assert.equal(matchesQuery(edge, "танк rhs"), false);
  });
});

describe("Арсенал: разбор тела запроса на шаблон", () => {
  test("полный шаблон принимается, поля нормализуются", () => {
    const result = validateArmoryTemplate(sampleBody(), "Командир Скиф");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.title, "Механик-водитель Т-90А");
    assert.equal(result.data.division, "Танковая рота");
    assert.equal(result.data.specialtyCode, "МВ-Т90А");
    assert.equal(result.data.createdBy, "Командир Скиф");
    assert.equal(result.data.isActive, true);
  });

  test("camelCase из интерфейса и snake_case из API равнозначны", () => {
    const camel = validateArmoryTemplate(
      {
        title: "Наводчик-оператор",
        division: "Танковая рота",
        specialtyCode: "НО-Т90А",
        equipmentBreakdown: sampleEquipment(),
        aceImportString: '["rhs_6b45"]',
        sqfCode: '["rhs_6b45"]',
      },
      null
    );
    assert.equal(camel.ok, true);
    if (!camel.ok) return;
    assert.equal(camel.data.specialtyCode, "НО-Т90А");

    const snake = validateArmoryTemplate(sampleBody({ title: "Наводчик-оператор" }), null);
    assert.equal(snake.ok, true);
  });

  test("короткое название отклоняется", () => {
    const result = validateArmoryTemplate(sampleBody({ title: " а " }), null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Название/);
  });

  test("название обрезается по пределу, а не отклоняется", () => {
    const result = validateArmoryTemplate(sampleBody({ title: "К".repeat(400) }), null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.title.length, ARMORY_TITLE_MAX);
  });

  test("неизвестный раздел отклоняется со списком допустимых", () => {
    const result = validateArmoryTemplate(sampleBody({ division: "Морская пехота" }), null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Танковая рота/);
  });

  test("битая выкладка, ACE и SQF отклоняются на уровне шаблона", () => {
    const equipment = validateArmoryTemplate(
      sampleBody({ equipment_breakdown: { uniform: "rhs_6b45" } }),
      null
    );
    assert.equal(equipment.ok, false);

    const ace = validateArmoryTemplate(sampleBody({ ace_import_string: "не массив" }), null);
    assert.equal(ace.ok, false);

    const sqf = validateArmoryTemplate(sampleBody({ sqf_code: '["rhs_6b45"' }), null);
    assert.equal(sqf.ok, false);
  });

  test("отсутствующие необязательные поля дают null, а не пустые строки", () => {
    const body = sampleBody();
    delete body.specialty_code;
    delete body.description;
    const result = validateArmoryTemplate(body, null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.specialtyCode, null);
    assert.equal(result.data.description, null);
  });

  test("состояние: явное true/false уважается, отсутствие — «действует»", () => {
    const archived = validateArmoryTemplate(sampleBody({ is_active: false }), null);
    assert.equal(archived.ok, true);
    if (archived.ok) assert.equal(archived.data.isActive, false);

    // Не-boolean трактуется как «в архив»: неактивный шаблон безопаснее случайно
    // опубликованного, а мусор в поле означает, что форма собрана не нами
    const garbage = validateArmoryTemplate(sampleBody({ is_active: "нет" }), null);
    assert.equal(garbage.ok, true);
    if (garbage.ok) assert.equal(garbage.data.isActive, false);

    const missing = validateArmoryTemplate(sampleBody(), null);
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.data.isActive, true);
  });

  test("пояснение обрезается и перенормализуется", () => {
    const result = validateArmoryTemplate(
      sampleBody({ description: "  Строка 1\r\n\r\n\r\n\r\nСтрока 2  " }),
      null
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.description, "Строка 1\n\nСтрока 2");
  });

  test("author берётся из сессии, а не из тела запроса", () => {
    // Иначе офицер мог бы подписать правку чужим позывным
    const body = { ...sampleBody(), createdBy: "Кто-то другой" } as Record<string, unknown>;
    const result = validateArmoryTemplate(body, "Командир Скиф");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.createdBy, "Командир Скиф");
  });
});

describe("Арсенал: текстовый табель", () => {
  const checklist = () =>
    buildTextChecklist({
      title: "Механик-водитель Т-90А",
      division: "Танковая рота",
      specialtyCode: "МВ-Т90А",
      description: "Требуется допуск КМБТ.\nВыдаётся перед выездом.",
      equipment: sampleEquipment(),
    });

  test("заголовок, раздел и код специальности попадают в табель", () => {
    const text = checklist();
    assert.match(text, /ТАБЕЛЬ ВЫКЛАДКИ — Механик-водитель Т-90А/);
    assert.match(text, /Подразделение: Танковая рота/);
    assert.match(text, /Код специальности: МВ-Т90А/);
  });

  test("три раздела выкладки присутствуют и пронумерованы", () => {
    const text = checklist();
    assert.match(text, /1\. ЭКИПИРОВКА И СИБЗ/);
    assert.match(text, /2\. ВООРУЖЕНИЕ И БК/);
    assert.match(text, /3\. МЕДИЦИНА ACE3 И СПЕЦСРЕДСТВА/);
  });

  test("позиции идут с количеством, спецсредства — с подсказкой", () => {
    const text = checklist();
    assert.match(text, /ACE_fieldDressing × 10/);
    assert.match(text, /rhs_30Rnd_545x39_AK × 8/);
    assert.match(text, /Radio \(проверить канал взвода\)/);
  });

  test("пустые позиции не выбрасываются: боец видит «не выдаётся», а не догадывается", () => {
    const text = buildTextChecklist({
      title: "Стрелок КМБТ",
      division: "Учебная часть",
      equipment: emptyEquipment(),
    });
    assert.match(text, /Рюкзак:\s+не выдаётся/);
    assert.match(text, /Основное:\s+не выдаётся/);
    assert.match(text, /Медицина:\s+—/);
  });

  test("переносы строк только \\n: табель уходит в буфер и в файлы", () => {
    const text = checklist();
    assert.ok(!text.includes("\r"), "в табеле не должно быть CR");
  });

  test("пояснение штаба сохраняет абзацы", () => {
    const text = checklist();
    assert.match(text, /Пояснение:/);
    assert.match(text, /Требуется допуск КМБТ\./);
  });

  test("табель читается целиком: есть финальная строка проверки", () => {
    assert.match(checklist(), /Проверка перед выездом/);
  });
});