/**
 * Контроль снятия ролей Discord у исключённых бойцов.
 *
 * Проверяются правила боевого модуля src/lib/roles-monitor.ts, а не их копия в
 * тесте. Именно здесь цена ошибки максимальна в обе стороны:
 *   * слишком ранний срок или сброшенный флаг `rolesAlertSentAt` превращают
 *     задачу в спам комсоставу на каждом цикле планировщика;
 *   * слишком поздний срок или лишняя проверка `status` оставляют исключённого
 *     с ролью подразделения — то есть с доступом к закрытым каналам.
 *
 * Время во всех проверках подставляется вручную (`now` — параметр функций),
 * поэтому тест не зависит от текущей даты и не «портится» через сутки.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DIVISION_ROLE_ID,
  ROLES_ALERT_DELAY_MS,
  ROLES_ALERT_MAX_HOURS,
  ROLES_ALERT_MIN_HOURS,
  buildRolesAlertEmbed,
  candidateLabel,
  isAlertDue,
  isSnowflake,
  leftoverClanRoles,
  pendingDivisionRoles,
  resolveAlertDelayMs,
  rolesAlertLogText,
  selectAlertCandidates,
  statusTrackingFields,
  toMillis,
  type DismissedCandidate,
} from "@/lib/roles-monitor.ts";
import { CLAN_ROLE_IDS, COMMON_ROLE_IDS, RANK_ROLE_IDS, SUBDIV_ROLE_IDS } from "@/lib/roles.ts";

/** Опорная точка отсчёта: «сейчас» для всех проверок */
const NOW = new Date("2026-09-30T12:00:00.000Z");

/** Сдвиг от опорной точки в часах — читаемые даты в данных теста */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

/** Боец, исключённый N часов назад — база для вариантов */
function candidate(overrides: Partial<DismissedCandidate> = {}): DismissedCandidate {
  return {
    id: 1,
    name: "Иванов Иван",
    callsign: "Игроман",
    discordId: "123456789012345678",
    status: "dismissed",
    dismissedAt: hoursAgo(25),
    rolesAlertSentAt: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Условия выборки: срок 24 часа                                       */
/* ------------------------------------------------------------------ */

describe("isAlertDue — срок в 24 часа", () => {
  test("исключён ровно 24 часа назад — напоминание пора", () => {
    assert.equal(isAlertDue(candidate({ dismissedAt: hoursAgo(24) }), NOW), true);
  });

  test("исключён 25 часов назад — пора", () => {
    assert.equal(isAlertDue(candidate({ dismissedAt: hoursAgo(25) }), NOW), true);
  });

  test("исключён 23 часа назад — рано, комсостав ещё может снять роли сам", () => {
    assert.equal(isAlertDue(candidate({ dismissedAt: hoursAgo(23) }), NOW), false);
  });

  test("исключён час назад — рано", () => {
    assert.equal(isAlertDue(candidate({ dismissedAt: hoursAgo(1) }), NOW), false);
  });

  test("миллисекунда до срока — рано, миллисекунда после — пора", () => {
    const justBefore = new Date(NOW.getTime() - ROLES_ALERT_DELAY_MS + 1);
    const justAfter = new Date(NOW.getTime() - ROLES_ALERT_DELAY_MS - 1);
    assert.equal(isAlertDue(candidate({ dismissedAt: justBefore }), NOW), false);
    assert.equal(isAlertDue(candidate({ dismissedAt: justAfter }), NOW), true);
  });

  test("дата может прийти строкой из БД — считается так же", () => {
    const iso = hoursAgo(30).toISOString();
    assert.equal(isAlertDue(candidate({ dismissedAt: iso }), NOW), true);
    const recent = hoursAgo(2).toISOString();
    assert.equal(isAlertDue(candidate({ dismissedAt: recent }), NOW), false);
  });
});

/* ------------------------------------------------------------------ */
/* Условия выборки: флаги и поля                                       */
/* ------------------------------------------------------------------ */

describe("isAlertDue — флаги и обязательные поля", () => {
  test("статус не dismissed (в строю) — не напоминаем", () => {
    assert.equal(isAlertDue(candidate({ status: "active" }), NOW), false);
  });

  test("статус отпуска — не напоминаем: боец в подразделении", () => {
    assert.equal(isAlertDue(candidate({ status: "vacation" }), NOW), false);
  });

  test("статус pending — не напоминаем", () => {
    assert.equal(isAlertDue(candidate({ status: "pending" }), NOW), false);
  });

  test("напоминание уже отправлено — повторного пинга нет", () => {
    assert.equal(
      isAlertDue(candidate({ rolesAlertSentAt: hoursAgo(1) }), NOW),
      false
    );
  });

  test("роли сняты, флаг поставлен давно — боец закрыт навсегда", () => {
    assert.equal(
      isAlertDue(candidate({ rolesAlertSentAt: hoursAgo(24 * 10) }), NOW),
      false
    );
  });

  test("dismissedAt не задан — напоминать не по чему, срок неизвестен", () => {
    assert.equal(isAlertDue(candidate({ dismissedAt: null }), NOW), false);
  });

  test("dismissedAt нечитаем — считаем неизвестным, а не «готовым»", () => {
    assert.equal(isAlertDue(candidate({ dismissedAt: "не дата" }), NOW), false);
  });

  test("discordId пуст — участника не запросить", () => {
    assert.equal(isAlertDue(candidate({ discordId: null }), NOW), false);
    assert.equal(isAlertDue(candidate({ discordId: "" }), NOW), false);
  });

  test("discordId = manual — это маркер «не привязан», не снежинка", () => {
    assert.equal(isAlertDue(candidate({ discordId: "manual" }), NOW), false);
  });

  test("discordId не из цифр — не запрашиваем участника", () => {
    assert.equal(isAlertDue(candidate({ discordId: "user#1234" }), NOW), false);
  });

  test("слишком короткий ID не считается снежинкой", () => {
    assert.equal(isSnowflake("1234"), false);
    assert.equal(isSnowflake("12345"), true);
    assert.equal(isSnowflake(" 123456789012345678 "), true);
    assert.equal(isSnowflake(null), false);
    assert.equal(isSnowflake(undefined), false);
  });
});

/* ------------------------------------------------------------------ */
/* Отбор кандидатов                                                    */
/* ------------------------------------------------------------------ */

describe("selectAlertCandidates", () => {
  test("отбираются только подходящие, порядок сохраняется", () => {
    const rows = [
      candidate({ id: 1, dismissedAt: hoursAgo(30) }), // пора
      candidate({ id: 2, dismissedAt: hoursAgo(3) }), // рано
      candidate({ id: 3, rolesAlertSentAt: hoursAgo(5) }), // уже отправлено
      candidate({ id: 4, dismissedAt: hoursAgo(48), status: "active" }), // не исключён
      candidate({ id: 5, dismissedAt: hoursAgo(100), discordId: "manual" }), // нет Discord
      candidate({ id: 6, dismissedAt: hoursAgo(24) }), // пора
    ];
    const selected = selectAlertCandidates(rows, NOW);
    assert.deepEqual(
      selected.map((r) => r.id),
      [1, 6]
    );
  });

  test("пустая выборка — пустой результат", () => {
    assert.deepEqual(selectAlertCandidates([], NOW), []);
  });

  test("свой срок ожидания применяется вместо стандартного", () => {
    const rows = [candidate({ id: 1, dismissedAt: hoursAgo(5) })];
    // По умолчанию (24 ч) рано, при сроке в 3 часа — уже пора
    assert.equal(selectAlertCandidates(rows, NOW).length, 0);
    assert.equal(selectAlertCandidates(rows, NOW, 3 * 60 * 60 * 1000).length, 1);
  });
});

describe("resolveAlertDelayMs — срок из настроек", () => {
  test("пусто или мусор — стандартные 24 часа", () => {
    assert.equal(resolveAlertDelayMs(""), ROLES_ALERT_DELAY_MS);
    assert.equal(resolveAlertDelayMs(null), ROLES_ALERT_DELAY_MS);
    assert.equal(resolveAlertDelayMs(undefined), ROLES_ALERT_DELAY_MS);
    assert.equal(resolveAlertDelayMs("сутки"), ROLES_ALERT_DELAY_MS);
  });

  test("корректное значение переводится в миллисекунды", () => {
    assert.equal(resolveAlertDelayMs("24"), 24 * 60 * 60 * 1000);
    assert.equal(resolveAlertDelayMs("3"), 3 * 60 * 60 * 1000);
  });

  test("ноль и отрицательное поднимаются до минимума — иначе был бы пинг сразу", () => {
    assert.equal(resolveAlertDelayMs("0"), ROLES_ALERT_MIN_HOURS * 60 * 60 * 1000);
    assert.equal(resolveAlertDelayMs("-5"), ROLES_ALERT_MIN_HOURS * 60 * 60 * 1000);
  });

  test("завышенное значение ограничивается сверху — иначе напоминания не будет никогда", () => {
    assert.equal(resolveAlertDelayMs("99999"), ROLES_ALERT_MAX_HOURS * 60 * 60 * 1000);
  });
});

/* ------------------------------------------------------------------ */
/* Проверка ролей на сервере                                           */
/* ------------------------------------------------------------------ */

describe("pendingDivisionRoles — роль АТК всё ещё висит", () => {
  test("роль подразделения есть — считаем, что не снята", () => {
    assert.deepEqual(pendingDivisionRoles(["111", DIVISION_ROLE_ID, "222"]), [
      DIVISION_ROLE_ID,
    ]);
  });

  test("роли нет — пустой список, предупреждать не о чем", () => {
    assert.deepEqual(pendingDivisionRoles(["111", "222"]), []);
  });

  test("«Друг АТК» снимать не требуем: это роль бывшего бойца", () => {
    assert.deepEqual(pendingDivisionRoles([COMMON_ROLE_IDS.FRIEND]), []);
  });

  test("участника нет на сервере (null) — это не «роль висит»", () => {
    assert.deepEqual(pendingDivisionRoles(null), []);
  });

  test("пустой справочник ID роли не приводит к снятию всего подряд", () => {
    assert.deepEqual(pendingDivisionRoles([DIVISION_ROLE_ID], ""), []);
  });
});

describe("leftoverClanRoles — подробности для журнала", () => {
  test("показывает все роли клана, оставшиеся у бойца", () => {
    const roles = [
      RANK_ROLE_IDS["Капитан"],
      DIVISION_ROLE_ID,
      SUBDIV_ROLE_IDS["ТР"],
      "999999", // кастомная роль сервера — не наша забота
    ];
    const leftover = leftoverClanRoles(roles);
    assert.equal(leftover.length, 3);
    assert.ok(leftover.includes(DIVISION_ROLE_ID));
    assert.ok(!leftover.includes("999999"));
  });

  test("все роли справочника входят в CLAN_ROLE_IDS", () => {
    for (const id of leftoverClanRoles(Object.values(RANK_ROLE_IDS))) {
      assert.ok(CLAN_ROLE_IDS.has(id));
    }
  });

  test("участника нет на сервере — пустой список", () => {
    assert.deepEqual(leftoverClanRoles(null), []);
  });
});

/* ------------------------------------------------------------------ */
/* Фиксация момента исключения                                         */
/* ------------------------------------------------------------------ */

describe("statusTrackingFields", () => {
  test("перевод в dismissed проставляет момент и сбрасывает флаг напоминания", () => {
    const fields = statusTrackingFields("dismissed", "active", NOW);
    assert.deepEqual(fields, { dismissedAt: NOW, rolesAlertSentAt: null });
  });

  test("перевод в запас из отпуска тоже начинает отсчёт", () => {
    const fields = statusTrackingFields("dismissed", "vacation", NOW);
    assert.deepEqual(fields, { dismissedAt: NOW, rolesAlertSentAt: null });
  });

  test("повторное сохранение исключённого не перезаписывает момент исключения", () => {
    // Иначе правка примечания откладывала бы напоминание ещё на сутки
    assert.deepEqual(statusTrackingFields("dismissed", "dismissed", NOW), {});
  });

  test("возврат в строй очищает и момент исключения, и флаг напоминания", () => {
    assert.deepEqual(statusTrackingFields("active", "dismissed", NOW), {
      dismissedAt: null,
      rolesAlertSentAt: null,
    });
  });

  test("возврат из запаса (reactivate) очищает отслеживание", () => {
    assert.deepEqual(statusTrackingFields("active", "dismissed", NOW), {
      dismissedAt: null,
      rolesAlertSentAt: null,
    });
  });

  test("обычная смена статуса без исключения ничего не трогает", () => {
    assert.deepEqual(statusTrackingFields("active", "active", NOW), {});
    assert.deepEqual(statusTrackingFields("vacation", "active", NOW), {});
    assert.deepEqual(statusTrackingFields("active", "pending", NOW), {});
  });

  test("первое исключение карточки без прежнего статуса", () => {
    assert.deepEqual(statusTrackingFields("dismissed", null, NOW), {
      dismissedAt: NOW,
      rolesAlertSentAt: null,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Форматирование уведомления                                          */
/* ------------------------------------------------------------------ */

describe("buildRolesAlertEmbed", () => {
  test("заголовок и текст соответствуют формулировке задачи", () => {
    const embed = buildRolesAlertEmbed(candidate(), { leftover: [DIVISION_ROLE_ID] });
    assert.equal(embed.title, "⚠️ Контроль личного состава // Не сняты роли");
    assert.match(embed.description ?? "", /покинул подразделение более 24 часов назад/);
    assert.match(embed.description ?? "", /имеет роль \*\*АТК\*\*/);
    assert.match(embed.description ?? "", /снимите роли подразделения/);
  });

  test("боец упоминается как <@id>: командир переходит в профиль одним кликом", () => {
    const embed = buildRolesAlertEmbed(candidate({ discordId: "987654321098765432" }));
    assert.match(embed.description ?? "", /<@987654321098765432>/);
  });

  test("в заголовке бойца — позывной, а не ФИО", () => {
    const embed = buildRolesAlertEmbed(candidate());
    assert.match(embed.description ?? "", /\*\*Игроман\*\*/);
  });

  test("без позывного берётся ФИО", () => {
    const embed = buildRolesAlertEmbed(candidate({ callsign: null }));
    assert.match(embed.description ?? "", /\*\*Иванов Иван\*\*/);
  });

  test("без позывного и ФИО подставляется заглушка, а не пустота", () => {
    const embed = buildRolesAlertEmbed(candidate({ callsign: "", name: "" }));
    assert.match(embed.description ?? "", /\*\*неизвестный боец\*\*/);
  });

  test("поля содержат время исключения и число оставшихся ролей", () => {
    const embed = buildRolesAlertEmbed(candidate({ dismissedAt: hoursAgo(30) }), {
      leftover: [DIVISION_ROLE_ID, RANK_ROLE_IDS["Капитан"]],
    });
    const names = (embed.fields ?? []).map((f) => f.name);
    assert.ok(names.includes("Исключён"));
    assert.ok(names.includes("Осталось ролей подразделения"));

    const left = (embed.fields ?? []).find(
      (f) => f.name === "Осталось ролей подразделения"
    );
    assert.equal(left?.value, "2");
  });

  test("нечитаемая дата исключения не ломает Embed", () => {
    const embed = buildRolesAlertEmbed(candidate({ dismissedAt: null }));
    const names = (embed.fields ?? []).map((f) => f.name);
    assert.ok(!names.includes("Исключён"));
    assert.ok(names.includes("Осталось ролей подразделения"));
  });

  test("без упоминания роли в описании остаётся только «АТК»", () => {
    const embed = buildRolesAlertEmbed(candidate(), { divisionRoleId: "555" });
    assert.match(embed.description ?? "", /роль \*\*АТК\*\*/);
  });
});

describe("rolesAlertLogText — запись в аудит", () => {
  test("в записи есть боец, Discord ID и перечисленные роли", () => {
    const text = rolesAlertLogText(candidate(), [DIVISION_ROLE_ID]);
    assert.match(text, /Игроман/);
    assert.match(text, /123456789012345678/);
    assert.match(text, new RegExp(DIVISION_ROLE_ID));
    assert.match(text, /более 24 часов/);
  });

  test("без оставшихся ролей вместо списка — прочерк", () => {
    const text = rolesAlertLogText(candidate(), []);
    assert.match(text, /Роли: —/);
  });
});

describe("candidateLabel и toMillis", () => {
  test("позывной приоритетнее ФИО, пробелы обрезаются", () => {
    assert.equal(candidateLabel({ callsign: "  Сокол ", name: "Петров" }), "Сокол");
    assert.equal(candidateLabel({ callsign: "   ", name: " Петров " }), "Петров");
    assert.equal(candidateLabel({}), "неизвестный боец");
  });

  test("toMillis понимает Date, ISO-строку и отвергает мусор", () => {
    assert.equal(toMillis(NOW), NOW.getTime());
    assert.equal(toMillis(NOW.toISOString()), NOW.getTime());
    assert.equal(toMillis(null), null);
    assert.equal(toMillis(""), null);
    assert.equal(toMillis("не дата"), null);
  });
});