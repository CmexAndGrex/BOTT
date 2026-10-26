/**
 * Матчинг ФИО при автозасеве часов за октябрь 2026.
 *
 * Причина появления теста — живой баг: часы из эталонных отчётов заполнились
 * только у 9 бойцов из 37. Ключ сравнения оставлял пробелы значимыми, поэтому
 * «Добролюбов Е.Д.» из базы и «Добролюбов Е Д» из отчёта давали разные ключи,
 * и в «Учёте онлайна» у 28 бойцов стояли прочерки.
 *
 * Проверяется боевой модуль src/lib/seed-official-reports.ts, а не копия
 * правила в тесте: если нормализация изменится в src/, тест упадёт.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeFighterName,
  OFFICIAL_REPORTS,
} from "../src/lib/seed-official-reports.ts";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("normalizeFighterName: жёсткий ключ ФИО", () => {
  test("инициалы с точками, с пробелами и без — один ключ", () => {
    const expected = "добролюбовед";
    for (const variant of [
      "Добролюбов Е.Д.",
      "Добролюбов Е. Д.",
      "Добролюбов Е Д",
      "Добролюбов Е.Д",
      "добролюбов е.д",
      "  Добролюбов   Е.Д.  ",
      "Добролюбов\u00A0Е.Д.",
    ]) {
      assert.equal(normalizeFighterName(variant), expected, `вариант «${variant}»`);
    }
  });

  test("«ё» приводится к «е», регистр не важен", () => {
    assert.equal(normalizeFighterName("СОКОЛОВ Д.О."), normalizeFighterName("Соколов Д.О."));
    assert.equal(normalizeFighterName("Королёв А.В."), normalizeFighterName("Королев А.В."));
  });

  test("спецсимволы и разделители удаляются", () => {
    assert.equal(normalizeFighterName("Сопрано-А.Д."), "сопраноад");
    assert.equal(normalizeFighterName("[ATK] Иванов К.М."), "atkивановкм");
    assert.equal(normalizeFighterName("Юсупов М.А.*"), "юсуповма");
  });

  test("пустое значение даёт пустой ключ", () => {
    assert.equal(normalizeFighterName(null), "");
    assert.equal(normalizeFighterName(undefined), "");
    assert.equal(normalizeFighterName(""), "");
    assert.equal(normalizeFighterName("   "), "");
  });
});

describe("Эталонные отчёты сопоставимы с ФИО в базе", () => {
  /**
   * Имена в том виде, в каком они лежат в division_members: у части бойцов
   * инициалы записаны с пробелами, у части слитно и без финальной точки.
   * Именно это расхождение и ломало матчинг.
   */
  const DB_NAMES = [
    "Акулова Д.В.",
    "Брюханов Е. Д.",
    "Вакутагин И.И.",
    "Вамилов И.В.",
    "Волков Д. В.",
    "Гагарин М.А.",
    "Гриповский Д.А.",
    "Добролюбов Е.Д.",
    "Жилин Н.Р.",
    "Зеленко Я.В.",
    "Иванов И.А",
    "Иванов К.М.",
    "Кайзер К.И.",
    "Коренков К.А.",
    "Кравчук В.Ю.",
    "Леонидов Г.А.",
    "Майлазин А.С.",
    "Макаров Е.А.",
    "Милорадович М.Н.",
    "Мутагенов И. С.",
    "Омельченко А.А.",
    "Осипов Г.А.",
    "Петрович А.Е.",
    "Пряник В.С.",
    "Реборн К.В.",
    "Рожков В.А.",
    "Розгов А.В.",
    "Романов А.В.",
    "Сильвестр К.Д.",
    "Снежный П.С.",
    "Соколов Д.О.",
    "Сопрано А.Д.",
    "Союзнов Ю.П.",
    "Чапаев В.И.",
    "Шевчик В.Д.",
    "Эпов С.А.",
    "Юсупов М.А.",
  ];

  test("все 37 бойцов из отчётов находят свою карточку в составе", () => {
    const dbIndex = new Map<string, string>();
    for (const name of DB_NAMES) dbIndex.set(normalizeFighterName(name), name);

    const unmatched = OFFICIAL_REPORTS.filter(
      (entry) => !dbIndex.has(normalizeFighterName(entry.name))
    ).map((entry) => entry.name);

    assert.deepEqual(
      unmatched,
      [],
      `не сопоставлены с составом: ${unmatched.join(", ")}`
    );
    assert.equal(OFFICIAL_REPORTS.length, 37, "изменилось число записей в отчёте");
    assert.equal(DB_NAMES.length, 37, "изменилось число карточек в тестовом составе");
  });

  test("однофамильцы не склеиваются в один ключ", () => {
    assert.notEqual(normalizeFighterName("Иванов И.А"), normalizeFighterName("Иванов К.М."));
    const keys = OFFICIAL_REPORTS.map((entry) => normalizeFighterName(entry.name));
    assert.equal(new Set(keys).size, keys.length, "в отчёте есть склеенные ключи ФИО");
  });
});

describe("Автозасев выполняется до чтения часов", () => {
  const source = () => read("src/app/api/control/route.ts");

  test("/api/control дожидается записи weekly_stats", () => {
    const text = source();
    // Раньше стояло seedOfficialOnlineReports().catch(...) — засев уходил в фон,
    // и первый запрос страницы рисовал прочерки во всех неделях.
    assert.match(text, /await\s+seedOfficialOnlineReports\(\)/, "засев не дожидается завершения");
    assert.equal(
      /seedOfficialOnlineReports\(\)\s*\n?\s*\.catch/.test(text),
      false,
      "вернулся фоновый запуск засева без ожидания"
    );
  });

  test("ошибка засева не роняет страницу «Контроль»", () => {
    assert.match(source(), /catch\s*\(seedError\)/, "исключение засева не перехвачено");
  });
});
