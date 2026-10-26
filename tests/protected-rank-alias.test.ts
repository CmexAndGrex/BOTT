/**
 * Алиасы званий в сверке ролей.
 *
 * Живой баг: звание «Старший лейтенант» (так его пишут в приказах) не
 * распознавалось — в справочнике ролей оно записано как «Ст. Лейтенант». Сверка
 * сообщала «для звания роли на сервере нет», и боец оставался без роли звания.
 *
 * Проверяется боевой parseRank из src/lib/role-sync.ts, а не копия правила.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRank } from "../src/lib/role-sync.ts";

describe("parseRank: развёрнутые написания званий", () => {
  test("«Старший лейтенант» приводится к каноническому «Ст. Лейтенант»", () => {
    assert.deepEqual(parseRank("Старший лейтенант"), { rank: "Ст. Лейтенант", subdiv: null });
    assert.deepEqual(parseRank("старший лейтенант"), { rank: "Ст. Лейтенант", subdiv: null });
  });

  test("сокращённые написания тоже распознаются", () => {
    assert.deepEqual(parseRank("Ст. Лейтенант"), { rank: "Ст. Лейтенант", subdiv: null });
    assert.deepEqual(parseRank("ст.лейтенант"), { rank: "Ст. Лейтенант", subdiv: null });
  });

  test("подразделение отделяется от развёрнутого звания", () => {
    assert.deepEqual(parseRank("Старший лейтенант ТР"), {
      rank: "Ст. Лейтенант",
      subdiv: "ТР",
    });
  });

  test("прочие развёрнутые написания", () => {
    assert.equal(parseRank("Старший прапорщик").rank, "Ст. Прапорщик");
    assert.equal(parseRank("Старший сержант").rank, "Ст. Сержант");
    assert.equal(parseRank("Младший сержант").rank, "Мл. Сержант");
  });

  test("неизвестное звание не подменяется «первым похожим»", () => {
    assert.deepEqual(parseRank("Генерал-майор"), { rank: null, subdiv: null });
    assert.deepEqual(parseRank(""), { rank: null, subdiv: null });
    assert.deepEqual(parseRank(null), { rank: null, subdiv: null });
  });
});
