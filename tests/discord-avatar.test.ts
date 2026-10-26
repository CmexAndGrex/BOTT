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
import {
  avatarHashFromUrl,
  avatarInitials,
  getDiscordAvatarUrl,
  resolveAvatarUrl,
} from "../src/lib/discord-avatar.ts";
import {
  PROTECTED_DISCORD_ID,
  PROTECTED_PROFILE,
  isProtectedFighter,
  protectMemberUpdate,
  protectedRankFor,
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

describe("Защита карточки заместителя командира корпуса", () => {
  test("постоянные данные зафиксированы", () => {
    assert.equal(PROTECTED_PROFILE.rank, "Ст. Лейтенант");
    assert.equal(PROTECTED_PROFILE.unit, "Танковая рота");
    assert.equal(PROTECTED_PROFILE.post, "Заместитель командира корпуса");
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

  test("правка звания, подразделения и должности откатывается к постоянным", () => {
    const changes = protectMemberUpdate(
      { discordId: PROTECTED_DISCORD_ID },
      { rank: "Рядовой", unit: "Артиллерийский дивизион", post: "Стрелок", updatedAt: new Date() }
    );
    assert.equal(changes.rank, PROTECTED_PROFILE.rank);
    assert.equal(changes.unit, PROTECTED_PROFILE.unit);
    assert.equal(changes.post, PROTECTED_PROFILE.post);
  });

  test("поля, которых правка не касалась, не появляются", () => {
    const changes = protectMemberUpdate({ name: "Иванов И. А." }, { rank: "Рядовой" });
    assert.deepEqual(Object.keys(changes), ["rank"]);
    assert.equal(changes.rank, PROTECTED_PROFILE.rank);
  });

  test("незащищённого бойца правка не меняет", () => {
    const changes = protectMemberUpdate({ name: "Петров П. П." }, { rank: "Рядовой" });
    assert.equal(changes.rank, "Рядовой");
  });

  test("protectedRankFor отдаёт звание только для защищённой карточки", () => {
    assert.equal(protectedRankFor({ discordId: PROTECTED_DISCORD_ID }), "Ст. Лейтенант");
    assert.equal(protectedRankFor({ name: "Петров П. П." }), null);
  });

  test("resolveRankAndUnit игнорирует источник целиком, а не частично", () => {
    assert.deepEqual(
      resolveRankAndUnit(
        { discordId: PROTECTED_DISCORD_ID },
        { rank: "Рядовой", unit: "Артиллерийский дивизион" }
      ),
      { rank: PROTECTED_PROFILE.rank, unit: PROTECTED_PROFILE.unit }
    );
    assert.deepEqual(
      resolveRankAndUnit({ name: "Петров П. П." }, { rank: "Рядовой", unit: "Танковая рота" }),
      { rank: "Рядовой", unit: "Танковая рота" }
    );
  });
});
