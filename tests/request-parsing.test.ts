/**
 * Тесты разбора заявок: «Редакция ШДС», отпуск, запас.
 *
 * Проверяем БОЕВОЙ модуль src/lib/gsheets.ts (не копию логики), поэтому тест
 * ловит регрессию, если правила разбора изменят.
 *
 * Почему это важно: почти все «заявка ушла не туда» и «ничего не произошло»
 * на практике — это ошибка разбора текста, а не сбой сети или Google.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRequestText, SHDS_ACTIONS, resolveLayout } from "@/lib/gsheets.ts";

/** Заявка как её шлёт бот формы или пишет человек */
const request = (...lines: string[]) => lines.join("\n");

describe("parseRequestText — операции ШДС", () => {
  test("«Добавление в ШДС» распознаётся как ADD", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Добавление в ШДС",
        "Имя пользователя: Петров",
        "Звание: Рядовой",
        "Steam ID: STEAM_0:1:12345",
        "Discord ID: 123456789012345678"
      )
    );
    assert.ok(parsed, "заявка должна разобраться");
    assert.equal(parsed.shdsAction, SHDS_ACTIONS.ADD);
    assert.equal(parsed.unit, "Танковая рота");
    assert.equal(parsed.userName, "Петров");
    assert.equal(parsed.rank, "Рядовой");
    assert.equal(parsed.steamId, "STEAM_0:1:12345");
    assert.equal(parsed.discordId, "123456789012345678");
    assert.equal(parsed.isVacation, false);
  });

  test("«Изменение звания» → RANK", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Изменение звания",
        "Имя пользователя: Петров",
        "Звание: Капитан"
      )
    );
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.RANK);
  });

  test("слово «должность» → POST (перенос и зачистка)", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Изменение должности (перенос и зачистка)",
        "Имя пользователя: Петров",
        "Должность: Командир орудия"
      )
    );
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.POST);
    assert.equal(parsed?.должность, "Командир орудия");
  });

  test("слово «экзамен» → EXAM, экзамены разбираются по запятой", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Получение подтверждения об экзаменации",
        "Имя пользователя: Петров",
        "Сданные экзамены: Огневая, Тактика",
        "Оценка: Отлично",
        "Экзаменатор: Иванов И.И."
      )
    );
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.EXAM);
    assert.deepEqual(parsed?.exams, ["Огневая", "Тактика"]);
    assert.equal(parsed?.grade, "Отлично");
    assert.equal(parsed?.examiner, "Иванов И.И.");
  });

  test("слово «убрать» → REMOVE", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Убрать из таблицы",
        "Имя пользователя: Петров"
      )
    );
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.REMOVE);
  });

  test("регистр слов не важен", () => {
    const parsed = parseRequestText(
      request(
        "подразделение: Танковая рота",
        "редакция шдс: добавление в шдс",
        "имя пользователя: Петров"
      )
    );
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.ADD);
  });
});

describe("parseRequestText — запас (уход и возврат не путаются)", () => {
  test("«Уход в запас» → RESERVE_GO", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Уход в запас",
        "Имя пользователя: Петров",
        "Discord ID: 123456789012345678"
      )
    );
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.RESERVE_GO);
  });

  test("«Возврат из запаса» → RESERVE_BACK (а не GO!)", () => {
    // Регрессия-ловушка: в обеих строках есть слово «запас», и если проверять
    // «запас» раньше «возврат», возврат уедет в уход.
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Возврат из запаса",
        "Имя пользователя: Петров"
      )
    );
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.RESERVE_BACK);
  });

  test("«Вернуться из запаса» → RESERVE_BACK", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Вернуться из запаса",
        "Имя пользователя: Петров"
      )
    );
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.RESERVE_BACK);
  });

  test("заявка запаса НЕ считается отпуском", () => {
    const parsed = parseRequestText(
      request(
        "Тип заявки: Запас",
        "Подразделение: Танковая рота",
        "Редакция ШДС: Уход в запас",
        "Имя пользователя: Петров"
      )
    );
    assert.equal(parsed?.isVacation, false);
    assert.equal(parsed?.shdsAction, SHDS_ACTIONS.RESERVE_GO);
  });

  test("заявка запаса без подразделения отбрасывается", () => {
    // Лист-источник нужен, чтобы знать, откуда переносить строку.
    const parsed = parseRequestText(
      request("Редакция ШДС: Уход в запас", "Имя пользователя: Петров")
    );
    assert.equal(parsed, null);
  });
});

describe("parseRequestText — отпуск", () => {
  test("«Отпуск» → isVacation, без снятия", () => {
    const parsed = parseRequestText(
      request(
        "Тип заявки: Отпуск",
        "Имя пользователя: Петров",
        "Даты отпуска: с 10.11.2026 по 20.11.2026"
      )
    );
    assert.equal(parsed?.isVacation, true);
    assert.equal(parsed?.vacationRemove, false);
    assert.equal(parsed?.vacationDates, "с 10.11.2026 по 20.11.2026");
  });

  test("«Снятие отпуска» → vacationRemove", () => {
    const parsed = parseRequestText(
      request("Тип заявки: Снятие отпуска", "Имя пользователя: Петров")
    );
    assert.equal(parsed?.isVacation, true);
    assert.equal(parsed?.vacationRemove, true);
  });

  test("«Выход из отпуска» → vacationRemove", () => {
    const parsed = parseRequestText(
      request("Тип заявки: Выход из отпуска", "Имя пользователя: Петров")
    );
    assert.equal(parsed?.vacationRemove, true);
  });

  test("отпуск НЕ требует подразделения (в таблицу не пишется)", () => {
    const parsed = parseRequestText(
      request("Тип заявки: Отпуск", "Имя пользователя: Петров")
    );
    assert.ok(parsed, "отпуск без подразделения должен разбираться");
    assert.equal(parsed.isVacation, true);
  });
});

describe("parseRequestText — защита от мусора и подделок", () => {
  test("без «Имя пользователя» заявка отбрасывается", () => {
    const parsed = parseRequestText(
      request("Подразделение: Танковая рота", "Редакция ШДС: Добавление в ШДС")
    );
    assert.equal(parsed, null);
  });

  test("обычный текст в канале не считается заявкой", () => {
    assert.equal(parseRequestText("Привет, бойцы! Сегодня операция в 20:00."), null);
    assert.equal(parseRequestText(""), null);
  });

  test("Discord ID чистится до цифр (упоминание тоже подходит)", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Добавление в ШДС",
        "Имя пользователя: Петров",
        "Discord ID: <@123456789012345678>"
      )
    );
    assert.equal(parsed?.discordId, "123456789012345678");
  });

  test("«Роли выдать» / «Роли снять» переносятся как есть", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Добавление в ШДС",
        "Имя пользователя: Петров",
        "Роли выдать: Игроман, Игломан2",
        "Роли снять: Друг АТК"
      )
    );
    assert.equal(parsed?.rolesGive, "Игроман, Игломан2");
    assert.equal(parsed?.rolesRemove, "Друг АТК");
  });

  test("неизвестная «Редакция ШДС» не превращается в действие", () => {
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Какая-то новая операция",
        "Имя пользователя: Петров"
      )
    );
    assert.ok(parsed);
    assert.equal(parsed.shdsAction, null);
  });

  test("экранированные символы в имени не ломают разбор", () => {
    // Имя с юникодом и пробелами должно попасть в userName целиком.
    const parsed = parseRequestText(
      request(
        "Подразделение: Танковая рота",
        "Редакция ШДС: Добавление в ШДС",
        "Имя пользователя: Клименко В.А."
      )
    );
    assert.equal(parsed?.userName, "Клименко В.А.");
  });
});

describe("resolveLayout — раскладка ШДС по подразделениям", () => {
  test("Танковая рота: колонка C, добавление в строки 42–56", () => {
    const layout = resolveLayout("Танковая рота");
    assert.equal(layout.key, "TR");
    assert.equal(layout.nameCol, "C");
    assert.deepEqual(layout.addRange, { top: 42, bottom: 56 });
    assert.deepEqual(layout.overall, { top: 10, bottom: 56 });
  });

  test("Артиллерийский дивизион: колонка D, добавление в строки 32–41", () => {
    const layout = resolveLayout("Артиллерийский дивизион");
    assert.equal(layout.key, "AD");
    assert.equal(layout.nameCol, "D");
    assert.deepEqual(layout.addRange, { top: 32, bottom: 41 });
  });

  test("название не строгое: «танковая рота» в нижнем регистре работает", () => {
    assert.equal(resolveLayout("танковая рота").key, "TR");
    assert.equal(resolveLayout("Артиллерийский дивизион").key, "AD");
  });

  test("неизвестное подразделение — явная ошибка (а не запись наугад)", () => {
    assert.throws(() => resolveLayout("Морская пехота"), /Неизвестное подразделение/);
  });
});