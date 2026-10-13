/**
 * Правка Discord ID бойца из табеля «Состав» (администратор).
 *
 * Проверяются боевые модули, а не копии правил в тесте: валидатор
 * (src/lib/validation.ts), запись в лист ШДС (src/lib/gsheets.ts), роут
 * (/api/admin/roster/[id]/discord-id) и вход в раздел через middleware.
 *
 * Почему это критично: слишком короткий ID («12345») выглядит как успешная
 * привязка, но бот по нему никого не упомянет — ошибку замечают уже в Discord,
 * когда должника не удалось пингануть. А ослабленный гвард роута позволил бы
 * править состав (и внешнюю таблицу) любому вошедшему.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  ROSTER_DISCORD_ID_MAX_LENGTH,
  ROSTER_DISCORD_ID_MIN_LENGTH,
  validateRosterDiscordId,
} from "../src/lib/validation.ts";
import { syncDiscordIdToSheet } from "../src/lib/gsheets.ts";
import { PATCH as patchDiscordId } from "../src/app/api/admin/roster/[id]/discord-id/route.ts";
import { middleware } from "../src/middleware.ts";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Действующий ID: 19 цифр (так выглядят современные снежинки Discord) */
const VALID_ID = "1085141850966458519";

/** Запрос к роуту правки: путь как у реального вызова из панели */
function discordIdRequest(
  options: { method?: string; cookie?: string; origin?: string; fetchSite?: string; body?: string } = {}
): NextRequest {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  headers.set("host", "panel.example");
  if (options.body) headers.set("content-type", "application/json");

  return new NextRequest(new URL("/api/admin/roster/7/discord-id", "http://panel.example"), {
    method: options.method ?? "PATCH",
    headers,
    body: options.body,
  });
}

/* ------------------------------------------------------------------ */
/* Валидатор: формат ID                                                */
/* ------------------------------------------------------------------ */

describe("Discord ID из табеля — проверка формата", () => {
  test("17, 18 и 19 цифр принимаются", () => {
    for (const length of [ROSTER_DISCORD_ID_MIN_LENGTH, 18, ROSTER_DISCORD_ID_MAX_LENGTH]) {
      const result = validateRosterDiscordId("1".repeat(length));
      assert.equal(result.ok, true, `${length} цифр должны приниматься`);
      if (result.ok) assert.equal(result.value, "1".repeat(length));
    }
  });

  test("16 и 20 цифр отклоняются с указанием причины", () => {
    for (const length of [ROSTER_DISCORD_ID_MIN_LENGTH - 1, ROSTER_DISCORD_ID_MAX_LENGTH + 1]) {
      const result = validateRosterDiscordId("1".repeat(length));
      assert.equal(result.ok, false, `${length} цифр должны отклоняться`);
      if (!result.ok) assert.match(result.error, /17 до 19 цифр/);
    }
  });

  test("короткое значение — ошибка, а не тихая привязка", () => {
    // Именно так выглядит опечатка: ID сохранён, бот молча не пингует
    assert.equal(validateRosterDiscordId("12345").ok, false);
  });

  test("пустое значение — осознанная очистка, а не ошибка", () => {
    for (const empty of ["", "   ", null, undefined]) {
      const result = validateRosterDiscordId(empty);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, null);
    }
  });

  test("упоминание из Discord принимается и очищается до цифр", () => {
    // Копипаст из чата тащит «<@…>» и «!» — требовать снять их руками незачем
    const result = validateRosterDiscordId(`<@!${VALID_ID}>`);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, VALID_ID);
  });

  test("пробелы по краям значения не ломают разбор", () => {
    const result = validateRosterDiscordId(`  ${VALID_ID}  `);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, VALID_ID);
  });

  test("нечисловой ввод отклоняется: без цифр и с неполным числом", () => {
    const noDigits = validateRosterDiscordId("user#abcd");
    assert.equal(noDigits.ok, false);
    if (!noDigits.ok) assert.match(noDigits.error, /только из цифр/);

    // Хвост из цифр не спасает: «user#1234» — это по-прежнему не ID, и жалоба
    // должна говорить о длине, а не пропускать значение
    const partial = validateRosterDiscordId("user#1234");
    assert.equal(partial.ok, false);
    if (!partial.ok) assert.match(partial.error, /17 до 19 цифр/);
  });

  test("маркер «manual» из заявок не проходит как ID", () => {
    // Значение приходит из базы кандидатов: это метка «ID впишет модератор»,
    // а не идентификатор Discord
    assert.equal(validateRosterDiscordId("manual").ok, false);
  });
});
/* ------------------------------------------------------------------ */
/* Запись в Google Таблицу: защитные ветки без обращения к Google      */
/* ------------------------------------------------------------------ */

describe("syncDiscordIdToSheet — отказ до обращения к таблице", () => {
  test("без подразделения известен только отказ, а не догадка о листе", async () => {
    const result = await syncDiscordIdToSheet({ unit: "", names: ["Петров"], discordId: VALID_ID });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /подразделение/);
  });

  test("без имени бойца строку искать нечем", async () => {
    const result = await syncDiscordIdToSheet({
      unit: "Танковая рота",
      names: ["", "   "],
      discordId: VALID_ID,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /имя бойца/);
  });

  test("боец ищется и по позывному, и по ФИО из табеля", () => {
    // В панели боец записан ФИО с rs-red.com, в ШДС нередко стоит позывной —
    // один вариант имени давал бы «боец не найден» на живых данных
    const source = read("src/lib/gsheets.ts");
    const fn = source.slice(source.indexOf("export async function syncDiscordIdToSheet"));
    assert.match(fn, /for \(const name of names\)/);
    assert.match(fn, /colLetter\(colIndex\(layout\.nameCol\) \+ 3\)/, "колонка Discord ID разошлась со сценарием «Добавление в ШДС»");
    assert.match(fn, /saveUpdatedCells\(\)/);
  });
});

/* ------------------------------------------------------------------ */
/* Роут: доступ                                                        */
/* ------------------------------------------------------------------ */

describe("PATCH /api/admin/roster/[id]/discord-id — доступ", () => {
  test("запрос без сессии получает 401", async () => {
    const res = await patchDiscordId(discordIdRequest(), { params: Promise.resolve({ id: "7" }) });
    assert.equal(res.status, 401);
  });

  test("роут допускает командира и администратора — единое правило прав", () => {
    const source = read("src/app/api/admin/roster/[id]/discord-id/route.ts");
    // Требование: правка доступна и администратору, и командиру подразделения.
    // Гвард берётся из общего модуля прав (requireRosterEditor), а не из
    // жёсткой роли admin — ослабление или подмена гварда должно ломать тест,
    // а не тихо открывать доступ.
    assert.match(source, /requireRosterEditor\(req\)/);
    assert.equal(
      /requireRole\(req, \["admin"\]\)/.test(source),
      false,
      "в роуте осталась жёсткая проверка роли admin"
    );
  });

  test("гвард правки считает права одним правилом с интерфейсом", () => {
    // Копия правила в двух местах разошлась бы: поле в табеле открыто, а
    // сервер отвечает 403 (ровно этот рассинхрон и был причиной бага)
    const source = read("src/lib/member-auth.ts");
    const fn = source.slice(source.indexOf("export async function requireRosterEditor"));
    assert.match(fn, /resolvePanelRights\(/, "гвард не использует общее правило прав");
    assert.match(fn, /canEditRosterDiscordId/, "гвард не проверяет право правки состава");
  });

  test("межсайтовый запрос отклоняется собственной проверкой источника", () => {
    // Middleware — не единственный барьер (matcher может быть сужен), поэтому
    // роут обязан проверять источник сам: он меняет внешний документ
    const source = read("src/app/api/admin/roster/[id]/discord-id/route.ts");
    assert.match(source, /isCrossSiteRequest\(req\)/);
    assert.match(source, /isUnsafeMethod\(req\.method\)/);
  });

  test("валидация идёт общим валидатором, а не копией правила в роуте", () => {
    const source = read("src/app/api/admin/roster/[id]/discord-id/route.ts");
    assert.match(source, /validateRosterDiscordId\(body\.discordId\)/);
    // Копия регулярки в роуте разошлась бы с интерфейсом
    assert.equal(/\\d\{17,19\}/.test(source), false, "в роуте появилась своя регулярка ID");
  });

  test("обращения к базе и таблице перечислены явно", () => {
    const source = read("src/app/api/admin/roster/[id]/discord-id/route.ts");
    assert.match(source, /update\(members\)/, "нет обновления division_members");
    assert.match(source, /syncDiscordIdToSheet/, "нет вызова записи в Google Таблицу");
    // Правка внешнего документа должна попадать в журнал панели
    assert.match(source, /insert\(logs\)/);
  });

  test("сбой Google не откатывает правку в базе, но возвращается предупреждением", () => {
    const source = read("src/app/api/admin/roster/[id]/discord-id/route.ts");
    const handler = source.slice(source.indexOf("export async function PATCH"));
    // Порядок: сначала запись в БД, затем таблица — иначе решение штаба терялось бы
    const dbAt = handler.indexOf("update(members)");
    const sheetAt = handler.indexOf("await syncSheet(");
    assert.ok(dbAt > 0 && sheetAt > dbAt, "таблица обновляется раньше базы");
    assert.match(handler, /warning:/);
  });
});

/* ------------------------------------------------------------------ */
/* Вход в раздел                                                       */
/* ------------------------------------------------------------------ */

describe("Доступ к правке через middleware и адрес раздела", () => {
  test("роут правки защищён на входе: без сессии — 401 JSON", async () => {
    const res = await middleware(
      new NextRequest(new URL("/api/admin/roster/7/discord-id", "http://panel.example"), {
        method: "PATCH",
        headers: { host: "panel.example" },
      })
    );
    assert.equal(res.status, 401);
  });

  test("адрес /roster ведёт на рабочий табель /members", () => {
    // Раздел «Состав» живёт на /members: второй копии интерфейса быть не должно
    const source = read("src/app/roster/page.tsx");
    assert.match(source, /redirect\("\/members"\)/);
  });

  test("страница состава показывает окно правки командиру и администратору", () => {
    const source = read("src/app/members/page.tsx");
    // Окно правки (запись и в панель, и в ШДС) доступно всем, кому разрешена
    // правка: право приходит флагом из /api/me, а не выводится из роли
    assert.match(source, /canEditDiscordId \? \(/, "нет ветки правки в колонке");
    assert.match(source, /<DiscordIdCell/);
    assert.match(source, /\/api\/admin\/roster\/\$\{id\}\/discord-id/);
    // Право берётся из флагов /api/me: у командира подразделения роль панели
    // может быть пустой, и по одной ей поле оставалось только для чтения
    assert.match(source, /setCanEditRosterDiscordId\(Boolean\(me\.isCommander \|\| me\.isAdmin\)\)/);
    // Колонка видна по тому же признаку: иначе поле было бы скрыто у командира
    // с ролью «member», у которого права идут от должности
    assert.match(source, /setCanViewPrivate\(Boolean\(me\.canViewPrivate\)\)/);
  });

  test("сводка «Без Discord ID» считается из тех же данных, что и строки", () => {
    // Иначе оптимистичное обновление строки не пересчитывало бы плашку
    const source = read("src/app/members/page.tsx");
    assert.match(source, /const withoutDiscord = active\.filter\(\(m\) => !m\.discordId\)\.length/);
  });
});