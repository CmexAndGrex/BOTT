/**
 * Восстановление доступа к панели: scripts/bootstrap-admin.ts.
 *
 * Проверяется именно паритет со скриптом боевого восстановления (как в L9 для
 * seed-admin): опечатка в SQL, забытая проверка политики пароля или убранный
 * инкремент token_version здесь не проявляются в обычных тестах приложения,
 * но ломают аварийный вход ровно тогда, когда он нужен.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PASSWORD_MIN_LENGTH } from "../src/lib/password-policy.ts";

const scriptPath = path.join(process.cwd(), "scripts", "bootstrap-admin.ts");
const source = readFileSync(scriptPath, "utf8");

describe("Восстановление доступа — scripts/bootstrap-admin.ts", () => {
  test("скрипт не дублирует политику пароля, а берёт боевую", () => {
    // Копия списка слабых слов разошлась бы с src/lib/password-policy.ts:
    // панель отклонила бы пароль, который скрипт считает допустимым.
    assert.match(source, /import \{ checkPasswordPolicy \} from "\.\.\/src\/lib\/password-policy\.ts"/);
    assert.match(source, /checkPasswordPolicy\(out\)\.ok/, "генератор не проверяет политику");
    assert.match(source, /checkPasswordPolicy\(provided\)/, "пароль из окружения не проверяется");
  });

  test("пароль из окружения проверяется до записи в БД", () => {
    const policyCheck = source.indexOf("checkPasswordPolicy(provided)");
    const poolCreate = source.indexOf("new Pool(");
    assert.ok(policyCheck > 0 && poolCreate > policyCheck, "проверка должна быть до подключения к БД");
  });

  test("хеш пароля считается bcrypt, совпадая с раундами проекта", () => {
    assert.match(source, /bcrypt\.hash\(password, BCRYPT_ROUNDS\)/);
    const m = source.match(/const BCRYPT_ROUNDS = (\d+);/);
    assert.ok(m, "BCRYPT_ROUNDS не найден");
    assert.equal(Number(m[1]), 10, "раунды должны совпадать с seed-admin и роутами смены пароля");
  });

  test("смена пароля отзывает прежние сессии", () => {
    // Без инкремента версии токена старые cookie панели остались бы живыми
    // после принудительной смены пароля.
    assert.match(source, /token_version = token_version \+ 1/);
    assert.match(source, /member_token_version = member_token_version \+ 1/);
  });

  test("Discord ID привязывается к учётной записи и валидируется", () => {
    assert.match(source, /SET password_hash = \$2, role = 'admin', discord_id = \$3/);
    assert.match(source, /VALUES \(\$1, \$2, \$3, \$4\)/, "ветка создания не пишет discord_id");
    assert.match(source, /function isDiscordId/, "нет проверки формата снежинки");
  });

  test("боец без записи в табеле не создаётся", () => {
    // Скрипт не должен дописывать состав подразделения: табель ведёт
    // синхронизация rs-red.com, а не восстановление доступа.
    assert.doesNotMatch(source, /INSERT INTO division_members/);
    assert.match(source, /UPDATE division_members SET/);
  });

  test("минимальная длина пароля согласована с приложением", () => {
    assert.equal(PASSWORD_MIN_LENGTH, 10);
    assert.ok(source.includes("ПАРОЛЬ") || source.includes("password"), "нет упоминания пароля");
  });
});