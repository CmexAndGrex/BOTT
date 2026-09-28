/**
 * Тесты раздела «Экзамены»: специальности подразделений, каскад нормативов,
 * сопоставление сданного с бейджем и прогресс.
 *
 * Проверяется боевой модуль src/lib/exams.ts, а не копия правил в тесте: если
 * состав специальностей или признак «столбец в ШДС» изменится в src/, тест
 * упадёт. Это критично по двум причинам:
 *   1. названия нормативов должны совпадать с каталогом рапортов (reports.ts) —
 *      иначе кнопка «Сдать норматив» отправит рапорт с неизвестным нормативом,
 *      и сервер его отклонит;
 *   2. признак inShds определяет, попадёт ли норматив в автоматическую отметку
 *      ШДС или его подтверждает штаб вручную.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  examSpecialities,
  matchQualification,
  requirementStatus,
  specialitiesProgress,
  specialityProgress,
  type ExamPassed,
  type ExamRequirement,
} from "../src/lib/exams.ts";
import { allExamCodes, examCatalog, findExam, formExamOptions, validateReportPayload } from "../src/lib/reports.ts";

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
      "Спецкурсы",
      "Экзамен на берет",
    ]);
  });

  test("допуск на миномёты — шесть нормативов", () => {
    assert.deepEqual(requirementTitles("Артиллерийский дивизион", "mortar"), [
      "Физическая подготовка",
      "ТТХ (миномёты)",
      "Миномётное дело (обучение)",
      "Миномётное дело (экзамен)",
      "Тест по теории",
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

  test("РСЗО включает ВСЕ нормативы САУ плюс три своих", () => {
    const spg = requirementTitles("Артиллерийский дивизион", "spg");
    const mlrs = requirementTitles("Артиллерийский дивизион", "mlrs");
    assert.deepEqual(mlrs.slice(0, spg.length), spg);
    assert.equal(mlrs.length, spg.length + 3);
    assert.deepEqual(mlrs.slice(spg.length), [
      "РСЗО (обучение)",
      "РСЗО (экзамен)",
      "Техника АТК",
    ]);
  });

  test("спецкурсы дивизиона: уставы, ПВО и БПЛА", () => {
    assert.deepEqual(requirementTitles("Артиллерийский дивизион", "specials"), [
      "Уставы общие",
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

  test("шдс-нормативы шкалы совпадают со столбцами листа", () => {
    // Для каждого норматива, который считается «столбцовым», название обязано
    // лежать в каталоге листа: иначе бот не найдёт столбец при закраске
    for (const unit of ["Танковая рота", "Артиллерийский дивизион"]) {
      const columnCodes = new Set(examCatalog(unit).exams.map((exam) => exam.code));
      for (const requirement of allRequirements(unit)) {
        const status = requirementStatus(requirement, unit, []);
        if (!status.inShds) continue;
        assert.ok(
          columnCodes.has(requirement.code),
          `«${requirement.code}» помечен столбцовым, но его нет в листе «${unit}»`
        );
      }
    }
  });

  test("внеплановые нормативы помечены как «без столбца в ШДС»", () => {
    const untitled = allRequirements("Танковая рота")
      .filter((requirement) => !requirementStatus(requirement, "Танковая рота", []).inShds)
      .map((requirement) => requirement.title);
    // Ровно спецкурсы, берет и курсы испытателя — эти штаб отмечает вручную
    for (const title of ["Берет", "Топография", "КБМ", "ПВО", "КБМ испытателя"]) {
      assert.ok(untitled.includes(title), `«${title}» должен быть без столбца в ШДС`);
    }
    for (const title of ["Огневая подготовка", "ТТХ, часть 2", "Устав АТК"]) {
      assert.ok(!untitled.includes(title), `«${title}» имеет столбец в листе`);
    }
  });

  test("каталог листа не раздувается внеплановыми нормативами", () => {
    // EXAM-каталог обязан совпадать с шапкой построчно: если внеплановые
    // нормативы в него попадут, тест связи с шапкой листа упадёт — а это
    // молчаливое «рапорт одобрен, столбец не закрашен»
    const trCodes = examCatalog("Танковая рота").exams.map((exam) => exam.code);
    assert.ok(!trCodes.includes("Берет"));
    assert.ok(!trCodes.includes("Топография"));
    assert.ok(!trCodes.includes("КБМ Испыт."));
    // Но валидатор рапорта их знает — иначе кнопка «Сдать норматив» не работает
    assert.ok(allExamCodes().includes("Берет"));
    assert.ok(allExamCodes().includes("КБМ Испыт."));
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

  test("форма подачи показывает и внеплановые нормативы — иначе кнопка не работает", () => {
    const tr = formExamOptions("Танковая рота").map((exam) => exam.code);
    const ad = formExamOptions("Артиллерийский дивизион").map((exam) => exam.code);

    // Столбцовые нормативы листа на месте
    assert.ok(tr.includes("Огневая подготовка"));
    assert.ok(ad.includes("Миномётное дело (Экзамен)"));

    // Внеплановые курсы тоже: без них кнопка «Сдать норматив» на берете,
    // спецкурсах и КБМ открывала бы форму без нужной строки
    for (const code of ["Берет", "Топография", "Должностные лица", "КБМ Испыт.", "ПВО"]) {
      assert.ok(tr.includes(code), `в форме нет «${code}»`);
    }
    assert.ok(ad.includes("БПЛА"));
    assert.ok(ad.includes("РСЗО (Экзамен)"));

    // Чужие нормативы не подмешиваются: курс РСЗО — не для танкиста
    assert.equal(tr.includes("БПЛА"), false);
  });

  test("у внеплановых нормативов в форме стоит признак «вручную»", () => {
    const options = formExamOptions("Танковая рота");
    const beret = options.find((exam) => exam.code === "Берет");
    const fire = options.find((exam) => exam.code === "Огневая подготовка");
    assert.equal(beret?.inShds, false);
    assert.equal(fire?.inShds, true);
  });

  test("внеплановые нормативы принимаются валидатором рапорта", () => {
    // Проверяем то, чем живёт кнопка «Сдать норматив» на спецкурсах
    for (const code of ["Берет", "Топография", "КБМ Испыт.", "ПВО", "БПЛА"]) {
      const result = validateReportPayload("exam", [{ exam_code: code, grade: "Отлично" }]);
      assert.equal(result.ok, true, `рапорт с «${code}» отклонён: ${result.ok ? "" : result.error}`);
    }
  });
});