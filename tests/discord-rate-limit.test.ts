/**
 * Тесты устойчивости к лимитам Discord и сверки ролей.
 *
 * Проверяются два боевых модуля: src/lib/discord-queue.ts (очередь запросов,
 * Retry-After, экспоненциальная задержка) и src/lib/role-sync.ts (сопоставление
 * ролей, дельта, применение). Это самая опасная часть бота: ошибка в дельте
 * означает, что боец потерял звание или получил права, которых не заслужил, а
 * ошибка в задержках — что панель и бот вместе упираются в лимит Discord и
 * перестают работать оба.
 *
 * Время в тестах ручное: очередь получает собственные `now` и `sleep`, поэтому
 * проверка пауз не занимает реальных секунд.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BACKOFF,
  DiscordApiError,
  DiscordRequestQueue,
  backoffDelayMs,
  isRetryableDiscordError,
  parseRetryAfterMs,
  queueOptionsFromSettings,
  statusOfError,
} from "@/lib/discord-queue.ts";
import {
  buildRoleSyncLog,
  computeRoleDelta,
  desiredRoles,
  managedRoleIds,
  normalizeKey,
  parsePostRoleMap,
  parseRank,
  planRoleSync,
  applyPlan,
  roleSyncSchedule,
  runRoleSync,
  subdivForUnit,
  summarizePlan,
  type GuildRoleInfo,
  type RoleSyncMember,
} from "@/lib/role-sync.ts";
import { COMMON_ROLE_IDS, RANK_ROLE_IDS, SUBDIV_ROLE_IDS } from "@/lib/roles.ts";

/* ------------------------------------------------------------------ */
/* Ручные часы                                                         */
/* ------------------------------------------------------------------ */

/**
 * Часы теста: `sleep` двигает время вперёд.
 *
 * Без этого очередь ждала бы реальные секунды, дойдя до 60-секундного потолка
 * задержки. Здесь время двигается ровно на запрошенную паузу — поведение то же,
 * а тест выполняется мгновенно.
 */
function manualClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      // Плюс миллисекунда: очередь должна увидеть, что пауза истекла, а не
      // остаться ровно на её границе и ждать второй раз тот же срок.
      now += ms + 1;
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Ошибка Discord указанного статуса: 429 с Retry-After или 5xx/4xx */
function apiError(status: number, retryAfterMs: number | null = null): DiscordApiError {
  return new DiscordApiError(`Discord API (${status})`, { status, retryAfterMs, path: "/test" });
}

/* ------------------------------------------------------------------ */
/* Разбор Retry-After и признак повторяемости                           */
/* ------------------------------------------------------------------ */

describe("parseRetryAfterMs — сколько ждать после лимита", () => {
  test("целые секунды в заголовке", () => {
    assert.equal(parseRetryAfterMs("5", null), 5000);
  });

  test("дробные секунды в теле ответа", () => {
    // Discord в теле 429 присылает дробное число: 1.5 → 1500 мс
    assert.equal(parseRetryAfterMs(null, 1.5), 1500);
  });

  test("заголовок важнее тела", () => {
    // Заголовок описывает весь бакет, retry_after — конкретный запрос
    assert.equal(parseRetryAfterMs("3", 10), 3000);
  });

  test("дата в заголовке (стандарт HTTP) тоже принимается", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    const value = parseRetryAfterMs("Sun, 28 Sep 2026 12:00:07 GMT", null, now);
    assert.equal(value, 7000);
  });

  test("число строкой из тела", () => {
    assert.equal(parseRetryAfterMs(null, "2"), 2000);
  });

  test("нет данных — null, а не выдуманный ноль", () => {
    // Ноль означал бы «повторяй немедленно» и гарантированный второй 429
    assert.equal(parseRetryAfterMs(null, null), null);
    assert.equal(parseRetryAfterMs("", undefined), null);
    assert.equal(parseRetryAfterMs("не число", "abc"), null);
  });
});

describe("isRetryableDiscordError — что имеет смысл повторять", () => {
  test("429 повторяем", () => {
    assert.equal(isRetryableDiscordError(apiError(429)), true);
  });

  test("5xx повторяем", () => {
    assert.equal(isRetryableDiscordError(apiError(500)), true);
    assert.equal(isRetryableDiscordError(apiError(503)), true);
  });

  test("сетевой сбой (нет статуса) повторяем", () => {
    assert.equal(isRetryableDiscordError(new Error("fetch failed")), true);
    assert.equal(statusOfError(new Error("fetch failed")), 0);
  });

  test("4xx повторять нельзя: это наша ошибка, а не лимит", () => {
    assert.equal(isRetryableDiscordError(apiError(403)), false);
    assert.equal(isRetryableDiscordError(apiError(404)), false);
    assert.equal(isRetryableDiscordError(apiError(400)), false);
  });
});

/* ------------------------------------------------------------------ */
/* Экспоненциальная задержка                                           */
/* ------------------------------------------------------------------ */

describe("backoffDelayMs — экспонента, джиттер и приоритет Retry-After", () => {
  test("без Retry-After задержка растёт экспоненциально", () => {
    // random = 0 → джиттер не добавляет ничего, видна чистая экспонента
    const low = () => 0;
    assert.equal(backoffDelayMs(1, null, DEFAULT_BACKOFF, low), 750);
    assert.equal(backoffDelayMs(2, null, DEFAULT_BACKOFF, low), 1500);
    assert.equal(backoffDelayMs(3, null, DEFAULT_BACKOFF, low), 3000);
    assert.equal(backoffDelayMs(4, null, DEFAULT_BACKOFF, low), 6000);
  });

  test("рост ограничен потолком maxMs", () => {
    // random = 0: без добавки джиттера видно именно потолок
    const low = () => 0;
    // 2^19 * 750 — астрономическая величина, но потолок её срезает
    assert.equal(backoffDelayMs(20, null, DEFAULT_BACKOFF, low), DEFAULT_BACKOFF.maxMs);
    // С джиттером потолок может быть превышен не более чем на его долю
    assert.ok(
      backoffDelayMs(20, null, DEFAULT_BACKOFF, () => 1) <= DEFAULT_BACKOFF.maxMs * 1.25
    );
  });

  test("джиттер не делает задержку короче базовой", () => {
    // random = 0 — самый неблагоприятный случай: всё равно не меньше экспоненты.
    // Джиттер сдвигает паузу только вверх: укороченная пауза означала бы повтор
    // раньше, чем Discord отпустит лимит.
    const low = () => 0;
    assert.equal(backoffDelayMs(1, null, DEFAULT_BACKOFF, low), 750);
    assert.equal(backoffDelayMs(2, null, DEFAULT_BACKOFF, low), 1500);
  });

  test("джиттер не превышает заданную долю разброса", () => {
    const high = () => 1;
    // 750 * 1.25 = 937.5 → округление вверх
    assert.equal(backoffDelayMs(1, null, DEFAULT_BACKOFF, high), 938);
  });

  test("Retry-After от Discord важнее собственной экспоненты", () => {
    // 90 секунд не должны урезаться до 60-секундного потолка: иначе следующий
    // запрос снова получит 429 и лимит сбросится ещё раз
    assert.equal(backoffDelayMs(1, 90_000, DEFAULT_BACKOFF, () => 0.5), 90_000);
    assert.equal(backoffDelayMs(5, 1_200, DEFAULT_BACKOFF, () => 0.5), 1_200);
  });

  test("нулевая задержка не превращается в отрицательную", () => {
    assert.ok(backoffDelayMs(1, 0, DEFAULT_BACKOFF, () => 0.5) >= 0);
    assert.ok(backoffDelayMs(-5, null, DEFAULT_BACKOFF, () => 0.5) > 0);
  });
});

/* ------------------------------------------------------------------ */
/* Очередь запросов                                                    */
/* ------------------------------------------------------------------ */

describe("DiscordRequestQueue — ограничение нагрузки на Discord", () => {
  test("одновременных запросов не больше заданного лимита", async () => {
    const clock = manualClock();
    const queue = new DiscordRequestQueue(
      { concurrency: 2, minIntervalMs: 0, maxAttempts: 1 },
      { now: clock.now, sleep: clock.sleep }
    );

    let inFlight = 0;
    let maxInFlight = 0;
    const task = () =>
      queue.run("test", async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Уступаем управление: без этого все задачи «одновременны» искусственно
        await Promise.resolve();
        inFlight--;
      });

    await Promise.all([task(), task(), task(), task(), task()]);

    assert.equal(maxInFlight, 2, "должно выполняться не больше двух запросов");
  });

  test("429 возвращает задачу в очередь и повторяет её после паузы", async () => {
    const clock = manualClock();
    const queue = new DiscordRequestQueue(
      { concurrency: 1, minIntervalMs: 0, maxAttempts: 3, backoff: DEFAULT_BACKOFF },
      { now: clock.now, sleep: clock.sleep, random: () => 0.5 }
    );

    let attempts = 0;
    const result = await queue.run("roles:add", async () => {
      attempts++;
      if (attempts < 3) throw apiError(429, 2_000);
      return "готово";
    });

    assert.equal(result, "готово");
    assert.equal(attempts, 3, "запрос должен быть повторён до успеха");
    // Пауза взята из Retry-After (2000 мс), а не из собственной экспоненты
    assert.ok(
      clock.sleeps.every((ms) => ms === 2_000),
      `ожидались паузы по 2000 мс, получено: ${clock.sleeps.join(", ")}`
    );
  });

  test("4xx не повторяется: это наша ошибка, а не лимит", async () => {
    const clock = manualClock();
    const queue = new DiscordRequestQueue(
      { concurrency: 1, minIntervalMs: 0, maxAttempts: 5 },
      { now: clock.now, sleep: clock.sleep, random: () => 0.5 }
    );

    let attempts = 0;
    await assert.rejects(
      () =>
        queue.run("roles:add", async () => {
          attempts++;
          throw apiError(403);
        }),
      (error: unknown) => {
        assert.equal(statusOfError(error), 403);
        return true;
      }
    );

    assert.equal(attempts, 1, "403 повторять бессмысленно: Discord ответит так же");
    assert.equal(queue.stats().retries, 0);
    assert.equal(queue.stats().failed, 1);
  });

  test("повторы прекращаются после исчерпания попыток", async () => {
    const clock = manualClock();
    const queue = new DiscordRequestQueue(
      { concurrency: 1, minIntervalMs: 0, maxAttempts: 2 },
      { now: clock.now, sleep: clock.sleep, random: () => 0.5 }
    );

    let attempts = 0;
    await assert.rejects(() =>
      queue.run("roles:add", async () => {
        attempts++;
        throw apiError(500);
      })
    );

    assert.equal(attempts, 2, "две попытки: первая и одна повторная");
  });

  test("пауза не удерживает слот очереди", async () => {
    const clock = manualClock();
    const queue = new DiscordRequestQueue(
      { concurrency: 1, minIntervalMs: 0, maxAttempts: 2 },
      { now: clock.now, sleep: clock.sleep, random: () => 0.5 }
    );

    const order: string[] = [];
    let failingFirst = true;

    // Первая задача поймает лимит и уйдёт на паузу, вторая — короткая, и она
    // должна выполниться ЗА ВРЕМЯ этой паузы, а не после неё. Иначе один 429
    // останавливал бы всю обработку (слоты заняты спящими задачами).
    const slow = queue.run("slow", async () => {
      if (failingFirst) {
        failingFirst = false;
        throw apiError(429, 10_000);
      }
      order.push("slow");
    });
    const quick = queue.run("quick", async () => {
      order.push("quick");
    });

    await Promise.all([slow, quick]);

    assert.deepEqual(
      order,
      ["quick", "slow"],
      "короткий запрос не должен ждать паузу чужого лимита"
    );
  });

  test("диагностика очереди показывает повторы и пустую очередь", async () => {
    const clock = manualClock();
    const queue = new DiscordRequestQueue(
      { concurrency: 1, minIntervalMs: 0, maxAttempts: 2 },
      { now: clock.now, sleep: clock.sleep, random: () => 0.5 }
    );

    let failingFirst = true;
    await queue.run("roles:add", async () => {
      if (failingFirst) {
        failingFirst = false;
        throw apiError(429, 750);
      }
    });

    const stats = queue.stats();
    assert.equal(stats.retries, 1);
    assert.equal(stats.failed, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.running, 0);
  });
});

describe("queueOptionsFromSettings — границы параметров из панели", () => {
  test("корректные значения принимаются", () => {
    const options = queueOptionsFromSettings({
      concurrency: "4",
      intervalMs: "250",
      attempts: "5",
    });
    assert.equal(options.concurrency, 4);
    assert.equal(options.minIntervalMs, 250);
    assert.equal(options.maxAttempts, 5);
  });

  test("слишком большие значения обрезаются", () => {
    // Параллелизм 1000 в настройках означал бы залп запросов и гарантированный 429
    const options = queueOptionsFromSettings({
      concurrency: "1000",
      intervalMs: "999999",
      attempts: "100",
    });
    assert.equal(options.concurrency, 8);
    assert.equal(options.minIntervalMs, 5_000);
    assert.equal(options.maxAttempts, 8);
  });

  test("мусор и пустые значения дают безопасные умолчания", () => {
    const options = queueOptionsFromSettings({
      concurrency: "abc",
      intervalMs: "",
      attempts: null,
    });
    assert.equal(options.concurrency, 2);
    assert.equal(options.minIntervalMs, 120);
    assert.equal(options.maxAttempts, 4);
  });
});

/* ------------------------------------------------------------------ */
/* Сопоставление данных панели с ролями сервера                        */
/* ------------------------------------------------------------------ */

/** Боец в строю: все поля заполнены — базовый случай для тестов дельты */
function activeMember(overrides: Partial<RoleSyncMember> = {}): RoleSyncMember {
  return {
    id: 1,
    name: "Гром",
    discordId: "111111111111111111",
    rank: "Капитан ТР",
    rankName: "Капитан ТР",
    unit: "Танковая рота",
    post: null,
    status: "active",
    active: true,
    vacation: false,
    // По умолчанию берет не сдан: тесты роли «Берет» задают признак явно
    beretPassed: false,
    ...overrides,
  };
}

/** Контекст сервера: роли, роль отпуска, роль запаса */
function context(overrides: Partial<Parameters<typeof computeRoleDelta>[2]> = {}) {
  const roles = new Map<string, GuildRoleInfo>(
    Object.entries(RANK_ROLE_IDS).map(([name, id]) => [id, { id, name, managed: false }])
  );
  roles.set(SUBDIV_ROLE_IDS["ТР"], { id: SUBDIV_ROLE_IDS["ТР"], name: "Танковая рота", managed: false });
  roles.set(SUBDIV_ROLE_IDS["АД"], { id: SUBDIV_ROLE_IDS["АД"], name: "Артиллерийский дивизион", managed: false });
  roles.set(COMMON_ROLE_IDS.RECRUIT, { id: COMMON_ROLE_IDS.RECRUIT, name: "Новобранец", managed: false });
  roles.set(COMMON_ROLE_IDS.FRIEND, { id: COMMON_ROLE_IDS.FRIEND, name: "Друг АТК", managed: false });
  roles.set(COMMON_ROLE_IDS.ATK_CORPS, { id: COMMON_ROLE_IDS.ATK_CORPS, name: "АТК", managed: false });
  roles.set(COMMON_ROLE_IDS.RANKS_CATEGORY, { id: COMMON_ROLE_IDS.RANKS_CATEGORY, name: "Звания", managed: false });

  return {
    everyoneRoleId: "999999999999999999",
    roles,
    leaveRoleId: "555555555555555555",
    reserveRoleId: "666666666666666666",
    ...overrides,
  };
}

describe("parseRank и subdivForUnit — разбор данных разной формы", () => {
  test("составное звание разделяется на звание и подразделение", () => {
    assert.deepEqual(parseRank("Капитан ТР"), { rank: "Капитан", subdiv: "ТР" });
    assert.deepEqual(parseRank("Ст. Лейтенант АД"), { rank: "Ст. Лейтенант", subdiv: "АД" });
  });

  test("регистр и точки не важны", () => {
    assert.deepEqual(parseRank("ст.лейтенант тр"), { rank: "Ст. Лейтенант", subdiv: "ТР" });
    assert.deepEqual(parseRank("КАПИТАН"), { rank: "Капитан", subdiv: null });
  });

  test("неизвестное звание — null, а не выдуманное совпадение", () => {
    // Важно: именно null, а не первое похожее — иначе бойцу выдали бы чужое звание
    assert.deepEqual(parseRank("Генерал-майор"), { rank: null, subdiv: null });
    assert.deepEqual(parseRank(""), { rank: null, subdiv: null });
    assert.deepEqual(parseRank(null), { rank: null, subdiv: null });
  });

  test("«Курсант» распознаётся, хотя роли на сервере нет", () => {
    assert.deepEqual(parseRank("Курсант"), { rank: "Курсант", subdiv: null });
  });

  test("подразделение по названию листа", () => {
    assert.equal(subdivForUnit("Танковая рота"), "ТР");
    assert.equal(subdivForUnit("Артиллерийский дивизион"), "АД");
    assert.equal(subdivForUnit(""), null);
    assert.equal(subdivForUnit("Морская пехота"), null);
  });

  test("normalizeKey приводит к сравнимому виду", () => {
    assert.equal(normalizeKey("Ст. Лейтенант"), normalizeKey("ст лейтенант"));
    assert.equal(normalizeKey("  Ефрейтор  "), "ефрейтор");
  });
});

/* ------------------------------------------------------------------ */
/* Дельта ролей: что выдаём и что снимаем                              */
/* ------------------------------------------------------------------ */

describe("computeRoleDelta — расхождения ролей", () => {
  test("новобранец получает полный комплект ролей в строю", () => {
    const delta = computeRoleDelta(
      activeMember(),
      [COMMON_ROLE_IDS.RECRUIT, COMMON_ROLE_IDS.FRIEND],
      context()
    );

    assert.ok(delta.add.includes(RANK_ROLE_IDS["Капитан"]), "звание должно быть выдано");
    assert.ok(delta.add.includes(SUBDIV_ROLE_IDS["ТР"]), "подразделение должно быть выдано");
    assert.ok(delta.add.includes(COMMON_ROLE_IDS.ATK_CORPS));
    assert.ok(delta.add.includes(COMMON_ROLE_IDS.RANKS_CATEGORY));
    assert.ok(delta.remove.includes(COMMON_ROLE_IDS.RECRUIT), "«Новобранец» лишний");
    assert.ok(delta.remove.includes(COMMON_ROLE_IDS.FRIEND), "«Друг АТК» лишний при службе");
  });

  test("смена звания: старое снимается, новое выдаётся", () => {
    const delta = computeRoleDelta(
      activeMember({ rank: "Майор ТР" }),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"], COMMON_ROLE_IDS.ATK_CORPS, COMMON_ROLE_IDS.RANKS_CATEGORY],
      context()
    );

    assert.deepEqual(delta.add, [RANK_ROLE_IDS["Майор"]]);
    assert.deepEqual(delta.remove, [RANK_ROLE_IDS["Капитан"]]);
  });

  test("перевод в другое подразделение меняет роль подразделения", () => {
    const delta = computeRoleDelta(
      activeMember({ rank: "Капитан АД", unit: "Артиллерийский дивизион" }),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"], COMMON_ROLE_IDS.ATK_CORPS, COMMON_ROLE_IDS.RANKS_CATEGORY],
      context()
    );

    assert.deepEqual(delta.add, [SUBDIV_ROLE_IDS["АД"]]);
    assert.deepEqual(delta.remove, [SUBDIV_ROLE_IDS["ТР"]]);
  });

  test("роли уже верны — пустая дельта, лишних запросов к Discord нет", () => {
    const delta = computeRoleDelta(
      activeMember(),
      [
        RANK_ROLE_IDS["Капитан"],
        SUBDIV_ROLE_IDS["ТР"],
        COMMON_ROLE_IDS.ATK_CORPS,
        COMMON_ROLE_IDS.RANKS_CATEGORY,
      ],
      context()
    );

    assert.deepEqual(delta.add, []);
    assert.deepEqual(delta.remove, []);
    assert.equal(delta.skipReason, "роли соответствуют данным");
  });

  test("отпуск выдаёт роль «Отпуск», возврат — снимает", () => {
    const onVacation = computeRoleDelta(
      activeMember({ vacation: true }),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"], COMMON_ROLE_IDS.ATK_CORPS, COMMON_ROLE_IDS.RANKS_CATEGORY],
      context()
    );
    assert.ok(onVacation.add.includes("555555555555555555"));

    const back = computeRoleDelta(
      activeMember(),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"], "555555555555555555"],
      context()
    );
    assert.ok(back.remove.includes("555555555555555555"), "роль отпуска должна быть снята");
  });

  test("вышел из состава: роли клана сняты, выдана «Друг АТК»", () => {
    const delta = computeRoleDelta(
      activeMember({ active: false, status: "dismissed" }),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"], COMMON_ROLE_IDS.ATK_CORPS],
      context()
    );

    assert.deepEqual(delta.add, [COMMON_ROLE_IDS.FRIEND]);
    assert.ok(delta.remove.includes(RANK_ROLE_IDS["Капитан"]));
    assert.ok(delta.remove.includes(SUBDIV_ROLE_IDS["ТР"]));
    assert.ok(delta.remove.includes(COMMON_ROLE_IDS.ATK_CORPS));
  });

  test("перевод в запас: роль «Запас» выдана, клан-роли сняты", () => {
    // «В запасе» отличается от «вышел» наличием роли «Запас» на сервере: в базе
    // оба состояния одинаковы (active = false при статусе dismissed)
    const delta = computeRoleDelta(
      activeMember({ active: false, status: "dismissed", vacation: true }),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"], "555555555555555555", "666666666666666666"],
      context()
    );

    assert.ok(!delta.remove.includes("666666666666666666"), "роль запаса не снимается");
    assert.ok(delta.remove.includes(RANK_ROLE_IDS["Капитан"]));
    assert.ok(delta.remove.includes("555555555555555555"), "роль отпуска в запасе лишняя");
    assert.deepEqual(delta.add, [], "роль запаса уже стоит — повторно не выдаём");
  });

  test("выбывший без роли «Запас» не получает её автоматически", () => {
    // Иначе роль «Запас» надели бы на всех, кто вышел из подразделения
    const delta = computeRoleDelta(
      activeMember({ active: false, status: "dismissed" }),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"]],
      context()
    );

    assert.ok(!delta.add.includes("666666666666666666"));
    assert.deepEqual(delta.add, [COMMON_ROLE_IDS.FRIEND]);
  });

  test("рапорт на рассмотрении: роли клана не выдаются", () => {
    const delta = computeRoleDelta(
      activeMember({ status: "pending" }),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"]],
      context()
    );

    assert.deepEqual(delta.add, [], "новобранцу в рассмотрении роли клана не выдаются");
    assert.ok(delta.remove.includes(RANK_ROLE_IDS["Капитан"]));
  });
});

describe("computeRoleDelta — защиты от порчи ролей", () => {
  test("кастомные роли вне справочника не снимаются", () => {
    // «Игроман», «Модератор» и прочие роли клана ведутся людьми: синхронизация
    // не должна их вычистить, даже если роль лишняя по данным панели
    const delta = computeRoleDelta(
      activeMember({ rank: "Майор ТР" }),
      [
        RANK_ROLE_IDS["Капитан"],
        SUBDIV_ROLE_IDS["ТР"],
        "777777777777777777", // «Игроман» — вне справочника
      ],
      context()
    );

    assert.ok(!delta.remove.includes("777777777777777777"));
    assert.equal(delta.removeNames.includes("777777777777777777"), false);
  });

  test("роль @everyone не снимается ни при каких данных", () => {
    const everyone = "999999999999999999";
    const delta = computeRoleDelta(activeMember(), [everyone, COMMON_ROLE_IDS.RECRUIT], context());

    assert.ok(!delta.remove.includes(everyone));
    assert.ok(!delta.add.includes(everyone));
  });

  test("managed-роли (бота и интеграции) не трогаются", () => {
    const managedId = "888888888888888888";
    const roles = context().roles;
    // Роль «Экзамен» выдаёт сторонний бот — Discord не даст её снять вручную
    roles.set(managedId, { id: managedId, name: "Экзамен", managed: true });

    const delta = computeRoleDelta(
      activeMember(),
      [managedId, COMMON_ROLE_IDS.RECRUIT],
      context({ roles })
    );

    assert.ok(!delta.remove.includes(managedId));
  });

  test("защищённые роли из настроек не трогаются", () => {
    // Страховка от ошибки в настройках: «модератор = Капитан» не должен
    // приводить к снятию роли модератора у действующего модератора
    const delta = computeRoleDelta(
      activeMember({ active: false, status: "dismissed" }),
      [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"]],
      context({ protectedRoleIds: [RANK_ROLE_IDS["Капитан"]] })
    );

    assert.ok(!delta.remove.includes(RANK_ROLE_IDS["Капитан"]));
    assert.ok(delta.remove.includes(SUBDIV_ROLE_IDS["ТР"]), "остальные роли снимаются");
  });

  test("неизвестное звание не приводит к снятию ролей", () => {
    // Боец с званием, которого нет в справочнике: данные неполные, поэтому
    // снятие откладывается — иначе он потерял бы всё звание целиком.
    // Выдача того, что известно (например, роли подразделения), при этом идёт:
    // «не знаю звание» не означает «не делай ничего».
    const delta = computeRoleDelta(
      activeMember({ rank: "Генерал-армии", rankName: "Генерал-армии" }),
      [RANK_ROLE_IDS["Майор"], SUBDIV_ROLE_IDS["ТР"]],
      context()
    );

    assert.equal(delta.incomplete, true);
    assert.deepEqual(delta.remove, [], "при неполных данных снятий нет");
    assert.match(delta.notes.join(" "), /не распознано/);
  });

  test("неполная карточка без известных ролей даёт честную причину пропуска", () => {
    // Ни звания, ни подразделения: менять нечего, и причина указана как
    // «данные неполные», а не «роли соответствуют данным» — это разные вещи
    const delta = computeRoleDelta(
      activeMember({ rank: "", rankName: null, unit: null }),
      [],
      context()
    );

    assert.equal(delta.incomplete, true);
    assert.equal(delta.skipReason, "данные неполные");
  });

  test("звание без роли на сервере («Мл. Лейтенант») не снимает чужие роли", () => {
    const delta = computeRoleDelta(
      activeMember({ rank: "Мл. Лейтенант ТР" }),
      [RANK_ROLE_IDS["Лейтенант"], SUBDIV_ROLE_IDS["ТР"]],
      context()
    );

    assert.equal(delta.incomplete, true);
    assert.deepEqual(delta.remove, []);
    assert.match(delta.notes.join(" "), /роли на сервере нет/);
  });

  test("отсутствие подразделения не приводит к снятию подразделений", () => {
    const delta = computeRoleDelta(
      activeMember({ unit: null, rank: "Капитан", rankName: null }),
      [SUBDIV_ROLE_IDS["ТР"], RANK_ROLE_IDS["Капитан"]],
      context()
    );

    assert.equal(delta.incomplete, true);
    assert.ok(!delta.remove.includes(SUBDIV_ROLE_IDS["ТР"]));
  });

  test("уже выданные роли не запрашиваются повторно", () => {
    // Сверка идёт по всему составу: «на всякий случай выдать» превратилось бы
    // в сотни лишних запросов и лимит Discord
    const current = [
      RANK_ROLE_IDS["Капитан"],
      SUBDIV_ROLE_IDS["ТР"],
      COMMON_ROLE_IDS.ATK_CORPS,
      COMMON_ROLE_IDS.RANKS_CATEGORY,
    ];
    const delta = computeRoleDelta(activeMember(), current, context());

    for (const id of current) assert.ok(!delta.add.includes(id));
    assert.deepEqual(delta.add, [], "все требуемые роли уже стоят");
  });

  test("второе звание в справочнике снимается: у бойца одно звание", () => {
    const delta = computeRoleDelta(
      activeMember({ rank: "Капитан ТР" }),
      [RANK_ROLE_IDS["Капитан"], RANK_ROLE_IDS["Майор"], SUBDIV_ROLE_IDS["ТР"]],
      context()
    );

    assert.deepEqual(delta.remove, [RANK_ROLE_IDS["Майор"]]);
  });

  test("должность из настроек выдаётся как роль", () => {
    const postRoleId = "123456789012345678";
    const roles = context().roles;
    roles.set(postRoleId, { id: postRoleId, name: "Механик-водитель", managed: false });

    const delta = computeRoleDelta(
      activeMember({ post: "Механик-водитель" }),
      [],
      context({ roles, postRoleMap: new Map([["Механик-водитель", postRoleId]]) })
    );

    assert.ok(delta.add.includes(postRoleId));
  });

  test("имена ролей берутся с сервера — журнал читается человеком", () => {
    const delta = computeRoleDelta(activeMember(), [COMMON_ROLE_IDS.RECRUIT], context());
    assert.ok(delta.addNames.includes("Капитан"));
    assert.ok(delta.removeNames.includes("Новобранец"));
  });
});
/* ------------------------------------------------------------------ */
/* Применение плана                                                    */
/* ------------------------------------------------------------------ */

describe("applyPlan — изменение ролей в Discord", () => {
  test("снятие идёт перед выдачей: у бойца не бывает двух званий сразу", async () => {
    const order: string[] = [];
    const entries = await planRoleSync([activeMember({ rank: "Майор ТР" })], {
      getMemberRoles: async () => [RANK_ROLE_IDS["Капитан"], SUBDIV_ROLE_IDS["ТР"]],
      context: context(),
    });

    await applyPlan(entries, {
      addRole: async (_u, roleId) => {
        order.push(`add:${roleId}`);
      },
      removeRole: async (_u, roleId) => {
        order.push(`remove:${roleId}`);
      },
    });

    assert.ok(
      order.indexOf(`remove:${RANK_ROLE_IDS["Капитан"]}`) <
        order.indexOf(`add:${RANK_ROLE_IDS["Майор"]}`),
      "сначала снимаем старое звание, потом выдаём новое"
    );
  });

  test("ошибка по одному бойцу не останавливает остальных", async () => {
    const members = [
      activeMember({ id: 1, name: "Гром", discordId: "111111111111111111", rank: "Майор ТР" }),
      activeMember({ id: 2, name: "Скиф", discordId: "222222222222222222", rank: "Майор ТР" }),
    ];
    const entries = await planRoleSync(members, {
      getMemberRoles: async () => [RANK_ROLE_IDS["Капитан"]],
      context: context(),
    });

    const applied: string[] = [];
    const result = await applyPlan(entries, {
      addRole: async (discordId) => {
        // Первому участнику Discord отказывает (например, роль выше роли бота)
        if (discordId === "111111111111111111") throw new Error("Missing Permissions");
        if (!applied.includes(discordId)) applied.push(discordId);
      },
      removeRole: async () => {},
    });

    assert.equal(result.failed, 1);
    assert.equal(result.applied, 1, "второй боец всё равно обработан");
    assert.deepEqual(applied, ["222222222222222222"]);
    assert.match(result.errors.join(" "), /Missing Permissions/);
  });

  test("бойцы без расхождений не трогаются вовсе", async () => {
    const entries = await planRoleSync([activeMember()], {
      getMemberRoles: async () => [
        RANK_ROLE_IDS["Капитан"],
        SUBDIV_ROLE_IDS["ТР"],
        COMMON_ROLE_IDS.ATK_CORPS,
        COMMON_ROLE_IDS.RANKS_CATEGORY,
      ],
      context: context(),
    });

    let calls = 0;
    await applyPlan(entries, {
      addRole: async () => {
        calls++;
      },
      removeRole: async () => {
        calls++;
      },
    });

    assert.equal(calls, 0, "при отсутствии расхождений запросов к Discord нет");
  });
});

describe("planRoleSync — устойчивость к проблемам участников", () => {
  test("участник без Discord ID помечается, но не срывает план", async () => {
    const entries = await planRoleSync(
      [
        activeMember({ id: 1, name: "Гром", discordId: "111111111111111111" }),
        activeMember({ id: 2, name: "Скиф", discordId: "" }),
      ],
      { getMemberRoles: async () => [], context: context() }
    );

    const broken = entries.find((e) => e.memberId === 2);
    assert.ok(broken?.error, "запись без Discord ID должна быть помечена ошибкой");
    assert.equal(entries.find((e) => e.memberId === 1)?.error, null);
  });

  test("вышедший с сервера участник не ломает сверку остальных", async () => {
    const entries = await planRoleSync(
      [
        activeMember({ id: 1, name: "Гром", discordId: "111111111111111111" }),
        activeMember({ id: 2, name: "Скиф", discordId: "222222222222222222" }),
      ],
      {
        getMemberRoles: async (discordId) => (discordId === "111111111111111111" ? null : []),
        context: context(),
      }
    );

    assert.ok(entries.find((e) => e.memberId === 1)?.error);
    assert.equal(entries.find((e) => e.memberId === 2)?.error, null);
  });

  test("план отсортирован по имени — журнал читается человеком", async () => {
    const entries = await planRoleSync(
      [
        activeMember({ id: 1, name: "Ястреб" }),
        activeMember({ id: 2, name: "Барон" }),
        activeMember({ id: 3, name: "Гром" }),
      ],
      { getMemberRoles: async () => [], context: context() }
    );

    assert.deepEqual(
      entries.map((e) => e.name),
      ["Барон", "Гром", "Ястреб"]
    );
  });

  test("сводные счётчики отражают план", async () => {
    const entries = await planRoleSync(
      [
        activeMember({ id: 1, name: "Гром" }), // расхождение: нет ролей
        activeMember({ id: 2, name: "Скиф", discordId: "" }), // пропущен: нет ID
        activeMember({ id: 3, name: "Барон", rank: "Генерал-армии", rankName: null, unit: null }), // неполные данные
      ],
      { getMemberRoles: async () => [], context: context() }
    );

    const counters = summarizePlan(entries);
    assert.equal(counters.checked, 3);
    assert.equal(counters.skipped, 1);
    assert.equal(counters.incomplete, 1);
    assert.ok(counters.changed >= 1);
  });
});

/* ------------------------------------------------------------------ */
/* Полный цикл сверки                                                  */
/* ------------------------------------------------------------------ */

/**
 * Собирает подставные зависимости полного цикла.
 *
 * Благодаря этому тест проверяет боевой код целиком — чтение настроек, план,
 * применение, журнал и обработку сбоев, — не поднимая ни базы, ни сети.
 */
function fakeDeps(
  overrides: Partial<Parameters<typeof runRoleSync>[0]> = {}
) {
  const logged: Record<string, unknown>[] = [];
  const saved: string[] = [];
  const rolesApplied: string[] = [];

  const settings = new Map<string, string>([
    ["guild_id", "999999999999999999"],
    ["leave_role_id", "555555555555555555"],
    ["reserve_role_id", "666666666666666666"],
    ["role_sync_enabled", "true"],
    ["role_sync_dry_run", "false"],
  ]);

  const deps = {
    loadSettings: async () => settings,
    loadMembers: async () => [activeMember()],
    getGuildRoles: async () => [...context().roles.values()],
    getMemberRoles: async () => [COMMON_ROLE_IDS.RECRUIT],
    addRole: async (_g: string, _u: string, roleId: string) => {
      rolesApplied.push(`+${roleId}`);
    },
    removeRole: async (_g: string, _u: string, roleId: string) => {
      rolesApplied.push(`-${roleId}`);
    },
    saveLog: async (row: Record<string, unknown>) => {
      logged.push(row);
    },
    saveState: async (iso: string) => {
      saved.push(iso);
    },
    getBotGuildIds: async () => ["999999999999999999"],
    now: () => 1_700_000_000_000,
    log: () => {},
    ...overrides,
  };

  return { deps, logged, saved, rolesApplied };
}

describe("runRoleSync — полный цикл сверки", () => {
  test("применяет расхождения и пишет запись в журнал", async () => {
    const { deps, logged, saved, rolesApplied } = fakeDeps();

    const result = await runRoleSync(deps, { source: "test" });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.counters.checked, 1);
    assert.equal(result.counters.changed, 1);
    assert.ok(rolesApplied.includes(`+${RANK_ROLE_IDS["Капитан"]}`));
    assert.ok(rolesApplied.includes(`-${COMMON_ROLE_IDS.RECRUIT}`));

    assert.equal(logged.length, 1, "цикл должен оставить ровно одну запись в журнале");
    assert.equal(logged[0].kind, "roles");
    assert.equal(logged[0].category, "edit", "изменения ролей — значимая запись аудита");
    assert.equal(logged[0].ok, true);
    assert.match(String(logged[0].detail), /Проверено бойцов: 1/);

    // Отметка времени: без неё после перезапуска контейнера сверка пошла бы снова
    assert.equal(saved.length, 1);
  });

  test("режим проверки не меняет роли, но показывает план", async () => {
    const { deps, logged, rolesApplied } = fakeDeps();

    const result = await runRoleSync(deps, { source: "test", dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(rolesApplied.length, 0, "в режиме проверки Discord не трогается");
    assert.equal(result.counters.changed, 1, "расхождения посчитаны");
    assert.match(result.message, /Проверка без изменений/);
    assert.ok(result.changes[0]?.includes("Гром"));
    assert.match(String(logged[0].title), /проверка без изменений/i);
  });

  test("режим проверки из настроек уважается", async () => {
    const { deps, rolesApplied } = fakeDeps({
      loadSettings: async () =>
        new Map([
          ["guild_id", "999999999999999999"],
          ["role_sync_dry_run", "true"],
        ]),
    });

    const result = await runRoleSync(deps, { source: "test" });

    assert.equal(result.dryRun, true);
    assert.equal(rolesApplied.length, 0);
  });

  test("сбой чтения настроек возвращается отчётом, а не падением", async () => {
    const { deps, logged } = fakeDeps({
      loadSettings: async () => {
        throw new Error("БД недоступна");
      },
    });

    const result = await runRoleSync(deps, { source: "test" });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /БД недоступна/);
    // Ошибка тоже попадает в журнал: молчаливый сбой сверки хуже громкого
    assert.equal(logged.length, 1);
    assert.equal(logged[0].ok, false);
  });

  test("недоступный журнал не срывает сам цикл", async () => {
    const { deps, rolesApplied } = fakeDeps({
      saveLog: async () => {
        throw new Error("журнал недоступен");
      },
    });

    const result = await runRoleSync(deps, { source: "test" });

    assert.equal(result.ok, true, "роли изменены — сбой журнала не отменяет работу");
    assert.ok(rolesApplied.length > 0);
  });

  test("сервер не определён: понятная ошибка вместо угадывания", async () => {
    const { deps, logged } = fakeDeps({
      loadSettings: async () => new Map(),
      getBotGuildIds: async () => ["111", "222"],
    });

    const result = await runRoleSync(deps, { source: "test" });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /guild_id/);
    assert.equal(logged[0].ok, false);
  });

  test("единственный сервер определяется автоматически", async () => {
    const { deps, rolesApplied } = fakeDeps({
      loadSettings: async () => new Map([["role_sync_dry_run", "false"]]),
      getBotGuildIds: async () => ["777777777777777777"],
    });

    const result = await runRoleSync(deps, { source: "test" });

    assert.equal(result.ok, true);
    assert.ok(rolesApplied.length > 0);
  });

  test("ошибки применения попадают в журнал поимённо", async () => {
    const { deps, logged } = fakeDeps({
      addRole: async () => {
        throw new Error("Missing Permissions");
      },
      removeRole: async () => {},
    });

    const result = await runRoleSync(deps, { source: "test" });

    assert.equal(result.ok, false);
    assert.equal(result.counters.failed, 1);
    assert.match(String(logged[0].error), /Гром: Missing Permissions/);
    assert.equal(logged[0].ok, false, "запись с ошибками не должна выглядеть успешной");
  });

  test("фильтр по бойцу проверяет только его", async () => {
    const { deps, rolesApplied } = fakeDeps({
      loadMembers: async () => [
        activeMember({ id: 1, name: "Гром", discordId: "111111111111111111" }),
        activeMember({ id: 2, name: "Скиф", discordId: "222222222222222222" }),
      ],
    });

    const result = await runRoleSync(deps, { source: "test", memberId: 2 });

    assert.equal(result.counters.checked, 1);
    assert.ok(rolesApplied.length > 0);
  });

  test("нет расхождений — журнал сообщает об этом, изменений нет", async () => {
    const { deps, logged, rolesApplied } = fakeDeps({
      getMemberRoles: async () => [
        RANK_ROLE_IDS["Капитан"],
        SUBDIV_ROLE_IDS["ТР"],
        COMMON_ROLE_IDS.ATK_CORPS,
        COMMON_ROLE_IDS.RANKS_CATEGORY,
      ],
    });

    const result = await runRoleSync(deps, { source: "test" });

    assert.equal(result.ok, true);
    assert.equal(result.counters.changed, 0);
    assert.equal(rolesApplied.length, 0);
    assert.match(String(logged[0].title), /расхождений нет/i);
  });
});

/* ------------------------------------------------------------------ */
/* Разбор настроек и запись журнала                                    */
/* ------------------------------------------------------------------ */

describe("parsePostRoleMap — соответствие «должность = роль»", () => {
  test("пары разбираются, комментарии игнорируются", () => {
    const map = parsePostRoleMap(
      ["# Должности подразделения", "Механик-водитель = 123456789012345678", "Наводчик: 223456789012345678"].join("\n")
    );

    assert.equal(map.get("Механик-водитель"), "123456789012345678");
    assert.equal(map.get("Наводчик"), "223456789012345678");
    assert.equal(map.size, 2);
  });

  test("мусорные строки не превращаются в соответствия", () => {
    // «Наводчик = роль такая-то» — не ID: принимать имена нельзя, потому что
    // командир может переименовать роль и соответствие молча сломается
    const map = parsePostRoleMap(["Наводчик = Наводчик", "Механик", "= 123456789012345678"].join("\n"));
    assert.equal(map.size, 0);
  });

  test("пустое значение даёт пустую карту", () => {
    assert.equal(parsePostRoleMap("").size, 0);
    assert.equal(parsePostRoleMap(null).size, 0);
  });
});

describe("managedRoleIds — граница ответственности синхронизации", () => {
  test("включает роли клана и «Друг АТК»", () => {
    const ids = managedRoleIds(context());
    assert.ok(ids.has(RANK_ROLE_IDS["Капитан"]));
    assert.ok(ids.has(SUBDIV_ROLE_IDS["ТР"]));
    assert.ok(ids.has(COMMON_ROLE_IDS.ATK_CORPS));
    // «Друг АТК» не входит в CLAN_ROLE_IDS, но синхронизация обязана её снимать:
    // боец, поступивший в строй, не должен остаться «другом»
    assert.ok(ids.has(COMMON_ROLE_IDS.FRIEND));
  });

  test("включает роли отпуска, запаса и должностей из настроек", () => {
    const ids = managedRoleIds(
      context({ postRoleMap: new Map([["Наводчик", "123456789012345678"]]) })
    );
    assert.ok(ids.has("555555555555555555"), "роль отпуска");
    assert.ok(ids.has("666666666666666666"), "роль запаса");
    assert.ok(ids.has("123456789012345678"), "роль должности");
  });

  test("кастомные роли вне справочника остаются вне досягаемости", () => {
    const ids = managedRoleIds(context());
    assert.equal(ids.has("777777777777777777"), false);
  });
});

describe("roleSyncSchedule — когда запускать сверку", () => {
  test("по умолчанию сверка выключена, а режим — проверочный", () => {
    const schedule = roleSyncSchedule(new Map());
    assert.equal(schedule.enabled, false, "менять роли людям по умолчанию нельзя");
    assert.equal(schedule.intervalMin, 30);
    // Ключа нет (старая база) → «проверка»: fail-safe в сторону «ничего не
    // изменено». Обратное поведение правила бы роли до первого отчёта.
    assert.equal(schedule.dryRun, true);
  });

  test("явное выключение проверки разрешает применение", () => {
    assert.equal(
      roleSyncSchedule(new Map([["role_sync_dry_run", "false"]])).dryRun,
      false
    );
  });

  test("включение и режим проверки читаются из настроек", () => {
    const schedule = roleSyncSchedule(
      new Map([
        ["role_sync_enabled", "true"],
        ["role_sync_dry_run", "true"],
        ["role_sync_interval_min", "15"],
      ])
    );
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.dryRun, true);
    assert.equal(schedule.intervalMin, 15);
  });

  test("слишком частый интервал поднимается до безопасного минимума", () => {
    // Раз в минуту сверять весь состав нельзя: это сотни запросов к Discord
    assert.equal(roleSyncSchedule(new Map([["role_sync_interval_min", "1"]])).intervalMin, 5);
    assert.equal(roleSyncSchedule(new Map([["role_sync_interval_min", "0"]])).intervalMin, 5);
  });

  test("чрезмерный интервал ограничен сутками, мусор — умолчанием", () => {
    assert.equal(roleSyncSchedule(new Map([["role_sync_interval_min", "99999"]])).intervalMin, 1440);
    assert.equal(roleSyncSchedule(new Map([["role_sync_interval_min", "abc"]])).intervalMin, 30);
  });
});

describe("buildRoleSyncLog — запись аудита", () => {
  const counters = {
    checked: 40,
    changed: 3,
    added: 4,
    removed: 2,
    skipped: 1,
    failed: 0,
    incomplete: 1,
  };

  test("успешный цикл описывается по-человечески", () => {
    const row = buildRoleSyncLog({
      source: "schedule",
      dryRun: false,
      counters,
      changes: ["Гром: +Капитан −Новобранец"],
      errors: [],
      durationMs: 1500,
    });

    assert.equal(row.ok, true);
    assert.equal(row.category, "edit");
    assert.match(row.detail, /Проверено бойцов: 40/);
    assert.match(row.detail, /выдать 4, снять 2/);
    assert.deepEqual(row.details["Изменения"], ["Гром: +Капитан −Новобранец"]);
  });

  test("ошибки применения делают запись неуспешной", () => {
    const row = buildRoleSyncLog({
      source: "manual:admin",
      dryRun: false,
      counters: { ...counters, failed: 2 },
      changes: [],
      errors: ["Гром: Missing Permissions", "Скиф: Unknown Member"],
      durationMs: 900,
    });

    assert.equal(row.ok, false, "запись с ошибками должна быть видна в журнале");
    assert.match(String(row.error), /Гром: Missing Permissions/);
  });

  test("длинный список изменений обрезается", () => {
    // Одна строка журнала не должна превращаться в многокилобайтный дамп
    const changes = Array.from({ length: 50 }, (_, i) => `Боец ${i}: +Рядовой`);
    const row = buildRoleSyncLog({
      source: "schedule",
      dryRun: false,
      counters,
      changes,
      errors: [],
      durationMs: 100,
    });

    const list = row.details["Изменения"] as string[];
    assert.equal(list.length, 21, "20 записей плюс строка «…и ещё N»");
    assert.match(list[list.length - 1], /и ещё 30/);
  });

  test("режим проверки отражён в заголовке", () => {
    const row = buildRoleSyncLog({
      source: "manual",
      dryRun: true,
      counters,
      changes: [],
      errors: [],
      durationMs: 10,
    });

    assert.match(row.title, /проверка без изменений/i);
    assert.match(row.action, /проверил роли/);
  });
});