/**
 * Тесты домена рапортов: каталог нормативов, проверка payload, статусы и кнопки.
 *
 * Проверяется боевой модуль src/lib/reports.ts, а не копия правил в тесте: если
 * каталог нормативов или проверка payload изменится в src/, тест упадёт. Это
 * критично, потому что названия нормативов сопоставляются с шапкой листа ШДС
 * (matchExamColumns) и опечатка = молча не зачтённый экзамен.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  allExamCodes,
  buildRecruitEmbed,
  buildReportEmbed,
  examCatalog,
  examColumnTokens,
  EXAM_GRADES,
  findExam,
  formatIsoDate,
  isReasonableIsoDate,
  isReviewStatus,
  isServiceReportType,
  normalizeExamCode,
  parseReviewCustomId,
  readReportPayload,
  reportTypeMeta,
  REPORT_TEXT_MAX,
  reviewCustomId,
  reviewStatusLabel,
  summarizeReport,
  validateReportPayload,
} from "../src/lib/reports.ts";
import { TEMP_PASSWORD_LENGTH, TEMP_PASSWORD_PREFIX, generateTempPassword } from "../src/lib/temp-password.ts";
import { checkPasswordPolicy } from "../src/lib/password-policy.ts";
import { matchExamColumns } from "../src/lib/gsheets.ts";
import type {
  ExamPayload,
  ReservePayload,
  ReviewEmbed,
  RolePayload,
  ShdsEntryPayload,
  VacationPayload,
} from "../src/lib/reports.ts";

/* ------------------------------------------------------------------ */
/* Хелперы: у ReviewEmbed поля необязательные, а payload — объединение */
/* ------------------------------------------------------------------ */

/** Поле карточки по имени. Нет поля — тест падает: офицер его не увидит */
function field(embed: ReviewEmbed, name: string): string {
  const found = (embed.fields ?? []).find((f) => f.name === name);
  if (!found) throw new Error(`в карточке нет поля «${name}»`);
  return found.value;
}

/** Есть ли в карточке поле с таким именем */
function hasField(embed: ReviewEmbed, name: string): boolean {
  return (embed.fields ?? []).some((f) => f.name === name);
}

/** Заголовок карточки (в типе он необязательный — здесь обязателен) */
function embedTitle(embed: ReviewEmbed): string {
  if (!embed.title) throw new Error("у карточки нет заголовка");
  return embed.title;
}

describe("Каталог нормативов", () => {
  test("у «Танковой роты» есть КМБТ и он без оценки", () => {
    const catalog = examCatalog("Танковая рота");
    assert.equal(catalog.assumed, false);
    assert.equal(catalog.unit, "Танковая рота");
    const kmbt = findExam("КМБТ");
    assert.ok(kmbt);
    assert.equal(kmbt.graded, false);
  });

  test("поле оценки предусмотрено почти у всех нормативов, кроме КМБТ", () => {
    const graded = allExamCodes().filter((code) => findExam(code)?.graded !== false);
    assert.ok(graded.length > 10);
    assert.equal(graded.includes("КМБТ"), false);
  });

  test("подразделение не назначено — объединённый перечень с флагом assumed", () => {
    const catalog = examCatalog(null);
    assert.equal(catalog.assumed, true);
    assert.equal(catalog.unit, null);
    // В объединённом списке есть нормативы обоих направлений
    assert.ok(catalog.exams.some((e) => e.code === "ТТХ (Часть 1)"));
    assert.ok(catalog.exams.some((e) => e.code === "ТТХ (минометы)"));
  });

  test("нормативы из каталога находятся в реальных шапках листов ШДС", () => {
    // Главная связка: если название в каталоге разойдётся с шапкой, рапорт
    // будет создан, но экзамен в таблице не зачтётся
    const trCatalog = examColumnTokens(examCatalog("Танковая рота").exams.map((e) => e.code));
    const trResult = matchExamColumns(TR_HEADERS, trCatalog);
    assert.deepEqual(trResult.unmatched, []);
    assert.equal(trResult.columns.length, examCatalog("Танковая рота").exams.length);

    const adCatalog = examColumnTokens(
      examCatalog("Артиллерийский дивизион").exams.map((e) => e.code)
    );
    const adResult = matchExamColumns(AD_HEADERS, adCatalog);
    assert.deepEqual(adResult.unmatched, []);
  });

  test("название с запятой передаётся кусками (как ждёт matchExamColumns)", () => {
    // «Снаряжение, обслуживание техники» целиком не сопоставилось бы:
    // функция делит по запятой и сравнивает куски
    const tokens = examColumnTokens(["Снаряжение, обслуживание техники"]);
    assert.deepEqual(tokens, ["Снаряжение", "обслуживание техники"]);
    const result = matchExamColumns(TR_HEADERS, tokens);
    assert.deepEqual(result.columns, [7]);
  });

  test("название норматива нормализуется: регистр, «ё», неразрывный пробел", () => {
    assert.equal(normalizeExamCode("  огневая   ПОДГОТОВКА "), "огневая подготовка");
    assert.equal(normalizeExamCode("КМБТ"), "кмбт");
    assert.equal(findExam("минометное дело (обучение)")?.code, "Миномётное дело (обучение)");
  });
});

/** Реальные шапки листов (скопированы из тестовой таблицы ШДС) */
const TR_HEADERS = [
  "Звание",
  "Фамилии, инициалы",
  "Должность",
  "Steam ID",
  "Discord ID",
  "Для пометок",
  "КМБТ",
  "Снаряжение, обслуживание техники",
  "Огневая подготовка",
  "ТТХ (Часть 1)",
  "Физ. Подготовка",
  "ПМП",
  "Езда в сложно-проходимых условиях",
  "Сдача на Мех. Водителя",
  "ТТХ (Часть 2)",
  "Тактическая Подготовка",
  "Техника АТК",
  "Учебные стрельбы",
  "Устав АТК",
];

const AD_HEADERS = [
  "Звание",
  "Фамилии, инициалы",
  "Должность",
  "Steam ID",
  "Discord ID",
  "Заметки",
  "КМБТ",
  "Физ. Подготовка",
  "ТТХ (минометы)",
  "Миномётное дело (обучение)",
  "Прохождение теста по теории",
  "Миномётное дело (Экзамен)",
  "ПМП",
  "Снаряжение и обслуживание техники",
  "ТТХ (ствольная артиллерия)",
  "Управление гусеничной техникой",
  "Сдача на мехвода",
  "Устав АТК",
];

describe("Типы рапортов и статусы", () => {
  test("все пять типов из ТЗ распознаются", () => {
    for (const type of ["exam", "role", "vacation", "reserve", "shds_entry"]) {
      assert.equal(isServiceReportType(type), true);
    }
    assert.equal(isServiceReportType("unknown"), false);
    assert.equal(isServiceReportType(undefined), false);
  });

  test("статусы рассмотрения проверяются по списку", () => {
    assert.equal(isReviewStatus("pending"), true);
    assert.equal(isReviewStatus("approved"), true);
    assert.equal(isReviewStatus("rejected"), true);
    assert.equal(isReviewStatus("done"), false);
  });

  test("подписи статусов читаемы", () => {
    assert.equal(reviewStatusLabel("pending"), "На рассмотрении");
    assert.equal(reviewStatusLabel("approved"), "Одобрено");
    assert.equal(reviewStatusLabel("rejected"), "Отклонено");
  });

  test("каждому типу рапорта сопоставлена пиктограмма и заголовок", () => {
    for (const type of ["exam", "role", "vacation", "reserve", "shds_entry"]) {
      const meta = reportTypeMeta(type as never);
      assert.ok(meta.label.length > 3, `пустой заголовок у ${type}`);
      assert.ok(meta.icon.length > 0, `нет пиктограммы у ${type}`);
      assert.notEqual(meta.label, type);
    }
  });
});

describe("Проверка payload: экзамены", () => {
  test("норматив с оценкой и без неё принимается", () => {
    const result = validateReportPayload("exam", [
      { exam_code: "Огневая подготовка", grade: "Отлично" },
      { exam_code: "КМБТ" },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Название уезжает в ШДС каноничным: сравнение идёт после нормализации
    assert.deepEqual(result.payload, {
      exams: [{ exam_code: "Огневая подготовка", grade: "Отлично" }, { exam_code: "КМБТ" }],
    });
  });

  test("регистр и «ё» в названии норматива не важны", () => {
    const result = validateReportPayload("exam", [{ exam_code: "минометное дело (обучение)" }]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.payload as ExamPayload).exams[0].exam_code, "Миномётное дело (обучение)");
  });

  test("пустой список нормативов отклоняется", () => {
    const result = validateReportPayload("exam", []);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /хотя бы один норматив/);
  });

  test("выдуманный норматив отклоняется — иначе рапорт уйдёт в никуда", () => {
    const result = validateReportPayload("exam", [{ exam_code: "Полёты на вертолёте" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /неизвестен/);
  });

  test("КМБТ с оценкой отклоняется: базовый экзамен идёт без оценки", () => {
    const result = validateReportPayload("exam", [{ exam_code: "КМБТ", grade: "Отлично" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /без оценки/);
  });

  test("оценка вне списка отклоняется", () => {
    const result = validateReportPayload("exam", [{ exam_code: "ПМП", grade: "Пять" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /недопустимая оценка/);
  });

  test("все оценки из EXAM_GRADES принимаются", () => {
    for (const grade of EXAM_GRADES) {
      const result = validateReportPayload("exam", [{ exam_code: "Физ. Подготовка", grade }]);
      assert.equal(result.ok, true, `оценка «${grade}» должна приниматься`);
    }
  });

  test("повтор норматива не дублирует столбец в таблице", () => {
    const result = validateReportPayload("exam", [
      { exam_code: "ПМП", grade: "Хорошо" },
      { exam_code: "пмп", grade: "Отлично" },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = result.payload as ExamPayload;
    assert.equal(payload.exams.length, 1);
    assert.equal(payload.exams[0].exam_code, "ПМП");
  });

  test("строка вместо объекта тоже принимается (простой перечень названий)", () => {
    const result = validateReportPayload("exam", ["Устав АТК"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual((result.payload as ExamPayload).exams, [{ exam_code: "Устав АТК" }]);
  });
});
describe("Проверка payload: отпуск и перевод в резерв", () => {
  test("корректный диапазон дат принимается", () => {
    const result = validateReportPayload("vacation", {
      from: "2026-07-01",
      to: "2026-07-14",
      reason: "Отпуск по семейным обстоятельствам",
    });
    assert.equal(result.ok, true);
  });

  test("дата возврата раньше начала отклоняется", () => {
    const result = validateReportPayload("vacation", {
      from: "2026-07-14",
      to: "2026-07-01",
      reason: "Перепутал даты",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /раньше даты начала/);
  });

  test("несуществующая дата (31 февраля) отклоняется", () => {
    const result = validateReportPayload("vacation", {
      from: "2026-02-31",
      to: "2026-03-05",
      reason: "Такой даты нет",
    });
    assert.equal(result.ok, false);
  });

  test("опечатка в годе отклоняется — иначе боец «уходит в отпуск» на 900 лет", () => {
    assert.equal(isReasonableIsoDate("2999-01-01"), false);
    assert.equal(isReasonableIsoDate("2206-01-01"), false);
    assert.equal(isReasonableIsoDate("2026-01-01"), true);

    const result = validateReportPayload("vacation", {
      from: "2999-01-01",
      to: "2999-01-02",
      reason: "Опечатка",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /ГГГГ-ММ-ДД/);
  });

  test("отпуск без причины отклоняется", () => {
    assert.equal(
      validateReportPayload("vacation", { from: "2026-07-01", to: "2026-07-14", reason: " " }).ok,
      false
    );
  });

  test("резерв требует причину", () => {
    assert.equal(validateReportPayload("reserve", { reason: "" }).ok, false);
    const ok = validateReportPayload("reserve", { reason: "Ухожу в запас по работе" });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.deepEqual(ok.payload, { reason: "Ухожу в запас по работе" });
  });
});

describe("Проверка payload: запись в ШДС", () => {
  test("подразделение и звание берутся только из справочников", () => {
    const result = validateReportPayload("shds_entry", {
      unit: "Танковая рота",
      rank: "Рядовой",
      steamId: "STEAM_0:1:12345",
      discordId: "1085141850966458519",
      отделение: "1-е отделение",
      должность: "Наводчик",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = result.payload as ShdsEntryPayload;
    assert.equal(payload.unit, "Танковая рота");
    assert.equal(payload.rank, "Рядовой");
    assert.equal(payload.должность, "Наводчик");
  });

  test("своё подразделение (не из листов таблицы) отклоняется", () => {
    const result = validateReportPayload("shds_entry", { unit: "Морская пехота", rank: "Рядовой" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /подразделение/i);
  });

  test("звание вне списка отклоняется", () => {
    assert.equal(
      validateReportPayload("shds_entry", { unit: "Танковая рота", rank: "Генералиссимус" }).ok,
      false
    );
  });

  test("Discord ID в свободной форме отклоняется, но пустой допустим", () => {
    const bad = validateReportPayload("shds_entry", {
      unit: "Танковая рота",
      rank: "Рядовой",
      discordId: "не-id",
    });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.match(bad.error, /только цифры/);

    assert.equal(
      validateReportPayload("shds_entry", { unit: "Танковая рота", rank: "Рядовой" }).ok,
      true
    );
  });
});

describe("Проверка payload: специальность и неизвестный тип", () => {
  test("слишком короткая специальность отклоняется", () => {
    assert.equal(validateReportPayload("role", { role: "я" }).ok, false);
  });

  test("специальность с должностью принимается, синоним «должность» не теряется", () => {
    const result = validateReportPayload("role", {
      specialization: "Наводчик орудия",
      должность: "Командир орудия",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = result.payload as RolePayload;
    assert.equal(payload.role, "Наводчик орудия");
    assert.equal(payload.post, "Командир орудия");
  });

  test("неизвестный тип рапорта не проходит проверку", () => {
    const result = validateReportPayload("unknown" as never, {});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Неизвестный тип/);
  });
});
describe("Чтение payload из jsonb — данные не считаются доверенными", () => {
  test("мусор вместо объекта даёт пустую заготовку нужной формы", () => {
    assert.deepEqual(readReportPayload("reserve", "просто строка"), { reason: "" });
    assert.deepEqual(readReportPayload("role", null), { role: "", post: "", comment: "" });
    assert.deepEqual(readReportPayload("exam", 42), { exams: [] });
  });

  test("в списке экзаменов выживают только корректные записи", () => {
    const payload = readReportPayload("exam", {
      exams: [
        { exam_code: "ПМП", grade: "Отлично" },
        { exam_code: "  " },
        null,
        "строка вместо объекта",
        { exam_code: "Устав АТК" },
      ],
    });
    assert.deepEqual(payload, {
      exams: [{ exam_code: "ПМП", grade: "Отлично" }, { exam_code: "Устав АТК" }],
    });
  });

  test("некорректная дата отпуска обнуляется, а не показывается как есть", () => {
    const payload = readReportPayload("vacation", {
      from: "вчера",
      to: "2026-07-14",
      reason: "Отпуск",
    }) as VacationPayload;
    assert.equal(payload.from, "");
    assert.equal(payload.to, "2026-07-14");
  });

  test("Discord ID чистится до цифр (в БД мог попасть мусор)", () => {
    const payload = readReportPayload("shds_entry", { discordId: "ID: 1085-1418" }) as ShdsEntryPayload;
    assert.equal(payload.discordId, "10851418");
  });

  test("длинный текст обрезается по лимиту", () => {
    const payload = readReportPayload("reserve", {
      reason: "а".repeat(REPORT_TEXT_MAX + 500),
    }) as ReservePayload;
    assert.equal(payload.reason.length, REPORT_TEXT_MAX);
  });
});

describe("Выжимка рапорта — то, что видит офицер в очереди", () => {
  test("экзамены перечисляются с оценками", () => {
    const text = summarizeReport("exam", {
      exams: [{ exam_code: "ПМП", grade: "Отлично" }, { exam_code: "КМБТ" }],
    });
    assert.equal(text, "ПМП — Отлично, КМБТ");
  });

  test("пустой список нормативов даёт прочерк, а не пустую строку", () => {
    assert.equal(summarizeReport("exam", { exams: [] }), "—");
  });

  test("отпуск показывается в человекочитаемых датах", () => {
    const text = summarizeReport("vacation", {
      from: "2026-07-01",
      to: "2026-07-14",
      reason: "Отпуск",
    });
    assert.equal(text, "01.07.2026 — 14.07.2026: Отпуск");
    assert.equal(formatIsoDate("2026-07-01"), "01.07.2026");
    assert.equal(formatIsoDate(""), "—");
  });

  test("запись в ШДС склеивается в строку через разделитель", () => {
    const payload = readReportPayload("shds_entry", {
      unit: "Танковая рота",
      rank: "Рядовой",
      отделение: "1-е отделение",
      должность: "Наводчик",
    });
    assert.equal(summarizeReport("shds_entry", payload), "Танковая рота · Рядовой · 1-е отделение · Наводчик");
  });
});

describe("CustomId кнопок Discord", () => {
  test("сборка и разбор взаимно обратны", () => {
    assert.equal(reviewCustomId("report", "approve", 12), "report_approve_12");
    assert.deepEqual(parseReviewCustomId("report_approve_12"), {
      scope: "report",
      action: "approve",
      id: 12,
    });
  });

  test("область различает таблицы: id заявки и рапорта могут совпасть", () => {
    assert.deepEqual(parseReviewCustomId("recruit_approve_7"), {
      scope: "recruit",
      action: "approve",
      id: 7,
    });
    assert.deepEqual(parseReviewCustomId("report_reject_7"), {
      scope: "report",
      action: "reject",
      id: 7,
    });
  });

  test("чужие и битые строки игнорируются, а не падают ошибкой", () => {
    for (const value of [
      "",
      "unknown_approve_1",
      "report_maybe_1",
      "report_approve_",
      "report_approve_0",
      "report_approve_abc",
      "report_approve_99999999999999",
      undefined,
      null,
    ]) {
      assert.equal(parseReviewCustomId(value), null, `должно игнорироваться: ${String(value)}`);
    }
  });
});

describe("Embed-сообщения Discord", () => {
  const baseReport = {
    id: 5,
    type: "vacation" as const,
    callsign: "Сокол",
    unit: "Танковая рота",
    rank: "Рядовой",
    payload: { from: "2026-07-01", to: "2026-07-14", reason: "Отпуск" },
    createdAt: "2026-06-20T10:00:00.000Z",
    status: "pending" as const,
  };

  test("ожидающий рапорт: янтарный цвет, метка в заголовке, поля решения нет", () => {
    const embed = buildReportEmbed(baseReport);
    assert.equal(embed.color, 0xffb020);
    assert.match(embedTitle(embed), /На рассмотрении/);
    assert.match(embedTitle(embed), /Рапорт на отпуск/);
    assert.match(embedTitle(embed), /#5/);
    assert.equal(hasField(embed, "Решение"), false);
    assert.equal(field(embed, "Суть рапорта"), "01.07.2026 — 14.07.2026: Отпуск");
  });

  test("решённый рапорт: зелёный цвет, офицер и комментарий в поле «Решение»", () => {
    const embed = buildReportEmbed({
      ...baseReport,
      status: "approved",
      reviewedBy: "Барс",
      moderatorComment: "Согласовано",
      outcome: "Отпуск внесён в график",
    });
    assert.equal(embed.color, 0x3ddc84);
    assert.match(embedTitle(embed), /Одобрено/);
    assert.equal(field(embed, "Решение"), "Офицер Барс · Согласовано");
    assert.equal(field(embed, "Итог"), "Отпуск внесён в график");
  });

  test("отклонённый рапорт красный, а без офицера решение подписано «Штаб»", () => {
    const embed = buildReportEmbed({ ...baseReport, status: "rejected" });
    assert.equal(embed.color, 0xff3d3d);
    assert.match(embedTitle(embed), /Отклонено/);
    assert.equal(field(embed, "Решение"), "Штаб");
  });

  test("пустые подразделение и звание не оставляют дыр в карточке", () => {
    const embed = buildReportEmbed({
      ...baseReport,
      unit: null,
      rank: null,
      payload: { reason: "" },
    });
    assert.equal(field(embed, "Подразделение"), "не назначено");
    assert.equal(field(embed, "Звание"), "—");
  });

  const baseRecruit = {
    id: 3,
    callsign: "Волк",
    discordTag: "volk",
    discordId: "1085141850966458519" as string | null,
    age: 24 as number | null,
    armaExperience: "3 года",
    about: "Хочу в танкисты",
    createdAt: "2026-06-20T10:00:00.000Z",
    status: "pending" as const,
  };

  test("Discord без тега подписан ID, без обоих — пометкой для командира", () => {
    const noTag = buildRecruitEmbed({ ...baseRecruit, discordTag: "" });
    assert.equal(field(noTag, "Discord"), "ID: 1085141850966458519");

    const nothing = buildRecruitEmbed({
      ...baseRecruit,
      discordTag: "",
      discordId: null,
      age: null,
      armaExperience: "",
      about: "",
    });
    assert.equal(field(nothing, "Discord"), "не указан — впишет командир");
    assert.equal(field(nothing, "Возраст"), "—");
    assert.equal(field(nothing, "Опыт в Arma"), "—");
  });

  test("решение офицера попадает в карточку заявки вместе с итогом", () => {
    const embed = buildRecruitEmbed({
      ...baseRecruit,
      status: "approved",
      reviewedBy: "Барс",
      outcome: "ЛК выслан",
    });
    assert.equal(field(embed, "Discord"), "volk (ID: 1085141850966458519)");
    assert.equal(field(embed, "Решение"), "Офицер Барс · ЛК выслан");
  });
});

describe("Временный пароль бойца", () => {
  test("формат «Atk-» + 6 символов", () => {
    const password = generateTempPassword();
    assert.ok(password.startsWith(TEMP_PASSWORD_PREFIX));
    assert.equal(password.length, TEMP_PASSWORD_PREFIX.length + TEMP_PASSWORD_LENGTH);
    assert.match(password, /^Atk-[A-Za-z0-9]+$/);
  });

  test("пароль всегда проходит политику — иначе боец не сменит его в кабинете", () => {
    for (let i = 0; i < 300; i++) {
      const password = generateTempPassword();
      const check = checkPasswordPolicy(password);
      assert.equal(check.ok, true, `пароль «${password}» отвергнут политикой`);
    }
  });

  test("пароли не повторяются между выдачами", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateTempPassword());
    assert.equal(seen.size, 200);
  });
});