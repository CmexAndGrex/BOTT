/**
 * Конфликт Discord ID при ручной привязке и правило «действующий боец».
 *
 * Причина появления теста — живой баг: боец сменил ник на rs-red.com
 * («Лектер Г.А.» → «Сопрано А.Д.»), старая карточка осталась в табеле выбывшей
 * и продолжала держать снежинку. Сохранение Discord ID действующему бойцу
 * отвечало 409 «уже привязан к другому бойцу», и штаб не мог ничего сделать из
 * панели. Проверяется боевой модуль src/lib/discord-conflict.ts, а не копия
 * правила в тесте.
 *
 * Здесь же проверяется isRosterActive — общее правило «числится в составе»:
 * по нему «Учёт онлайна» (/api/control) и «Состав» (/members) должны
 * показывать одно и то же количество бойцов.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decideDiscordConflict,
  discordConflictMessage,
  needsUnitLookup,
  type DiscordConflictOccupant,
} from "../src/lib/discord-conflict.ts";
import { isRosterActive, MEMBER_STATUS } from "../src/lib/recruits.ts";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Боец в строю */
function active(id: number, name: string): DiscordConflictOccupant {
  return { id, name, active: true, status: MEMBER_STATUS.ACTIVE };
}

/** Боец, выбывший из строя (синхронизация сняла флаг) */
function left(id: number, name: string): DiscordConflictOccupant {
  return { id, name, active: false, status: MEMBER_STATUS.ACTIVE };
}

/** Исключённый: флаг мог остаться, но статус закрывает доступ */
function dismissed(id: number, name: string): DiscordConflictOccupant {
  return { id, name, active: true, status: MEMBER_STATUS.DISMISSED };
}

describe("Конфликт Discord ID: разбор занятости снежинки", () => {
  test("снежинка свободна, если её никто не держит", () => {
    assert.deepEqual(decideDiscordConflict([], 1), { kind: "free" });
  });

  test("своя же карточка конфликтом не считается (повторное сохранение)", () => {
    assert.deepEqual(decideDiscordConflict([active(7, "Сопрано А.Д.")], 7), {
      kind: "free",
    });
  });

  test("ID на выбывшей записи освобождается автоматически", () => {
    const decision = decideDiscordConflict([left(3, "Лектер Г.А.")], 9);
    assert.equal(decision.kind, "release");
    if (decision.kind !== "release") return;
    assert.deepEqual(
      decision.release.map((occupant) => occupant.id),
      [3]
    );
  });

  test("исключённый (dismissed) тоже освобождается: флаг active не спасает", () => {
    const decision = decideDiscordConflict([dismissed(4, "Лектер Г.А.")], 9);
    assert.equal(decision.kind, "release");
  });

  test("статус pending/неизвестный считается недействующим и освобождается", () => {
    const pending: DiscordConflictOccupant = {
      id: 5,
      name: "Заявка",
      active: true,
      status: MEMBER_STATUS.PENDING,
    };
    assert.equal(decideDiscordConflict([pending], 9).kind, "release");
  });

  test("отпуск — действующий боец: снежинку не отбираем", () => {
    const vacation: DiscordConflictOccupant = {
      id: 6,
      name: "Скиф",
      active: true,
      status: MEMBER_STATUS.VACATION,
    };
    const decision = decideDiscordConflict([vacation], 9);
    assert.equal(decision.kind, "blocked");
    if (decision.kind !== "blocked") return;
    assert.equal(decision.message, "Этот Discord ID уже привязан к активному бойцу: Скиф");
  });

  test("действующий боец блокирует привязку, и в ошибке его имя", () => {
    const decision = decideDiscordConflict([active(2, "Волков Д.В.")], 9);
    assert.equal(decision.kind, "blocked");
    if (decision.kind !== "blocked") return;
    assert.equal(decision.occupant.id, 2);
    assert.equal(decision.message, discordConflictMessage("Волков Д.В."));
  });

  test("действующий боец важнее выбывшего дубля: сначала блокировка", () => {
    const decision = decideDiscordConflict(
      [left(1, "Старый ник"), active(8, "Сопрано А.Д.")],
      9
    );
    assert.equal(decision.kind, "blocked");
    if (decision.kind !== "blocked") return;
    assert.equal(decision.occupant.id, 8);
  });

  test("несколько выбывших записей освобождаются все сразу", () => {
    const decision = decideDiscordConflict(
      [left(1, "Дубль 1"), dismissed(2, "Дубль 2")],
      9
    );
    assert.equal(decision.kind, "release");
    if (decision.kind !== "release") return;
    assert.deepEqual(
      decision.release.map((occupant) => occupant.id),
      [1, 2]
    );
  });
});

describe("Правило «действующий боец» (общее для /members и /control)", () => {
  test("в строю и в отпуске числятся действующими", () => {
    assert.equal(isRosterActive({ active: true, status: MEMBER_STATUS.ACTIVE }), true);
    assert.equal(isRosterActive({ active: true, status: MEMBER_STATUS.VACATION }), true);
  });

  test("снятый флаг active — выбывший", () => {
    assert.equal(isRosterActive({ active: false, status: MEMBER_STATUS.ACTIVE }), false);
  });

  test("исключённый не числится, даже если флаг active остался", () => {
    assert.equal(isRosterActive({ active: true, status: MEMBER_STATUS.DISMISSED }), false);
  });

  test("русские и альтернативные статусы трактуются так же", () => {
    assert.equal(isRosterActive({ active: true, status: "В строю" }), true);
    assert.equal(isRosterActive({ active: true, status: "в отпуске" }), true);
    assert.equal(isRosterActive({ active: true, status: "исключен" }), false);
  });

  test("боец без unit действующим остаётся (иначе теряется АД и командование)", () => {
    assert.equal(isRosterActive({ active: true, status: MEMBER_STATUS.ACTIVE }), true);
  });
});

describe("Подразделение для записи в ШДС", () => {
  test("null, пусто и «не назначено» — подразделение нужно определить", () => {
    assert.equal(needsUnitLookup(null), true);
    assert.equal(needsUnitLookup(undefined), true);
    assert.equal(needsUnitLookup(""), true);
    assert.equal(needsUnitLookup("  не назначено "), true);
  });

  test("реальное подразделение определение не требует", () => {
    assert.equal(needsUnitLookup("Танковая рота"), false);
    assert.equal(needsUnitLookup("Артиллерийский дивизион"), false);
  });
});

/* ------------------------------------------------------------------ */
/* Роуты: конфликт разбирается общим правилом                           */
/* ------------------------------------------------------------------ */

describe("Роуты привязки Discord ID используют общее правило конфликта", () => {
  const rosterRoute = () => read("src/app/api/admin/roster/[id]/discord-id/route.ts");
  const memberRoute = () => read("src/app/api/members/[id]/route.ts");

  test("оба роута разбирают конфликт через decideDiscordConflict", () => {
    for (const [label, source] of [
      ["roster/discord-id", rosterRoute()],
      ["members/[id]", memberRoute()],
    ] as const) {
      assert.match(source, /decideDiscordConflict\(/, `${label}: нет общего правила конфликта`);
      // Прежняя «жёсткая» проверка давала 409 на любой дубль, в том числе на
      // выбывшую карточку — именно это ломало привязку после смены ника
      assert.equal(
        /Этот Discord ID уже привязан к другому бойцу/.test(source),
        false,
        `${label}: остался текст ошибки без имени бойца`
      );
    }
  });

  test("снежинка снимается только с выбывших записей — через inArray по их id", () => {
    for (const [label, source] of [
      ["roster/discord-id", rosterRoute()],
      ["members/[id]", memberRoute()],
    ] as const) {
      assert.match(source, /set\(\{ discordId: null/, `${label}: конфликт не освобождается`);
      assert.match(source, /inArray\(members\.id/, `${label}: освобождение не ограничено одной записью`);
    }
  });

  test("в 409 возвращается имя занявшего бойца, а не обезличенный текст", () => {
    for (const [label, source] of [
      ["roster/discord-id", rosterRoute()],
      ["members/[id]", memberRoute()],
    ] as const) {
      assert.match(source, /decision\.message/, `${label}: текст ошибки не из правила`);
      assert.match(source, /conflictMemberId/, `${label}: панель не узнает виновника`);
    }
  });

  test("запись в ШДС пропускается, если подразделение не назначено", () => {
    const source = rosterRoute();
    assert.match(source, /needsUnitLookup\(/, "нет проверки неназначенного подразделения");
    assert.match(source, /resolveMemberUnitFromDiscord/, "подразделение не выводится по ролям Discord");
    assert.match(source, /skipped: true/, "пропуск ШДС не отличается от сбоя Google");
    // Предупреждение для панели не должно выглядеть как провал сохранения
    assert.match(source, /запись в Google Таблицу пропущена/);
  });
});

describe("«Учёт онлайна» показывает весь действующий состав", () => {
  const source = () => read("src/app/api/control/route.ts");

  test("фильтр по подразделению командира снят", () => {
    const text = source();
    // Раньше стояло eq(members.unit, auth.member.unit) — АД, командование и
    // бойцы без unit пропадали из таблицы (20 человек вместо 37)
    assert.equal(
      /eq\(members\.unit, auth\.member\.unit\)/.test(text),
      false,
      "в /api/control вернулся фильтр по подразделению"
    );
  });

  test("действующих бойцов определяет общее правило isRosterActive", () => {
    const text = source();
    assert.match(text, /isRosterActive\(/, "/api/control не использует общее правило состава");
    assert.match(text, /weeklyStats/, "история часов по неделям не отдаётся");
  });
});
