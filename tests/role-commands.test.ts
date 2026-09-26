/**
 * Тесты запросов ролей: разбор команд «Выдать / Снять» и составных званий.
 *
 * Проверяется боевой модуль src/lib/roles.ts. Это самая опасная часть бота:
 * ошибка здесь означает выдачу не той роли не тому человеку.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseRoleCommand,
  parseRoleRequest,
  RANK_ROLE_IDS,
  SUBDIV_ROLE_IDS,
  COMMON_ROLE_IDS,
  CLAN_ROLE_IDS,
} from "@/lib/roles.ts";

describe("parseRoleCommand — простые команды", () => {
  test("одна роль на выдачу", () => {
    assert.deepEqual(parseRoleCommand("Выдать Игроман"), [
      { action: "give", name: "Игроман" },
    ]);
  });

  test("одна роль на снятие", () => {
    assert.deepEqual(parseRoleCommand("Снять Друг АТК"), [
      { action: "remove", name: "Друг АТК" },
    ]);
  });

  test("регистр слов-действий не важен", () => {
    assert.deepEqual(parseRoleCommand("выдать Игроман"), [
      { action: "give", name: "Игроман" },
    ]);
    assert.deepEqual(parseRoleCommand("СНЯТЬ Игроман"), [
      { action: "remove", name: "Игроман" },
    ]);
  });

  test("несколько ролей через запятую наследуют действие", () => {
    // «Игроман, Игломан2, Снять Друг АТК» — первые две выдаём, третью снимаем
    assert.deepEqual(parseRoleCommand("Выдать Игроман, Игломан2, Снять Друг АТК"), [
      { action: "give", name: "Игроман" },
      { action: "give", name: "Игломан2" },
      { action: "remove", name: "Друг АТК" },
    ]);
  });

  test("действие можно переключать несколько раз", () => {
    assert.deepEqual(parseRoleCommand("Выдать Роль1, Снять Роль2, Выдать Роль3"), [
      { action: "give", name: "Роль1" },
      { action: "remove", name: "Роль2" },
      { action: "give", name: "Роль3" },
    ]);
  });

  test("слово «роль» перед именем отбрасывается", () => {
    assert.deepEqual(parseRoleCommand("Выдать роль Игроман"), [
      { action: "give", name: "Игроман" },
    ]);
  });

  test("без слова-действия первая роль выдаётся по умолчанию", () => {
    assert.deepEqual(parseRoleCommand("Игроман"), [{ action: "give", name: "Игроман" }]);
  });

  test("пустые сегменты (лишние запятые) пропускаются", () => {
    assert.deepEqual(parseRoleCommand("Выдать Игроман,, Снять Друг АТК,"), [
      { action: "give", name: "Игроман" },
      { action: "remove", name: "Друг АТК" },
    ]);
  });

  test("пустая строка — пустой список операций", () => {
    assert.deepEqual(parseRoleCommand(""), []);
    assert.deepEqual(parseRoleCommand("   "), []);
  });

  test("составное звание сохраняется целиком (комплект собирает applyRoleCommand)", () => {
    assert.deepEqual(parseRoleCommand("Выдать Капитан ТР"), [
      { action: "give", name: "Капитан ТР" },
    ]);
    assert.deepEqual(parseRoleCommand("Выдать Ст. Лейтенант АД"), [
      { action: "give", name: "Ст. Лейтенант АД" },
    ]);
  });
});

describe("parseRoleRequest — сообщение из трёх строк", () => {
  test("получатель + экзаменатор + команда", () => {
    const req = parseRoleRequest(
      ["<@111111111111111111>", "<@222222222222222222>", "Выдать Капитан ТР"].join("\n")
    );
    assert.ok(req);
    assert.equal(req.recipientId, "111111111111111111");
    assert.equal(req.examinerId, "222222222222222222");
    assert.deepEqual(req.ops, [{ action: "give", name: "Капитан ТР" }]);
  });

  test("экзаменатор не обязателен (заявка из Google-формы)", () => {
    const req = parseRoleRequest(
      ["<@111111111111111111>", "Заявка из Google-формы: Петров", "Выдать Игроман"].join("\n")
    );
    assert.ok(req);
    assert.equal(req.examinerId, null);
    assert.deepEqual(req.ops, [{ action: "give", name: "Игроман" }]);
  });

  test("формат с восклицательным знаком <@!id> тоже принимается", () => {
    const req = parseRoleRequest(["<@!111111111111111111>", "Выдать Игроман"].join("\n"));
    assert.ok(req);
    assert.equal(req.recipientId, "111111111111111111");
  });

  test("лишние строки внутри команды склеиваются", () => {
    const req = parseRoleRequest(
      [
        "<@111111111111111111>",
        "<@222222222222222222>",
        "Выдать Капитан ТР,",
        "Снять Друг АТК",
      ].join("\n")
    );
    assert.ok(req);
    assert.deepEqual(req.ops, [
      { action: "give", name: "Капитан ТР" },
      { action: "remove", name: "Друг АТК" },
    ]);
  });

  test("без упоминания получателя сообщение не считается запросом", () => {
    assert.equal(parseRoleRequest(["Петров", "Выдать Игроман"].join("\n")), null);
  });

  test("без строки-команды сообщение не считается запросом", () => {
    assert.equal(
      parseRoleRequest(["<@111111111111111111>", "<@222222222222222222>"].join("\n")),
      null
    );
  });

  test("одной строки недостаточно", () => {
    assert.equal(parseRoleRequest("<@111111111111111111> Выдать Игроман"), null);
  });

  test("пустое сообщение не ломает разбор", () => {
    assert.equal(parseRoleRequest(""), null);
  });
});

describe("Константы ролей — целостность справочника", () => {
  test("все ID званий — числовые снежинки", () => {
    for (const [rank, id] of Object.entries(RANK_ROLE_IDS)) {
      assert.match(id, /^\d{17,20}$/, `звание «${rank}»: некорректный ID`);
    }
  });

  test("подразделения ТР и АД заданы и различимы", () => {
    assert.ok(SUBDIV_ROLE_IDS["ТР"]);
    assert.ok(SUBDIV_ROLE_IDS["АД"]);
    assert.notEqual(SUBDIV_ROLE_IDS["ТР"], SUBDIV_ROLE_IDS["АД"]);
  });

  test("«Мл. Лейтенант» отсутствует осознанно (роли нет на сервере)", () => {
    assert.equal(RANK_ROLE_IDS["Мл. Лейтенант"], undefined);
  });

  test("обязательные системные роли заданы", () => {
    assert.match(COMMON_ROLE_IDS.RECRUIT, /^\d+$/);
    assert.match(COMMON_ROLE_IDS.FRIEND, /^\d+$/);
    assert.match(COMMON_ROLE_IDS.ATK_CORPS, /^\d+$/);
    assert.match(COMMON_ROLE_IDS.RANKS_CATEGORY, /^\d+$/);
  });

  test("CLAN_ROLE_IDS содержит звания и подразделения, но НЕ «Друг АТК»", () => {
    assert.ok(CLAN_ROLE_IDS.has(RANK_ROLE_IDS["Рядовой"]));
    assert.ok(CLAN_ROLE_IDS.has(SUBDIV_ROLE_IDS["ТР"]));
    // «Друг АТК» — роль бывшего бойца, она не входит в набор ролей клана
    assert.equal(CLAN_ROLE_IDS.has(COMMON_ROLE_IDS.FRIEND), false);
  });

  test("ID званий и подразделений уникальны (нет дублей-опечаток)", () => {
    const all = [
      ...Object.values(RANK_ROLE_IDS),
      ...Object.values(SUBDIV_ROLE_IDS),
      ...Object.values(COMMON_ROLE_IDS),
    ];
    assert.equal(new Set(all).size, all.length, "найден дублирующийся ID роли");
  });
});