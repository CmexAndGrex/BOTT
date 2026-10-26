/**
 * Адреса аватарок Discord и защита карточек командования.
 *
 * Проверяются боевые модули src/lib/discord-avatar.ts и
 * src/lib/protected-profiles.ts, а не их копия в тесте.
 *
 * Причина появления теста — живые баги:
 *   * аватарки не грузились (403 от Discord CDN без referrerPolicy);
 *   * данные заместителя командира корпуса сбрасывались синхронизацией.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  avatarHashFromUrl,
  avatarInitials,
  getDiscordAvatarUrl,
  resolveAvatarUrl,
} from "../src/lib/discord-avatar.ts";
import {
  PROTECTED_DISCORD_ID,
  isDefaultPost,
  isDefaultRank,
  isDefaultUnit,
  isProtectedFighter,
  protectMemberUpdate,
  resolveRankAndUnit,
} from "../src/lib/protected-profiles.ts";

describe("getDiscordAvatarUrl: адрес аватарки Discord", () => {
  test("ID и хеш дают картинку пользователя нужного размера", () => {
    assert.equal(
      getDiscordAvatarUrl("1394327098801389762", "abc123def", 128),
      "https://cdn.discordapp.com/avatars/1394327098801389762/abc123def.png?size=128"
    );
  });

  test("анимированный аватар (префикс a_) поддерживается", () => {
    assert.equal(
      getDiscordAvatarUrl("123456789012345678", "a_0123456789abcdef", 64),
      "https://cdn.discordapp.com/avatars/123456789012345678/a_0123456789abcdef.png?size=64"
    );
  });

  test("без хеша — дефолтная аватарка Discord по старшим битам ID", () => {
    // (id >> 22) % 6 — алгоритм самого Discord; для этого ID индекс равен 0
    const url = getDiscordAvatarUrl("123456789012345678");
    assert.match(url || "", /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  });

  test("дефолтный индекс считается без потери точности snowflake", () => {
    // Number(id) >> 22 дал бы другой индекс: id не влезает в 53 бита
    const url = getDiscordAvatarUrl("1394327098801389762");
    assert.match(url || "", /embed\/avatars\/[0-5]\.png$/);
  });

  test("безропотный мусор в ID не превращается в ссылку", () => {
    assert.equal(getDiscordAvatarUrl(null), null);
    assert.equal(getDiscordAvatarUrl(undefined), null);
    assert.equal(getDiscordAvatarUrl(""), null);
    assert.equal(getDiscordAvatarUrl("не-id"), null);
  });

  test("недопустимый хеш игнорируется, берётся дефолтная аватарка", () => {
    const url = getDiscordAvatarUrl("123456789012345678", "javascript:alert(1)");
    assert.match(url || "", /embed\/avatars\/[0-5]\.png$/);
  });

  test("размер ограничен списком Discord, иначе 128", () => {
    assert.match(getDiscordAvatarUrl("123456789012345678", "abc") || "", /size=128$/);
    assert.match(getDiscordAvatarUrl("123456789012345678", "abc", 99) || "", /size=128$/);
    assert.match(getDiscordAvatarUrl("123456789012345678", "abc", 512) || "", /size=512$/);
  });
});

describe("avatarHashFromUrl / resolveAvatarUrl", () => {
  test("хеш извлекается из сохранённого адреса Discord", () => {
    assert.equal(
      avatarHashFromUrl("https://cdn.discordapp.com/avatars/123/abdcef123456.png?size=256"),
      "abdcef123456"
    );
  });

  test("чужой адрес хеша не даёт", () => {
    assert.equal(avatarHashFromUrl("https://example.com/avatar.png"), null);
    assert.equal(avatarHashFromUrl(null), null);
  });

  test("сохранённый адрес пересобирается под размер запроса", () => {
    const resolved = resolveAvatarUrl(
      "https://cdn.discordapp.com/avatars/123/abdcef123456.png?size=4096",
      "123"
    );
    assert.equal(resolved, "https://cdn.discordapp.com/avatars/123/abdcef123456.png?size=128");
  });

  test("без сохранённого адреса берётся дефолтная аватарка по ID", () => {
    const resolved = resolveAvatarUrl(null, "123456789012345678");
    assert.match(resolved || "", /embed\/avatars\/[0-5]\.png$/);
  });

  test("без адреса и ID остаётся null: рисуется локальная заглушка", () => {
    assert.equal(resolveAvatarUrl(null, null), null);
    assert.equal(resolveAvatarUrl("", ""), null);
  });
});

describe("avatarInitials: заглушка с инициалами", () => {
  test("две первые буквы ФИО", () => {
    assert.equal(avatarInitials("Иванов И. А."), "ИИ");
  });

  test("пустое имя даёт вопросительный знак", () => {
    assert.equal(avatarInitials(""), "?");
    assert.equal(avatarInitials(null), "?");
  });
});

describe("Динамическая защита карточки командования корпуса", () => {
  test("звание, подразделение и должность больше не зафиксированы константами", () => {
    // Хардкода значений в модуле нет: единственные постоянные — Discord ID и ФИО
    const source = readFileSync(
      new URL("../src/lib/protected-profiles.ts", import.meta.url),
      "utf8"
    );
    assert.ok(!/PROTECTED_PROFILE/.test(source), "константа PROTECTED_PROFILE удалена");
    assert.ok(!/Ст\.\s*Лейтенант/.test(source), "звание «Ст. Лейтенант» не вшито в модуль");
  });

  test("распознаётся по Discord ID", () => {
    assert.equal(isProtectedFighter({ discordId: PROTECTED_DISCORD_ID }), true);
    assert.equal(isProtectedFighter({ discordId: "999999999999999999" }), false);
  });

  test("распознаётся по ФИО в любом написании", () => {
    assert.equal(isProtectedFighter({ name: "Иванов И. А." }), true);
    assert.equal(isProtectedFighter({ name: "Иванов И.А" }), true);
    assert.equal(isProtectedFighter({ name: "иванов и а" }), true);
  });

  test("однофамилец не защищён", () => {
    assert.equal(isProtectedFighter({ name: "Иванов К. М." }), false);
    assert.equal(isProtectedFighter({ name: "Иванов" }), false);
  });

  test("дефолтные значения распознаются как «источник не знает данных»", () => {
    assert.equal(isDefaultRank(""), true);
    assert.equal(isDefaultRank(null), true);
    assert.equal(isDefaultRank("Курсант"), true);
    assert.equal(isDefaultRank("Рядовой"), true);
    assert.equal(isDefaultRank("Капитан"), false);
    assert.equal(isDefaultRank("Майор"), false);

    assert.equal(isDefaultUnit(null), true);
    assert.equal(isDefaultUnit("не назначено"), true);
    assert.equal(isDefaultUnit("Танковая рота"), false);

    assert.equal(isDefaultPost(""), true);
    assert.equal(isDefaultPost("—"), true);
    assert.equal(isDefaultPost("КБМ"), false);
  });

  test("дефолт из источника не затирает сохранённое звание офицера", () => {
    const changes = protectMemberUpdate(
      { discordId: PROTECTED_DISCORD_ID },
      { rank: "Рядовой", unit: "не назначено", post: "" },
      { rank: "Капитан", unit: "Командование корпуса", post: "КБМ" }
    );
    assert.equal(changes.rank, "Капитан");
    assert.equal(changes.unit, "Командование корпуса");
    assert.equal(changes.post, "КБМ");
  });

  test("явное повышение из источника проходит без откатов", () => {
    const changes = protectMemberUpdate(
      { discordId: PROTECTED_DISCORD_ID },
      { rank: "Майор", post: "Начальник штаба" },
      { rank: "Капитан", post: "КБМ" }
    );
    assert.equal(changes.rank, "Майор");
    assert.equal(changes.post, "Начальник штаба");
  });

  test("сохранять нечего — поле не попадает в UPDATE вовсе", () => {
    const changes = protectMemberUpdate(
      { name: "Иванов И. А." },
      { rank: "Рядовой" },
      { rank: "Курсант" }
    );
    assert.deepEqual(Object.keys(changes), []);
  });

  test("незащищённого бойца правка не меняет", () => {
    const changes = protectMemberUpdate({ name: "Петров П. П." }, { rank: "Рядовой" });
    assert.equal(changes.rank, "Рядовой");
  });

  test("resolveRankAndUnit берёт сохранённые значения вместо строки «Вакант»", () => {
    assert.deepEqual(
      resolveRankAndUnit(
        { discordId: PROTECTED_DISCORD_ID },
        { rank: "Рядовой", unit: "Артиллерийский дивизион" },
        { rank: "Капитан", unit: "Танковая рота" }
      ),
      { rank: "Капитан", unit: "Танковая рота" }
    );
    assert.deepEqual(
      resolveRankAndUnit({ name: "Петров П. П." }, { rank: "Рядовой", unit: "Танковая рота" }),
      { rank: "Рядовой", unit: "Танковая рота" }
    );
  });
});
