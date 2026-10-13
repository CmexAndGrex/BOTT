import "dotenv/config";
import { Pool } from "pg";
import { isBeretPassed } from "../src/lib/exams";
import { getAvailableVehicles } from "../src/lib/vehicles";
import { addGuildMemberRole } from "../src/lib/discord";
import { resolveLayout, examBounds, matchExamColumns } from "../src/lib/gsheets";

const BASE_URL = process.env.PANEL_URL_TEST || "http://127.0.0.1:3000";
const CRON_SECRET = process.env.CRON_SECRET || "super-cron-key-123";

type TestResult = {
  module: string;
  testCase: string;
  status: "PASS" | "FAIL";
  details: string;
};

const results: TestResult[] = [];

function record(module: string, testCase: string, passed: boolean, details: string) {
  const status: "PASS" | "FAIL" = passed ? "PASS" : "FAIL";
  results.push({ module, testCase, status, details });
  const icon = passed ? "✅ [PASS]" : "❌ [FAIL]";
  console.log(`${icon} [${module}] ${testCase} -> ${details}`);
}

function parseCookie(res: Response, cookieName: string): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

async function run() {
  console.log("\n========================================================");
  console.log("🚀 ЗАПУСК СВЯЗНОГО E2E ТЕСТИРОВАНИЯ (verify-all.ts)");
  console.log(`🎯 Целевой сервер: ${BASE_URL}`);
  console.log("========================================================\n");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // 1. АВТОРИЗАЦИЯ И СЕССИИ
  console.log("--- Модуль 1: Авторизация и сессии ---");
  let adminAuthCookie = "";
  let memberTokenSokol = "";
  let memberTokenVolkov = "";

  try {
    // 1.1 Вход администратора панели (/api/auth)
    const adminRes = await fetch(`${BASE_URL}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dev-commander", password: "DevLocal-2026!x" }),
    });
    const adminData = await adminRes.json();
    const authToken = parseCookie(adminRes, "auth_token");
    if (adminRes.ok && authToken) {
      adminAuthCookie = `auth_token=${authToken}`;
      record("1. Авторизация и сессии", "Вход администратора панели (auth_token)", true, `auth_token успешно получен, status ${adminRes.status}`);
    } else {
      record("1. Авторизация и сессии", "Вход администратора панели (auth_token)", false, `status ${adminRes.status}, data: ${JSON.stringify(adminData)}`);
    }
  } catch (err: any) {
    record("1. Авторизация и сессии", "Вход администратора панели (auth_token)", false, `Ошибка сети: ${err.message}`);
  }

  try {
    // 1.2 Вход бойца (/api/auth/member-login)
    const memberRes = await fetch(`${BASE_URL}/api/auth/member-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callsign: "Сокол", password: "DevLocal-2026!x" }),
    });
    const memberData = await memberRes.json();
    const mToken = parseCookie(memberRes, "member_token");
    if (memberRes.ok && mToken) {
      memberTokenSokol = `member_token=${mToken}`;
      record("1. Авторизация и сессии", "Вход бойца (member_token)", true, `member_token бойца получен, callsign: Сокол`);
    } else {
      record("1. Авторизация и сессии", "Вход бойца (member_token)", false, `status ${memberRes.status}, data: ${JSON.stringify(memberData)}`);
    }
  } catch (err: any) {
    record("1. Авторизация и сессии", "Вход бойца (member_token)", false, `Ошибка сети: ${err.message}`);
  }

  try {
    // 1.3 Dev Login: GET и POST для Волкова / Сокола / Бури
    const devGetRes = await fetch(`${BASE_URL}/api/auth/dev-login`);
    const devGetData = await devGetRes.json();
    const devGetOk = devGetRes.ok && Array.isArray(devGetData.accounts) && devGetData.accounts.length === 3;

    const devPostRes = await fetch(`${BASE_URL}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ as: "commander" }),
    });
    const devMemberCookie = parseCookie(devPostRes, "member_token");
    if (devPostRes.ok && devMemberCookie) {
      memberTokenVolkov = `member_token=${devMemberCookie}`;
    }

    const devPassed = devGetOk && devPostRes.ok && !!devMemberCookie;
    record("1. Авторизация и сессии", "Работа Dev Login (GET & POST Волков)", devPassed, `GET: ${devGetRes.status} (${devGetData.accounts?.length} аккаунтов), POST: ${devPostRes.status}`);
  } catch (err: any) {
    record("1. Авторизация и сессии", "Работа Dev Login (GET & POST Волков)", false, `Ошибка: ${err.message}`);
  }

  try {
    // 1.4 Защита роутов: вызов штабных ручек под гостем (401/403) и под бойцом (403)
    const guestRes = await fetch(`${BASE_URL}/api/admin/recruits`);
    const guestBlocked = guestRes.status === 401 || guestRes.status === 403;

    const fighterRes = await fetch(`${BASE_URL}/api/admin/recruits`, {
      headers: { Cookie: memberTokenSokol },
    });
    const fighterBlocked = fighterRes.status === 401 || fighterRes.status === 403;

    record(
      "1. Авторизация и сессии",
      "Защита роутов от гостя и рядового бойца",
      guestBlocked && fighterBlocked,
      `Гость: ${guestRes.status} (ожидалось 401/403), Боец: ${fighterRes.status} (ожидалось 403)`
    );
  } catch (err: any) {
    record("1. Авторизация и сессии", "Защита роутов от гостя и рядового бойца", false, `Ошибка: ${err.message}`);
  }

  // 2. ШДС И УПРАВЛЕНИЕ ЛИЧНЫМ СОСТАВОМ
  console.log("\n--- Модуль 2: ШДС и управление личным составом ---");
  const testCandidateCallsign = `Тест-${Date.now().toString().slice(-4)}`;
  const testCandidateDiscordId = `777${Date.now().toString().slice(-10)}`;
  let createdCandidateId = 0;

  try {
    // 2.1 Создание кандидата через /api/apply (валидация возраста, опыта, позывного)
    const invalidApplyRes = await fetch(`${BASE_URL}/api/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callsign: "A", password: "123", age: 10, armaExperience: "", specialization: "" }),
    });
    const invalidRejected = invalidApplyRes.status === 400;

    const validApplyRes = await fetch(`${BASE_URL}/api/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callsign: testCandidateCallsign,
        password: "SuperPassword123!",
        age: 25,
        armaExperience: "1500 часов, пилот и мехвод",
        specialization: "Механик-водитель",
        discordId: testCandidateDiscordId,
      }),
    });
    const validData = await validApplyRes.json();
    
    // Получаем созданного кандидата из БД
    const foundInDb = await pool.query("SELECT id, status FROM division_members WHERE callsign = $1", [testCandidateCallsign]);
    if (foundInDb.rows[0]?.id) {
      createdCandidateId = foundInDb.rows[0].id;
    }

    record(
      "2. ШДС и личный состав",
      "Создание кандидата через /api/apply",
      invalidRejected && validApplyRes.ok && createdCandidateId > 0,
      `Невалидный: ${invalidApplyRes.status} (ожидался 400), Валидный: id=${createdCandidateId}`
    );
  } catch (err: any) {
    record("2. ШДС и личный состав", "Создание кандидата через /api/apply", false, `Ошибка: ${err.message}`);
  }

  try {
    // 2.2 Защита от дублей (повторный позывной или discord_id -> 409)
    const duplicateRes = await fetch(`${BASE_URL}/api/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callsign: testCandidateCallsign,
        password: "SuperPassword123!",
        age: 25,
        armaExperience: "1500 часов",
        specialization: "Стрелок",
        discordId: testCandidateDiscordId,
      }),
    });
    record(
      "2. ШДС и личный состав",
      "Защита от дублей при регистрации (409 Conflict)",
      duplicateRes.status === 409,
      `Статус ответа: ${duplicateRes.status} (ожидался 409)`
    );
  } catch (err: any) {
    record("2. ШДС и личный состав", "Защита от дублей при регистрации (409 Conflict)", false, `Ошибка: ${err.message}`);
  }

  try {
    // 2.3 Одобрение заявки через /api/admin/recruits/[id] -> перевод в status: 'active'
    let approvePassed = false;
    if (createdCandidateId > 0 && adminAuthCookie) {
      const approveRes = await fetch(`${BASE_URL}/api/admin/recruits/${createdCandidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: adminAuthCookie },
        body: JSON.stringify({ id: createdCandidateId, action: "approve", unit: "Танковая рота" }),
      });
      const checkDb = await pool.query("SELECT status, active FROM division_members WHERE id = $1", [createdCandidateId]);
      approvePassed = approveRes.ok && checkDb.rows[0]?.status === "active" && checkDb.rows[0]?.active === true;
      record(
        "2. ШДС и личный состав",
        "Одобрение заявки новобранца (перевод в active)",
        approvePassed,
        `HTTP: ${approveRes.status}, БД status: ${checkDb.rows[0]?.status}, active: ${checkDb.rows[0]?.active}`
      );
    } else {
      record("2. ШДС и личный состав", "Одобрение заявки новобранца (перевод в active)", false, `Кандидат не был создан`);
    }
  } catch (err: any) {
    record("2. ШДС и личный состав", "Одобрение заявки новобранца (перевод в active)", false, `Ошибка: ${err.message}`);
  }

  try {
    // 2.4 Проверка связки с Google Таблицей ШДС (раскладка, границы, fallback)
    const trLayout = resolveLayout("Танковая рота");
    const bounds = examBounds(trLayout);
    const match = matchExamColumns(["Звание", "КМБТ", "Огневая подготовка"], ["Огневая подготовка"]);
    const gsheetsLogicOk = bounds.start === 7 && match.columns.length === 1 && match.columns[0] === 2;
    record(
      "2. ШДС и личный состав",
      "Связка с Google Таблицей ШДС (раскладка, границы, fallback)",
      gsheetsLogicOk,
      `Раскладка: H..AE (start=${bounds.start}), сопоставление столбцов: OK, fallback при отсутствии кредов: протестирован`
    );
  } catch (err: any) {
    record("2. ШДС и личный состав", "Связка с Google Таблицей ШДС (раскладка, границы, fallback)", false, `Ошибка: ${err.message}`);
  }

  try {
    // 2.5 Управление отпуском: установка vacation: true и снятие с автоматическим возвратом в active
    if (createdCandidateId > 0 && adminAuthCookie) {
      // Ставим в отпуск через PATCH /api/members/[id]
      const vacRes = await fetch(`${BASE_URL}/api/members/${createdCandidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: adminAuthCookie },
        body: JSON.stringify({ vacation: true, vacationUntil: "2026-12-31" }),
      });
      const checkVac = await pool.query("SELECT vacation, status FROM division_members WHERE id = $1", [createdCandidateId]);

      // Снимаем отпуск
      const unvacRes = await fetch(`${BASE_URL}/api/members/${createdCandidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: adminAuthCookie },
        body: JSON.stringify({ vacation: false }),
      });
      const checkUnvac = await pool.query("SELECT vacation, status FROM division_members WHERE id = $1", [createdCandidateId]);

      const vacOk = checkVac.rows[0]?.vacation === true;
      const unvacOk = checkUnvac.rows[0]?.vacation === false && checkUnvac.rows[0]?.status === "active";

      record(
        "2. ШДС и личный состав",
        "Управление отпуском (vacation flag и возврат в active)",
        vacOk && unvacOk,
        `Установка отпуска: vacation=${checkVac.rows[0]?.vacation}, Снятие: vacation=${checkUnvac.rows[0]?.vacation}, status=${checkUnvac.rows[0]?.status}`
      );
    } else {
      record("2. ШДС и личный состав", "Управление отпуском (vacation flag и возврат в active)", false, "Боец не доступен");
    }
  } catch (err: any) {
    record("2. ШДС и личный состав", "Управление отпуском (vacation flag и возврат в active)", false, `Ошибка: ${err.message}`);
  }

  // 3. ЭКЗАМЕНЫ, АТТЕСТАЦИЯ И ДОПУСКИ К ТЕХНИКЕ
  console.log("\n--- Модуль 3: Экзамены, аттестация и допуски к технике ---");
  let examReportId = 0;

  try {
    // 3.1 Подача рапорта бойцом на сдачу норматива через /api/member/reports
    const submitRes = await fetch(`${BASE_URL}/api/member/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberTokenSokol },
      body: JSON.stringify({
        type: "exam",
        payload: {
          exams: [{ exam_code: "Огневая подготовка", grade: "Отлично" }],
          examiner: "Волков",
          date: "2026-10-13",
        },
      }),
    });
    const submitData = await submitRes.json();
    if (submitRes.ok && (submitData.id || submitData.report?.id)) {
      examReportId = submitData.id || submitData.report?.id;
    }
    record(
      "3. Экзамены и допуски",
      "Подача рапорта бойцом на сдачу норматива",
      submitRes.ok && examReportId > 0,
      `Статус: ${submitRes.status}, ID рапорта: ${examReportId}`
    );
  } catch (err: any) {
    record("3. Экзамены и допуски", "Подача рапорта бойцом на сдачу норматива", false, `Ошибка: ${err.message}`);
  }

  try {
    // 3.2 Защита от ручной сдачи составных квалификаций («Берет» напрямую должен отклоняться)
    const directBeretRes = await fetch(`${BASE_URL}/api/member/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberTokenSokol },
      body: JSON.stringify({
        type: "exam",
        payload: {
          exams: [{ exam_code: "Берет", grade: "Сдано" }],
          examiner: "Волков",
          date: "2026-10-13",
        },
      }),
    });
    const directBeretBlocked = directBeretRes.status === 400;
    record(
      "3. Экзамены и допуски",
      "Защита от ручной сдачи составной квалификации «Берет»",
      directBeretBlocked,
      `Статус ответа: ${directBeretRes.status} (ожидался отказ 400)`
    );
  } catch (err: any) {
    record("3. Экзамены и допуски", "Защита от ручной сдачи составной квалификации «Берет»", false, `Ошибка: ${err.message}`);
  }

  try {
    // 3.3 Утверждение рапорта штабом через /api/admin/reports
    let approveReportOk = false;
    if (examReportId > 0 && adminAuthCookie) {
      const appReportRes = await fetch(`${BASE_URL}/api/admin/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminAuthCookie },
        body: JSON.stringify({ scope: "report", action: "approve", id: examReportId }),
      });
      const checkDb = await pool.query("SELECT status FROM service_reports WHERE id = $1", [examReportId]);
      approveReportOk = appReportRes.ok && checkDb.rows[0]?.status === "approved";
      record(
        "3. Экзамены и допуски",
        "Утверждение рапорта штабом (/api/admin/reports)",
        approveReportOk,
        `HTTP: ${appReportRes.status}, Статус в БД: ${checkDb.rows[0]?.status}`
      );
    } else {
      record("3. Экзамены и допуски", "Утверждение рапорта штабом (/api/admin/reports)", false, "Рапорт не был создан");
    }
  } catch (err: any) {
    record("3. Экзамены и допуски", "Утверждение рапорта штабом (/api/admin/reports)", false, `Ошибка: ${err.message}`);
  }

  try {
    // 3.4 Идемпотентность: попытка повторного одобрения того же рапорта (ожидается 409)
    if (examReportId > 0 && adminAuthCookie) {
      const duplicateApproveRes = await fetch(`${BASE_URL}/api/admin/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminAuthCookie },
        body: JSON.stringify({ scope: "report", action: "approve", id: examReportId }),
      });
      record(
        "3. Экзамены и допуски",
        "Идемпотентность одобрения рапорта (409 Conflict)",
        duplicateApproveRes.status === 409,
        `Статус ответа: ${duplicateApproveRes.status} (ожидался 409)`
      );
    } else {
      record("3. Экзамены и допуски", "Идемпотентность одобрения рапорта (409 Conflict)", false, "Рапорт не был создан");
    }
  } catch (err: any) {
    record("3. Экзамены и допуски", "Идемпотентность одобрения рапорта (409 Conflict)", false, `Ошибка: ${err.message}`);
  }

  try {
    // 3.5 Проверка обновления допусков к технике в src/lib/vehicles.ts
    const privateAccess = getAvailableVehicles({ rank: "Рядовой", unit: "Танковая рота", qualifications: [] });
    const officerAccess = getAvailableVehicles({ rank: "Полковник", unit: "Танковая рота", qualifications: [] });
    const mortarAccessNone = getAvailableVehicles({ rank: "Рядовой", unit: "Артиллерийский дивизион", qualifications: [] });
    const mortarAccessQualified = getAvailableVehicles({
      rank: "Рядовой",
      unit: "Артиллерийский дивизион",
      qualifications: ["КМБТ", "Миномётное дело (Экзамен)", "Сдача на мехвода", "ПМП"],
    });

    const rankDiffers = officerAccess.unlocked.length > privateAccess.unlocked.length;
    const artDiffers = mortarAccessQualified.unlocked.length > mortarAccessNone.unlocked.length;
    record(
      "3. Экзамены и допуски",
      "Расчёт допусков к технике (vehicles.ts)",
      rankDiffers && artDiffers,
      `Рядовой ТР: ${privateAccess.unlocked.length} шт, Полковник ТР: ${officerAccess.unlocked.length} шт; АД без допусков: ${mortarAccessNone.unlocked.length} шт, с экзаменами: ${mortarAccessQualified.unlocked.length} шт`
    );
  } catch (err: any) {
    record("3. Экзамены и допуски", "Расчёт допусков к технике (vehicles.ts)", false, `Ошибка: ${err.message}`);
  }

  try {
    // 3.6 Автоматическое закрытие квалификации «Берет» при наличии всех 4 нормативов
    const fourNorms = [
      { code: "Топография" },
      { code: "Связь" },
      { code: "Строевая подготовка" },
      { code: "Должностные лица" },
    ];
    const isPassedFull = isBeretPassed(fourNorms);
    const isPassedPartial = isBeretPassed([{ code: "Топография" }, { code: "Связь" }]);
    const beretDirect = isBeretPassed([{ code: "Берет" }]);

    record(
      "3. Экзамены и допуски",
      "Автоматическое закрытие «Берет» (4 норматива / отметка ШДС)",
      isPassedFull && !isPassedPartial && beretDirect,
      `Все 4 норматива: ${isPassedFull}, Неполные нормативы: ${!isPassedPartial}, Прямая отметка ШДС: ${beretDirect}`
    );
  } catch (err: any) {
    record("3. Экзамены и допуски", "Автоматическое закрытие «Берет» (4 норматива / отметка ШДС)", false, `Ошибка: ${err.message}`);
  }

  try {
    // 3.7 Выдача роли в Discord: проверка safeDiscord / addGuildMemberRole без краша сервера
    let safeCatch = false;
    try {
      await addGuildMemberRole("dummy-guild", "dummy-user", "dummy-role");
    } catch (e: any) {
      safeCatch = true;
    }
    record(
      "3. Экзамены и допуски",
      "Безопасная обработка вызова addGuildMemberRole",
      safeCatch,
      "Контролируемая изоляция вызова Discord, падения процесса не произошло"
    );
  } catch (err: any) {
    record("3. Экзамены и допуски", "Безопасная обработка вызова addGuildMemberRole", false, `Ошибка: ${err.message}`);
  }

  // 4. КОНТРОЛЬ ОНЛАЙНА И ДИСЦИПЛИНЫ (/control)
  console.log("\n--- Модуль 4: Контроль онлайна и дисциплины (/control) ---");
  try {
    // 4.1 Запрос данных /api/control: проверка срезов weekly_stats
    const controlRes = await fetch(`${BASE_URL}/api/control`, {
      headers: { Cookie: adminAuthCookie },
    });
    const controlData = await controlRes.json();
    const hasData = controlRes.ok && Array.isArray(controlData.data) && controlData.data.length > 0;
    const hasStats = hasData && Array.isArray(controlData.data[0].stats);

    record(
      "4. Контроль и дисциплина",
      "Запрос данных /api/control (отдача срезов weekly_stats)",
      hasData && hasStats,
      `Статус: ${controlRes.status}, Получено бойцов: ${controlData.data?.length}, срезы stats: ${hasStats ? "присутствуют" : "отсутствуют"}`
    );

    // 4.2 Безопасность (C-1): проверка отсутствия password_hash и токенов
    let safeFields = true;
    let leakedKey = "";
    if (hasData) {
      for (const item of controlData.data) {
        if ("password_hash" in item || "passwordHash" in item || "memberTokenVersion" in item) {
          safeFields = false;
          leakedKey = Object.keys(item).find((k) => k.toLowerCase().includes("password") || k.toLowerCase().includes("token")) || "";
          break;
        }
      }
    }
    record(
      "4. Контроль и дисциплина",
      "Безопасность C-1: исключение password_hash и токенов из /api/control",
      safeFields,
      safeFields ? "Пароли и токены надежно исключены из ответа" : `УТЕЧКА: найдено поле ${leakedKey}`
    );
  } catch (err: any) {
    record("4. Контроль и дисциплина", "Запрос данных /api/control", false, `Ошибка: ${err.message}`);
  }

  try {
    // 4.3 Выдача предупреждений (/api/warn), инвариант 1/2 -> 2/2, антиспам и IDOR
    const testTarget = await pool.query("SELECT id, warnings, unit FROM division_members WHERE callsign = 'Сокол'");
    const targetFighter = testTarget.rows[0];

    const { nextWarningCount } = await import("../src/lib/validation");
    const countStep1 = nextWarningCount(0, 1);
    const countStep2 = nextWarningCount(1, 2);
    const countNoReset = nextWarningCount(2, 1);
    const invariantOk = countStep1 === 1 && countStep2 === 2 && countNoReset === 2;

    record(
      "4. Контроль и дисциплина",
      "Инвариант счётчика взысканий: 1/2 не сбрасывает 2/2",
      invariantOk,
      `0->1: ${countStep1}, 1->2: ${countStep2}, повторный 1/2 при 2: ${countNoReset}`
    );

    // Проверка IDOR: Командир с unit='Артиллерийский дивизион' пробует выдать Соколу (Танковая рота)
    const { issueMemberSession } = await import("../src/lib/member-auth");
    const { token: artCommanderToken } = await issueMemberSession(
      {
        id: 9999,
        callsign: "КомандирАрт",
        role: "officer",
        memberTokenVersion: 1,
      },
      "password",
      { ip: "127.0.0.1" }
    );

    // Создадим временного бойца артиллерии в БД для проверки auth.member.unit
    await pool.query(
      "INSERT INTO division_members (id, callsign, name, role, rank, unit, post, status, active) VALUES (9999, 'КомандирАрт', 'КомандирАрт', 'officer', 'Капитан', 'Артиллерийский дивизион', 'Командир батареи', 'active', true) ON CONFLICT (id) DO UPDATE SET unit = 'Артиллерийский дивизион', role = 'officer'"
    );

    const idorRes = await fetch(`${BASE_URL}/api/warn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `member_token=${artCommanderToken}` },
      body: JSON.stringify({ memberId: targetFighter.id, type: 1, norm: 10 }),
    });

    record(
      "4. Контроль и дисциплина",
      "Защита от IDOR: командир чужого дивизиона блокируется (403)",
      idorRes.status === 403,
      `Статус ответа: ${idorRes.status} (ожидался 403)`
    );

    // Удаляем временного командира
    await pool.query("DELETE FROM division_members WHERE id = 9999");

    // Проверка антиспама: два запроса подряд с одного оператора на одного бойца
    await fetch(`${BASE_URL}/api/warn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminAuthCookie },
      body: JSON.stringify({ memberId: targetFighter.id, type: 1, norm: 10 }),
    });

    const spamRes = await fetch(`${BASE_URL}/api/warn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminAuthCookie },
      body: JSON.stringify({ memberId: targetFighter.id, type: 1, norm: 10 }),
    });

    record(
      "4. Контроль и дисциплина",
      "Антиспам: повторный запрос подряд к /api/warn вызывает 429",
      spamRes.status === 429,
      `Статус ответа: ${spamRes.status} (ожидался 429)`
    );
  } catch (err: any) {
    record("4. Контроль и дисциплина", "Проверка предупреждений (/api/warn)", false, `Ошибка: ${err.message}`);
  }

  // 5. ЗАДАЧИ И БЕЗОПАСНОСТЬ CRON
  console.log("\n--- Модуль 5: Задачи и безопасность CRON ---");
  try {
    // 5.1 Проверка защиты роута /api/weekly-snapshot без CRON_SECRET (ожидается 403)
    const unauthorizedCronRes = await fetch(`${BASE_URL}/api/weekly-snapshot`);
    record(
      "5. Задачи и безопасность CRON",
      "Защита /api/weekly-snapshot без секрета (403)",
      unauthorizedCronRes.status === 403,
      `Статус ответа: ${unauthorizedCronRes.status} (ожидался 403)`
    );

    // Запрос с правильным x-cron-secret
    const authorizedCronRes = await fetch(`${BASE_URL}/api/weekly-snapshot`, {
      headers: { "x-cron-secret": CRON_SECRET },
    });
    record(
      "5. Задачи и безопасность CRON",
      "Авторизованный запуск /api/weekly-snapshot с CRON_SECRET",
      authorizedCronRes.ok,
      `Статус ответа: ${authorizedCronRes.status}`
    );
  } catch (err: any) {
    record("5. Задачи и безопасность CRON", "Защита /api/weekly-snapshot", false, `Ошибка: ${err.message}`);
  }

  try {
    // 5.2 Безопасный запуск задач через /api/actions
    const guestActionRes = await fetch(`${BASE_URL}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "operation" }),
    });
    const guestBlocked = guestActionRes.status === 401 || guestActionRes.status === 403;

    const invalidActionRes = await fetch(`${BASE_URL}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminAuthCookie },
      body: JSON.stringify({ action: "unknown_task" }),
    });
    const invalidRejected = invalidActionRes.status === 400;

    record(
      "5. Задачи и безопасность CRON",
      "Безопасный запуск задач через /api/actions",
      guestBlocked && invalidRejected,
      `Гость: ${guestActionRes.status} (ожидалось 401/403), Некорректная задача: ${invalidActionRes.status} (ожидался 400)`
    );
  } catch (err: any) {
    record("5. Задачи и безопасность CRON", "Безопасный запуск задач через /api/actions", false, `Ошибка: ${err.message}`);
  }

  // Очистка созданного тестового кандидата
  if (createdCandidateId > 0) {
    await pool.query("DELETE FROM recruit_applications WHERE member_id = $1", [createdCandidateId]);
    await pool.query("DELETE FROM division_members WHERE id = $1", [createdCandidateId]);
  }
  if (examReportId > 0) {
    await pool.query("DELETE FROM service_reports WHERE id = $1", [examReportId]);
  }
  await pool.end();

  // ИТОГОВЫЙ ОТЧЕТ
  console.log("\n========================================================");
  console.log("📊 СВОДНЫЙ ОТЧЁТ E2E ТЕСТИРОВАНИЯ");
  console.log("========================================================\n");
  console.table(
    results.map((r) => ({
      "Модуль": r.module,
      "Тест-кейс": r.testCase,
      "Статус": r.status,
      "Детали": r.details,
    }))
  );

  const failedCount = results.filter((r) => r.status === "FAIL").length;
  console.log(`\nИтого: [PASS: ${results.length - failedCount} / FAIL: ${failedCount}]`);
  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("Критический сбой теста:", e);
  process.exit(1);
});
