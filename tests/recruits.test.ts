/**
 * Тесты домена новобранцев: позывные, анкеты, статусы, Discord ID и лимит входов.
 *
 * Запуск: npm run test
 * Проверяется боевой модуль src/lib/recruits.ts, а не копия правил в тесте:
 * если правило позывного или разбор возраста изменится в src/, тест упадёт.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AGE_MAX,
  AGE_MIN,
  callsignFromHandle,
  hasProfileAccess,
  isCallsign,
  isDiscordSnowflake,
  isMemberRole,
  isMemberStatus,
  isStaffRole,
  LoginThrottle,
  MANUAL_DISCORD_ID,
  normalizeCallsign,
  readApplication,
  validateApplication,
} from "../src/lib/recruits.ts";
import { checkPasswordPolicy } from "../src/lib/password-policy.ts";

describe("Позывной — нормализация и проверка формата", () => {
  test("пробелы по краям и внутри схлопываются", () => {
    assert.equal(normalizeCallsign("  Скиф   Гром  "), "Скиф Гром");
  });

  test("регистр сохраняется: позывной виден в табеле как написан", () => {
    assert.equal(normalizeCallsign("Скиф"), "Скиф");
    assert.notEqual(normalizeCallsign("Скиф"), normalizeCallsign("скиф"));
  });

  test("допустимы кириллица, цифры, пробел, точка и дефис", () => {
    assert.equal(isCallsign("Скиф"), true);
    assert.equal(isCallsign("Гром-2"), true);
    assert.equal(isCallsign("Штурман 1"), true);
    assert.equal(isCallsign("Ranger.01"), true);
  });

  test("спецсимволы и эмодзи отклоняются (ломают поиск по листу)", () => {
    assert.equal(isCallsign("Скиф<b>"), false);
    assert.equal(isCallsign("Скиф🚀"), false);
    assert.equal(isCallsign("Скиф;DROP"), false);
  });

  test("длина ограничена: от 3 до 32 символов", () => {
    assert.equal(isCallsign("Ск"), false);
    assert.equal(isCallsign("Ски"), true);
    assert.equal(isCallsign("A".repeat(32)), true);
    assert.equal(isCallsign("A".repeat(33)), false);
  });

  test("не строка или пустое значение — не позывной", () => {
    assert.equal(isCallsign(undefined), false);
    assert.equal(isCallsign(null), false);
    assert.equal(isCallsign("   "), false);
    assert.equal(isCallsign(12345), false);
  });
});

describe("callsignFromHandle — имя бойца с rs-red.com", () => {
  test("подходящее имя принимается", () => {
    assert.equal(callsignFromHandle("Скиф"), "Скиф");
  });

  test("неподходящее имя отбрасывается, а не подставляется как есть", () => {
    assert.equal(callsignFromHandle("x"), "");
    assert.equal(callsignFromHandle(""), "");
    assert.equal(callsignFromHandle(null), "");
describe("Анкета рапорта — validateApplication", () => {
  const base = { armaExperience: "600 часов, 3 года", specialization: "Механик-водитель" };

  test("возраст из формы (строка) приводится к числу", () => {
    const result = validateApplication({ ...base, age: "18" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.age, 18);
  });

  test("возраст вне границ отклоняется", () => {
    assert.equal(validateApplication({ ...base, age: AGE_MIN - 1 }).ok, false);
    assert.equal(validateApplication({ ...base, age: AGE_MAX + 1 }).ok, false);
    assert.equal(validateApplication({ ...base, age: "не число" }).ok, false);
    assert.equal(validateApplication({ ...base, age: 17.5 }).ok, false);
  });

  test("пустой опыт в Arma 3 отклоняется (без него штаб не решает)", () => {
    const result = validateApplication({ age: 20, specialization: "Связист", armaExperience: "" });
    assert.equal(result.ok, false);
  });

  test("пустая специализация отклоняется", () => {
    const result = validateApplication({ age: 20, armaExperience: "100 часов", specialization: "" });
    assert.equal(result.ok, false);
  });

  test("длинные тексты обрезаются, а не ломают запись", () => {
    const result = validateApplication({ ...base, age: 20, comment: "а".repeat(5000) });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.comment.length, 1000);
  });
});

describe("readApplication — чтение jsonb из БД", () => {
  test("мусор вместо объекта не роняет интерфейс", () => {
    assert.deepEqual(readApplication(null), {});
    assert.deepEqual(readApplication("строка"), {});
    assert.deepEqual(readApplication(42), {});
  });

  test("корректные поля извлекаются", () => {
    const app = readApplication({ age: 24, specialization: "Связист", comment: "текст" });
    assert.equal(app.age, 24);
    assert.equal(app.specialization, "Связист");
  });

  test("некорректный возраст отбрасывается", () => {
    assert.equal(readApplication({ age: "старый" }).age, undefined);
    assert.equal(readApplication({ age: -5 }).age, undefined);
  });
});

describe("Статусы, роли и доступ", () => {
  test("статусы и роли проверяются по списку", () => {
    assert.equal(isMemberStatus("pending"), true);
    assert.equal(isMemberStatus("dismissed"), true);
    assert.equal(isMemberStatus("active"), true);
    assert.equal(isMemberStatus("boss"), false);
    assert.equal(isMemberRole("officer"), true);
    assert.equal(isMemberRole("superadmin"), false);
  });

  test("кабинет доступен только «в строю» и «в отпуске»", () => {
    assert.equal(hasProfileAccess("active"), true);
    assert.equal(hasProfileAccess("vacation"), true);
    // Регрессия: кандидат со статусом pending не должен видеть карточку бойца
    assert.equal(hasProfileAccess("pending"), false);
    assert.equal(hasProfileAccess("dismissed"), false);
  });

  test("модерация доступна командиру и администратору", () => {
    assert.equal(isStaffRole("officer"), true);
    assert.equal(isStaffRole("admin"), true);
    assert.equal(isStaffRole("member"), false);
    assert.equal(isStaffRole("recruit"), false);
  });
});

describe("Discord ID", () => {
  test("снежинка принимается", () => {
    assert.equal(isDiscordSnowflake("123456789012345678"), true);
  });

  test("маркер «manual» и пустое значение не считаются ID", () => {
    assert.equal(isDiscordSnowflake(MANUAL_DISCORD_ID), false);
    assert.equal(isDiscordSnowflake(""), false);
    assert.equal(isDiscordSnowflake("user#1234"), false);
  });
});
  });
});
describe("LoginThrottle — защита от перебора пароля", () => {
  test("после 5 неудач вход блокируется на 15 минут", () => {
    const throttle = new LoginThrottle();
    const start = 1_000_000;
    for (let i = 0; i < 4; i++) {
      assert.equal(throttle.registerFailure("ip:скиф", start).locked, false);
    }
    const fifth = throttle.registerFailure("ip:скиф", start);
    assert.equal(fifth.locked, true);
    assert.equal(throttle.check("ip:скиф", start).locked, true);
  });

  test("блокировка снимается по истечении времени", () => {
    const throttle = new LoginThrottle(2, 60_000);
    const start = 5_000_000;
    throttle.registerFailure("ip:гром", start);
    throttle.registerFailure("ip:гром", start);
    assert.equal(throttle.check("ip:гром", start).locked, true);
    assert.equal(throttle.check("ip:гром", start + 60_001).locked, false);
  });

  test("успешный вход снимает счётчик", () => {
    const throttle = new LoginThrottle(2, 60_000);
    throttle.registerFailure("ip:скиф", 1000);
    throttle.reset("ip:скиф");
    // После сброса снова нужны полные 2 неудачи для блокировки
    assert.equal(throttle.registerFailure("ip:скиф", 2000).locked, false);
  });

  test("разные ключи не влияют друг на друга (перебор по одному аккаунту)", () => {
    const throttle = new LoginThrottle(2, 60_000);
    throttle.registerFailure("ip:скиф", 1000);
    throttle.registerFailure("ip:скиф", 1000);
    assert.equal(throttle.check("ip:гром", 1000).locked, false);
  });
});

describe("Связка политики пароля с формой рапорта", () => {
  test("слабый пароль кандидата отклоняется той же политикой, что и в панели", () => {
    assert.equal(checkPasswordPolicy("12345").ok, false);
    assert.equal(checkPasswordPolicy("пароль12345").ok, false);
    assert.equal(checkPasswordPolicy("НадёжныйПароль123").ok, true);
  });
});