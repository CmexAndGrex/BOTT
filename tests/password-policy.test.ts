/**
 * Тесты политики паролей (Этап 3: L9).
 *
 * Две части:
 *  1) сам модуль src/lib/password-policy.ts;
 *  2) паритет с дубликатом в scripts/seed-admin.mjs — политика продублирована
 *     там вынужденно (скрипт запускается на Node 22 в образе migrator, где нет
 *     нативного выполнения TypeScript), поэтому рассинхрон ловим тестом.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  checkPasswordPolicy,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from "../src/lib/password-policy.ts";

/** Причина отказа или "ok" — для компактных таблиц кейсов */
function verdict(password: string): string {
  const r = checkPasswordPolicy(password);
  return r.ok ? "ok" : r.error;
}

describe("L9 — политика паролей: длина", () => {
  test("старый слабый пароль «12345» отклоняется", () => {
    // Регрессия: в форме было minLength=5, сервер принимал такой пароль
    const r = checkPasswordPolicy("12345");
    assert.equal(r.ok, false);
  });

  test("минимум — PASSWORD_MIN_LENGTH, граница включительно", () => {
    assert.equal(PASSWORD_MIN_LENGTH, 10);
    assert.equal(checkPasswordPolicy("a".repeat(PASSWORD_MIN_LENGTH - 1)).ok, false);
    // Ровно на границе — но должен пройти остальные правила (смешанный состав)
    assert.equal(checkPasswordPolicy("Xq7" + "k".repeat(PASSWORD_MIN_LENGTH - 3)).ok, true);
  });

  test("слишком длинный пароль отклоняется (лимит bcrypt)", () => {
    assert.equal(PASSWORD_MAX_LENGTH, 72);
    assert.equal(checkPasswordPolicy("Aa1" + "x".repeat(PASSWORD_MAX_LENGTH - 3)).ok, true);
    assert.equal(checkPasswordPolicy("Aa1" + "x".repeat(PASSWORD_MAX_LENGTH - 2)).ok, false);
  });

  test("не-строка отклоняется", () => {
    assert.equal(checkPasswordPolicy(undefined).ok, false);
    assert.equal(checkPasswordPolicy(null).ok, false);
    assert.equal(checkPasswordPolicy(12345678901).ok, false);
    assert.equal(checkPasswordPolicy("").ok, false);
  });
});

describe("L9 — политика паролей: распространённые пароли", () => {
  test("точное совпадение со слабым паролем отклоняется", () => {
    for (const p of ["admin-password", "password1", "qwertyuiop", "administrator"]) {
      assert.equal(checkPasswordPolicy(p).ok, false, `должен быть отклонён: ${p}`);
    }
  });

  test("косметические вариации слабого слова отклоняются", () => {
    // Цифры и знаки не делают слабое слово надёжнее
    for (const p of ["Пароль12345!", "Qwerty_2026", "admin1234567", "Password!2345"]) {
      assert.equal(checkPasswordPolicy(p).ok, false, `должен быть отклонён: ${p}`);
    }
  });

  test("совпадение регистронезависимо", () => {
    assert.equal(checkPasswordPolicy("ADMIN-PASSWORD").ok, false);
    assert.equal(checkPasswordPolicy("ПАРОЛЬ12345!").ok, false);
  });
});

describe("L9 — политика паролей: структура", () => {
  test("повтор одного символа отклоняется", () => {
    assert.equal(checkPasswordPolicy("1".repeat(11)).ok, false);
    assert.equal(checkPasswordPolicy("a".repeat(12)).ok, false);
  });

  test("один вид символов отклоняется", () => {
    assert.equal(checkPasswordPolicy("abcdefghij").ok, false, "только строчные");
    assert.equal(checkPasswordPolicy("ABCDEFGHIJ").ok, false, "только прописные");
  });

  test("два и более видов символов принимаются", () => {
    assert.equal(checkPasswordPolicy("abcdefghij1").ok, true);
    assert.equal(checkPasswordPolicy("ABCDEFGHIJ1").ok, true);
  });

  test("дата отклоняется", () => {
    assert.equal(checkPasswordPolicy("20240101").ok, false);
    assert.equal(checkPasswordPolicy("19991231").ok, false);
  });

  test("надёжные пароли принимаются", () => {
    for (const p of ["Рядовой2026!", "Str0ng-Pass!", "Танкист#47ТВ", "k7#LmQ2$vZ"]) {
      assert.equal(checkPasswordPolicy(p).ok, true, `должен быть принят: ${p}`);
    }
  });

  test("сообщение об ошибке непустое и понятное", () => {
    const r = checkPasswordPolicy("12345");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.length > 10, "сообщение должно объяснять причину");
      assert.ok(r.error.includes("10"), "сообщение должно называть минимальную длину");
    }
  });
});

describe("L9 — паритет политики с scripts/seed-admin.mjs", () => {
  const seedPath = path.join(process.cwd(), "scripts", "seed-admin.mjs");
  const seedSource = readFileSync(seedPath, "utf8");

  test("в seed-admin есть проверка пароля по политике", () => {
    assert.match(seedSource, /function passwordPolicyError\(/, "проверка отсутствует в seed-admin");
  });

  test("минимальная длина совпадает с приложением", () => {
    const m = seedSource.match(/const PASSWORD_MIN_LENGTH = (\d+);/);
    assert.ok(m, "PASSWORD_MIN_LENGTH не найден в seed-admin");
    assert.equal(Number(m[1]), PASSWORD_MIN_LENGTH, "минимальная длина разошлась");
  });

  test("максимальная длина совпадает с приложением", () => {
    const m = seedSource.match(/const PASSWORD_MAX_LENGTH = (\d+);/);
    assert.ok(m, "PASSWORD_MAX_LENGTH не найден в seed-admin");
    assert.equal(Number(m[1]), PASSWORD_MAX_LENGTH, "максимальная длина разошлась");
  });

  test("наборы слабых паролей и основ не пусты в обоих местах", () => {
    assert.match(seedSource, /const WEAK_PASSWORDS = new Set\(\[/);
    assert.match(seedSource, /"password"/, "список слабых паролей потерян");
    assert.match(seedSource, /"qwerty"/, "список слабых паролей потерян");
  });

  test("проверка вызывается при создании и при сбросе пароля", () => {
    const calls = seedSource.match(/passwordPolicyError\(password\)/g) ?? [];
    assert.ok(calls.length >= 2, `ожидалось минимум 2 вызова, найдено ${calls.length}`);
    assert.match(seedSource, /ADMIN_PASSWORD_RESET/, "не найдена ветка сброса пароля");
  });
});