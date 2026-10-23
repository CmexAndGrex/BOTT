/**
 * Права командира подразделения и сценарий «Возврат из запаса».
 *
 * Проверяются боевые модули, а не копии правил в тесте: расчёт прав
 * (src/lib/panel-rights.ts), выдача флагов клиенту (/api/me,
 * /api/member/session), ворота разделов (middleware) и решение по возврату
 * (approveRecruitByKind).
 *
 * Почему это критично. Причиной отчёта был рассинхрон: интерфейс и роуты
 * считали «командира» по-разному, поэтому командир подразделения («Волков»)
 * видел «Доступ запрещен. Только для командиров» на /control, а в табеле
 * «Состав» поле Discord ID оставалось заблокированным. Второй риск — принятие
 * заявки на возврат из запаса за обычное зачисление: тогда боец получил бы
 * вторую строку в ШДС вместо восстановления прежней.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isCommanderAppointment,
  isCommanderPost,
  isCommanderRank,
  normalizeCommanderRole,
  resolvePanelRights,
} from "../src/lib/panel-rights.ts";
import {
  APPLICATION_KIND_LABELS,
  APPLICATION_KIND_RESERVE_RETURN,
  APPLICATION_KIND_TITLES,
  isFullName,
  isRecruitApplicationKind,
  normalizeFullName,
  RECRUIT_APPLICATION_KINDS,
  validateApplication,
} from "../src/lib/recruits.ts";
import { buildRecruitEmbed } from "../src/lib/reports.ts";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Исходник одной функции из модуля.
 *
 * Срез нужен, чтобы проверять именно разбираемую функцию: соседние в том же
 * файле делают другое (например, approveRecruitApplication создаёт бойца через
 * insert, а возврат из запаса обязан его восстанавливать), и «срез до конца
 * файла» приписал бы их код проверяемой функции.
 */
function fnSource(source: string, name: string, endMarker = "\nexport "): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `функция ${name} не найдена`);
  const end = source.indexOf(endMarker, start + 1);
  return end > 0 ? source.slice(start, end) : source.slice(start);
}

/* ------------------------------------------------------------------ */
/* Кто считается командиром подразделения                              */
/* ------------------------------------------------------------------ */

describe("Должность и звание командира подразделения", () => {
  test("«Командир подразделения» распознаётся в любом регистре и с пробелами", () => {
    // Должность приходит из rs-red.com, из Google Таблицы и вписывается руками
    for (const post of [
      "Командир подразделения",
      "командир подразделения",
      "КОМАНДИР ПОДРАЗДЕЛЕНИЯ",
      "  Командир   подразделения ",
    ]) {
      assert.equal(isCommanderPost(post), true, `«${post}» должна распознаваться`);
    }
  });

  test("прочие должности командиром не делают", () => {
    // Иначе права штаба разъехались бы по всему составу
    for (const post of [
      "Командир отделения",
      "Механик-водитель",
      "Наводчик",
      "Заместитель командира",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isCommanderPost(post), false, `«${String(post)}» не даёт прав командира`);
    }
  });

  test("звание «Полковник» — тоже признак командира подразделения", () => {
    // Требование: у командира может быть не заполнена должность, но звание есть
    assert.equal(isCommanderRank("Полковник"), true);
    assert.equal(isCommanderRank("полковник"), true);
    assert.equal(isCommanderRank("Подполковник"), false);
    assert.equal(isCommanderRank("Рядовой"), false);
  });

  test("командир определяется по должности ИЛИ по званию", () => {
    assert.equal(isCommanderAppointment("Командир подразделения", "Рядовой"), true);
    assert.equal(isCommanderAppointment("Механик-водитель", "Полковник"), true);
    assert.equal(isCommanderAppointment("Механик-водитель", "Рядовой"), false);
    assert.equal(isCommanderAppointment(null, null), false);
  });
});

/* ------------------------------------------------------------------ */
/* Алиас «commander» и расчёт прав                                     */
/* ------------------------------------------------------------------ */

describe("Роли: «commander» и итоговые права", () => {
  test("«commander» сводится к внутреннему «officer»", () => {
    // Требование называет роль commander, БД и токены — officer
    assert.equal(normalizeCommanderRole("commander"), "officer");
    assert.equal(normalizeCommanderRole("Commander"), "officer");
    assert.equal(normalizeCommanderRole("officer"), "officer");
    assert.equal(normalizeCommanderRole("admin"), "admin");
  });

  test("мусор в колонке роли прав не даёт", () => {
    for (const junk of ["guest", "superuser", "", null, undefined, 42, {}]) {
      assert.equal(normalizeCommanderRole(junk), null);
    }
  });

  test("командир подразделения получает флаги и без роли штаба", () => {
    // Ровно случай из отчёта: должность есть, сессии панели нет
    const rights = resolvePanelRights({
      panelRole: null,
      memberRole: "member",
      memberPost: "Командир подразделения",
      memberRank: "Полковник",
    });
    assert.equal(rights.isCommander, true);
    assert.equal(rights.canControl, true);
    assert.equal(rights.canEditRosterDiscordId, true);
    assert.equal(rights.accessRole, "commander");
    // Командир не становится администратором: /settings и обслуживание закрыты
    assert.equal(rights.isAdmin, false);
  });

  test("роль officer/commander у бойца даёт те же права", () => {
    for (const role of ["officer", "commander"]) {
      const rights = resolvePanelRights({ memberRole: role });
      assert.equal(rights.isCommander, true, `роль «${role}» должна давать командира`);
      assert.equal(rights.isAdmin, false);
    }
  });

  test("администратор проходит всегда и получает isAdmin", () => {
    for (const panelRole of ["admin", "Admin"]) {
      const rights = resolvePanelRights({ panelRole });
      assert.equal(rights.isAdmin, true);
      assert.equal(rights.isCommander, true);
      assert.equal(rights.accessRole, "admin");
    }
    // Админ из кабинета бойца — тоже администратор
    assert.equal(resolvePanelRights({ memberRole: "admin" }).isAdmin, true);
  });

  test("боец и гость прав штаба не получают", () => {
    for (const input of [
      { memberRole: "member", memberPost: "Механик-водитель", memberRank: "Рядовой" },
      { panelRole: null, memberRole: "recruit" },
      { panelRole: "guest" },
      {},
    ]) {
      const rights = resolvePanelRights(input);
      assert.equal(rights.isCommander, false);
      assert.equal(rights.canControl, false);
      assert.equal(rights.canEditRosterDiscordId, false);
      assert.equal(rights.accessRole, "guest");
    }
  });

  test("права объединяются по ИЛИ и не понижаются", () => {
    // Командир, чья учётная запись привязана к бойцу-«member», не теряет доступ
    const rights = resolvePanelRights({
      panelRole: "officer",
      memberRole: "member",
      memberPost: "Механик-водитель",
      memberRank: "Рядовой",
    });
    assert.equal(rights.isCommander, true);
    assert.equal(rights.accessRole, "commander");
  });
});

/* ------------------------------------------------------------------ */
/* Флаги отдаются клиенту и учитываются воротами                       */
/* ------------------------------------------------------------------ */

describe("Флаги прав в API и воротах разделов", () => {
  test("/api/me отдаёт isCommander, isAdmin и роль по обеим сессиям", () => {
    const source = read("src/app/api/me/route.ts");
    assert.match(source, /isCommander: rights\.isCommander/);
    assert.match(source, /isAdmin: rights\.isAdmin/);
    assert.match(source, /role: rights\.accessRole/);
    assert.match(source, /canViewPrivate: rights\.canViewPrivate/);
    // Права считает единое правило, а не «роль панельной cookie»
    assert.match(source, /resolvePanelRights\(/);
    assert.match(source, /memberPost: member\?\.post/);
  });

  test("/api/member/session отдаёт те же флаги, включая гостя", () => {
    const source = read("src/app/api/member/session/route.ts");
    assert.match(source, /isCommander: rights\.isCommander/);
    assert.match(source, /isAdmin: rights\.isAdmin/);
    // Гость получает явные false: клиент работает по одному контракту
    assert.match(source, /isCommander: false/);
  });

  test("страница «Контроль» пускает по флагу, а не по «role === guest»", () => {
    const source = read("src/app/control/page.tsx");
    assert.match(source, /if \(!isCommander\)/);
    assert.equal(
      /role === "guest"\) \{\s*return <div className="p-10 text-center font-bold"/.test(source),
      false,
      "осталась проверка роли сессии панели"
    );
    assert.match(source, /me\.isCommander/);
  });

  test("сайдбар показывает «Контроль» командирам и админам", () => {
    const source = read("src/components/shell.tsx");
    assert.match(source, /href: "\/control", label: "Контроль", icon: ShieldAlert/);
    assert.match(source, /const isStaff = isCommander \|\| isAdmin;/);
    // Настройки остаются привилегией администратора
    assert.match(source, /isAdmin \? \[\{ href: "\/settings"/);
  });

  test("middleware пропускает командира к правке Discord ID из кабинета", () => {
    const source = read("src/middleware.ts");
    // Ветка стоит до protectedPaths: иначе командир с member_token получал 401
    const rosterAt = source.indexOf('pathname.startsWith("/api/admin/roster")');
    const protectedAt = source.indexOf("if (!isProtected) return withCsp");
    assert.ok(rosterAt > 0, "нет отдельной ветки для правки Discord ID");
    assert.ok(rosterAt < protectedAt, "ветка правки стоит после общей проверки protectedPaths");
    assert.match(source, /memberClaims\(memberToken\)/);
    // Правка состава больше не описана как админская зона
    assert.equal(
      /pathname\.startsWith\("\/api\/admin\/roster"\);/.test(source),
      false,
      "правка состава осталась в списке админских зон"
    );
  });

  test("/api/members отдаёт Discord ID командиру подразделения", () => {
    const source = read("src/app/api/members/route.ts");
    // Иначе колонка в табеле видна, но пуста — ID приходит как null, и поле
    // выглядит «заблокированным» даже при открытом окне правки
    assert.match(source, /resolvePanelRights\(/);
    assert.match(source, /memberPost: member\?\.post/);
    assert.equal(
      /canViewPrivateFields\(user\?\.role, member\?\.role\)/.test(source),
      false,
      "право видимости осталось на ролях без учёта должности"
    );
  });
});
/* ------------------------------------------------------------------ */
/* Вид заявки: новобранец или возврат из запаса                        */
/* ------------------------------------------------------------------ */

describe("Вид заявки на вступление", () => {
  test("известны ровно два вида, подписи совпадают с требованием", () => {
    assert.deepEqual([...RECRUIT_APPLICATION_KINDS], ["recruit", "reserve_return"]);
    assert.equal(APPLICATION_KIND_LABELS.recruit, "Новобранец");
    assert.equal(APPLICATION_KIND_LABELS.reserve_return, "Возврат из запаса");
    // Формулировка требования для панели модерации
    assert.equal(APPLICATION_KIND_TITLES.reserve_return, "Запрос на возврат из запаса");
  });

  test("неизвестный вид не проходит проверку", () => {
    assert.equal(isRecruitApplicationKind("reserve_return"), true);
    assert.equal(isRecruitApplicationKind("recruit"), true);
    assert.equal(isRecruitApplicationKind("reserve"), false);
    assert.equal(isRecruitApplicationKind(null), false);
  });

  test("возврат из запаса не требует анкеты, новобранец — требует", () => {
    // Возвращающегося не спрашивают про возраст и опыт: он уже служил, и его
    // данные в табеле. Требование называет для него только позывной и ФИО.
    const returned = validateApplication({ kind: APPLICATION_KIND_RESERVE_RETURN });
    assert.equal(returned.ok, true, "анкета возврата должна приниматься пустой");

    // Новобранец без анкеты по-прежнему отклоняется: поля нужны штабу
    assert.equal(validateApplication({ kind: "recruit" }).ok, false);
    assert.equal(validateApplication({}).ok, false);
  });

  test("ФИО нормализуется и проверяется как ключ поиска строки", () => {
    assert.equal(normalizeFullName("  Волков   Д. В.  "), "Волков Д. В.");
    assert.equal(isFullName("Волков Д. В."), true);
    // Слишком короткое значение строку на листе «Запас» не найдёт
    assert.equal(isFullName("Вол"), false);
    assert.equal(isFullName(""), false);
    assert.equal(isFullName(null), false);
  });
});

/* ------------------------------------------------------------------ */
/* Признак возврата в Embed и в очереди модерации                      */
/* ------------------------------------------------------------------ */

describe("Заявка на возврат помечается для штаба", () => {
  test("Embed возврата называется «Запрос на возврат из запаса»", () => {
    const embed = buildRecruitEmbed({
      id: 7,
      callsign: "Волков",
      discordTag: "",
      discordId: null,
      age: 30,
      armaExperience: "1000 часов",
      about: "",
      createdAt: new Date("2026-09-01T10:00:00Z"),
      status: "pending",
      kind: APPLICATION_KIND_RESERVE_RETURN,
      fullName: "Волков Д. В.",
    });
    assert.match(embed.title ?? "", /Запрос на возврат из запаса #7/);
    const fields = embed.fields ?? [];
    assert.ok(
      fields.some((f) => f.name === "ФИО в табеле" && f.value.includes("Волков Д. В.")),
      "нет поля с ФИО возвращающегося"
    );
  });

  test("обычная заявка сохраняет прежний заголовок", () => {
    const embed = buildRecruitEmbed({
      id: 8,
      callsign: "Сокол",
      discordTag: "",
      discordId: null,
      age: 20,
      armaExperience: "300 часов",
      about: "",
      createdAt: new Date("2026-09-01T10:00:00Z"),
      status: "pending",
    });
    assert.match(embed.title ?? "", /Заявка на вступление #8/);
    assert.equal(
      (embed.fields ?? []).some((f) => f.name === "ФИО в табеле"),
      false,
      "у новобранца не должно быть поля ФИО"
    );
  });

  test("очередь модерации подписывает возврат отдельной формулировкой", () => {
    const source = read("src/components/review-queue.tsx");
    assert.match(source, /APPLICATION_KIND_TITLES\.reserve_return/);
    assert.match(source, /row\.kind === APPLICATION_KIND_RESERVE_RETURN/);
    // ФИО показывается, иначе строку в «Запасе» найти нечем
    assert.match(source, /row\.fullName/);
  });
});
/* ------------------------------------------------------------------ */
/* Решение по возврату: восстановление, а не зачисление                */
/* ------------------------------------------------------------------ */

describe("Решение по заявке зависит от её вида", () => {
  test("одобрение выбирает сценарий по виду заявки из БД", () => {
    const source = read("src/lib/review.ts");
    const fn = fnSource(source, "approveRecruitByKind");
    assert.match(fn, /application\.kind === APPLICATION_KIND_RESERVE_RETURN/);
    assert.match(fn, /approveReserveReturn\(/);
    assert.match(fn, /approveRecruitApplication\(/);
  });

  test("панель модерации и кнопки Discord решают одинаково", () => {
    // Копия выбора в двух местах разошлась бы: из сайта зачисляло бы, а из
    // Discord восстанавливало (или наоборот).
    //
    // Из бота дополнительно передаётся Discord ID нажавшего — по требованию
    // сообщение должно сказать «Одобрено модератором @ник». Поэтому вызов
    // проверяется по имени функции и её первому аргументу, а не дословно.
    assert.match(read("src/app/api/admin/reports/route.ts"), /approveRecruitByKind\(id, reviewer\)/);
    assert.match(read("src/lib/bot.ts"), /approveRecruitByKind\(parsed\.id, reviewer,/);
  });

  test("возврат восстанавливает бойца, а не создаёт нового", () => {
    const source = read("src/lib/review.ts");
    const fn = fnSource(source, "approveReserveReturn");
    // active = true и статус «в строю» — требование сценария
    assert.match(fn, /active: true/);
    assert.match(fn, /status: MEMBER_STATUS\.ACTIVE/);
    // Строку ШДС двигает существующий модуль запаса (лист «Запас» → «Вакант»),
    // а INSERT нового бойца в этом сценарии быть не должно: иначе вместо
    // восстановления появился бы дубль строки в табеле
    assert.match(fn, /returnFromReserve\(/);
    assert.equal(/insert\(members\)/.test(fn), false, "возврат создаёт нового бойца вместо восстановления");
  });

  test("отказ переноса строки не фиксирует решение", () => {
    const source = read("src/lib/review.ts");
    const fn = fnSource(source, "approveReserveReturn");
    // Строка осталась в запасе — состояние согласовано, модератор повторит
    assert.match(fn, /SHEET_FAILED/);
    assert.match(fn, /sheet\.ok/);
  });

  test("заявка без ФИО возврату не подлежит", () => {
    const source = read("src/lib/review.ts");
    const fn = fnSource(source, "approveReserveReturn");
    assert.match(fn, /EMPTY_FULL_NAME/);
    assert.match(fn, /application\.fullName/);
  });

  test("форма /apply позволяет выбрать вид и требует ФИО для возврата", () => {
    const source = read("src/app/apply/page.tsx");
    assert.match(source, /setKind\(option\)/);
    assert.match(source, /kind === APPLICATION_KIND_RESERVE_RETURN/);
    assert.match(source, /kind,\s*\r?\n\s*fullName,/);
  });

  test("роут /apply проверяет ФИО только для возврата и пишет вид в БД", () => {
    const source = read("src/app/api/apply/route.ts");
    assert.match(source, /isRecruitApplicationKind\(body\.kind\)/);
    assert.match(source, /kind: input\.kind/);
    assert.match(source, /fullName: input\.fullName \|\| null/);
  });

  test("заявка на возврат не создаёт дубль карточки бойца", () => {
    const source = read("src/app/api/apply/route.ts");
    // Позывной уникален, и карточка возвращающегося уже существует: INSERT
    // дал бы дубль, а форма отвечала бы «Позывной занят» самому бойцу
    assert.match(source, /createApplicationForMember\(req, ip, found, input, discordId, fromCookie\)/);
    const fn = (() => {
      const start = source.indexOf("function createApplicationForMember");
      assert.ok(start > 0, "нет ветки заявки по существующей карточке");
      // Функция последняя в файле: срезаем от её начала до конца
      return source.slice(start);
    })();
    assert.equal(/insert\(members\)/.test(fn), false, "ветка создаёт нового бойца вместо привязки к существующему");
  });

  test("возврат недоступен тому, кто и так в строю, и незнакомому ФИО", () => {
    const source = read("src/app/api/apply/route.ts");
    // Иначе заявка на возврат принималась бы у действующего бойца или у чужого
    // человека, и модератор искал бы строку, которой в «Запасе» нет
    assert.match(source, /found\.active && found\.status !== "dismissed"/);
    assert.match(source, /не найден в составе/);
  });

  test("схема БД хранит вид заявки и ФИО отдельными колонками", () => {
    const source = read("src/db/schema.ts");
    assert.match(source, /kind: varchar\("kind", \{ length: 20 \}\)/);
    assert.match(source, /fullName: text\("full_name"\)/);
    // Миграция обязана существовать: без неё чтение колонок упало бы на проде
    const migration = read("scripts/migrations/2026-09-reserve-return.sql");
    assert.match(migration, /ADD COLUMN IF NOT EXISTS "kind"/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS "full_name"/);
  });
});

/* ------------------------------------------------------------------ */
/* Discord — «мягкий» сервис, и повторный клик по одобрению            */
/* ------------------------------------------------------------------ */

/**
 * Исходник функции по имени: экспортной или внутренней.
 *
 * Скобка после имени не требуется: у обобщённых функций между ними стоит
 * параметр типа (`function safeDiscord<T>(`), и поиск по «имя(» их бы пропустил.
 */
function anyFnSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `функция ${name} не найдена`);
  const end = source.indexOf("\nexport ", start + 1);
  return end > 0 ? source.slice(start, end) : source.slice(start);
}

describe("Ошибка Discord не отменяет решение штаба", () => {
  const source = read("src/lib/review.ts");

  test("есть общая обёртка, которая логирует и возвращает fallback", () => {
    const fn = anyFnSource(source, "safeDiscord");
    // Решение уже в БД: исключение наружу превратило бы зачисление в «ошибку»
    assert.match(fn, /catch \(err\)/);
    assert.match(fn, /console\.warn\(DISCORD_WARNING/);
    assert.match(fn, /return fallback/);
    // Формулировка из требования — по ней ищут инцидент в журнале
    assert.match(source, /const DISCORD_WARNING = "\[review\] Ошибка Discord, продолжаем зачисление:"/);
  });

  test("каждый вызов Discord в модуле обёрнут или логирует отказ", () => {
    // Голых вызовов быть не должно: любой из них способен прервать зачисление
    const dm = source.slice(source.indexOf("if (realDiscord) {"), source.indexOf("await grantRecruitRole("));
    assert.match(dm, /safeDiscord<DmResult>/, "отправка ЛС не обёрнута");

    const publish = anyFnSource(source, "publishReviewMessage");
    assert.match(publish, /catch \(e\)/);
    assert.match(publish, /console\.warn\(DISCORD_WARNING/);

    for (const name of ["refreshRecruitMessage", "refreshReportMessage"]) {
      const fn = anyFnSource(source, name);
      assert.match(fn, /console\.warn\(DISCORD_WARNING/, `${name}: отказ Discord не помечен общей формулировкой`);
    }
  });

  test("нечисловой ID канала — без сетевого запроса", () => {
    const fn = anyFnSource(source, "realDiscordId");
    // Плейсхолдер «:id», «undefined» и обрезанные строки — не снежинки
    assert.match(fn, /\^\\d\{5,25\}\$/);
    // Всё, что не снежинка, превращается в пустую строку — признак «не отправлять»
    assert.match(fn, /\? id : ""/);

    // Публикация: выход до вызова sendChannelMessage
    const publish = anyFnSource(source, "publishReviewMessage");
    const guard = publish.indexOf("const channel = realDiscordId(channelId)");
    const send = publish.indexOf("sendChannelMessage(channel");
    assert.ok(guard > 0 && guard < send, "проверка канала должна стоять до запроса");

    // Обновление сообщений: выход до editChannelMessage
    for (const name of ["refreshRecruitMessage", "refreshReportMessage"]) {
      const fn = anyFnSource(source, name);
      const check = fn.indexOf("if (!channelId || !messageId)");
      const edit = fn.indexOf("await editChannelMessage(channelId, messageId");
      assert.ok(check > 0, `${name}: нет проверки ID`);
      assert.ok(edit > check, `${name}: запрос уходит без проверки ID`);
      // Прежние обращения к полям БД напрямую в путь не попадают
      assert.equal(
        /editChannelMessage\(application\.discord/.test(fn) ||
          /editChannelMessage\(report\.discord/.test(fn),
        false,
        `${name}: в путь запроса уходит необработанный ID из БД`
      );
    }
  });
});

describe("Повторное одобрение заявки доводит зачисление до конца", () => {
  const source = read("src/lib/review.ts");

  test("карточка из упавшей попытки опознаётся и подхватывается", () => {
    const fn = anyFnSource(source, "lookupCallsignForApplication");
    // Связь заявки с бойцом — самый надёжный признак той же попытки
    assert.match(fn, /application\.memberId === taken\.id/);
    assert.match(fn, /kind: "retry"/);
    // Признаки «свежей» карточки новобранца: иначе одобрение перехватило бы
    // чужой действующий аккаунт
    assert.match(fn, /taken\.role === "recruit"/);
    assert.match(fn, /taken\.status === MEMBER_STATUS\.ACTIVE/);
    assert.match(fn, /!taken\.unit/);
    assert.match(fn, /kind: "taken"/);
  });

  test("CALLSIGN_TAKEN остаётся только для чужого позывного", () => {
    const fn = fnSource(source, "approveRecruitApplication");
    // Отказ выдаётся лишь при исходе taken, а не по факту занятости позывного
    assert.match(fn, /if \(lookup\.kind === "taken"\)/);
    assert.match(fn, /CALLSIGN_TAKEN/);
    // Прямая проверка занятости из функции ушла — она жила до try/catch и не
    // умела отличать повторную попытку от чужого аккаунта
    assert.equal(
      /where\(eq\(members\.callsign, callsign\)\)/.test(fn),
      false,
      "проверка позывного осталась в обход lookupCallsignForApplication"
    );
  });

  test("при повторе записывается ШДС и выставляется статус approved", () => {
    const fn = fnSource(source, "approveRecruitApplication");
    const retry = fn.slice(fn.indexOf("if (isRetry)"), fn.indexOf("} else {"));
    assert.match(retry, /status: "approved"/);
    assert.match(retry, /memberId,/);
    assert.match(retry, /reviewedBy: reviewer/);
    assert.match(retry, /ensureShdsRowForMember\(/);
    // Нового бойца повтор не создаёт: иначе появился бы дубль в табеле
    assert.equal(/insert\(members\)/.test(retry), false, "повтор создаёт второго бойца");
  });

  test("повторная запись в ШДС не занимает вторую строку «Вакант»", () => {
    const fn = anyFnSource(source, "ensureShdsRowForMember");
    // Сначала поиск бойца в листе — та же колонка имени, что у сценария добавления
    assert.match(fn, /findNameRow\(sheet, layout, name\)/);
    assert.match(fn, /повторная запись не нужна/);
    // И только потом собственно запись
    const search = fn.indexOf("findNameRow(");
    const write = fn.indexOf("return writeMemberToShds(");
    assert.ok(search > 0 && write > search, "запись идёт до проверки наличия строки");
    // Прежние имена тоже проверяются: при слиянии карточек в листе может
    // стоять ФИО из заявки, а в карточке — позывной
    assert.match(fn, /extraNames/);
  });

  test("ошибка ШДС не отменяет зачисление и видна в итоге", () => {
    const fn = anyFnSource(source, "writeMemberToShds");
    assert.match(fn, /catch \(e\)/);
    assert.match(fn, /return `ШДС: ошибка/);
    // Итог попадает и в ответ решения, и в журнал
    const approve = fnSource(source, "approveRecruitApplication");
    assert.match(approve, /shdsOutcome = await ensureShdsRowForMember/);
    assert.match(approve, /"ШДС": shdsOutcome/);
  });
});