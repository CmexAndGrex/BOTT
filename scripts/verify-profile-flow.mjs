/**
 * Живая проверка сценария «Личный кабинет» на работающем приложении.
 *
 * Не заменяет тесты: это внешняя проверка того, что видит браузер — редиректы,
 * cookie и отрисовка страницы. Проверки 1–6 идут по HTTP (как это делает
 * клиент), проверка 7 вызывает боевой роут напрямую, чтобы увидеть состояние
 * отказа «сессии нет» (middleware отсекает гостя раньше и отвечает 403).
 *
 * Запуск (хук нужен из-за алиасов «@/» в боевых модулях):
 *   node --import ./tests/setup.mjs scripts/verify-profile-flow.mjs http://localhost:3000
 */
const base = process.argv[2] || "http://127.0.0.1:3000";

/** Cookie-банка: fetch в Node не хранит cookie сам */
const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" ) jar.delete(name);
    else jar.set(name, value);
  }
}

async function call(path, options = {}) {
  const res = await fetch(new URL(path, base), {
    ...options,
    redirect: "manual",
    headers: {
      ...(options.headers || {}),
      cookie: cookieHeader(),
      // same-origin: иначе роуты со сменой сессии отклонят запрос как CSRF
      origin: base,
      host: new URL(base).host,
    },
  });
  absorb(res);
  return res;
}

const check = (name, ok, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const state = async () => {
  const res = await call("/api/me");
  return res.json();
};

console.log(`--- Живой сценарий: ${base} ---`);

// 1. Гость на /profile: middleware уводит на вход С возвратом (?next=/profile)
const guest = await call("/profile");
const location = guest.headers.get("location") || "";
check("гостя с /profile уводит на /login?next=/profile", location.includes("/login?next=%2Fprofile"), location);

// 2. Обычный вход по логину и паролю (учётная запись панели = командир)
const login = await call("/api/auth", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "dev-commander", password: "DevLocal-2026!x" }),
});
const loginBody = await login.json();
check("вход в панель успешен", loginBody.ok === true, JSON.stringify(loginBody));
check("вход выдал cookie панели", jar.has("auth_token"));
check("вход выдал cookie кабинета (синхронизация сессий)", jar.has("member_token"), [...jar.keys()].join(","));

// 3. Состояние кабинета для меню
const after = await state();
check("роль из /api/me — admin", after.role === "admin", String(after.role));
check("боец отдан в /api/me (пункт меню виден)", Boolean(after.member), JSON.stringify(after.member));
check("состояние кабинета — ok", after.cabinet === "ok", String(after.cabinet));
check("позывной бойца", after.member?.callsign === "Волков", String(after.member?.callsign));
check("звание бойца", after.member?.rank === "Полковник", String(after.member?.rank));

// 4. Досье открывается сразу по сессии панели
const dossier = await call("/api/member/dossier");
const dossierBody = await dossier.json();
check("досье отдаётся без второго входа", dossier.status === 200 && dossierBody.ok === true, `status=${dossier.status}`);
// Матрица техники: у Танковой роты это ступени по званиям (tiers), у
// артиллерии — категории допуска (categories). Проверяем то, что относится к
// подразделению бойца, иначе проверка прошла бы на пустом списке.
const division = dossierBody.vehicles?.division;
const vehicleRows =
  division === "tank" ? dossierBody.vehicles?.tiers : dossierBody.vehicles?.categories;
check(
  `матрица техники заполнена (${division})`,
  Array.isArray(vehicleRows) && vehicleRows.length > 0,
  `rows=${vehicleRows?.length}`
);
check("досье содержит историю службы", Array.isArray(dossierBody.reports));

// 5. Страница кабинета отдаёт разметку (заглушки «войдите» быть не должно)
const page = await call("/profile");
const html = await page.text();
check("страница /profile открывается по сессии", page.status === 200, `status=${page.status}`);
check("на странице нет заглушки «Войдите в личный кабинет»", !html.includes("Войдите в личный кабинет, чтобы увидеть личное дело"));

// 6. Повторный проход меню→кабинет не требует авторизации
const second = await state();
check("повторный заход не сбрасывает сессию", second.cabinet === "ok", String(second.cabinet));

// 7. Гость не получает досье: middleware отсекает его на входе в область
// кабинета (403 JSON на API), а сам роут для прямого вызова отвечает 401 с
// состоянием no_session. Проверяем оба уровня — именно они и закрывают доступ.
const authed = new Map(jar);
jar.clear();
const anonApi = await call("/api/member/dossier");
check("гость не получает досье через middleware (403)", anonApi.status === 403, `status=${anonApi.status}`);

const { GET: dossierRoute } = await import("../src/app/api/member/dossier/route.ts");
const { NextRequest } = await import("next/server");
const direct = await dossierRoute(
  new NextRequest(new URL("/api/member/dossier", "http://panel.example"), {
    headers: new Headers({ host: "panel.example" }),
  })
);
const directBody = await direct.json();
check(
  "без сессии роут отвечает 401 с состоянием no_session",
  direct.status === 401 && directBody.state === "no_session",
  `status=${direct.status} state=${directBody.state}`
);
for (const [k, v] of authed) jar.set(k, v);

/* ------------------------------------------------------------------ */
/* 8. Dev-вход: сессия панели и кабинет выдаются вместе                */
/* ------------------------------------------------------------------ */
const devJar = new Map(jar);
jar.clear();
const dev = await call("/api/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ as: "commander" }) });
const devBody = await dev.json();
check("dev-вход успешен", devBody.ok === true, JSON.stringify(devBody).slice(0, 120));
check("dev-вход выдал сессию панели", jar.has("auth_token"));
check("dev-вход выдал сессию кабинета", jar.has("member_token"), [...jar.keys()].join(","));
const devState = await state();
check("dev-вход: кабинет сразу доступен", devState.cabinet === "ok", String(devState.cabinet));
const devDossier = await call("/api/member/dossier");
check("dev-вход: досье отдаётся (200)", devDossier.status === 200, `status=${devDossier.status}`);
jar.clear();
for (const [k, v] of devJar) jar.set(k, v);

/* ------------------------------------------------------------------ */
/* 9. Штаб без связки: не «войдите», а «свяжите аккаунт»               */
/* ------------------------------------------------------------------ */
// Воспроизводим состояние, в котором и возникал цикл: человек вошёл в панель,
// но его учётная запись не связана с бойцом. Проверяем, что он получит 409 и
// состояние not_linked (страница предложит «Доступы»), а не 401 «войдите».
const { Pool } = await import("pg");
const { readFileSync } = await import("node:fs");
const { parse } = await import("dotenv");
const dbUrl = parse(readFileSync(".env", "utf8")).DATABASE_URL;
const pool = new Pool({ connectionString: dbUrl });
const saved = await pool.query("SELECT member_id, discord_id FROM users WHERE username = 'dev-commander'");
await pool.query("UPDATE users SET member_id = NULL, discord_id = NULL WHERE username = 'dev-commander'");

const unlinkedJar = new Map(jar);
jar.clear();
const login2 = await call("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dev-commander", password: "DevLocal-2026!x" }) });
check("вход без связки в панель успешен", login2.status === 200, `status=${login2.status}`);
check("сессия кабинета при этом не выдаётся", !jar.has("member_token"), [...jar.keys()].join(","));
const unlinked = await state();
check("состояние кабинета — not_linked (а не no_session)", unlinked.cabinet === "not_linked", String(unlinked.cabinet));
const unlinkedDossier = await call("/api/member/dossier");
const unlinkedBody = await unlinkedDossier.json();
check("досье отвечает 409 и просит связать аккаунт", unlinkedDossier.status === 409 && unlinkedBody.state === "not_linked", `status=${unlinkedDossier.status} state=${unlinkedBody.state}`);
check("текст отказа говорит про «Доступы»", String(unlinkedBody.error).includes("Доступы"), String(unlinkedBody.error));

// Возвращаем связку — как было
const row = saved.rows[0];
await pool.query("UPDATE users SET member_id = $1, discord_id = $2 WHERE username = 'dev-commander'", [row.member_id, row.discord_id]);
await pool.end();
jar.clear();
for (const [k, v] of unlinkedJar) jar.set(k, v);

console.log(process.exitCode ? "--- ЕСТЬ ЗАМЕЧАНИЯ ---" : "--- СЦЕНАРИЙ ПРОЙДЕН ---");