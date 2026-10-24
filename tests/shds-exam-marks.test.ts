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
import {
  COMMAND_CORPS_NAMES,
  PASS_MARK,
  RESERVE_LAYOUT,
  VACANT_FILL_RANGES,
  isCommandCorps,
  parseExamMark,
  resolveExamRubric,
  resolveLayout,
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

describe("Геометрия листов по ТЗ", () => {
  test("у дивизиона блок запаса — строки 44–78, инфо-блоки ниже 80", () => {
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.deepEqual(ad.reserveBlock, { top: 44, bottom: 78 });
    assert.equal(ad.infoBlockTop, 80);
  });

  test("у дивизиона ФИО ищется и в C, и в D", () => {
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.equal(ad.nameCol, "C");
    assert.deepEqual([...(ad.extraNameCols ?? [])], ["D"]);
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

  test("диапазоны «Вакант» для автозаписи: ТР 36–41, АД 18–22", () => {
    assert.deepEqual(VACANT_FILL_RANGES.TR, { top: 36, bottom: 41 });
    assert.deepEqual(VACANT_FILL_RANGES.AD, { top: 18, bottom: 22 });
  });
});
