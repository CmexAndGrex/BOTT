/**
 * Тесты сопоставления экзаменов из заявки со столбцами шапки листа ШДС.
 *
 * Почему это критично: названия экзаменов в форме выбираются флажками, и Google
 * склеивает их через запятую. Если название САМО содержит запятую
 * («Снаряжение, обслуживание техники»), заявка разъезжается на куски и раньше
 * падала с ошибкой «Столбцы экзаменов не найдены».
 *
 * Заголовки в тестах — реальные, скопированы из шапки тестовой таблицы ШДС
 * (лист «Танковая рота», строка 6, и «Артиллерийский дивизион», строка 8).
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchExamColumns } from "@/lib/gsheets.ts";

/** Шапка «Танковая рота» (реальные названия столбцов листа) */
const TR_HEADERS = [
  "Звание",
  "Фамилии, инициалы",
  "Должность",
  "Steam ID",
  "Discord ID",
  "Для пометок",
  "КМБТ",
  "Снаряжение, обслуживание техники",
  "Огневая подготовка",
  "ТТХ (Часть 1)",
  "Физ. Подготовка",
  "ПМП",
  "Езда в сложно-проходимых условиях",
  "Сдача на Мех. Водителя",
  "ТТХ (Часть 2)",
  "Тактическая Подготовка",
  "Техника АТК",
  "Учебные стрельбы",
  "Устав АТК",
];

/** Шапка «Артиллерийский дивизион» */
const AD_HEADERS = [
  "Звание",
  "Фамилии, инициалы",
  "Должность",
  "Steam ID",
  "Discord ID",
  "Заметки",
  "КМБТ",
  "Физ. Подготовка",
  "ТТХ (минометы)",
  "Миномётное дело (обучение)",
  "Прохождение теста по теории",
  "Миномётное дело (Экзамен)",
  "ПМП",
  "Снаряжение и обслуживание техники",
  "ТТХ (ствольная артиллерия)",
  "Управление гусеничной техникой",
  "Сдача на мехвода",
  "Устав АТК",
];

/** Названия столбцов, найденных по индексам */
const titlesOf = (headers: string[], columns: number[]) => columns.map((c) => headers[c]);

describe("matchExamColumns — простые случаи", () => {
  test("один экзамен находится по точному названию", () => {
    const r = matchExamColumns(TR_HEADERS, ["Огневая подготовка"]);
    assert.deepEqual(titlesOf(TR_HEADERS, r.columns), ["Огневая подготовка"]);
    assert.deepEqual(r.unmatched, []);
  });

  test("несколько экзаменов находятся все", () => {
    const r = matchExamColumns(TR_HEADERS, ["КМБТ", "ПМП", "Устав АТК"]);
    assert.deepEqual(titlesOf(TR_HEADERS, r.columns), ["КМБТ", "ПМП", "Устав АТК"]);
    assert.deepEqual(r.unmatched, []);
  });

  test("порядок в заявке не важен — столбцы возвращаются в порядке шапки", () => {
    const r = matchExamColumns(TR_HEADERS, ["Устав АТК", "КМБТ", "ПМП"]);
    assert.deepEqual(titlesOf(TR_HEADERS, r.columns), ["КМБТ", "ПМП", "Устав АТК"]);
  });

  test("регистр не важен", () => {
    const r = matchExamColumns(TR_HEADERS, ["огневая ПОДГОТОВКА"]);
    assert.deepEqual(titlesOf(TR_HEADERS, r.columns), ["Огневая подготовка"]);
  });

  test("лишние пробелы по краям и внутри не мешают", () => {
    const r = matchExamColumns(TR_HEADERS, ["  Огневая   подготовка  "]);
    assert.deepEqual(titlesOf(TR_HEADERS, r.columns), ["Огневая подготовка"]);
  });
});

describe("matchExamColumns — экзамен с запятой внутри названия (главный кейс)", () => {
  test("«Снаряжение, обслуживание техники» находится, когда форма отдала два куска", () => {
    // Так выглядит требование после разбора заявки: parseRequestText делит
    // «Сданные экзамены» по запятой, и одно название превращается в два куска.
    const r = matchExamColumns(TR_HEADERS, ["Снаряжение", "обслуживание техники"]);
    assert.deepEqual(titlesOf(TR_HEADERS, r.columns), ["Снаряжение, обслуживание техники"]);
    assert.deepEqual(r.unmatched, []);
  });

  test("составное название распознаётся и вместе с другими экзаменами", () => {
    const r = matchExamColumns(TR_HEADERS, [
      "КМБТ",
      "Снаряжение",
      "обслуживание техники",
      "ПМП",
    ]);
    assert.deepEqual(titlesOf(TR_HEADERS, r.columns), [
      "КМБТ",
      "Снаряжение, обслуживание техники",
      "ПМП",
    ]);
    assert.deepEqual(r.unmatched, []);
  });

  test("у АД похожее название (через «и») тоже находится", () => {
    const r = matchExamColumns(AD_HEADERS, ["Снаряжение и обслуживание техники"]);
    assert.deepEqual(titlesOf(AD_HEADERS, r.columns), ["Снаряжение и обслуживание техники"]);
  });

  test("оба похожих названия в одной шапке не путаются между собой", () => {
    const headers = ["Снаряжение", "Снаряжение, обслуживание техники"];
    const r = matchExamColumns(headers, ["Снаряжение", "обслуживание техники"]);
    // Составное название «съедает» оба куска и не даёт закрасить одиночный столбец
    assert.deepEqual(titlesOf(headers, r.columns), ["Снаряжение, обслуживание техники"]);
    assert.deepEqual(r.unmatched, []);
  });

  test("одиночный «Снаряжение» закрашивает одиночный столбец", () => {
    const headers = ["Снаряжение", "Снаряжение, обслуживание техники"];
    const r = matchExamColumns(headers, ["Снаряжение"]);
    assert.deepEqual(titlesOf(headers, r.columns), ["Снаряжение"]);
  });
});

describe("matchExamColumns — устойчивость к формату", () => {
  test("«ё» и «е» считаются одним и тем же", () => {
    const r = matchExamColumns(AD_HEADERS, ["Минометное дело (обучение)"]);
    assert.deepEqual(titlesOf(AD_HEADERS, r.columns), ["Миномётное дело (обучение)"]);
  });

  test("неразрывный пробел в шапке не мешает", () => {
    const headers = ["Огневая\u00A0подготовка"];
    const r = matchExamColumns(headers, ["Огневая подготовка"]);
    assert.deepEqual(r.columns, [0]);
  });

  test("лишняя запятая в шапке («а , б») обрабатывается", () => {
    const headers = ["Снаряжение , обслуживание техники"];
    const r = matchExamColumns(headers, ["Снаряжение", "обслуживание техники"]);
    assert.deepEqual(r.columns, [0]);
  });

  test("пустые столбцы шапки игнорируются", () => {
    const headers = ["", "  ", "КМБТ"];
    const r = matchExamColumns(headers, ["КМБТ"]);
    assert.deepEqual(r.columns, [2]);
  });
});

describe("matchExamColumns — ошибки и защита от дублей", () => {
  test("неизвестный экзамен попадает в unmatched (а не молча теряется)", () => {
    const r = matchExamColumns(TR_HEADERS, ["Огневая подготовка", "Экзамен-призрак"]);
    assert.deepEqual(titlesOf(TR_HEADERS, r.columns), ["Огневая подготовка"]);
    assert.deepEqual(r.unmatched, ["Экзамен-призрак"]);
  });

  test("ничего не найдено — пустой список столбцов и все куски в unmatched", () => {
    const r = matchExamColumns(TR_HEADERS, ["Нет такого", "И такого тоже"]);
    assert.deepEqual(r.columns, []);
    assert.deepEqual(r.unmatched, ["Нет такого", "И такого тоже"]);
  });

  test("один экзамен не закрашивает столбец дважды", () => {
    const r = matchExamColumns(TR_HEADERS, ["КМБТ"]);
    assert.equal(r.columns.length, 1);
  });

  test("повтор того же экзамена в заявке не создаёт дубль столбца", () => {
    const r = matchExamColumns(TR_HEADERS, ["КМБТ", "КМБТ"]);
    assert.equal(r.columns.length, 1);
    // второй кусок остаётся неиспользованным — это честно видно в unmatched
    assert.deepEqual(r.unmatched, ["КМБТ"]);
  });

  test("пустой запрос — пустой результат, без исключений", () => {
    const r = matchExamColumns(TR_HEADERS, []);
    assert.deepEqual(r.columns, []);
    assert.deepEqual(r.unmatched, []);
  });

  test("пустая шапка — все куски в unmatched, без исключений", () => {
    const r = matchExamColumns([], ["КМБТ"]);
    assert.deepEqual(r.columns, []);
    assert.deepEqual(r.unmatched, ["КМБТ"]);
  });
});