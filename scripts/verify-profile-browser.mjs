/**
 * Браузерная проверка сценария «Личный кабинет» (headless Chrome через CDP).
 *
 *
 * Зачем не только HTTP-проверка: пункт меню и подсветка активного пункта —
 * клиентские (React + framer-motion + usePathname), а страница кабинета
 * наполняется запросами из браузера. HTTP-скрипт этого не видит: он проверяет
 * серверную часть. Здесь же воспроизводится путь пользователя целиком:
 * вход → клик по пункту «Личный кабинет» в сайдбаре → отрисовка досье.
 *
 * Почему на CDP, а не Playwright: в проекте нет Playwright, и добавлять
 * зависимость ради одной проверки не стоит. Node 24 имеет встроенный WebSocket,
 * а Chrome/Edge управляются протоколом DevTools напрямую.
 *
 * Запуск: node scripts/verify-profile-browser.mjs http://localhost:3000
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = process.argv[2] || "http://localhost:3000";

/**
 * Порт отладки.
 *
 * Почему не фиксированный 9222: на Windows часть диапазонов TCP зарезервирована
 * системой (netsh int ipv4 show excludedportrange protocol=tcp — например,
 * 8879–9278 у Hyper-V), и Chrome молча не поднимает на них http-сервер DevTools:
 * «bind() returned an error: доступ запрещён». Поэтому порт подбирается свободным.
 */
const DEBUG_PORT = await freePort();

async function freePort() {
  const { createServer } = await import("node:net");
  for (let port = 9555; port < 9600; port++) {
    const free = await new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("Не нашли свободный порт для отладки браузера");
}

/** Браузер: сначала Chrome, затем Edge (на стендах бывает только он) */
const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const binary = CANDIDATES.find((p) => existsSync(p));
if (!binary) {
  console.error("Браузер не найден. Проверьте пути в CANDIDATES.");
  process.exit(2);
}

const profileDir = mkdtempSync(path.join(tmpdir(), "atk-cdp-"));
const child = spawn(
  binary,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" }
);

/** Ждём, пока откроется порт отладки, и берём адрес страницы */
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // порт ещё не поднялся
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Не дождались порта отладки браузера");
}

/** Минимальный CDP-клиент поверх встроенного WebSocket */
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
      return;
    }
    events.push(msg);
    for (const waiter of [...waiters]) {
      if (waiter.match(msg)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(msg);
      }
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  return {
    ready,
    send(method, params = {}) {
      const messageId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        ws.send(JSON.stringify({ id: messageId, method, params }));
      });
    },
    /** Ждём событие, подходящее под условие */
    waitEvent(match, timeoutMs = 20000) {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error("Таймаут ожидания события"));
        }, timeoutMs);
      });
    },
    close: () => ws.close(),
  };
}

/** Значение выражения в странице */
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Ошибка в странице");
  }
  return result.result.value;
}

const check = (name, ok, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

/** Ждём выполнения условия в странице (запросы и отрисовка асинхронны) */
async function waitFor(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(cdp, expression)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

try {
  const page = await targets();
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  console.log(`--- Браузерный сценарий: ${base} ---`);

  // 1. Гость открывает /profile — его уводит на страницу входа с возвратом
  await cdp.send("Page.navigate", { url: `${base}/profile` });
  await cdp.waitEvent((m) => m.method === "Page.loadEventFired", 25000);
  const guestUrl = await evaluate(cdp, "location.pathname + location.search");
  check(
    "гостя с /profile уводит на вход с возвратом",
    String(guestUrl).startsWith("/login?next="),
    String(guestUrl)
  );
  const guestForm = await evaluate(
    cdp,
    "Boolean(document.querySelector('input[autocomplete=\"username\"]'))"
  );
  check("на странице входа есть форма", guestForm === true);

  /**
   * Ждём гидратацию React.
   *
   * Это не формальность: до гидратации обработчика onSubmit ещё нет, и
   * requestSubmit() ушёл бы нативным GET-запросом — вход «проходил» бы
   * вхолостую, а проверка ловила бы текст страницы входа вместо личного дела.
   * Признак гидратации — служебное свойство React на форме (__reactProps$…):
   * React навешивает его на узлы с обработчиками, и в статичной разметке его нет.
   * Ждём с запасом: в режиме разработки Next компилирует страницу при первом
   * запросе, и это может занять больше времени, чем обычная загрузка.
   */
  const hydrated = await waitFor(
    cdp,
    "Boolean(document.querySelector('form') && Object.keys(document.querySelector('form')).some((k) => k.startsWith('__reactProps')))",
    60000
  );
  check("страница входа гидратирована (React готов)", hydrated === true);

  // 2. Вход по логину и паролю (учётная запись панели, связанная с бойцом)
  await evaluate(
    cdp,
    `(() => {
       const user = document.querySelector('input[autocomplete="username"]');
       const pass = document.querySelector('input[autocomplete="current-password"]');
       const setValue = (el, value) => {
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(el, value);
         el.dispatchEvent(new Event('input', { bubbles: true }));
       };
       setValue(user, 'dev-commander');
       setValue(pass, 'DevLocal-2026!x');
       const submit = document.querySelector('form button[type="submit"]');
       submit.click();
       return true;
     })()`
  );
  // После входа страница сама уводит на ?next= (кабинет) — это и есть сценарий из ТЗ
  const backToProfile = await waitFor(cdp, "location.pathname === '/profile'", 25000);
  check(
    "после входа браузер возвращается в /profile (нет цикла)",
    backToProfile === true,
    await evaluate(cdp, "location.pathname + location.search")
  );

  // 3. Личное дело отрисовано, а не заглушка «войдите».
  // Условие включает адрес: текст «Волков» встречается и на странице входа
  // (кнопка dev-входа подписана именем командира), поэтому одного совпадения
  // текста мало — проверяем, что мы именно в кабинете.
  const dossierShown = await waitFor(
    cdp,
    "location.pathname === '/profile' && document.body.innerText.includes('Волков')",
    25000
  );
  check("на странице отрисовано личное дело (позывной)", dossierShown === true);
  const text = String(await evaluate(cdp, "document.body.innerText"));
  check(
    "нет заглушки «Войдите в личный кабинет»",
    !text.includes("Войдите в личный кабинет, чтобы увидеть личное дело")
  );
  check("видно звание бойца", text.includes("Полковник"));
  check("видно подразделение", text.includes("Танковая рота"));
  check("виден виджет дежурства («На дежурстве / На ВЧ»)", text.includes("На дежурстве / На ВЧ"), "");

  // 4. Пункт меню «Личный кабинет» присутствует и подсвечен активным
  const navExpr = `(() => {
      const links = [...document.querySelectorAll('aside nav a')];
      const item = links.find((a) => a.getAttribute('href') === '/profile');
      return item
        ? { found: true, label: item.innerText.trim(), active: item.classList.contains('nav-active'),
            icon: Boolean(item.querySelector('svg')) }
        : { found: false };
    })()`;
  const nav = await evaluate(cdp, navExpr);
  check("в сайдбаре есть пункт «Личный кабинет»", nav?.found === true, JSON.stringify(nav));
  check(
    "пункт подписан и с иконкой",
    nav?.label === "Личный кабинет" && nav?.icon === true,
    JSON.stringify(nav)
  );
  check("пункт подсвечен активным на /profile", nav?.active === true, JSON.stringify(nav));

  // 5. Переход из меню: уходим на «Обзор», затем кликаем по пункту кабинета
  await evaluate(
    cdp,
    "(() => { const a=[...document.querySelectorAll('aside nav a')].find(x=>x.getAttribute('href')==='/'); a.click(); return true; })()"
  );
  const atOverview = await waitFor(cdp, "location.pathname === '/'", 20000);
  check("переход на «Обзор» состоялся", atOverview === true, await evaluate(cdp, "location.pathname"));

  await evaluate(
    cdp,
    "(() => { const a=[...document.querySelectorAll('aside nav a')].find(x=>x.getAttribute('href')==='/profile'); a.click(); return true; })()"
  );
  const backFromMenu = await waitFor(cdp, "location.pathname === '/profile'", 20000);
  check("клик по пункту меню ведёт в кабинет", backFromMenu === true);

  const shownAgain = await waitFor(
    cdp,
    "location.pathname === '/profile' && document.body.innerText.includes('Волков')",
    25000
  );
  check("досье показано сразу, без повторной авторизации", shownAgain === true);
  const stillAuthed = await evaluate(
    cdp,
    "location.pathname === '/profile' && !document.body.innerText.includes('Войдите в личный кабинет')"
  );
  check("повторных требований авторизации нет", stillAuthed === true);

  // 6. Подсветка сохраняется после возврата через меню
  const navAgain = await evaluate(
    cdp,
    `(() => { const a=[...document.querySelectorAll('aside nav a')].find(x=>x.getAttribute('href')==='/profile');
       return a ? a.classList.contains('nav-active') : false; })()`
  );
  check("пункт снова подсвечен активным", navAgain === true);

  cdp.close();
  console.log(process.exitCode ? "--- ЕСТЬ ЗАМЕЧАНИЯ ---" : "--- СЦЕНАРИЙ ПРОЙДЕН ---");
} catch (e) {
  console.error("Ошибка проверки:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  child.kill();
  // Профиль браузера — временный каталог, чтобы не мусорить на стенде
  setTimeout(() => rmSync(profileDir, { recursive: true, force: true }), 500);
}