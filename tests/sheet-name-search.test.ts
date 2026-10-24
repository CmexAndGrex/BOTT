/**
 * Поиск строки бойца на листе ШДС (findNameRow).
 *
 * Проверяется БОЕВОЙ модуль src/lib/gsheets.ts на подставном листе: настоящий
 * Google API в тестах недоступен, а «фейковый лист» повторяет только те методы,
 * которые вызывает поиск (`getCell`) — ровно как библиотека google-spreadsheet
 * (строка и колонка 0-based, незагруженная ячейка бросает исключение).
 *
 * Почему это важно: ошибка «Боец Розгов А.В. не найден на листе
 * «Артиллерийский дивизион»» блокировала рапорт на смену должности. Причины,
 * которые здесь зафиксированы:
 *   * поиск шёл только по колонке C, а имя могло оказаться в B;
 *   * строки выше overall.top (командование) вообще не читались;
 *   * «А. В.» и «А.В», латинская «A» и неразрывный пробел не совпадали.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findNameRow, resolveLayout } from "@/lib/gsheets.ts";

/** Колонка по индексу (0 → A) — своя копия, чтобы не зависеть от экспортов */
function colLetter(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Подставной лист: значения задаются адресами («B12» → текст).
 *
 * Ведёт себя как google-spreadsheet v5: `getCell` бросает на выходе за границы
 * и на ячейке, которую не загружали. «Загружены» здесь колонки A..G и строки
 * до лимита `loadedRows` — поиск обязан пережить обращение вне этого диапазона.
 */
function fakeSheet(
  values: Record<string, string>,
  options: { rowCount?: number; columnCount?: number; loadedRows?: number } = {}
) {
  const { rowCount = 120, columnCount = 40, loadedRows = 120 } = options;
  return {
    title: "Артиллерийский дивизион",
    rowCount,
    columnCount,
    getCell(row: number, col: number) {
      if (row < 0 || col < 0) throw new Error("Min coordinate is 0, 0");
      if (row >= rowCount || col >= columnCount) {
        throw new Error(`Out of bounds, sheet is ${rowCount} by ${columnCount}`);
      }
      if (row >= loadedRows || col > 6) {
        throw new Error("This cell has not been loaded yet");
      }
      const address = `${colLetter(col)}${row + 1}`;
      return { value: values[address] ?? undefined };
    },
  };
}

/** Раскладка дивизиона: таблица участников начинается с 12-й строки */
const AD = resolveLayout("Артиллерийский дивизион");

describe("findNameRow — колонки ФИО", () => {
  test("боец находится в колонке D (по ТЗ дивизиона)", () => {
    // Геометрия дивизиона: A пустая, B — синяя полоса, C — звание,
    // D — фамилия и инициалы, E — должность, F — Steam, G — Discord
    assert.equal(AD.nameCol, "D");
    const sheet = fakeSheet({ D12: "Розгов А.В." });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 12);
  });

  test("имя в колонке C тоже находится: строку сдвинули руками", () => {
    const sheet = fakeSheet({ C15: "Розгов А.В.", D15: "Специалист - наводчик" });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 15);
  });

  test("колонка ФИО определяется по заголовку «Фамилия» в шапке", () => {
    // Шапка называет ФИО колонкой D, и имена действительно лежат в D
    const sheet = fakeSheet({ D4: "Фамилия", D15: "Розгов А.В." });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 15);
  });

  test("звание в колонке C бойцом не считается, если он есть в D", () => {
    // C12 — звание, D12 — фамилия: поиск обязан вернуть строку по D
    const sheet = fakeSheet({ C12: "Рядовой", D12: "Розгов А.В." });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 12);
  });

  test("слово «Фамилия» в служебной колонке A не сбивает поиск", () => {
    const sheet = fakeSheet({
      A2: "Штатно-должностной список: фамилия, звание, должность",
      D12: "Розгов А.В.",
    });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 12);
  });
});

describe("findNameRow — терпимость к написанию", () => {
  test("пробел между инициалами не мешает", () => {
    const sheet = fakeSheet({ C12: "Милорадович М. Н." });
    assert.equal(findNameRow(sheet as never, AD, "Милорадович М.Н."), 12);
  });

  test("неразрывный пробел из Google Таблиц не мешает", () => {
    const sheet = fakeSheet({ C12: "Розгов\u00A0А.В." });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 12);
  });

  test("латинская «A» в инициалах не мешает", () => {
    const sheet = fakeSheet({ C12: "Розгов A.В." });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 12);
  });

  test("пропущенная точка в инициалах не мешает", () => {
    const sheet = fakeSheet({ C12: "Розгов А В" });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 12);
  });

  test("пометка в скобках не мешает, но не перебивает точную запись", () => {
    const withNote = fakeSheet({ C20: "Розгов А.В. (отпуск)" });
    assert.equal(findNameRow(withNote as never, AD, "Розгов А.В."), 20);

    const both = fakeSheet({ C20: "Розгов А.В. (отпуск)", C25: "Розгов А.В." });
    assert.equal(findNameRow(both as never, AD, "Розгов А.В."), 25);
  });

  test("похожие ФИО не склеиваются", () => {
    const sheet = fakeSheet({ C12: "Розгов И.В." });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), null);
  });

  test("«Вакант» бойцом не считается", () => {
    const sheet = fakeSheet({ C14: "Вакант" });
    assert.equal(findNameRow(sheet as never, AD, "Вакант"), null);
  });
});

describe("findNameRow — диапазон строк", () => {
  test("боец из командования (выше overall.top) находится", () => {
    // overall.top у дивизиона = 12, командование — строки 1–11. До правки
    // поиск начинался с 12 и отвечал «не найден»
    assert.equal(AD.overall.top, 12);
    const sheet = fakeSheet({ C5: "Розгов А.В.", D5: "Командование дивизиона" });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 5);
  });

  test("боец ниже прежней границы 41 находится", () => {
    const sheet = fakeSheet({ C90: "Розгов А.В." });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 90);
  });

  test("незагруженные строки не роняют поиск", () => {
    // Читалась только область участников: обращение к остальным строкам
    // бросает «This cell has not been loaded yet» — поиск должен это пережить
    const sheet = fakeSheet({ C12: "Розгов А.В." }, { loadedRows: 20 });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В."), 12);
  });

  test("исключённая строка не возвращается", () => {
    const sheet = fakeSheet({ C12: "Розгов А.В." });
    assert.equal(findNameRow(sheet as never, AD, "Розгов А.В.", 12), null);
  });
});
