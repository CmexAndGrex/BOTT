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
import { readFileSync } from "node:fs";
import { parseRank } from "../src/lib/role-sync.ts";
import {
  PROTECTED_DISCORD_ID,
  isDefaultRank,
  isProtectedFighter,
  protectMemberUpdate,
  resolveRankAndUnit,
} from "../src/lib/protected-profiles.ts";
import {
  ASSIGNABLE_UNITS,
  COMMAND_UNIT,
  UNITS,
  isCommandUnit,
} from "../src/lib/recruits.ts";

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

describe("Ручное повышение офицера командования не откатывается", () => {
  /**
   * Живой сценарий: командир корпуса повысил Иванова И. А. до «Капитан» и
   * сменил должность. Автоматика (rs-red.com, сверка ШДС, заявка) не имеет
   * права вернуть «Рядового»: она отсекает только пустые дефолты.
   */
  test("«Капитан» из панели сохраняется при последующей синхронизации ШДС", () => {
    const officer = { discordId: PROTECTED_DISCORD_ID, name: "Иванов И. А." };
    assert.equal(isProtectedFighter(officer), true);

    // Сверка листа подразделения прислала «Рядового» из строки «Вакант»
    const resolved = resolveRankAndUnit(
      officer,
      { rank: "Рядовой", unit: "Артиллерийский дивизион" },
      { rank: "Капитан", unit: "Командование корпуса" }
    );
    assert.equal(resolved.rank, "Капитан");
    assert.equal(resolved.unit, "Командование корпуса");
  });

  test("смена должности на «КБМ» проходит, дефолтная должность — нет", () => {
    const officer = { name: "Иванов И. А." };

    const explicit = protectMemberUpdate(
      officer,
      { post: "КБМ" },
      { post: "Заместитель командира корпуса" }
    );
    assert.equal(explicit.post, "КБМ");

    const fromSite = protectMemberUpdate(officer, { post: "Рядовой" }, { post: "КБМ" });
    assert.equal(fromSite.post, "КБМ");
  });

  test("«Рядовой» с rs-red.com не понижает звание офицера", () => {
    const officer = { discordId: PROTECTED_DISCORD_ID };
    assert.equal(isDefaultRank("Рядовой"), true);
    const changes = protectMemberUpdate(officer, { rank: "Рядовой" }, { rank: "Майор" });
    assert.equal(changes.rank, "Майор");
  });

  test("подразделение командования можно сменить на любое другое", () => {
    const officer = { discordId: PROTECTED_DISCORD_ID };
    for (const unit of ["Танковая рота", "Артиллерийский дивизион"]) {
      const changes = protectMemberUpdate(
        officer,
        { unit },
        { unit: "Командование корпуса" }
      );
      assert.equal(changes.unit, unit);
    }
  });

  test("ручная правка из панели не проходит через фильтр дефолтов", () => {
    // Приказ по офицеру — явное действие: роут пишет значение напрямую.
    // Проверяется исходник боевых роутов, а не копия правила в тесте.
    const routes = [
      "../src/app/api/members/[id]/route.ts",
      "../src/app/api/admin/recruits/[id]/route.ts",
    ];
    for (const route of routes) {
      const source = readFileSync(new URL(route, import.meta.url), "utf8");
      assert.ok(
        !/PROTECTED_PROFILE/.test(source),
        `${route}: жёсткая подмена звания/должности удалена`
      );
    }

    const memberRoute = readFileSync(
      new URL("../src/app/api/members/[id]/route.ts", import.meta.url),
      "utf8"
    );
    // Роут обязан принимать звание, подразделение и должность из тела запроса
    assert.match(memberRoute, /body\.rank/);
    assert.match(memberRoute, /body\.unit/);
    assert.match(memberRoute, /body\.post/);
  });
});

describe("Подразделение «Командование корпуса»", () => {
  test("значение известно, но не входит в перечень листов ШДС", () => {
    assert.equal(COMMAND_UNIT, "Командование корпуса");
    assert.equal(isCommandUnit("Командование корпуса"), true);
    assert.equal(isCommandUnit("командование атк"), true);
    assert.equal(isCommandUnit("Танковая рота"), false);
    // UNITS — это листы Google Таблицы: третье значение сломало бы resolveLayout
    assert.deepEqual([...UNITS], ["Танковая рота", "Артиллерийский дивизион"]);
  });

  test("администратор может назначить любое из трёх подразделений", () => {
    assert.deepEqual(
      [...ASSIGNABLE_UNITS],
      ["Танковая рота", "Артиллерийский дивизион", COMMAND_UNIT]
    );
  });
});
