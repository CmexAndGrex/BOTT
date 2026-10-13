/**
 * Снапшот строки бойца при переводе в запас.
 *
 * Проверяем БОЕВЫЕ модули (src/lib/gsheets.ts, src/lib/reserve.ts), а не копию
 * правил в тесте: если границы снапшота или координаты служебных колонок
 * изменят, тест это поймает.
 *
 * Зачем вообще: прежний снапшот копировал строку только до колонки T, и
 * отметки правее (уставы, ПВО, БПЛА, береты) у бойца пропадали — он возвращался
 * из запаса с пустым хвостом блока оценок.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FULL_ROW_COL_COUNT,
  FULL_ROW_END_COL,
  FULL_ROW_END_INDEX,
  columnIndexOf,
  resolveLayout,
} from "@/lib/gsheets.ts";
import { metaColumnsForWidth } from "@/lib/reserve.ts";

describe("Снапшот строки бойца: границы A..AG", () => {
  test("правая граница снапшота — колонка AG (33 колонки)", () => {
    assert.equal(FULL_ROW_END_COL, "AG");
    assert.equal(FULL_ROW_END_INDEX, 32);
    assert.equal(FULL_ROW_COL_COUNT, 33);
    assert.equal(columnIndexOf(FULL_ROW_END_COL), FULL_ROW_END_INDEX);
  });

  test("снапшот шире блока оценок у роты: хвост не обрезается", () => {
    // У роты оценки кончаются на «AE» (индекс 30), у дивизиона — на «AG» (32).
    // Снапшот обязан доходить до «AG» у ОБОИХ листов: иначе у роты терялись
    // последние два норматива (уставы, ПВО, БПЛА, береты).
    const tr = resolveLayout("Танковая рота");
    const ad = resolveLayout("Артиллерийский дивизион");
    assert.equal(tr.examEndCol, "AE");
    assert.equal(ad.examEndCol, "AG");
    assert.ok(
      FULL_ROW_END_INDEX > columnIndexOf(tr.examEndCol),
      "снапшот роты не покрывает хвост блока оценок"
    );
    assert.equal(FULL_ROW_END_INDEX, columnIndexOf(ad.examEndCol));
  });

  test("снапшот не доходит до служебных колонок AH..AJ", () => {
    // Колонки метаданных листа «Запас» лежат ПРАВЕЕ снапшота: накрытие их
    // строкой бойца затирало бы подразделение и роли, и возврат из запаса
    // терял бы и то, и другое.
    assert.ok(FULL_ROW_END_INDEX < 33, "AH (33) должна быть правее снапшота");
  });
});

describe("Лист «Запас»: колонки метаданных по ширине строки", () => {
  test("новая строка (снапшот A..AG + AH) читается из AH..AJ", () => {
    const meta = metaColumnsForWidth(34);
    assert.deepEqual(meta, { unit: 33, roles: 34, date: 35 });
  });

  test("старая строка (снапшот A–T) читается из U..W", () => {
    // Обратная совместимость: строки, положенные до расширения снапшота,
    // никто не переносит руками — их служебные данные остались в U–W.
    for (const width of [20, 21, 22, 23, 33]) {
      assert.deepEqual(
        metaColumnsForWidth(width),
        { unit: 20, roles: 21, date: 22 },
        `ширина ${width} должна читаться по старому формату`
      );
    }
  });

  test("пустая строка не считается строкой нового формата", () => {
    assert.deepEqual(metaColumnsForWidth(0), { unit: 20, roles: 21, date: 22 });
  });

  test("порог переключения — ровно колонка AH", () => {
    assert.deepEqual(metaColumnsForWidth(33), { unit: 20, roles: 21, date: 22 });
    assert.deepEqual(metaColumnsForWidth(34), { unit: 33, roles: 34, date: 35 });
  });
});