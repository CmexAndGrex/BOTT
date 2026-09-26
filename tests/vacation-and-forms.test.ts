/**
 * Тесты логики отпусков и заявок из Google-формы.
 *
 * Проверяются боевые модули src/lib/bot.ts (разбор дат) и src/lib/forms.ts
 * (маршрутизация заявки в нужный канал Discord).
 *
 * Почему это важно: ошибка в разборе даты = отпуск не закроется сам,
 * ошибка маршрутизации = заявка уйдёт не в тот канал и её не заметят.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseVacationUntil, formatDate } from "@/lib/bot.ts";
import { buildRequestMessage, type FormResponse } from "@/lib/forms.ts";

/** Дата в московском представлении — так её видит боец и панель */
const asMskDate = (iso: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));

describe("parseVacationUntil — разбор даты окончания отпуска", () => {
  test("диапазон «с 10.11.2026 по 20.11.2026» → берётся дата окончания", () => {
    const until = parseVacationUntil("с 10.11.2026 по 20.11.2026");
    assert.ok(until, "дата должна разобраться");
    assert.equal(formatDate(until), "20.11.2026");
  });

  test("диапазон с дефисом «10.11.2026 - 20.11.2026»", () => {
    const until = parseVacationUntil("10.11.2026 - 20.11.2026");
    assert.equal(formatDate(until), "20.11.2026");
  });

  test("диапазон с длинным тире «10.11.2026 – 20.11.2026»", () => {
    const until = parseVacationUntil("10.11.2026 – 20.11.2026");
    assert.equal(formatDate(until), "20.11.2026");
  });

  test("одна дата «20.11.2026» — это и есть дата возвращения", () => {
    const until = parseVacationUntil("20.11.2026");
    assert.equal(formatDate(until), "20.11.2026");
  });

  test("короткая запись «20.11» — год подставляется (дата не в прошлом)", () => {
    const until = parseVacationUntil("20.11");
    assert.ok(until, "короткая дата должна разбираться");
    // Иначе отпуск закрылся бы сразу же после одобрения
    assert.ok(until.getTime() > Date.now() - 24 * 60 * 60 * 1000);
  });

  test("пустая строка → null (дата не выдумывается)", () => {
    assert.equal(parseVacationUntil(""), null);
  });

  test("текст без даты → null", () => {
    assert.equal(parseVacationUntil("пока не знаю"), null);
  });

  test("дата трактуется как 00:01 по Москве (не съезжает на день назад)", () => {
    const until = parseVacationUntil("20.11.2026");
    assert.ok(until);
    assert.equal(asMskDate(until.toISOString()), "20.11.2026");
  });

  test("formatDate: некорректная дата → прочерк, а не «Invalid Date»", () => {
    assert.equal(formatDate(null), "—");
    assert.equal(formatDate(new Date("не дата")), "—");
  });
});

/** Заготовка ответа формы: заполняем только нужные поля */
const formResponse = (patch: Partial<FormResponse>): FormResponse => ({
  timestamp: "01.11.2026 12:00:00",
  userName: "Петров",
  discordId: "123456789012345678",
  requestType: "",
  unit: "Танковая рота",
  rank: "",
  steamId: "",
  role: "",
  roleGive: "",
  roleRemove: "",
  exam: "",
  grade: "",
  examiner: "",
  otdelenie: "",
  vacationDates: "",
  reason: "",
  ...patch,
});

/** Настройки панели в виде Map — так их видит forms.ts */
const settings = (patch: Record<string, string> = {}) =>
  new Map<string, string>(
    Object.entries({
      shds_channel_id: "111111111111111111",
      vacation_channel_id: "222222222222222222",
      roles_channel_id: "333333333333333333",
      command_role_id: "444444444444444444",
      ...patch,
    })
  );

describe("buildRequestMessage — маршрутизация заявок по каналам", () => {
  test("«Добавить в ШДС» → канал ШДС", () => {
    const built = buildRequestMessage(
      formResponse({ requestType: "Добавить в ШДС", rank: "Рядовой", steamId: "STEAM_0:1:1" }),
      settings()
    );
    assert.ok(built);
    assert.equal(built.channelKey, "shds_channel_id");
    assert.match(built.content, /Редакция ШДС: Добавление в ШДС/);
    assert.match(built.content, /Звание: Рядовой/);
  });

  test("«Отпуск» → канал отпусков", () => {
    const built = buildRequestMessage(
      formResponse({ requestType: "Отпуск", vacationDates: "с 10.11.2026 по 20.11.2026" }),
      settings()
    );
    assert.ok(built);
    assert.equal(built.channelKey, "vacation_channel_id");
    assert.match(built.content, /Тип заявки: Отпуск/);
    assert.match(built.content, /Даты отпуска: с 10\.11\.2026 по 20\.11\.2026/);
  });

  test("«Снять отпуск» → канал отпусков, тип «Снятие отпуска»", () => {
    // Ловушка: строка содержит «снять», но это НЕ управление ролями
    const built = buildRequestMessage(
      formResponse({ requestType: "Снять отпуск" }),
      settings()
    );
    assert.ok(built);
    assert.equal(built.channelKey, "vacation_channel_id");
    assert.match(built.content, /Тип заявки: Снятие отпуска/);
  });

  test("«Управление ролями» → канал запросов ролей", () => {
    const built = buildRequestMessage(
      formResponse({
        requestType: "Управление ролями",
        roleGive: "Игроман",
        roleRemove: "Друг АТК",
      }),
      settings()
    );
    assert.ok(built);
    assert.equal(built.channelKey, "roles_channel_id");
    assert.match(built.content, /^<@123456789012345678>/);
    assert.match(built.content, /Выдать Игроман, Снять Друг АТК/);
  });

  test("«Уйти в запас» → канал ШДС с действием «Уход в запас»", () => {
    const built = buildRequestMessage(
      formResponse({ requestType: "Уйти в запас", rank: "Рядовой" }),
      settings()
    );
    assert.ok(built);
    assert.equal(built.channelKey, "shds_channel_id");
    assert.match(built.content, /Редакция ШДС: Уход в запас/);
  });

  test("«Вернуться из запаса» → канал ШДС с действием «Возврат из запаса»", () => {
    const built = buildRequestMessage(
      formResponse({ requestType: "Вернуться из запаса" }),
      settings()
    );
    assert.ok(built);
    assert.equal(built.channelKey, "shds_channel_id");
    assert.match(built.content, /Редакция ШДС: Возврат из запаса/);
  });

  test("«Сдать экзамен» → канал ШДС с подтверждением экзаменации", () => {
    const built = buildRequestMessage(
      formResponse({ requestType: "Сдать экзамен", exam: "Огневая", grade: "Отлично" }),
      settings()
    );
    assert.ok(built);
    assert.equal(built.channelKey, "shds_channel_id");
    assert.match(built.content, /Получение подтверждения об экзаменации/);
    assert.match(built.content, /Сданные экзамены: Огневая/);
  });

  test("«Убрать из ШДС» → канал ШДС + пинг Командирского состава", () => {
    // Ловушка: строка содержит «шдс», но это удаление, а не добавление
    const built = buildRequestMessage(
      formResponse({ requestType: "Убрать из ШДС" }),
      settings()
    );
    assert.ok(built);
    assert.equal(built.channelKey, "shds_channel_id");
    assert.match(built.content, /Редакция ШДС: Убрать из таблицы/);
    assert.match(built.content, /<@&444444444444444444>/);
  });

  test("неизвестный тип заявки → null (бот не публикует мусор)", () => {
    assert.equal(
      buildRequestMessage(formResponse({ requestType: "Что-то непонятное" }), settings()),
      null
    );
  });

  test("без настроенного канала заявка не публикуется (а не падает)", () => {
    const built = buildRequestMessage(
      formResponse({ requestType: "Уйти в запас" }),
      settings({ shds_channel_id: "" })
    );
    assert.equal(built, null);
  });

  test("заявка ролей без Discord ID не публикуется (некому выдавать)", () => {
    const built = buildRequestMessage(
      formResponse({ requestType: "Управление ролями", discordId: "", roleGive: "Игроман" }),
      settings()
    );
    assert.equal(built, null);
  });
});