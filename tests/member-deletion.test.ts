/**
 * Полное удаление профиля бойца администратором.
 *
 * Проверяются боевые модули, а не копии правил в тесте:
 *   * src/lib/member-deletion.ts — правило доступа, подтверждение, порядок
 *     шагов удаления, разбор внешних ключей;
 *   * роут /api/admin/members/[id] — ответы 401/403/404/400 и успешное удаление
 *     с отвязкой users.member_id и очисткой сессий;
 *   * src/middleware.ts — гость и командир до роута не доходят.
 *
 * Почему это критично. Удаление необратимо: ошибка в правиле доступа отдаёт
 * командиру право стирать личные дела, ослабленное подтверждение превращает
 * промах по корзине в потерю бойца, а пропущенный шаг отвязки учётной записи
 * оставляет администратора без входа в панель (внешний ключ без SET NULL
 * останавливает DELETE). Ровно эти три сценария проверяются ниже.
 *
 * Роут вызывается через deleteMemberHandler с подменёнными зависимостями:
 * без базы подписанный токен не проверяется (роль читается из users), поэтому
 * «настоящий» 403 для командира иначе не получить. Подменяется только источник
 * данных — правила, порядок шагов и тексты ответов исполняет боевой код.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  deleteMemberProfile,
  MemberDeletionError,
  memberDeletionAction,
  memberDeletionAuthor,
  memberDeletionConfirmationLabel,
  memberDeletionConfirmationMatches,
  memberDeletionDecision,
  parseMemberId,
  relatedColumnsToClear,
  isSafeRelationName,
  KNOWN_MEMBER_TABLES,
  type ForeignKeyRow,
  type MemberDeletionStore,
  type MemberDeletionTarget,
} from "../src/lib/member-deletion.ts";
import { middleware } from "../src/middleware.ts";
import type { MemberDeletionApiDeps } from "../src/app/api/admin/members/[id]/route.ts";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/* ------------------------------------------------------------------ */
/* Хелперы                                                             */
/* ------------------------------------------------------------------ */

/** Запрос к роуту удаления. Тело — подтверждение, как его шлёт окно панели */
function deleteRequest(
  id: number | string,
  options: {
    method?: string;
    cookie?: string;
    confirmation?: string;
    origin?: string;
    fetchSite?: string;
  } = {}
): NextRequest {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  headers.set("host", "panel.example");

  const body =
    options.confirmation === undefined
      ? undefined
      : JSON.stringify({ confirmation: options.confirmation });
  if (body) headers.set("content-type", "application/json");

  return new NextRequest(new URL(`/api/admin/members/${id}`, "http://panel.example"), {
    method: options.method ?? "DELETE",
    headers,
    body,
  });
}

/** Боец для проверок правил и удаления */
const TARGET: MemberDeletionTarget = { id: 7, name: "Волков Д. В.", callsign: "Волков" };

/**
 * Хранилище-двойник: записывает порядок вызовов и отдаёт заданные числа строк.
 * Позволяет проверить, что отвязка users.member_id и очистка сессий реально
 * происходят и происходят ДО удаления самой карточки.
 */
function makeStore(options: {
  member?: MemberDeletionTarget | null;
  sessions?: number;
  weeklyStats?: number;
  panelAccounts?: number;
  /** Удалить строку не удалось: имитация гонки параллельного DELETE */
  deleteFails?: boolean;
} = {}) {
  const calls: string[] = [];
  const store: MemberDeletionStore = {
    async findMember() {
      calls.push("findMember");
      return options.member === undefined ? TARGET : options.member;
    },
    async unlinkPanelAccounts() {
      calls.push("unlinkPanelAccounts");
      return options.panelAccounts ?? 0;
    },
    async clearMemberSessions() {
      calls.push("clearMemberSessions");
      return options.sessions ?? 0;
    },
    async clearWeeklyStats() {
      calls.push("clearWeeklyStats");
      return options.weeklyStats ?? 0;
    },
    async deleteMember() {
      calls.push("deleteMember");
      return !options.deleteFails;
    },
  };
  return { store, calls };
}

/**
 * Подменяемые зависимости роута: тип берётся из боевого модуля, поэтому
 * переименование поля в роуте сломает тест, а не пройдёт незамеченным.
 */
type RouteDeps = MemberDeletionApiDeps;

/** Зависимости роута с подменёнными источниками */
async function makeDeps(
  overrides: {
    panelRole?: string | null;
    memberRole?: string | null;
    member?: MemberDeletionTarget | null;
    sessions?: number;
    weeklyStats?: number;
    panelAccounts?: number;
    removeError?: Error;
  } = {}
) {
  const { deleteMemberHandler } = await import("../src/app/api/admin/members/[id]/route.ts");
  // Роли сессий: undefined означает «значение по умолчанию для этого теста»
  const logged: unknown[] = [];
  const removeCalls: number[] = [];

  const panelRole = overrides.panelRole === undefined ? "admin" : overrides.panelRole;
  const memberRole = overrides.memberRole === undefined ? null : overrides.memberRole;

  const deps: RouteDeps = {
    panel: async () =>
      panelRole === null
        ? null
        : ({ role: panelRole, username: "dev-admin" } as never),
    member: async () =>
      memberRole === null ? null : ({ role: memberRole, callsign: "Волков" } as never),
    loadMember: async () => (overrides.member === undefined ? TARGET : overrides.member),
    remove: async (id: number) => {
      removeCalls.push(id);
      if (overrides.removeError) throw overrides.removeError;
      return {
        member: TARGET,
        result: {
          removed: {
            sessions: overrides.sessions ?? 2,
            weeklyStats: overrides.weeklyStats ?? 1,
          },
          unlinkedPanelAccounts: overrides.panelAccounts ?? 1,
        },
      };
    },
    log: async (entry: unknown) => {
      logged.push(entry);
    },
  };

  return { deps, logged, removeCalls, deleteMemberHandler };
}

/* ------------------------------------------------------------------ */
/* Правило доступа                                                     */
/* ------------------------------------------------------------------ */

describe("Кто вправе удалить профиль бойца", () => {
  test("администратор допускается в любой из сессий", () => {
    // Панель: администратор ведёт бота, строки в табеле у него может не быть
    assert.equal(memberDeletionDecision("admin", undefined), "allow");
    // Кабинет: боец с ролью admin из division_members
    assert.equal(memberDeletionDecision(undefined, "admin"), "allow");
    assert.equal(memberDeletionDecision("admin", "member"), "allow");
  });

  test("командир, офицер и боец получают отказ — это не их полномочие", () => {
    // Ослабление этого правила отдало бы уничтожение личных дел командиру
    for (const role of ["officer", "commander", "member", "recruit"]) {
      assert.equal(memberDeletionDecision(role, undefined), "forbidden", `панель: ${role}`);
      assert.equal(memberDeletionDecision(undefined, role), "forbidden", `кабинет: ${role}`);
    }
  });

  test("гость без сессий — не авторизован, а не «недостаточно прав»", () => {
    // 401 и 403 различают «войдите» и «у вас нет прав»: смешение заставит
    // командира искать проблему в cookie вместо роли
    assert.equal(memberDeletionDecision(undefined, undefined), "unauthenticated");
    assert.equal(memberDeletionDecision(null, null), "unauthenticated");
    assert.equal(memberDeletionDecision("guest", undefined), "forbidden");
  });
});

/* ------------------------------------------------------------------ */
/* Подтверждение                                                       */
/* ------------------------------------------------------------------ */

describe("Подтверждение удаления", () => {
  test("подтверждается позывной бойца", () => {
    assert.equal(memberDeletionConfirmationLabel(TARGET), "Волков");
    assert.equal(memberDeletionConfirmationMatches("Волков", TARGET), true);
  });

  test("регистр и лишние пробелы не мешают", () => {
    // Цель — не дать удалить карточку одной кнопкой, а не заставить админа
    // угадывать регистр позывного
    assert.equal(memberDeletionConfirmationMatches("  волков ", TARGET), true);
    assert.equal(memberDeletionConfirmationMatches("ВОЛКОВ", TARGET), true);
  });

  test("чужие значения отклоняются: имя, пустота, часть позывного", () => {
    assert.equal(memberDeletionConfirmationMatches("Волков Д. В.", TARGET), false);
    assert.equal(memberDeletionConfirmationMatches("", TARGET), false);
    assert.equal(memberDeletionConfirmationMatches("   ", TARGET), false);
    assert.equal(memberDeletionConfirmationMatches("Волк", TARGET), false);
    assert.equal(memberDeletionConfirmationMatches(null, TARGET), false);
    assert.equal(memberDeletionConfirmationMatches(undefined, TARGET), false);
    assert.equal(memberDeletionConfirmationMatches(123, TARGET), false);
  });

  test("без позывного подтверждением служит имя из табеля", () => {
    // У бойцов из синхронизации rs-red.com позывного может не быть: требовать
    // пустую строку означало бы подтверждение «на Enter»
    const noCallsign: MemberDeletionTarget = { id: 9, name: "Сокол А. В.", callsign: null };
    assert.equal(memberDeletionConfirmationLabel(noCallsign), "Сокол А. В.");
    assert.equal(memberDeletionConfirmationMatches("Сокол А. В.", noCallsign), true);
    // Пустая строка при пустом позывном не подтверждает ничего
    const empty: MemberDeletionTarget = { id: 10, name: "   ", callsign: "  " };
    assert.equal(memberDeletionConfirmationMatches("", empty), false);
  });
});

/* ------------------------------------------------------------------ */
/* Аудит                                                               */
/* ------------------------------------------------------------------ */

describe("Запись в аудит-лог", () => {
  test("формулировка действия содержит позывной и ID", () => {
    const action = memberDeletionAction(TARGET);
    assert.match(action, /удалил личное дело бойца Волков \(ID: 7\)/);
  });

  test("вместо пустого позывного подставляется имя", () => {
    const action = memberDeletionAction({ id: 3, name: "Сокол", callsign: null });
    assert.match(action, /бойца Сокол \(ID: 3\)/);
  });

  test("подпись автора: логин панели, иначе позывной, иначе просто роль", () => {
    assert.equal(memberDeletionAuthor({ username: "dev-admin" }), "Администратор dev-admin");
    assert.equal(memberDeletionAuthor({ username: "", callsign: "Волков" }), "Администратор Волков");
    assert.equal(memberDeletionAuthor({}), "Администратор");
  });
});

/* ------------------------------------------------------------------ */
/* Порядок шагов удаления                                              */
/* ------------------------------------------------------------------ */

describe("deleteMemberProfile — неделимая операция", () => {
  test("успех: отвязка аккаунта и сессии ДО удаления карточки", async () => {
    const { store, calls } = makeStore({ sessions: 3, weeklyStats: 2, panelAccounts: 1 });
    const outcome = await deleteMemberProfile(7, { store });

    assert.equal(outcome.member.id, 7);
    assert.equal(outcome.result.removed.sessions, 3);
    assert.equal(outcome.result.removed.weeklyStats, 2);
    assert.equal(outcome.result.unlinkedPanelAccounts, 1);

    // Порядок критичен: отвязка и очистка сессий должны пройти до DELETE, иначе
    // строгий внешний ключ остановит удаление, а админская учётка останется
    // указывать на несуществующего бойца
    assert.deepEqual(calls, [
      "findMember",
      "unlinkPanelAccounts",
      "clearMemberSessions",
      "clearWeeklyStats",
      "deleteMember",
    ]);
    assert.ok(
      calls.indexOf("unlinkPanelAccounts") < calls.indexOf("deleteMember"),
      "users.member_id обнуляется после удаления карточки"
    );
    assert.ok(
      calls.indexOf("clearMemberSessions") < calls.indexOf("deleteMember"),
      "сессии бойца удаляются после его карточки"
    );
  });

  test("несуществующий id — ошибка not_found, а не отчёт об успехе", async () => {
    // «Успех» на несуществующем id маскировал бы опечатку в адресе и писал в
    // журнал удаление призрака
    const { store, calls } = makeStore({ member: null });
    await assert.rejects(
      () => deleteMemberProfile(404, { store }),
      (e: unknown) => e instanceof MemberDeletionError && e.code === "not_found"
    );
    // Ни одной разрушающей операции выполнено не было
    assert.deepEqual(calls, ["findMember"]);
  });

  test("гонка: карточку удалили параллельно — транзакция откатывается", async () => {
    const { store } = makeStore({ deleteFails: true });
    await assert.rejects(
      () => deleteMemberProfile(7, { store }),
      (e: unknown) => e instanceof MemberDeletionError && e.code === "not_found"
    );
  });

  test("очистка строгих зависимостей вызывается до удаления карточки", async () => {
    const { store, calls } = makeStore();
    let clearedFor: number | null = null;
    await deleteMemberProfile(7, {
      store,
      clearRelated: async (id) => {
        clearedFor = id;
        calls.push("clearRelated");
      },
    });
    assert.equal(clearedFor, 7);
    assert.ok(
      calls.indexOf("clearRelated") < calls.indexOf("deleteMember"),
      "строгие внешние ключи чистятся после удаления — DELETE упадёт на FK"
    );
  });
});

/* ------------------------------------------------------------------ */
/* Разбор внешних ключей                                               */
/* ------------------------------------------------------------------ */

describe("Внешние ключи: что придётся вычистить самим", () => {
  /** Строка каталога pg_constraint */
  const fk = (over: Partial<ForeignKeyRow>): ForeignKeyRow => ({
    child: "public.weekly_stats",
    columns: ["member_id"],
    action: "a",
    constraint: "weekly_stats_member_id_division_members_id_fk",
    ...over,
  });

  test("каскад и SET NULL оставляем базе — чистить нечего", () => {
    for (const action of ["c", "n"]) {
      assert.deepEqual(
        relatedColumnsToClear([fk({ action })]),
        [],
        `действие ${action}: база справляется сама`
      );
    }
  });

  test("RESTRICT и NO ACTION требуют явной очистки", () => {
    for (const action of ["r", "a"]) {
      const result = relatedColumnsToClear([fk({ action })]);
      assert.deepEqual(result, [{ table: "public.weekly_stats", column: "member_id" }]);
    }
  });

  test("собственные ключи бойца не «чистятся» — иначе удалили бы саму цель", () => {
    const own: ForeignKeyRow = {
      child: "public.division_members",
      columns: ["id"],
      action: "a",
      constraint: "division_members_pid_fk",
    };
    assert.deepEqual(relatedColumnsToClear([own]), []);
  });

  test("ограничение уровня таблицы (без колонок) пропускается", () => {
    assert.deepEqual(relatedColumnsToClear([fk({ columns: [] })]), []);
  });

  test("имя схемы не мешает распознать таблицу состава", () => {
    // pg_constraint отдаёт потомка как «schema.table»: без разбора схемы
    // self-reference на состав не распознался бы, и «очистка» удалила бы цель
    const selfWithSchema: ForeignKeyRow = {
      child: "public.division_members",
      columns: ["id"],
      action: "a",
      constraint: "division_members_leader_fk",
    };
    assert.deepEqual(relatedColumnsToClear([selfWithSchema]), []);
    // Обычный потомок при этом не теряется
    assert.deepEqual(relatedColumnsToClear([fk({ action: "r" })]), [
      { table: "public.weekly_stats", column: "member_id" },
    ]);
  });

  test("документы штаба из схемы идут с SET NULL и сохраняются", () => {
    const source = read("src/db/schema.ts");
    // Рапорты и заявки — служебные документы: удаление профиля не должно
    // стирать решения штаба, позывной в них хранится текстом
    const serviceReports = source.slice(source.indexOf("export const serviceReports"));
    assert.match(serviceReports, /memberId: integer\("member_id"\)\.references\(\(\) => members\.id, \{ onDelete: "set null" \}\)/);
    const applications = source.slice(
      source.indexOf("export const recruitApplications"),
      source.indexOf("export const serviceReports")
    );
    assert.match(applications, /memberId: integer\("member_id"\)\.references\(\(\) => members\.id, \{ onDelete: "set null" \}\)/);
    // Полный перечень таблиц, ссылающихся на бойца, объявлен в модуле
    assert.ok(KNOWN_MEMBER_TABLES.includes("service_reports"));
    assert.ok(KNOWN_MEMBER_TABLES.includes("recruit_applications"));
  });

  test("имена таблиц для подстановки в SQL проверяются", () => {
    assert.equal(isSafeRelationName("public.weekly_stats"), true);
    assert.equal(isSafeRelationName("stat_snapshots"), true);
    // Подстановка имён в запрос — потенциальная точка инъекции
    assert.equal(isSafeRelationName('public."weekly_stats"'), false);
    assert.equal(isSafeRelationName("weekly_stats; DROP TABLE users"), false);
    assert.equal(isSafeRelationName("public.weekly stats"), false);
    assert.equal(isSafeRelationName(""), false);
  });
});

/* ------------------------------------------------------------------ */
/* Роут: доступ и ответы                                               */
/* ------------------------------------------------------------------ */

describe("DELETE /api/admin/members/[id] — доступ", () => {
  test("гость без сессии получает 401", async () => {
    const { deps, deleteMemberHandler } = await makeDeps({ panelRole: null, memberRole: null });
    const res = await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "7" }),
    }, deps);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.match(String(body.error), /авторизуйтесь/i);
  });

  test("командир и офицер получают 403 — удаление не их полномочие", async () => {
    for (const role of ["officer", "commander"]) {
      const { deps, deleteMemberHandler } = await makeDeps({ panelRole: role });
      const res = await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
        params: Promise.resolve({ id: "7" }),
      }, deps);
      assert.equal(res.status, 403, `роль ${role} должна получить отказ`);
      const body = (await res.json()) as { error?: string };
      assert.match(String(body.error), /только администратору/i);
    }
  });

  test("обычный боец с сессией кабинета получает 403", async () => {
    const { deps, deleteMemberHandler } = await makeDeps({ panelRole: null, memberRole: "member" });
    const res = await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "7" }),
    }, deps);
    assert.equal(res.status, 403);
  });

  test("отказ не доходит до удаления: зависимость remove не вызывалась", async () => {
    // Иначе 403 в ответе мог бы сопровождаться уже выполненным DELETE
    const { deps, removeCalls, deleteMemberHandler } = await makeDeps({ panelRole: "officer" });
    await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "7" }),
    }, deps);
    assert.deepEqual(removeCalls, []);
  });
});

describe("DELETE /api/admin/members/[id] — успешное удаление", () => {
  test("админ удаляет профиль: 200, сессии и привязка очищены", async () => {
    const { deps, logged, removeCalls, deleteMemberHandler } = await makeDeps({
      sessions: 2,
      weeklyStats: 3,
      panelAccounts: 1,
    });
    const res = await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "7" }),
    }, deps);

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      member: { id: number; callsign: string | null };
      removed: { sessions: number; weeklyStats: number; unlinkedPanelAccounts: number };
      message: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.member.id, 7);
    assert.equal(body.removed.sessions, 2);
    assert.equal(body.removed.weeklyStats, 3);
    assert.equal(body.removed.unlinkedPanelAccounts, 1, "учётная запись панели должна быть отвязана");
    assert.match(body.message, /Волков/);
    assert.deepEqual(removeCalls, [7]);
  });

  test("действие фиксируется в аудит-логе", async () => {
    const { deps, logged, deleteMemberHandler } = await makeDeps();
    await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "7" }),
    }, deps);

    assert.equal(logged.length, 1, "удаление обязано попасть в журнал");
    const entry = logged[0] as {
      author: string;
      action: string;
      category: string;
      details: Record<string, string>;
    };
    assert.equal(entry.category, "edit");
    assert.equal(entry.author, "Администратор dev-admin");
    assert.match(entry.action, /удалил личное дело бойца Волков \(ID: 7\)/);
    assert.equal(entry.details["Отвязано учётных записей"], "1");
  });

  test("бойцу-администратору из кабинета удаление тоже доступно", async () => {
    const { deps, deleteMemberHandler } = await makeDeps({ panelRole: null, memberRole: "admin" });
    const res = await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "7" }),
    }, deps);
    assert.equal(res.status, 200);
  });

  test("подтверждение принимается и параметром ?confirmation=", async () => {
    // Окно панели шлёт тело, а проверка из документации — параметром
    const { deps, deleteMemberHandler } = await makeDeps();
    const req = new NextRequest(
      new URL("/api/admin/members/7?confirmation=%D0%92%D0%BE%D0%BB%D0%BA%D0%BE%D0%B2", "http://panel.example"),
      { method: "DELETE", headers: { host: "panel.example" }, body: JSON.stringify({ confirmation: "Волков" }) }
    );
    const res = await deleteMemberHandler(req, { params: Promise.resolve({ id: "7" }) }, deps);
    assert.equal(res.status, 200);
  });
});

describe("DELETE /api/admin/members/[id] — защиты от ошибок", () => {
  test("несуществующий id — 404", async () => {
    const { deps, removeCalls, deleteMemberHandler } = await makeDeps({ member: null });
    const res = await deleteMemberHandler(deleteRequest(999, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "999" }),
    }, deps);
    assert.equal(res.status, 404);
    // Ничего не удалялось: 404 означает «нечего удалять»
    assert.deepEqual(removeCalls, []);
  });

  test("гонка в транзакции тоже отвечает 404, а не 500", async () => {
    const { deps, deleteMemberHandler } = await makeDeps({
      removeError: new MemberDeletionError("not_found", "Боец не найден"),
    });
    const res = await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "7" }),
    }, deps);
    assert.equal(res.status, 404);
  });

  test("без подтверждения (или с неверным) — 400, профиль не тронут", async () => {
    for (const confirmation of [undefined, "", "Волков Д. В.", "Дух"]) {
      const { deps, logged, removeCalls, deleteMemberHandler } = await makeDeps();
      const res = await deleteMemberHandler(deleteRequest(7, { confirmation }), {
        params: Promise.resolve({ id: "7" }),
      }, deps);
      assert.equal(res.status, 400, `подтверждение «${confirmation}» должно отклоняться`);
      const body = (await res.json()) as { confirmation?: string };
      // Сервер подсказывает, что именно нужно ввести (позывной бойца)
      assert.equal(body.confirmation, "Волков");
      assert.deepEqual(removeCalls, []);
      assert.deepEqual(logged, [], "отклонённая попытка не пишется как удаление");
    }
  });

  test("разбор ID из адреса строгий: «7.5» не означает бойца с id 7", () => {
    // Number.parseInt("7.5") вернул бы 7, и промах в адресе удалил бы чужой
    // профиль — поэтому разбор идёт отдельным правилом
    assert.equal(parseMemberId("7"), 7);
    assert.equal(parseMemberId(" 12 "), 12);
    assert.equal(parseMemberId("007"), 7);
    for (const bad of ["7.5", "7abc", "0", "-5", "abc", "", "   ", "1e3", "+7", null, undefined, 7]) {
      assert.equal(parseMemberId(bad), null, `«${String(bad)}» должен отклоняться`);
    }
  });

  test("некорректный ID — 400", async () => {
    const { deps, deleteMemberHandler } = await makeDeps();
    for (const id of ["abc", "0", "-5", "7.5", "1e3"]) {
      const res = await deleteMemberHandler(deleteRequest(id, { confirmation: "Волков" }), {
        params: Promise.resolve({ id }),
      }, deps);
      assert.equal(res.status, 400, `id «${id}» должен отклоняться`);
    }
  });

  test("межсайтовый запрос отклоняется собственной проверкой источника", async () => {
    // Middleware — не единственный барьер (matcher может быть сужен), а запрос
    // необратим: проверка источника живёт и в самом роуте
    const { deps, removeCalls, deleteMemberHandler } = await makeDeps();
    const res = await deleteMemberHandler(
      deleteRequest(7, { confirmation: "Волков", origin: "https://evil.example" }),
      { params: Promise.resolve({ id: "7" }) },
      deps
    );
    assert.equal(res.status, 403);
    assert.deepEqual(removeCalls, []);
  });

  /**
   * Сбой базы: клиенту — общее сообщение, детали — только в логах сервера.
   *
   * Проверяем обе половины правила: текст ошибки драйвера (имена таблиц,
   * ограничений, фрагменты SQL) не должен уходить наружу, но обязан попасть в
   * console.error — иначе разбирать инцидент было бы не по чему.
   */
  test("сбой хранилища отвечает 500 без технических деталей", async () => {
    const { deps, deleteMemberHandler } = await makeDeps({
      removeError: new Error("connection terminated"),
    });

    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    let body: { error?: string };
    try {
      const res = await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
        params: Promise.resolve({ id: "7" }),
      }, deps);
      assert.equal(res.status, 500);
      body = (await res.json()) as { error?: string };
    } finally {
      console.error = original;
    }

    assert.equal(body.error, "Не удалось удалить профиль бойца. Обратитесь к логам сервера.");
    assert.doesNotMatch(String(body.error), /connection terminated/, "детали БД наружу не уходят");
    assert.ok(
      logged.some((args) => args.some((a) => String(a).includes("connection terminated"))),
      "причина сбоя должна остаться в логах сервера"
    );
  });

  test("сбой записи в журнал не отменяет уже состоявшееся удаление", async () => {
    const { deps, deleteMemberHandler } = await makeDeps();
    const failing: typeof deps = {
      ...deps,
      log: async () => {
        throw new Error("журнал недоступен");
      },
    };
    const res = await deleteMemberHandler(deleteRequest(7, { confirmation: "Волков" }), {
      params: Promise.resolve({ id: "7" }),
    }, failing);
    // Профиля уже нет — отвечать ошибкой значило бы соврать о состоянии базы
    assert.equal(res.status, 200);
  });
});

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

describe("Middleware: адрес удаления закрыт строго для администратора", () => {
  test("без сессии — 401 JSON, а не редирект", async () => {
    const res = await middleware(
      new NextRequest(new URL("/api/admin/members/7", "http://panel.example"), {
        method: "DELETE",
        headers: { host: "panel.example" },
      })
    );
    assert.equal(res.status, 401);
  });

  test("небезопасный метод с чужого источника отклоняется на входе", async () => {
    const res = await middleware(
      new NextRequest(new URL("/api/admin/members/7", "http://panel.example"), {
        method: "DELETE",
        headers: {
          host: "panel.example",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      })
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.match(String(body.error), /чужого источника/);
  });

  test("адрес внесён в список cookie-авторизованных путей (CSRF-проверка)", () => {
    const source = read("src/middleware.ts");
    const list = source.slice(
      source.indexOf("const cookieAuthApiPaths = ["),
      source.indexOf("/**\n * Отсекаем межсайтовые запросы")
    );
    assert.match(list, /"\/api\/admin\/members"/, "удаление не покрыто CSRF-проверкой middleware");
  });

  test("ветка удаления в middleware пускает только роль admin", () => {
    const source = read("src/middleware.ts");
    const branch = source.slice(
      source.indexOf("if (pathname.startsWith(\"/api/admin/members\"))"),
      source.indexOf("«Журнал» (/logs и /api/logs)")
    );
    assert.ok(branch.length > 0, "в middleware нет отдельной ветки для удаления профиля");
    assert.match(branch, /role === "admin"/, "ветка не проверяет роль администратора панели");
    assert.match(branch, /claims\?\.role === "admin"/, "ветка не проверяет роль администратора кабинета");
    // Командир и офицер в этой ветке допускаться не должны
    assert.equal(
      /role === "officer"/.test(branch),
      false,
      "ветка удаления пропускает офицера — это не его полномочие"
    );
  });
});

/* ------------------------------------------------------------------ */
/* Интерфейс: кнопка и окно                                            */
/* ------------------------------------------------------------------ */

describe("Интерфейс: удаление доступно только администратору", () => {
  test("табель показывает кнопку по флагу isAdmin из /api/me", () => {
    const source = read("src/app/members/page.tsx");
    assert.match(source, /setIsAdmin\(Boolean\(me\.isAdmin\)\)/);
    assert.match(source, /const canDeleteMembers = Boolean\(isAdmin\)/);
    // Кнопка рендерится под тем же условием, что право считает сервер
    assert.match(source, /canDeleteMembers && \(/);
    assert.match(source, /<MemberDeleteButton/);
  });

  test("кнопка уходит в боевой роут удаления", () => {
    const component = read("src/components/member-delete-button.tsx");
    assert.match(component, /Удалить безвозвратно/, "в окне нет кнопки необратимого действия");
    // Подтверждение проверяется тем же правилом, что и на сервере
    assert.match(component, /memberDeletionConfirmationMatches\(draft, member\)/);
    assert.match(component, /disabled=\{!confirmed \|\| deleting\}/);
  });

  test("предупреждение окна перечисляет последствия удаления", () => {
    const component = read("src/components/member-delete-button.tsx");
    assert.match(component, /необратимо/);
    assert.match(component, /привязка к Discord/);
    assert.match(component, /допуски, история/);
  });

  test("после успеха строка уходит из таблицы, а список пересчитывается", () => {
    const source = read("src/app/members/page.tsx");
    // Удаление строки из состояния: сводные карточки считаются из того же массива
    assert.match(source, /filter\(\(m\) => m\.id !== id\)/);
    // Уведомление об успехе вместо тихого исчезновения строки
    assert.match(source, /setNotice\(\{ ok: true, text: data\.message \|\| "Профиль бойца удалён" \}\)/);
  });

  test("окно правки состава (роут) и удаления — разные адреса и разные гварды", () => {
    const route = read("src/app/api/admin/members/[id]/route.ts");
    assert.match(route, /memberDeletionDecision\(panel\?\.role, actor\?\.role\)/);
    // Правка состава командиру доступна, удаление — только админу: копия
    // requireRosterEditor здесь означала бы, что командир стирает личные дела
    assert.equal(
      /requireRosterEditor\(req\)/.test(route),
      false,
      "роут удаления использует гвард правки состава"
    );
    const rosterRoute = read("src/app/api/admin/roster/[id]/discord-id/route.ts");
    assert.match(rosterRoute, /requireRosterEditor\(req\)/);
  });
});