/**
 * Личный кабинет: связка учётной записи панели с бойцом и отсутствие цикла входа.
 *
 * Что именно проверяется и почему это важно:
 *   1. Правило связки (src/lib/panel-link.ts) — по нему аккаунт панели получает
 *      личное дело. Ошибка здесь показывает одному человеку чужое досье либо
 *      оставляет командира без кабинета навсегда.
 *   2. Боевое middleware — реальные вызовы, а не копии правил: именно на нём
 *      завязан сценарий «Личный кабинет → вход → кабинет». Регрессия, которую
 *      ловим: гостя ведёт на /login БЕЗ возврата (?next=), и после входа он
 *      снова оказывается на заглушке — цикл из отчёта.
 *   3. Инварианты исходников, которые иначе ловятся только руками: вход в панель
 *      обязан открывать кабинет (attachCabinetSession), dev-вход и «Доступы»
 *      обязаны писать связку users.member_id, а страница кабинета — не
 *      предлагать «Войти» тому, кто уже вошёл.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import {
  CABINET_STATE_MESSAGES,
  canOpenCabinet,
  pickMemberForPanelAccount,
  type PanelMemberCandidate,
} from "@/lib/panel-link.ts";
import { safeRedirectPath } from "@/lib/validation.ts";
import { getJwtSecret } from "@/lib/auth.ts";
import { middleware } from "../src/middleware.ts";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/* ------------------------------------------------------------------ */
/* Хелперы                                                             */
/* ------------------------------------------------------------------ */

/** Запрос с cookie так, как его шлёт браузер */
function request(
  path: string,
  cookies: Record<string, string> = {},
  method = "GET"
): NextRequest {
  const headers = new Headers();
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  if (cookie) headers.set("cookie", cookie);
  headers.set("host", "panel.example");
  return new NextRequest(new URL(path, "http://panel.example"), { method, headers });
}

/** Подписанный токен сессии бойца — тот же вид, что выпускает issueMemberSession */
async function memberToken(payload: {
  memberId: number;
  role?: string;
  tokenVersion?: number;
}): Promise<string> {
  return new SignJWT({
    purpose: "member_session",
    memberId: payload.memberId,
    callsign: "Волков",
    role: payload.role ?? "admin",
    tokenVersion: payload.tokenVersion ?? 1,
    kind: "password",
    jti: "test-session",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(getJwtSecret());
}

/** Подписанный токен сессии панели */
async function panelToken(role = "admin"): Promise<string> {
  return new SignJWT({
    purpose: "panel_session",
    userId: 1,
    username: "dev-commander",
    role,
    tokenVersion: 1,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(getJwtSecret());
}

/** Боец состава для проверок правила связки */
function candidate(over: Partial<PanelMemberCandidate> & { id: number }): PanelMemberCandidate {
  return {
    callsign: null,
    name: "Боец",
    discordId: null,
    status: "active",
    role: "member",
    ...over,
  };
}

describe("Связка аккаунта панели с бойцом", () => {
  test("совпадение по Discord ID имеет приоритет над позывным", () => {
    // Discord подтверждён самим человеком через OAuth2 — совпасть случайно не
    // может. Позывной мог быть переименован в табеле, поэтому он слабее.
    const roster = [
      candidate({ id: 5, callsign: "Волков", name: "Волков Д. В.", discordId: "111" }),
      candidate({ id: 7, callsign: "Дух", name: "Дух", discordId: "999" }),
    ];
    const picked = pickMemberForPanelAccount({ username: "Дух", discordId: "111" }, roster);
    assert.equal(picked?.id, 5, "связка по Discord ID должна побеждать совпадение позывного");
  });

  test("без Discord связка ищется по позывному без учёта регистра", () => {
    const roster = [candidate({ id: 3, callsign: "Волков" })];
    assert.equal(pickMemberForPanelAccount({ username: "волков", discordId: null }, roster)?.id, 3);
  });

  test("неоднозначный позывной НЕ даёт связи: чужое досье показать нельзя", () => {
    // Два бойца с одинаковым позывным (например, после чистки табеля): выбрать
    // первого значило бы отдать одному человеку личное дело другого.
    const roster = [candidate({ id: 1, callsign: "Скиф" }), candidate({ id: 2, callsign: "Скиф" })];
    assert.equal(pickMemberForPanelAccount({ username: "Скиф", discordId: null }, roster), null);
  });

  test("неизвестный логин не связывается ни с кем", () => {
    const roster = [candidate({ id: 1, callsign: "Скиф" })];
    assert.equal(pickMemberForPanelAccount({ username: "Кто-то", discordId: null }, roster), null);
    assert.equal(pickMemberForPanelAccount({ username: "", discordId: null }, roster), null);
  });

  test("боец без позывного находится по имени в табеле", () => {
    // У бойцов из синхронизации rs-red.com позывного может не быть: тогда
    // единственный ключ — имя, и связка должна работать именно по нему.
    const roster = [candidate({ id: 9, callsign: null, name: "Сокол А. В." })];
    assert.equal(
      pickMemberForPanelAccount({ username: "Сокол А. В.", discordId: null }, roster)?.id,
      9
    );
  });

  test("кабинет открыт только «в строю» и «в отпуске»", () => {
    assert.equal(canOpenCabinet("active"), true);
    assert.equal(canOpenCabinet("vacation"), true);
    assert.equal(canOpenCabinet("pending"), false);
    assert.equal(canOpenCabinet("dismissed"), false);
  });

  test("тексты состояний кабинета различимы: «войдите» ≠ «свяжите аккаунт»", () => {
    // Одинаковый текст на все отказы и порождал цикл: командир, уже вошедший в
    // панель, читал «войдите в личный кабинет» и шёл входить заново.
    assert.match(CABINET_STATE_MESSAGES.no_session, /Войдите/);
    assert.match(CABINET_STATE_MESSAGES.not_linked, /Доступы/);
    assert.notEqual(CABINET_STATE_MESSAGES.no_session, CABINET_STATE_MESSAGES.not_linked);
    assert.notEqual(CABINET_STATE_MESSAGES.no_session, CABINET_STATE_MESSAGES.no_access);
  });
});

describe("Возврат после входа: безопасность адреса ?next=", () => {
  test("локальный путь принимается", () => {
    assert.equal(safeRedirectPath("/profile"), "/profile");
    assert.equal(safeRedirectPath("/reports?type=exam"), "/reports?type=exam");
  });

  test("чужой домен и схемы отклоняются (открытый редирект)", () => {
    // «//evil.com» браузер читает как протокол-относительный адрес, то есть
    // уводит на чужой сайт: возврат после входа стал бы удобной фишинговой
    // ссылкой, выглядящей как наш домен.
    const bad = ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "\\\\evil"];
    for (const raw of bad) {
      assert.equal(safeRedirectPath(raw, "/"), "/", `«${raw}» не должен приниматься`);
    }
  });

  test("управляющие символы отсекаются, пустое значение — запасной путь", () => {
    assert.equal(safeRedirectPath("/profile\nSet-Cookie: x=1", "/"), "/");
    assert.equal(safeRedirectPath("", "/"), "/");
    assert.equal(safeRedirectPath(null, "/"), "/");
    assert.equal(safeRedirectPath(undefined, "/"), "/");
  });
});

describe("Middleware: кабинет и путь возврата", () => {
  test("гость отправляется на вход с возвратом в кабинет, а не без него", async () => {
    // Это и есть устранение цикла: без ?next= человек после входа попадал на
    // «/» и, чтобы увидеть досье, шёл в кабинет заново.
    const res = await middleware(request("/profile"));
    assert.equal(res.status, 307);
    const location = res.headers.get("location") || "";
    assert.match(location, /\/login\?next=%2Fprofile$/);
  });

  test("сессия бойца пускает в кабинет без перенаправления", async () => {
    const token = await memberToken({ memberId: 1, role: "member", tokenVersion: 1 });
    const res = await middleware(request("/profile", { member_token: token }));
    assert.equal(res.headers.get("location"), null, "боец не должен перенаправляться");
    assert.notEqual(res.status, 307);
  });

  test("сессия панели тоже пускает в кабинет (командир ведёт и панель, и досье)", async () => {
    const token = await panelToken("admin");
    const res = await middleware(request("/profile", { auth_token: token }));
    assert.equal(res.headers.get("location"), null);
    assert.notEqual(res.status, 307);
  });

  test("роут досье без сессии отвечает 403 JSON, а не редиректом", async () => {
    const res = await middleware(request("/api/member/dossier"));
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.match(String(body.error), /кабинет/i);
  });

  test("сессия бойца открывает роуты кабинета", async () => {
    const token = await memberToken({ memberId: 1 });
    const res = await middleware(request("/api/member/dossier", { member_token: token }));
    assert.notEqual(res.status, 403);
    assert.equal(res.headers.get("location"), null);
  });
});

/* ------------------------------------------------------------------ */
/* Инварианты исходников: связка пишется там, где вход выдаёт сессию    */
/* ------------------------------------------------------------------ */

describe("Синхронизация сессий при входе", () => {
  test("вход в панель по паролю открывает и кабинет", () => {
    const source = read("src/app/api/auth/route.ts");
    assert.match(source, /attachCabinetSession\(/, "вход в панель обязан связать сессию с бойцом");
    // Порядок: cookie панели ставится до попытки открыть кабинет, иначе сбой
    // кабинета отменил бы уже состоявшийся вход.
    assert.ok(
      source.indexOf("setPanelCookie(") < source.indexOf("attachCabinetSession("),
      "сессия панели должна выдаваться до связки с бойцом"
    );
  });

  test("dev-вход связывает учётную запись панели с бойцом командира", () => {
    const source = read("src/app/api/auth/dev-login/route.ts");
    assert.match(source, /ensureDevPanelUser\(member\.id\)/, "dev-вход обязан писать member_id");
    assert.match(source, /memberId,/, "member_id должен попадать в запись пользователя");
  });

  test("«Доступы» сохраняют связку аккаунта с бойцом", () => {
    const source = read("src/app/api/users/route.ts");
    assert.match(source, /set\.memberId = member\.id/);
    assert.match(source, /memberId: users\.memberId/, "список аккаунтов отдаёт связку");
  });

  test("личное дело открывается и по сессии панели", () => {
    const source = read("src/lib/member-auth.ts");
    // Резолв по сессии панели: без него командир видел заглушку, хотя боец есть
    assert.match(source, /export async function getPanelSessionMember/);
    assert.match(source, /return getPanelSessionMember\(req\);/);
    // Связка ищется по правилу модуля, а не копией условий здесь
    assert.match(source, /pickMemberForPanelAccount/);
  });

  test("восстановление доступа (bootstrap) тоже связывает аккаунт с бойцом", () => {
    const source = read("scripts/bootstrap-admin.ts");
    assert.match(source, /UPDATE users SET member_id = \$2 WHERE username = \$1/);
  });
});

describe("Интерфейс: пункт меню и экран кабинета", () => {
  test("в сайдбаре есть пункт «Личный кабинет» с иконкой досье", () => {
    const source = read("src/components/shell.tsx");
    assert.match(source, /href: "\/profile",/);
    assert.match(source, /label: "Личный кабинет"/);
    assert.match(source, /icon: IdCard/);
    assert.match(source, /IdCard/, "иконка досье должна быть импортирована");
  });

  test("пункт виден любой действующей сессии, но не гостю", () => {
    const source = read("src/components/shell.tsx");
    // Состояние кабинета приходит из /api/me: у гостя no_session — пункта нет,
    // у штаба без связи not_linked — пункт есть (он ведёт к объяснению и связке).
    assert.match(source, /cabinet !== "no_session"/);
    assert.match(source, /setCabinet\(d\.cabinet \|\| "no_session"\)/);
  });

  test("активный пункт подсвечивается (nav-active, как у остальных)", () => {
    const source = read("src/components/shell.tsx");
    assert.match(source, /pathname\.startsWith\(item\.href\)/);
    assert.match(source, /nav-link \$\{active \? "nav-active" : ""\}/);
  });

  test("API отдаёт состояние кабинета для меню", () => {
    const source = read("src/app/api/me/route.ts");
    assert.match(source, /cabinet/);
    assert.match(source, /"not_linked"/);
  });

  test("заглушка кабинета не замыкает круг: «Войти» ведёт с возвратом", () => {
    const source = read("src/app/profile/page.tsx");
    assert.match(source, /href="\/login\?next=%2Fprofile"/);
    // Для вошедшего штаба без связки показывается путь в «Доступы», а не «Войти»
    assert.match(source, /href="\/users"/);
    assert.match(source, /not_linked/);
    // Страница различает состояния по коду ответа, а не по одной заглушке
    assert.match(source, /res\.status === 409/);
  });

  test("роут досье называет состояние отказа", () => {
    const source = read("src/app/api/member/dossier/route.ts");
    assert.match(source, /requireCabinetMember\(req\)/);
    const auth = read("src/lib/member-auth.ts");
    assert.match(auth, /staff \? "not_linked" : "no_session"/);
    assert.match(auth, /status: staff \? 409 : 401/);
  });

  test("страница входа возвращает на исходную страницу", () => {
    const source = read("src/app/login/page.tsx");
    assert.match(source, /safeRedirectPath\(searchParams\.get\("next"\), ""\)/);
    assert.match(source, /router\.push\(nextPath \|\| "\/profile"\)/);
    assert.match(source, /router\.push\(nextPath \|\| "\/"\)/);
  });
});