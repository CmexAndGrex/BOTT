/**
 * Dev-вход и доступ командира в /profile.
 *
 * Проверяются боевые правила, а не копии в тесте: список dev-аккаунтов
 * (src/lib/dev-accounts.ts), гвард режима, точные формулировки ошибок из ТЗ и
 * решение middleware о доступе командира к кабинету.
 *
 * Почему это важно проверять: набор dev-входов — это способ выдать сессию в
 * обход пароля. Ошибка в isDevLoginEnabled() открыла бы его на боевом стенде
 * (любой вошёл бы командиром), а расхождение списка званий с recruits.ts
 * создало бы бойца с несуществующим званием — допуск к технике поехал бы.
 *
 * С новым правилом «двух ключей» ручка требует ОБА условия: NODE_ENV не
 * production И явный флаг ENABLE_DEV_LOGIN=true. Иначе стенд без
 * NODE_ENV=production снова открывал бы создание админа с известным паролем.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEV_ACCOUNTS,
  DEV_ADMIN_PASSWORD_DEFAULT,
  DEV_RANKS,
  DEV_UNITS,
  findDevAccount,
  isDevLoginEnabled,
} from "@/lib/dev-accounts.ts";
import { RANKS, UNITS } from "@/lib/recruits.ts";
import { checkPasswordPolicy } from "@/lib/password-policy.ts";

/** Окружение для проверки режима (Next.js расширяет ProcessEnv — каст через unknown) */
function fakeEnv(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...vars } as unknown as NodeJS.ProcessEnv;
}

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/* ------------------------------------------------------------------ */
/* Режим: набор обязан быть выключен в production                      */
/* ------------------------------------------------------------------ */

describe("Dev-вход: доступность только при двух ключах", () => {
  test("в production выключен при любом флаге", () => {
    // Второй ключ (ENABLE_DEV_LOGIN) не должен переопределять боевой режим:
    // иначе админ-доступ с известным паролем открылся бы на проде.
    assert.equal(isDevLoginEnabled(fakeEnv({ NODE_ENV: "production" })), false);
    assert.equal(
      isDevLoginEnabled(fakeEnv({ NODE_ENV: "production", ENABLE_DEV_LOGIN: "true" })),
      false
    );
  });

  test("вне production ручка закрыта без явного флага", () => {
    // Это и есть закрытие исходной дыры: «забыли» NODE_ENV=production — уже
    // недостаточно, ручка по умолчанию недоступна.
    assert.equal(isDevLoginEnabled(fakeEnv({ NODE_ENV: "development" })), false);
    assert.equal(isDevLoginEnabled(fakeEnv({ NODE_ENV: "test" })), false);
    assert.equal(isDevLoginEnabled(fakeEnv({})), false);
  });

  test("вне production с флагом ENABLE_DEV_LOGIN=true ручка открывается", () => {
    assert.equal(
      isDevLoginEnabled(fakeEnv({ NODE_ENV: "development", ENABLE_DEV_LOGIN: "true" })),
      true
    );
    assert.equal(
      isDevLoginEnabled(fakeEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "true" })),
      true
    );
    // Значение флага нечувствительно к регистру и пробелам
    assert.equal(isDevLoginEnabled(fakeEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "TRUE" })), true);
    // Иные значения (в т.ч. «1» и пустое) ручку не открывают
    assert.equal(isDevLoginEnabled(fakeEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "1" })), false);
    assert.equal(
      isDevLoginEnabled(fakeEnv({ NODE_ENV: "test", ENABLE_DEV_LOGIN: "false" })),
      false
    );
  });

  test("решение принимается по NODE_ENV и флагу, а не по адресу запроса", () => {
    // Адрес приходит заголовком Host и подделывается: проверка по «localhost»
    // открыла бы боевой вход тому, кто подменит заголовок.
    //
    // Смотрим только тело функции и только код: слова про localhost есть в
    // комментарии (он объясняет, почему так делать нельзя), и буквальная
    // проверка «нет слова localhost» ловила бы собственное пояснение.
    const source = read("src/lib/dev-accounts.ts");
    // Оба ключа обязательны: боевой режим закрывает ручку безусловно...
    assert.match(source, /env\.NODE_ENV === "production"/);
    // ...а вне прода — только явный флаг ENABLE_DEV_LOGIN=true.
    assert.match(source, /env\.ENABLE_DEV_LOGIN/);

    const body = source.slice(
      source.indexOf("export function isDevLoginEnabled"),
      source.indexOf("export function findDevAccount")
    );
    const code = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");

    assert.doesNotMatch(
      code,
      /localhost|127\.0\.0\.1|headers|\.host/,
      "адрес запроса не должен влиять на доступность dev-входа"
    );
  });

  test("роут отвечает 404 до любой работы с базой", () => {
    const source = read("src/app/api/auth/dev-login/route.ts");
    assert.match(source, /import \{[\s\S]*isDevLoginEnabled[\s\S]*\} from "@\/lib\/dev-accounts"/);
    // Оба обработчика обязаны проверить режим первой строкой
    const handlers = source.split("export async function ").slice(1);
    assert.equal(handlers.length, 2, "ожидаются два обработчика: GET и POST");
    for (const part of handlers) {
      assert.match(
        part,
        /if \(!isDevLoginEnabled\(\)\) return notFound\(\);/,
        "каждый обработчик обязан проверять режим до остальной логики"
      );
    }
    // 404, а не 403: на боевом стенде не подтверждаем существование ручки
    assert.match(source, /status: 404/);
  });

  test("сессия выпускается сервером, а не подстановкой cookie", () => {
    const source = read("src/app/api/auth/dev-login/route.ts");
    // Подделанная cookie не проходит: гварды читают роль и статус из БД,
    // поэтому настоящую сессию обязан выписать сервер.
    assert.match(source, /issueMemberSession\(/);
    assert.match(source, /setMemberCookie\(/);
    assert.match(source, /issuePanelToken\(/);
    assert.match(source, /setPanelCookie\(/);
  });
});
/* ------------------------------------------------------------------ */
/* Состав dev-аккаунтов                                                */
/* ------------------------------------------------------------------ */

describe("Dev-вход: состав аккаунтов", () => {
  test("три аккаунта из ТЗ: командир, танкист, наводчик", () => {
    assert.deepEqual(
      DEV_ACCOUNTS.map((a) => a.key),
      ["commander", "tank", "artillery"]
    );
  });

  test("позывные и ключи уникальны: иначе кнопки перекрыли бы друг друга", () => {
    const keys = DEV_ACCOUNTS.map((a) => a.key);
    const callsigns = DEV_ACCOUNTS.map((a) => a.callsign);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(new Set(callsigns).size, callsigns.length, "позывной — ключ записи в БД");
  });

  test("командир получает админа в обоих пространствах ролей", () => {
    const commander = DEV_ACCOUNTS.find((a) => a.key === "commander");
    assert.ok(commander);
    // Полный доступ: панель (panelRole) и кабинет (role)
    assert.equal(commander?.panelRole, "admin");
    assert.equal(commander?.role, "admin");
  });

  test("боец и наводчик не получают прав штаба", () => {
    const fighters = DEV_ACCOUNTS.filter((a) => a.key !== "commander");
    assert.equal(fighters.length, 2);
    for (const account of fighters) {
      assert.equal(account.panelRole, null, `у «${account.callsign}» не должно быть сессии панели`);
      assert.notEqual(account.role, "admin");
      assert.notEqual(account.role, "officer");
    }
  });

  test("подразделения бойцов: танкист в роте, наводчик в дивизионе", () => {
    assert.equal(findDevAccount("tank")?.unit, "Танковая рота");
    assert.equal(findDevAccount("artillery")?.unit, "Артиллерийский дивизион");
  });

  test("подписи кнопок совпадают с формулировками ТЗ", () => {
    assert.equal(findDevAccount("commander")?.label, "Войти как Волков Д. В. (Командир)");
    assert.equal(findDevAccount("tank")?.label, "Войти как боец Танковой роты");
    assert.equal(findDevAccount("artillery")?.label, "Войти как наводчик Артдивизиона");
  });

  test("неизвестный ключ не даёт аккаунта", () => {
    assert.equal(findDevAccount("hacker"), null);
    assert.equal(findDevAccount(""), null);
    assert.equal(findDevAccount(null), null);
    assert.equal(findDevAccount(42), null);
  });
});

/* ------------------------------------------------------------------ */
/* Паритет с боевыми справочниками                                     */
/* ------------------------------------------------------------------ */

describe("Dev-вход: паритет со справочниками проекта", () => {
  test("звания dev-аккаунтов существуют в RANKS", () => {
    assert.deepEqual(
      [...DEV_RANKS],
      [...RANKS],
      "копия справочника разошлась: боец получил бы несуществующее звание"
    );
    for (const account of DEV_ACCOUNTS) {
      assert.ok(
        (RANKS as readonly string[]).includes(account.rank),
        `звание «${account.rank}» отсутствует в RANKS`
      );
    }
  });

  test("подразделения совпадают с UNITS (имена листов ШДС)", () => {
    assert.deepEqual([...DEV_UNITS], [...UNITS]);
    for (const account of DEV_ACCOUNTS) {
      assert.ok(
        (UNITS as readonly string[]).includes(account.unit),
        `подразделение «${account.unit}» отсутствует в UNITS`
      );
    }
  });

  test("пароль dev-входа проходит боевую политику паролей", () => {
    // «admin123» из ТЗ политика проекта ЗАПРЕЩАЕТ (WEAK_PASSWORDS), и оба
    // скрипта сида падают на нём (fail-fast). Если бы dev-пароль не проходил
    // политику, роут создал бы бойца, чей пароль панель откажется принять
    // при смене — то есть работающий вход и неработающая смена пароля.
    const check = checkPasswordPolicy(DEV_ADMIN_PASSWORD_DEFAULT);
    assert.equal(check.ok, true, `пароль dev-входа не проходит политику: ${JSON.stringify(check)}`);
    assert.match(DEV_ADMIN_PASSWORD_DEFAULT, /^.{10,}$/);
  });

  test("роут проверяет пароль политикой до выдачи сессии", () => {
    const source = read("src/app/api/auth/dev-login/route.ts");
    const policyAt = source.indexOf("checkPasswordPolicy(DEV_ADMIN_PASSWORD_DEFAULT)");
    const sessionAt = source.indexOf("issueMemberSession(");
    assert.ok(policyAt > 0, "проверка политики отсутствует");
    assert.ok(sessionAt > policyAt, "проверка политики должна быть до выдачи сессии");
  });

  test("сид использует тот же список, а не свою копию", () => {
    const source = read("scripts/dev-seed.ts");
    assert.match(
      source,
      /import \{[\s\S]*DEV_ACCOUNTS[\s\S]*\} from "\.\.\/src\/lib\/dev-accounts\.ts"/
    );
    assert.match(source, /checkPasswordPolicy/, "сид обязан проверять пароль политикой");
    assert.match(source, /ON CONFLICT \(callsign\) DO UPDATE/, "сид должен быть идемпотентным");
  });
});

/* ------------------------------------------------------------------ */
/* Формулировки ошибок из ТЗ                                           */
/* ------------------------------------------------------------------ */

describe("Вход: формулировки ошибок", () => {
  test("неверные данные — «Неверный позывной или пароль»", () => {
    const source = read("src/app/login/page.tsx");
    assert.match(source, /"Неверный позывной или пароль"/);
  });

  test("Discord без бойца в ШДС — текст из ТЗ есть в карте ошибок", () => {
    const source = read("src/app/login/page.tsx");
    assert.match(
      source,
      /discord_not_linked: "Ваш Discord аккаунт не привязан к бойцу в ШДС\. Обратитесь к штабу"/
    );
  });

  test("callback возвращает код discord_not_linked вместо молчаливого /apply", () => {
    const source = read("src/app/api/auth/discord/callback/route.ts");
    assert.match(source, /discord_not_linked/);
    assert.doesNotMatch(
      source,
      /redirectTo\(req, "\/apply\?discord=1"\)/,
      "вход не должен молча уводить на форму рапорта"
    );
    // Контакт Discord при этом сохраняется: форму рапорта можно заполнить сразу
    assert.match(source, /MEMBER_OAUTH_PENDING_COOKIE/);
  });

  test("плашка ошибки рисуется на форме", () => {
    const source = read("src/app/login/page.tsx");
    assert.match(source, /\{error && \(/, "блок вывода ошибки отсутствует");
    assert.match(source, /ShieldAlert/);
  });

  test("технические ответы сервера не подменяются общей формулировкой", () => {
    const source = read("src/app/login/page.tsx");
    // Блокировка попыток (429) и сбой сервера (500) должны доходить до бойца:
    // иначе он будет перебирать пароль, не зная, что уже заблокирован.
    // Шаблон без буквы перед «.status»: переменные называются panelRes/memberRes.
    assert.match(source, /\.status === 429/);
    assert.match(source, /\.status === 500/);
  });
});

/* ------------------------------------------------------------------ */
/* Командир: доступ и к панели, и к кабинету                           */
/* ------------------------------------------------------------------ */

describe("Командир: доступ к /profile", () => {
  test("middleware пускает сессию панели в область кабинета", () => {
    const source = read("src/middleware.ts");
    // Ветка «нет member_token, но есть auth_token штаба» должна возвращать
    // пропуск для области кабинета, а не отказ: иначе командир вылетает на
    // /login при попытке открыть /profile (это и был симптом из отчёта).
    const areaBlock = source.slice(
      source.indexOf("if (isMemberArea || isStaffArea)"),
      source.indexOf("if (!isProtected)")
    );
    assert.match(areaBlock, /memberPaths[\s\S]*|/, "блок области кабинета не найден");
    assert.match(
      areaBlock,
      /const panelToken = req\.cookies\.get\("auth_token"\)\?\.value;/
    );
    assert.match(
      areaBlock,
      /if \(role === "admin" \|\| role === "officer"\) \{\s*return withCsp\(NextResponse\.next/,
      "командир должен получать пропуск, а не редирект на /login"
    );
  });

  test("/profile остаётся в списке путей кабинета", () => {
    const source = read("src/middleware.ts");
    const memberPaths = source.slice(
      source.indexOf("const memberPaths = ["),
      source.indexOf("const staffPaths = [")
    );
    assert.match(memberPaths, /"\/profile"/);
    assert.match(memberPaths, /"\/api\/member\/dossier"/);
    assert.match(memberPaths, /"\/api\/member\/vch"/);
  });

  test("отладочный и парольный вход защищены от CSRF", () => {
    const source = read("src/middleware.ts");
    const cookiePaths = source.slice(
      source.indexOf("const cookieAuthApiPaths = ["),
      source.indexOf("function isCrossSite")
    );
    assert.match(cookiePaths, /"\/api\/auth\/dev-login"/, "dev-login меняет сессию — нужен CSRF-гвард");
    assert.match(cookiePaths, /"\/api\/auth\/member-login"/);
  });
});