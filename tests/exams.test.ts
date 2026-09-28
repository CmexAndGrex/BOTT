/**
 * Тесты раздела «Экзамены»: специальности подразделений, каскад нормативов,
 * сопоставление сданного с бейджем и прогресс.
 *
 * Проверяется боевой модуль src/lib/exams.ts, а не копия правил в тесте: если
 * состав специальностей или правило автозакрытия берета изменится в src/, тест
 * упадёт. Это критично по трём причинам:
 *   1. названия нормативов должны совпадать с каталогом рапортов (reports.ts) —
 *      иначе кнопка «Сдать норматив» отправит рапорт с неизвестным нормативом,
 *      и сервер его отклонит;
 *   2. у каждого норматива шкалы обязан быть столбец в листе ШДС: рапорт,
 *      который никуда не закрашивается, — это молча не зачтённый норматив;
 *   3. «Берет» закрывается автоматически после четырёх нормативов экзамена, а
 *      «Допуск на РСЗО» без него заблокирован — здесь проверяются оба правила.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  examSpecialities,
  isBeretPassed,
  matchQualification,
  requirementStatus,
  specialitiesProgress,
  specialityProgress,
  type ExamPassed,
  type ExamRequirement,
} from "../src/lib/exams.ts";
import { allExamCodes, columnExamFor, examCatalog, findExam, formExamOptions, validateReportPayload } from "../src/lib/reports.ts";

/** Все нормативы всех специальностей подразделения */
function allRequirements(unit: string): ExamRequirement[] {
  return examSpecialities(unit).flatMap((speciality) => [...speciality.requirements]);
}

/** Заголовки вкладок — по ним проверяем состав шкал */
function titles(unit: string): string[] {
  return examSpecialities(unit).map((speciality) => speciality.title);
}

/** Название норматива специальности по вкладке */
function requirementTitles(unit: string, key: string): string[] {
  const speciality = examSpecialities(unit).find((item) => item.key === key);
  assert.ok(speciality, `нет специальности ${key} у «${unit}»`);
  return speciality.requirements.map((requirement) => requirement.title);
}

describe("Экзамены: специальности Танковой роты", () => {
  test("вкладки идут в порядке ТЗ", () => {
    assert.deepEqual(titles("Танковая рота"), [
      "Механик-водитель",
      "Наводчик-оператор",
      "КБМ / Испытатель",
      "ПВО / Спецкурсы",
      "Экзамен на берет",
    ]);
  });

  test("у мехвода ровно 7 экзаменов из ТЗ", () => {
    const driver = requirementTitles("Танковая рота", "driver");
    assert.equal(driver.length, 7);
    assert.deepEqual(driver, [
      "Снаряжение / обслуживание техники",
      "Огневая подготовка",
      "ТТХ, часть 1",
      "Физическая подготовка",
      "ПМП",
      "Езда в сложно-проходимых условиях",
      "Сдача на мехвода",
    ]);
  });

  test("наводчик включает ВСЕ экзамены мехвода плюс свои пять", () => {
    const driver = requirementTitles("Танковая рота", "driver");
    const gunner = requirementTitles("Танковая рота", "gunner");
    // Каскад: база мехвода должна присутствовать целиком и в том же порядке
    assert.deepEqual(gunner.slice(0, driver.length), driver);
    assert.equal(gunner.length, driver.length + 5);
    assert.deepEqual(gunner.slice(driver.length), [
      "ТТХ, часть 2",
      "Тактическая подготовка",
      "Техника АТК",
      "Учебные стрельбы",
      "Устав АТК",
    ]);
  });

  test("КБМ / Испытатель включает экзамены мехвода и наводчика плюс свои три", () => {
    const gunner = requirementTitles("Танковая рота", "gunner");
    const tester = requirementTitles("Танковая рота", "tester");
    assert.deepEqual(tester.slice(0, gunner.length), gunner);
    assert.equal(tester.length, gunner.length + 3);
    assert.deepEqual(tester.slice(gunner.length), ["КБМ испытателя", "Уставы общие", "КБМ"]);
  });

  test("спецкурсы и берет — короткие отдельные шкалы", () => {
    assert.deepEqual(requirementTitles("Танковая рота", "specials"), [
      "ПВО",
      "Миномётное дело",
      "Арт. дело",
    ]);
    assert.deepEqual(requirementTitles("Танковая рота", "beret"), [
      "Топография",
      "Связь",
      "Строевая подготовка",
      "Должностные лица",
      "Берет",
    ]);
  });
});

describe("Экзамены: специальности Артдивизиона", () => {
  test("вкладки идут в порядке ТЗ", () => {
    assert.deepEqual(titles("Артиллерийский дивизион"), [
      "Допуск на Минометы",
      "Допуск на САУ + Гаубицы",
      "Допуск на РСЗО",
      "Дополнительно / Спецкурсы",
      "Экзамен на берет",
    ]);
  });

  test("допуск на миномёты — шесть нормативов", () => {
    assert.deepEqual(requirementTitles("Артиллерийский дивизион", "mortar"), [
      "Физическая подготовка",
      "ТТХ (миномёты)",
      "Миномётное дело (обучение)",
      "Тест по теории",
      "Миномётное дело (экзамен)",
      "ПМП",
    ]);
  });

  test("САУ включает ВСЕ миномёты плюс артиллерию и вождение", () => {
    const mortar = requirementTitles("Артиллерийский дивизион", "mortar");
    const spg = requirementTitles("Артиллерийский дивизион", "spg");
    assert.deepEqual(spg.slice(0, mortar.length), mortar);
    // Шесть миномётных плюс семь из ТЗ: снаряжение, ТТХ ствольной артиллерии,
    // управление гусеничной техникой, сдача на мехвода, устав АТК и арт. дело
    // (обучение + экзамен)
    assert.equal(spg.length, mortar.length + 7);
    assert.deepEqual(spg.slice(mortar.length), [
      "Снаряжение и обслуживание техники",
      "ТТХ (ствольная артиллерия)",
      "Управление гусеничной техникой",
      "Сдача на мехвода",
      "Устав АТК",
      "Арт. дело (обучение)",
      "Арт. дело (экзамен)",
    ]);
  });

  test("РСЗО включает ВСЕ нормативы САУ плюс три своих и «Берет»", () => {
    const spg = requirementTitles("Артиллерийский дивизион", "spg");
    const mlrs = requirementTitles("Артиллерийский дивизион", "mlrs");
    assert.deepEqual(mlrs.slice(0, spg.length), spg);
    // Три своих норматива плюс итоговый «Берет»: он входит в требования
    // ступени, потому что без него допуск к РСЗО не выдаётся
    assert.equal(mlrs.length, spg.length + 4);
    assert.deepEqual(mlrs.slice(spg.length), [
      "РСЗО (обучение)",
      "РСЗО (экзамен)",
      "Техника АТК",
      "Берет",
    ]);
  });

  test("спецкурсы дивизиона: уставы, ПВО и БПЛА", () => {
    assert.deepEqual(requirementTitles("Артиллерийский дивизион", "specials"), [
      "Уставы (общевойсковые)",
      "ПВО",
      "БПЛА",
    ]);
  });
});

describe("Экзамены: подразделение не назначено", () => {
  test("шкал нет: направление определит штаб, чужие допуски не показываем", () => {
    assert.deepEqual(examSpecialities(null), []);
    assert.deepEqual(examSpecialities(""), []);
    assert.deepEqual(examSpecialities("Морская пехота"), []);
  });

  test("подразделение распознаётся по словам, как в матрице техники", () => {
    // Те же правила, что в vehicleDivision: «танк…» и «дивизион/артиллер…»
    assert.equal(examSpecialities("танковая рота").length, 5);
    assert.equal(examSpecialities("артдивизион").length, 5);
    assert.equal(examSpecialities("Артиллерийский дивизион").length, 5);
  });
});

describe("Экзамены: нормативы раздела принимаются рапортом", () => {
  test("каждый норматив шкалы есть в каталоге рапортов (иначе рапорт отклонят)", () => {
    const known = new Set(allExamCodes());
    for (const unit of ["Танковая рота", "Артиллерийский дивизион"]) {
      for (const requirement of allRequirements(unit)) {
        assert.ok(
          known.has(requirement.code),
          `норматив «${requirement.code}» (${requirement.title}) не принимается рапортом`
        );
      }
    }
  });

  test("у каждого норматива шкалы есть столбец в листе ШДС своего подразделения", () => {
    // Раньше часть нормативов считалась «внеплановой» (inShds = false), и отметку
    // по ним штаб ставил вручную. Теперь столбцы есть у всех: спецкурсы, экзамен
    // на берет и «Берет» тоже закрашиваются ботом.
    //
    // Проверяем не совпадение строк, а сопоставление каталога листа со шкалой
    // (columnExamFor): один и тот же норматив в листах роты и дивизиона назван
    // по-разному, и сверять названия напрямую значило бы требовать их совпадения.
    for (const unit of ["Танковая рота", "Артиллерийский дивизион"]) {
      for (const requirement of allRequirements(unit)) {
        assert.ok(
          requirementStatus(requirement, unit, []).inShds,
          `у «${requirement.title}» (${requirement.code}) нет столбца в листе «${unit}»`
        );
        const column = columnExamFor(unit, requirement.code);
        assert.ok(
          column,
          `«${requirement.code}» помечен столбцовым, но его нет в листе «${unit}»`
        );
      }
    }
  });

  test("каталог листа содержит спецкурсы, берет и курсы испытателя", () => {
    // Хвост шапки листа (КБМ, уставы, миномётное и артиллерийское дело, ПВО,
    // берет) раньше в каталог не входил, и рапорт по нему не закрашивал столбец
    const trCodes = examCatalog("Танковая рота").exams.map((exam) => exam.code);
    for (const code of ["Берет", "Топография", "КБМ Испыт.", "ПВО", "Уставы (общевойсковые)"]) {
      assert.ok(trCodes.includes(code), `в каталоге роты нет «${code}»`);
    }
    const adCodes = examCatalog("Артиллерийский дивизион").exams.map((exam) => exam.code);
    for (const code of ["БПЛА", "РСЗО (Экзамен)", "Берет", "Артиллерийское дело (обучение)"]) {
      assert.ok(adCodes.includes(code), `в каталоге дивизиона нет «${code}»`);
    }
  });
});

describe("Экзамены: сопоставление сданного норматива", () => {
  const gunner: ExamRequirement = {
    title: "Сдача на мехвода",
    code: "Сдача на Мех. Водителя",
    aliases: ["Сдача на мехвода"],
  };

  test("написание из ШДС засчитывается: регистр, «ё», лишние пробелы", () => {
    assert.ok(matchQualification(gunner, [{ code: "сдача на мех. водителя" }]));
    assert.ok(matchQualification(gunner, [{ code: "Сдача на мехвода" }]));
    assert.ok(matchQualification(gunner, [{ code: "  СДАЧА   НА МЕХВОДА " }]));
  });

  test("чужой норматив не засчитывается", () => {
    assert.equal(matchQualification(gunner, [{ code: "Огневая подготовка" }]), null);
  });

  test("оценка и дата попадают в статус, а без них бейдж нейтральный", () => {
    const graded = requirementStatus(gunner, "Танковая рота", [
      { code: "Сдача на мехвода", grade: "Отлично", at: "2026-08-01T10:00:00.000Z" },
    ]);
    assert.equal(graded.passed, true);
    assert.equal(graded.grade, "Отлично");
    assert.equal(graded.at, "2026-08-01T10:00:00.000Z");

    const ungraded = requirementStatus(gunner, "Танковая рота", [{ code: "Сдача на мехвода" }]);
    assert.equal(ungraded.passed, true);
    assert.equal(ungraded.grade, null);
    assert.equal(ungraded.at, null);
  });
});

describe("Экзамены: прогресс специальности", () => {
  test("подпись прогресс-бара: «Сдано: N из M нормативов (P%)»", () => {
    const speciality = examSpecialities("Танковая рота")[0];
    const progress = specialityProgress(speciality, "Танковая рота", [
      { code: "Огневая подготовка" },
      { code: "ПМП" },
    ]);

    assert.equal(progress.total, 7);
    assert.equal(progress.passedCount, 2);
    assert.equal(progress.percent, 28); // 2/7 = 28.57 → округление вниз
    assert.equal(progress.summary, "Сдано: 2 из 7 нормативов (28%)");
    assert.deepEqual(progress.missing, [
      "Снаряжение / обслуживание техники",
      "ТТХ, часть 1",
      "Физическая подготовка",
      "Езда в сложно-проходимых условиях",
      "Сдача на мехвода",
    ]);
  });

  test("пример из ТЗ: 5 из 12 нормативов — это 41%", () => {
    // «Наводчик-оператор» — ровно 12 нормативов (7 мехвода + 5 наводчика),
    // тот самый пример шкалы из ТЗ
    const speciality = examSpecialities("Танковая рота")[1];
    assert.equal(speciality.requirements.length, 12);

    const passed: ExamPassed[] = speciality.requirements
      .slice(0, 5)
      .map((requirement) => ({ code: requirement.code }));
    const progress = specialityProgress(speciality, "Танковая рота", passed);

    assert.equal(progress.passedCount, 5);
    assert.equal(progress.total, 12);
    assert.equal(progress.percent, 41);
    assert.equal(progress.summary, "Сдано: 5 из 12 нормативов (41%)");
  });

  test("всё сдано — 100% и пустой список недостающего", () => {
    const speciality = examSpecialities("Танковая рота")[4];
    const passed: ExamPassed[] = speciality.requirements.map((requirement) => ({
      code: requirement.code,
    }));
    const progress = specialityProgress(speciality, "Танковая рота", passed);
    assert.equal(progress.percent, 100);
    assert.equal(progress.missing.length, 0);
  });

  test("каскад читается в прогрессе: сданная база мехвода видна и у наводчика", () => {
    const gunner = examSpecialities("Танковая рота")[1];
    const progress = specialityProgress(gunner, "Танковая рота", [
      { code: "Огневая подготовка" },
      { code: "ТТХ (Часть 1)" },
    ]);
    assert.equal(progress.passedCount, 2);
    assert.equal(progress.total, 12);
  });

  test("specialitiesProgress отдаёт по одной записи на вкладку", () => {
    const all = specialitiesProgress("Танковая рота", [{ code: "ПМП" }]);
    assert.equal(all.length, 5);
    for (const item of all) {
      assert.ok(item.total > 0);
      assert.ok(item.summary.includes("Сдано:"));
    }
  });
});

describe("Экзамены: связь с каталогом рапортов", () => {
  test("findExam находит код каждого норматива шкалы", () => {
    // Код норматива обязан быть в каталоге: алиасы — лишь прочие написания из
    // ШДС, сам код должен существовать, иначе рапорт отклонят на сервере
    for (const unit of ["Танковая рота", "Артиллерийский дивизион"]) {
      for (const requirement of allRequirements(unit)) {
        assert.ok(findExam(requirement.code), `каталог не знает «${requirement.code}»`);
      }
    }
  });

  test("форма подачи показывает нормативы листа — иначе кнопка не работает", () => {
    const tr = formExamOptions("Танковая рота").map((exam) => exam.code);
    const ad = formExamOptions("Артиллерийский дивизион").map((exam) => exam.code);

    // Столбцовые нормативы листа на месте, включая спецкурсы и берет
    assert.ok(tr.includes("Огневая подготовка"));
    assert.ok(tr.includes("ПВО"));
    assert.ok(tr.includes("КБМ Испыт."));
    assert.ok(tr.includes("Топография"));
    assert.ok(ad.includes("Миномётное дело (Экзамен)"));
    assert.ok(ad.includes("БПЛА"));
    assert.ok(ad.includes("РСЗО (Экзамен)"));

    // Чужие нормативы не подмешиваются: курс РСЗО — не для танкиста
    assert.equal(tr.includes("БПЛА"), false);
  });

  test("производный «Берет» в форме отсутствует — он закрывается сам", () => {
    for (const unit of ["Танковая рота", "Артиллерийский дивизион"]) {
      const codes = formExamOptions(unit).map((exam) => exam.code);
      assert.equal(codes.includes("Берет"), false, `«Берет» не должен подаваться рапортом (${unit})`);
      assert.ok(codes.length > 0);
      // Столбец есть у КАЖДОГО норматива формы: «ручных» отметок не осталось
      for (const exam of formExamOptions(unit)) {
        assert.equal(exam.inShds, true, `у «${exam.code}» должен быть столбец в ШДС`);
      }
    }
  });

  test("нормативы раздела принимаются валидатором рапорта", () => {
    // Проверяем то, чем живёт кнопка «Сдать норматив»
    for (const code of ["Топография", "КБМ Испыт.", "ПВО", "БПЛА", "Артиллерийское дело (обучение)"]) {
      const result = validateReportPayload("exam", [{ exam_code: code, grade: "Отлично" }]);
      assert.equal(result.ok, true, `рапорт с «${code}» отклонён: ${result.ok ? "" : result.error}`);
    }
  });

  test("рапорт на производный «Берет» отклоняется с понятной причиной", () => {
    // Берет засчитывается автоматически после четырёх нормативов экзамена:
    // принять такой рапорт значило бы записать оценку нормативу без рапорта
    const result = validateReportPayload("exam", [{ exam_code: "Берет", grade: "Отлично" }]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /автоматически/);
  });

  test("алиасы панели принимаются и приводятся к коду столбца", () => {
    // «Уставы общие» боец видит в разделе, а столбец в листе зовётся
    // «Уставы (общевойсковые)»: в рапорт обязан уехать код из каталога
    const result = validateReportPayload("exam", [{ exam_code: "Уставы общие" }]);
    assert.equal(result.ok, true);
    if (result.ok) {
      const exams = (result.payload as { exams: { exam_code: string }[] }).exams;
      assert.equal(exams[0].exam_code, "Уставы (общевойсковые)");
    }
  });
});

describe("Экзамены: автозакрытие берета", () => {
  /** Четыре норматива экзамена на берет — ровно те, что закрывают берет */
  const BERET_STEPS: ExamPassed[] = [
    { code: "Топография" },
    { code: "Связь" },
    { code: "Строевая подготовка" },
    { code: "Должностные лица" },
  ];

  test("берет закрыт только когда сданы все четыре норматива", () => {
    assert.equal(isBeretPassed([]), false);
    for (let i = 1; i <= 3; i++) {
      assert.equal(
        isBeretPassed(BERET_STEPS.slice(0, i)),
        false,
        `берет не должен закрываться при ${i} из 4 нормативов`
      );
    }
    assert.equal(isBeretPassed(BERET_STEPS), true);
  });

  test("«Берет» в шкале показывается сданным, когда сданы четыре норматива", () => {
    const beret: ExamRequirement = { title: "Берет", code: "Берет", derived: true };

    const before = requirementStatus(beret, "Танковая рота", BERET_STEPS.slice(0, 2));
    assert.equal(before.passed, false);

    const after = requirementStatus(beret, "Танковая рота", BERET_STEPS);
    assert.equal(after.passed, true);
    // Норматив производный: оценки у него нет — экзаменатор её не выставлял
    assert.equal(after.grade, null);
    assert.equal(after.inShds, true, "столбец «Берет» в листе есть — бот его закрашивает");
  });

  test("дата берета — самая поздняя из сданных нормативов экзамена", () => {
    const dates: ExamPassed[] = [
      { code: "Топография", at: "2026-08-01T10:00:00.000Z" },
      { code: "Связь", at: "2026-08-02T10:00:00.000Z" },
      { code: "Строевая подготовка", at: "2026-08-03T10:00:00.000Z" },
      { code: "Должностные лица", at: "2026-08-02T10:00:00.000Z" },
    ];
    const status = requirementStatus({ title: "Берет", code: "Берет" }, "Танковая рота", dates);
    assert.equal(status.passed, true);
    assert.equal(status.at, "2026-08-03T10:00:00.000Z");
  });

  test("РСЗО заблокирована без берета и открывается с ним", () => {
    const mlrs = examSpecialities("Артиллерийский дивизион").find((s) => s.key === "mlrs");
    assert.ok(mlrs);

    const locked = specialityProgress(mlrs, "Артиллерийский дивизион", []);
    assert.equal(locked.blocked, true);
    assert.equal(locked.blockedHint, "Требуется сдача Экзамена на берет");

    const open = specialityProgress(mlrs, "Артиллерийский дивизион", BERET_STEPS);
    assert.equal(open.blocked, false);
    assert.equal(open.blockedHint, "");
  });

  test("низшие ступени дивизиона от берета не зависят", () => {
    for (const key of ["mortar", "spg", "specials", "beret"]) {
      const speciality = examSpecialities("Артиллерийский дивизион").find((s) => s.key === key);
      assert.ok(speciality);
      assert.equal(
        specialityProgress(speciality, "Артиллерийский дивизион", []).blocked,
        false,
        `ступень «${key}» не должна блокироваться беретом`
      );
    }
  });
});