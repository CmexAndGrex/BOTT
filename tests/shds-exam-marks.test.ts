/**
 * Синхронизация оценок между БД и тремя листами ШДС.
 *
 * Проверяются доменные правила боевого модуля src/lib/gsheets.ts:
 *   * распознавание оценки по тексту («5», «4+», «5-», «зач») и по заливке;
 *   * синяя заливка «КБМ Испыт.» на листе «Запас» как зачёт;
 *   * командование Корпуса — все нормативы сданные;
 *   * геометрия листов: блок запаса дивизиона 44–78, граница инфо-блоков 80,
 *     шапка «Запас» (строка 3, I..AF) и диапазоны «Вакант» для автозаписи.
 *
 * Живой Google API в тестах недоступен, поэтому проверяются чистые функции и
 * константы раскладки — та их часть, которая решает, попадёт ли оценка бойцу.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COMMAND_CLEANUP_POST,
  COMMAND_CLEANUP_RANGES,
  COMMAND_CORPS_NAMES,
  COMMAND_SHEET_LAYOUT,
  COMMAND_SHEET_NAME,
  FORCED_SECTION_MOVES,
  PASS_MARK,
  RESERVE_LAYOUT,
  SECTION_FILL_MAX,
  UNIT_COMMAND_ROWS,
  VACANT_FILL_RANGES,
  VACANT_SECTIONS,
  cleanSteamIdForSheet,
  findVacantSection,
  isCommandCorps,
  isSheetCommandMember,
  isUnitCommandName,
  matchesCommandRoster,
  parseExamMark,
  resolveExamRubric,
  resolveLayout,
  sanitizeSheetPost,
  sectionAtRow,
  sectionsForPost,
  vacantFillRange,
  vacantFillRangesForPost,
  examReadBounds,
  examBounds,
  columnIndexOf,
} from "@/lib/gsheets.ts";

/** Зелёная заливка сданного экзамена (#00ff00) */
const GREEN = { red: 0, green: 1, blue: 0 };
/** Синяя заливка «КБМ Испыт.» на листе «Запас» */
const BLUE = { red: 0, green: 0, blue: 0.9 };
/** Белый фон пустой ячейки */
const WHITE = { red: 1, green: 1, blue: 1 };

describe("parseExamMark — оценки текстом", () => {
  for (const grade of ["5", "4", "5-", "4-", "4+", "5+"]) {
    test(`«${grade}» считается сданным и сохраняет оценку`, () => {
      const mark = parseExamMark({ value: grade });
      assert.equal(mark.passed, true);
      assert.equal(mark.grade, grade);
    });
  }

  test("«зач» превращается в «Зачёт» (числовой оценки нет)", () => {
    const mark = parseExamMark({ value: "зач" });
    assert.equal(mark.passed, true);
    assert.equal(mark.grade, PASS_MARK);
  });

  test("«3» не считается сданным, но оценка сохраняется", () => {
    const mark = parseExamMark({ value: "3" });
    assert.equal(mark.passed, false);
    assert.equal(mark.grade, "3");
  });

  test("пустая ячейка без заливки — не сдано", () => {
    const mark = parseExamMark({ value: "", color: WHITE });
    assert.equal(mark.passed, false);
    assert.equal(mark.grade, null);
  });
});

describe("parseExamMark — зелёная и синяя заливка", () => {
  test("пустая ячейка с зелёной заливкой — «Зачёт»", () => {
    const mark = parseExamMark({ value: "", color: GREEN });
    assert.equal(mark.passed, true);
    assert.equal(mark.grade, PASS_MARK);
  });

  test("светло-зелёная заливка (условное форматирование) тоже зачёт", () => {
    // green > 0.6 и доминирует над красным и синим
    const mark = parseExamMark({ value: "", color: { red: 0.72, green: 0.88, blue: 0.72 } });
    assert.equal(mark.passed, true);
  });

  test("зелёная заливка не важнее текстовой оценки «3»", () => {
    const mark = parseExamMark({ value: "3", color: GREEN });
    assert.equal(mark.passed, false);
    assert.equal(mark.grade, "3");
  });

  test("синяя заливка засчитывается только в столбце «КБМ Испыт.»", () => {
    const kmb = parseExamMark({ value: "", color: BLUE, title: "КБМ Испыт." });
    assert.equal(kmb.passed, true);
    assert.equal(kmb.grade, PASS_MARK);

    // В остальных столбцах синий — не признак сдачи
    const other = parseExamMark({ value: "", color: BLUE, title: "Огневая подготовка" });
    assert.equal(other.passed, false);
  });

  test("белая/серая заливка сдачей не считается", () => {
    assert.equal(parseExamMark({ value: "", color: WHITE }).passed, false);
    assert.equal(
      parseExamMark({ value: "", color: { red: 0.85, green: 0.85, blue: 0.85 } }).passed,
      false
    );
  });
});

describe("resolveExamRubric — названия листа «Запас»", () => {
  test("сокращения листа запаса находятся", () => {
    assert.equal(resolveExamRubric("КМБТ"), "КМБТ");
    assert.equal(resolveExamRubric("Снаряжение техники"), "Снаряжение, обслуживание техники");
    assert.equal(
      resolveExamRubric("Езда в проходимых условиях"),
      "Езда в сложно-проходимых условиях"
    );
    assert.equal(resolveExamRubric("Сдача на Мех. Водителя"), "Сдача на Мех. Водителя");
  });

  test("кавычки шапки берета не мешают", () => {
    assert.equal(resolveExamRubric("“Топография”"), "Топография");
    assert.equal(resolveExamRubric("“Связь”"), "Связь");
    assert.equal(resolveExamRubric("“Строевая подготовка”"), "Строевая подготовка");
    assert.equal(resolveExamRubric("“Должностные лица”"), "Должностные лица");
  });

  test("неизвестный заголовок — null (а не случайный норматив)", () => {
    assert.equal(resolveExamRubric("Для пометок"), null);
    assert.equal(resolveExamRubric(""), null);
  });
});

describe("Командование Корпуса", () => {
  test("список содержит ровно трёх человек из ТЗ", () => {
    assert.deepEqual([...COMMAND_CORPS_NAMES], ["Волков Д. В.", "Иванов И. А.", "Иванов К. М."]);
  });

  for (const name of COMMAND_CORPS_NAMES) {
    test(`«${name}» распознаётся независимо от точек и пробелов`, () => {
      assert.equal(isCommandCorps([name]), true);
      assert.equal(isCommandCorps([name.replace(/\./g, "")]), true);
    });
  }

  test("рядовой-однофамилец командованием не считается", () => {
    assert.equal(isCommandCorps(["Иванов И.Б."]), false);
    assert.equal(isCommandCorps(["Петров М.С."]), false);
  });
});

describe("Запрет записи командования в «Вакант»", () => {
  test("лист командования назван по ТЗ и читается по своей раскладке", () => {
    assert.equal(COMMAND_SHEET_NAME, "Командование АТК");
    // Шапка в строке 1, бойцы 2–4, экзамены с G по T
    assert.equal(COMMAND_SHEET_LAYOUT.headerRow, 1);
    assert.equal(COMMAND_SHEET_LAYOUT.firstRow, 2);
    assert.equal(COMMAND_SHEET_LAYOUT.lastRow, 4);
    assert.equal(COMMAND_SHEET_LAYOUT.nameCol, "C");
    assert.equal(COMMAND_SHEET_LAYOUT.examStartCol, "G");
    assert.equal(COMMAND_SHEET_LAYOUT.examEndCol, "T");
  });

  test("командиры подразделений стоят вверху своих листов и распознаются", () => {
    const tr = resolveLayout("Танковая рота");
    const ad = resolveLayout("Артиллерийский дивизион");

    // Рота: строки 7–8, дивизион: 9–10 — это ВЫШЕ overall.top листов
    assert.equal(UNIT_COMMAND_ROWS.TR.top, 7);
    assert.equal(UNIT_COMMAND_ROWS.TR.bottom, 8);
    assert.equal(UNIT_COMMAND_ROWS.AD.top, 9);
    assert.equal(UNIT_COMMAND_ROWS.AD.bottom, 10);
    assert.ok(UNIT_COMMAND_ROWS.TR.bottom < tr.overall.top);
    assert.ok(UNIT_COMMAND_ROWS.AD.bottom < ad.overall.top);

    assert.equal(isUnitCommandName(["Брюханов Е.Д."], "TR"), true);
    assert.equal(isUnitCommandName(["Осипов Г. А."], "TR"), true);
    assert.equal(isUnitCommandName(["Милорадович М.Н."], "AD"), true);
    assert.equal(isUnitCommandName(["Гриповский Д.А."], "AD"), true);
    // Чужой лист — не командование этого подразделения
    assert.equal(isUnitCommandName(["Брюханов Е.Д."], "AD"), false);
  });

  for (const name of COMMAND_CORPS_NAMES) {
    test(`«${name}» не пишется ни в «Вакант» ТР, ни в «Вакант» АД`, () => {
      assert.equal(isSheetCommandMember([name], "TR"), true);
      assert.equal(isSheetCommandMember([name], "AD"), true);
    });
  }

  test("командование распознаётся и по должности, а не только по ФИО", () => {
    assert.equal(isSheetCommandMember(["Петров П.П."], "TR", "Командир Корпуса"), true);
    assert.equal(isSheetCommandMember(["Петров П.П."], "TR", "Зам. Ком. Корпуса"), true);
    assert.equal(isSheetCommandMember(["Петров П.П."], "TR", "Наводчик"), false);
  });

  test("замы подразделений в «Вакант» не считаются командованием корпуса", () => {
    // Командир роты должен оставаться обычной строкой своего листа
    assert.equal(isCommandCorps(["Брюханов Е.Д."]), false);
    assert.equal(isCommandCorps(["Осипов Г.А."]), false);
  });

  test("сопоставление не зависит от точек и пробелов", () => {
    assert.equal(matchesCommandRoster(["Иванов К.М."], ["Иванов К. М."]), true);
    assert.equal(matchesCommandRoster(["Иванов  К М"], ["Иванов К. М."]), true);
    assert.equal(matchesCommandRoster(["Иванов К.Б."], ["Иванов К. М."]), false);
    assert.equal(matchesCommandRoster(["Любое"], []), false);
  });

  test("блоки очистки накрывают все секции «Вакант» листов", () => {
    const tr = COMMAND_CLEANUP_RANGES.TR;
    // Секции роты: КБМ 10–14, наводчики 16–22, мехводы 24–29, логисты 31–47
    for (const row of [10, 14, 16, 22, 24, 29, 31, 38, 39, 47]) {
      assert.ok(row >= tr.top && row <= tr.bottom, `строка ${row} вне блока очистки`);
    }
    // Дивизион: командиры 12/24, 1 ООВ 13–22, 2 ООВ 25–32, снабжение 34–42;
    // ниже 42-й начинается блок запаса и в очистку не входит
    const ad = COMMAND_CLEANUP_RANGES.AD;
    assert.equal(ad.bottom, 42);
    for (const row of [12, 13, 22, 24, 25, 32, 34, 42]) {
      assert.ok(row >= ad.top && row <= ad.bottom, `строка ${row} вне блока очистки`);
    }
    // Приписки «/резерв» в штатной должности больше нет
    assert.equal(COMMAND_CLEANUP_POST, "Логист-снабженец");
  });
});

describe("Steam ID в листе: без подписи «ID:»", () => {
  test("чистый SteamID64 остаётся без изменений", () => {
    assert.equal(cleanSteamIdForSheet("76561198000000001"), "76561198000000001");
  });

  test("префикс «ID:» снимается (жалоба: E42 у Юсупова в ТР)", () => {
    assert.equal(cleanSteamIdForSheet("ID: 76561198000000001"), "76561198000000001");
    assert.equal(cleanSteamIdForSheet("id:76561198000000001"), "76561198000000001");
    assert.equal(cleanSteamIdForSheet("Steam ID: 76561198000000001"), "76561198000000001");
    assert.equal(cleanSteamIdForSheet("  ID :  76561198000000001  "), "76561198000000001");
  });

  test("пустое значение остаётся пустым, формат STEAM_0 не ломается", () => {
    assert.equal(cleanSteamIdForSheet(""), "");
    assert.equal(cleanSteamIdForSheet(null), "");
    assert.equal(cleanSteamIdForSheet("STEAM_0:1:12345"), "STEAM_0:1:12345");
  });
});

describe("Геометрия листов по ТЗ", () => {
  test("у дивизиона блок запаса — строки 43–78, инфо-блоки ниже 80", () => {
    // С 43-й строки начинается «Запас | долгий отпуск»: активных бойцов туда
    // не пишем, поэтому нижняя граница секций листа — 42
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.deepEqual(ad.reserveBlock, { top: 43, bottom: 78 });
    assert.equal(ad.infoBlockTop, 80);
    assert.equal(SECTION_FILL_MAX.AD, 42);
  });

  test("у дивизиона ФИО в D, звание в C", () => {
    // Раскладка дивизиона: A пустая, B — синяя полоса, C — звание,
    // D — фамилия и инициалы, E — должность, F — Steam, G — Discord
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.equal(ad.nameCol, "D");
    assert.equal(columnIndexOf(ad.nameCol), 3);
    assert.deepEqual([...(ad.extraNameCols ?? [])], ["C"]);
    // Относительная арифметика: звание = nameCol-1 = C, должность = E,
    // Steam = F, Discord = G
    assert.equal(columnIndexOf("C"), columnIndexOf(ad.nameCol) - 1);
    assert.equal(columnIndexOf("E"), columnIndexOf(ad.nameCol) + 1);
    assert.equal(columnIndexOf("F"), columnIndexOf(ad.nameCol) + 2);
    assert.equal(columnIndexOf("G"), columnIndexOf(ad.nameCol) + 3);
  });

  test("чтение оценок дивизиона шире записи: до AI, запись до AG", () => {
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.equal(examBounds(ad).end, columnIndexOf("AG"));
    assert.equal(examReadBounds(ad).end, columnIndexOf("AI"));
  });

  test("у роты границы чтения и записи совпадают (H..AE)", () => {
    const tr = resolveLayout("Танковая рота");
    assert.deepEqual(examReadBounds(tr), examBounds(tr));
    assert.equal(tr.examEndCol, "AE");
  });

  test("лист «Запас»: шапка в строке 3, блок оценок I..AF, ФИО в D", () => {
    assert.equal(RESERVE_LAYOUT.headerRow, 3);
    assert.equal(RESERVE_LAYOUT.examStartCol, "I");
    assert.equal(RESERVE_LAYOUT.examEndCol, "AF");
    assert.equal(columnIndexOf(RESERVE_LAYOUT.examStartCol), 8);
    assert.equal(columnIndexOf(RESERVE_LAYOUT.examEndCol), 31);
    // D (индекс 3) обязан проверяться при поиске строки запаса
    assert.ok(RESERVE_LAYOUT.nameCols.includes(3));
  });

  test("диапазоны «Вакант» по умолчанию: ТР 31–47, АД 18–22", () => {
    assert.deepEqual(VACANT_FILL_RANGES.TR, { top: 31, bottom: 47 });
    assert.deepEqual(VACANT_FILL_RANGES.AD, { top: 18, bottom: 22 });
  });
});

/**
 * Секции «Вакант»: боец обязан вставать в свободную строку СВОЕЙ должности.
 *
 * Проверяются боевые константы и хелперы gsheets.ts: именно они решают, куда
 * уедет строка при зачислении и при переводе по рапорту.
 */
describe("Секции «Вакант» по должностям", () => {
  test("секции роты: КБМ, наводчики, мехводы, логисты — с должностями ТЗ", () => {
    const tr = resolveLayout("Танковая рота");
    assert.deepEqual(
      VACANT_SECTIONS.TR.map((s) => s.rows),
      [
        { top: 10, bottom: 14 },
        { top: 16, bottom: 22 },
        { top: 24, bottom: 29 },
        { top: 31, bottom: 47 },
      ]
    );
    assert.equal(findVacantSection(tr, "Командир Боевой Машины")?.key, "tr_bcm");
    assert.equal(findVacantSection(tr, "КБМ")?.key, "tr_bcm");
    assert.equal(findVacantSection(tr, "Специалист Наводчик-Оператор")?.key, "tr_gunner");
    assert.equal(findVacantSection(tr, "Специалист Мех.водитель")?.key, "tr_driver");
    // Должность с припиской «/резерв» тоже относится к логистам
    assert.equal(findVacantSection(tr, "Логист-снабженец/резерв")?.key, "tr_logist");
    assert.equal(findVacantSection(tr, "Курсант")?.key, "tr_logist");
  });

  test("секции дивизиона: командиры 12/24, 1 ООВ 13–22 (писать с 18), 2 ООВ 25–32, снабжение 34–42", () => {
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.deepEqual(
      VACANT_SECTIONS.AD.map((s) => s.rows),
      [
        { top: 12, bottom: 12 },
        { top: 13, bottom: 22 },
        { top: 24, bottom: 24 },
        { top: 25, bottom: 32 },
        { top: 34, bottom: 42 },
      ]
    );
    assert.equal(findVacantSection(ad, "Командир")?.key, "ad_commander_1");
    assert.equal(findVacantSection(ad, "Специалист - наводчик")?.key, "ad_gunner_1");
    assert.equal(findVacantSection(ad, "Логист-снабженец")?.key, "ad_supply");
    // Ни один диапазон не заходит в блок запаса (43+)
    for (const section of VACANT_SECTIONS.AD) {
      assert.ok(
        vacantFillRange(section).bottom <= SECTION_FILL_MAX.AD,
        `секция ${section.key} заходит в блок запаса`
      );
    }
  });

  test("наводчики дивизиона пишутся в «Вакант» строк 18–22, а не с 13-й", () => {
    const ad = resolveLayout("Артиллерийский дивизион");
    const gunner = VACANT_SECTIONS.AD.find((s) => s.key === "ad_gunner_1");
    assert.ok(gunner);
    assert.deepEqual(vacantFillRange(gunner), { top: 18, bottom: 22 });
  });

  test("строка листа сопоставляется со своей секцией", () => {
    const tr = resolveLayout("Танковая рота");
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.equal(sectionAtRow(tr, 12)?.key, "tr_bcm");
    assert.equal(sectionAtRow(tr, 19)?.key, "tr_gunner");
    assert.equal(sectionAtRow(tr, 26)?.key, "tr_driver");
    assert.equal(sectionAtRow(tr, 38)?.key, "tr_logist");
    assert.equal(sectionAtRow(tr, 48), null);
    assert.equal(sectionAtRow(ad, 12)?.key, "ad_commander_1");
    assert.equal(sectionAtRow(ad, 30)?.key, "ad_squad_2");
    assert.equal(sectionAtRow(ad, 43), null);
  });

  test("приписка «/резерв» снимается с должности активного бойца", () => {
    assert.equal(sanitizeSheetPost("Логист-снабженец/резерв"), "Логист-снабженец");
    assert.equal(sanitizeSheetPost("Логист-снабженец / резерв"), "Логист-снабженец");
    assert.equal(sanitizeSheetPost("Логист-снабженец (резерв)"), "Логист-снабженец");
    // Обычные должности не меняются
    assert.equal(sanitizeSheetPost("Специалист - наводчик"), "Специалист - наводчик");
    assert.equal(sanitizeSheetPost("Командир Боевой Машины"), "Командир Боевой Машины");
    assert.equal(sanitizeSheetPost(""), "");
    assert.equal(sanitizeSheetPost(null), "");
  });

  test("одна должность в нескольких блоках: «Командир» ищется в 12 и 24", () => {
    // У дивизиона командир 1-го отделения — строка 12, 2-го — строка 24.
    // Без объединения боец получал отказ, стоило занять одну из строк.
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.deepEqual(
      sectionsForPost(ad, "Командир").map((s) => s.rows),
      [
        { top: 12, bottom: 12 },
        { top: 24, bottom: 24 },
      ]
    );
    assert.deepEqual(vacantFillRangesForPost(ad, "Командир"), [
      { top: 12, bottom: 12 },
      { top: 24, bottom: 24 },
    ]);
    // Должность вне секций листа — пустой список (вызывающий берёт диапазон
    // по умолчанию), а не случайная чужая секция
    assert.deepEqual(vacantFillRangesForPost(ad, "Повар"), []);
  });

  test("Чапаев В.И. закреплён за секцией наводчиков роты", () => {
    // Ошибочно записан в логистах (строка 38), должен стоять в «Вакант»
    // наводчиков (19–22) с должностью «Специалист Наводчик-Оператор»
    const move = FORCED_SECTION_MOVES.TR.find((m) => m.name === "Чапаев В.И.");
    assert.ok(move, "нет правила переноса Чапаева В.И.");
    assert.equal(move.section, "tr_gunner");
    const gunner = VACANT_SECTIONS.TR.find((s) => s.key === move.section);
    assert.ok(gunner);
    assert.equal(gunner.post, "Специалист Наводчик-Оператор");
    assert.ok(19 >= gunner.rows.top && 19 <= gunner.rows.bottom);
  });
});

/**
 * Шрифт таблицы не должен сбиваться — это отдельное требование ТЗ
 * (эталон — оформление строки Юсупова). Проверка идёт по ИСХОДНИКУ модуля:
 * живой Google API в тестах недоступен, а именно код запросов определяет,
 * какие поля формата уедут в batchUpdate.
 */
describe("Оформление: меняется только заливка, не шрифт", () => {
  // Переводы строк нормализуются: файл в репозитории может быть с CRLF, и
  // поиск границ функции по "\n}\n" тогда не сработал бы (тест молча получал
  // обрезанный кусок и «проходил» по неверной причине).
  const source = readFileSync(path.join(process.cwd(), "src/lib/gsheets.ts"), "utf8").replace(
    /\r\n/g,
    "\n"
  );

  /**
   * Исходник без комментариев.
   *
   * Проверять код по тексту с комментариями нельзя: в модуле намеренно
   * объяснено, ОТКУДА взялся сбитый шрифт (там есть и «Times New Roman», и
   * «textFormat»), и такой тест падал бы на собственном объяснении.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  /** Тело функции от объявления до первой закрывающей скобки на нулевом уровне */
  function functionBody(anchor: string): string {
    const from = code.indexOf(anchor);
    if (from < 0) return "";
    const end = code.indexOf("\n}\n", from);
    return end < 0 ? code.slice(from) : code.slice(from, end + 2);
  }

  test("жёстко зашитого шрифта в коде модуля нет", () => {
    assert.equal(
      /Times New Roman/.test(code),
      false,
      "в gsheets.ts снова появился зашитый шрифт — он перезапишет оформление листа"
    );
    assert.equal(
      /\.textFormat\s*=/.test(code),
      false,
      "модуль присваивает textFormat ячейке: шрифт таблицы собьётся"
    );
    assert.equal(
      /applyStdFormat/.test(code),
      false,
      "вернулся хелпер принудительного формата ячеек"
    );
  });

  test("каждая заливка просит у Google только backgroundColor", () => {
    const body = functionBody("function fillRequest");
    assert.ok(body.length > 0, "функция fillRequest не найдена");
    assert.match(body, /fields:\s*"userEnteredFormat\.backgroundColor"/);
    // В запросе заливки не должно быть ни textFormat, ни других полей формата
    assert.equal(/textFormat/.test(body), false, "заливка тащит textFormat");
  });

  test("формат строки-образца не копируется (источник сбоя шрифта)", () => {
    const body = functionBody("async function applyRowFormat");
    assert.ok(body.length > 0, "функция applyRowFormat не найдена");
    // Сам запрос копирования формата, а не упоминание в комментарии
    assert.equal(
      /pasteType:\s*"PASTE_FORMAT"/.test(body),
      false,
      "вернулся copyPaste PASTE_FORMAT: оформление строки снова зависит от образца"
    );
    assert.match(body, /updateBorders/, "строка остаётся без границ");
    assert.match(body, /fillRequest/, "строка остаётся без заливки");
  });

  test("перенос строки не тащит textFormat и выравнивание", () => {
    const body = functionBody("export function copyRow");
    assert.ok(body.length > 0, "функция copyRow не найдена");
    assert.equal(/textFormat/.test(body), false, "copyRow снова переносит шрифт");
    assert.equal(
      /horizontalAlignment/.test(body),
      false,
      "copyRow снова переносит выравнивание"
    );
    // Заливка переносится: она несёт смысл (зелёные отметки экзаменов)
    assert.match(body, /backgroundColor/);
  });

  test("запись бойца не выставляет формат ячеек", () => {
    const body = functionBody("function writeSoldierRow");
    assert.ok(body.length > 0, "функция writeSoldierRow не найдена");
    assert.equal(/textFormat/.test(body), false, "writeSoldierRow меняет шрифт");
    assert.equal(
      /horizontalAlignment/.test(body),
      false,
      "writeSoldierRow меняет выравнивание"
    );
    // Steam ID пишется через нормализацию — без подписи «ID:»
    assert.match(body, /cleanSteamIdForSheet\(data\.steamId\)/);
  });
});

/**
 * Автоочистка ШДС при следующей синхронизации.
 *
 * Живой Google API в тестах недоступен, поэтому проверяется, что боевой код
 * синхронизации ВЫЗЫВАЕТ очистку и что очистка возвращает строку в «Вакант»
 * заданным ТЗ состоянием. Пропуск вызова — ровно та ошибка, из-за которой
 * строки 40/41 роты остались бы с замами корпуса.
 */
describe("Автоочистка ШДС при синхронизации", () => {
  const normalize = (text: string) => text.replace(/\r\n/g, "\n");
  const gsheetsSource = normalize(
    readFileSync(path.join(process.cwd(), "src/lib/gsheets.ts"), "utf8")
  );
  const schedulerSource = normalize(
    readFileSync(path.join(process.cwd(), "src/lib/sync-scheduler.ts"), "utf8")
  );

  /** Тело функции от объявления до закрывающей скобки на нулевом уровне */
  function bodyOf(anchor: string): string {
    const from = gsheetsSource.indexOf(anchor);
    if (from < 0) return "";
    const end = gsheetsSource.indexOf("\n}\n", from);
    return end < 0 ? gsheetsSource.slice(from) : gsheetsSource.slice(from, end + 2);
  }

  test("синхронизация вызывает очистку ДО автозаписи в «Вакант»", () => {
    // Иначе строки командования успели бы попасть в отчёт как действующий состав
    const repairAt = schedulerSource.indexOf("await repairShdsSheets()");
    const ensureAt = schedulerSource.indexOf("await ensureMembersInShds(entries)");
    assert.ok(repairAt > 0, "syncShdsRoster не вызывает repairShdsSheets");
    assert.ok(ensureAt > 0, "syncShdsRoster не вызывает ensureMembersInShds");
    assert.ok(repairAt < ensureAt, "очистка идёт после автозаписи — порядок неверен");
    // Каждый шаг изолирован: ошибка очистки не отменяет синхронизацию
    assert.match(schedulerSource, /repair\.warnings/);
  });

  test("очистка возвращает строку в состояние «Вакант» по ТЗ", () => {
    const body = bodyOf("async function clearRowToVacant");
    assert.ok(body.length > 0, "функция clearRowToVacant не найдена");
    // Звание «Рядовой», ФИО «Вакант», пустые Steam и Discord
    assert.match(body, /DEFAULT_SHEET_RANK/);
    assert.match(body, /"Вакант"/);
    assert.match(body, /steamCol\)\.value\s*=\s*""/);
    assert.match(body, /discordCol\)\.value\s*=\s*""/);
    // Белая заливка имени вместо зелёной
    assert.match(body, /VACANT_WHITE/);
  });

  test("должность очищенной строки — штатная должность её секции", () => {
    const body = bodyOf("export async function repairShdsSheets");
    assert.ok(body.length > 0, "функция repairShdsSheets не найдена");
    // У секций разные должности (КБМ, наводчик, мехвод, логист), поэтому
    // подставляется должность СЕКЦИИ строки, а общий текст — только резерв
    assert.match(body, /defaultPostFor\(layout, row\)/);
    assert.match(body, /COMMAND_CLEANUP_POST/);
    assert.match(body, /clearRowToVacant\(/);
  });

  test("очистка возвращает строку в состояние «Вакант» и приводит должности", () => {
    const body = bodyOf("export async function repairShdsSheets");
    assert.ok(body.length > 0, "функция repairShdsSheets не найдена");
    // 3) снятие «/резерв» у активного бойца (Соколов Д.О.)
    assert.match(body, /sanitizeSheetPost\(post\)/);
    assert.match(body, /postsFixed\.push/);
    // 4) принудительный перенос в свою секцию (Чапаев В.И.)
    assert.match(body, /FORCED_SECTION_MOVES\[layout\.key\]/);
    assert.match(body, /moved\.push/);
    // Переход в собственную секцию не должен пробивать границу запаса
    assert.match(body, /SECTION_FILL_MAX\[layout\.key\]/);
  });

  test("префикс «ID:» снимается при очистке (строка E42 роты)", () => {
    const body = bodyOf("export async function repairShdsSheets");
    assert.ok(body.length > 0, "функция repairShdsSheets не найдена");
    assert.match(body, /cleanSteamIdForSheet\(raw\)/);
    assert.match(body, /steamFixed\.push/);
  });

  test("фильтр командования стоит до поиска строки и до записи", () => {
    const body = bodyOf("export async function ensureMembersInShds");
    assert.ok(body.length > 0, "функция ensureMembersInShds не найдена");
    const guardAt = body.indexOf("isSheetCommandMember(names, layout.key, entry.post)");
    const writeAt = body.indexOf("writeSoldierRow(sheet, layout, target");
    assert.ok(guardAt > 0, "в автозаписи нет фильтра командования");
    assert.ok(writeAt > 0 && guardAt < writeAt, "фильтр командования стоит после записи");
  });

  test("командиры подразделений ищутся с первой строки листа", () => {
    // Строки 7–8 (ТР) и 9–10 (АД) выше overall.top: поиск обязан их видеть
    const body = bodyOf("export async function ensureMembersInShds");
    assert.match(body, /findNamedRows\(sheet, nameColumns, names, SEARCH_TOP_ROW/);
    // И синхронизация званий читает с первой строки, а не с overall.top
    assert.match(schedulerSource, /SHEET_SEARCH_TOP_ROW/);
  });
});
