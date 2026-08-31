/*
 * RED ATK Cookie Sync v5 — сборка для магазина расширений (Opera Add-ons).
 * Данные сервера и ключ перехватываются с сайта через content.js.
 */

const COOKIE_DOMAIN = "rs-red.com";
const ALARM_PUSH = "rsred-push";
const ALARM_RETRY = "rsred-retry";
const PUSH_PERIOD_MINUTES = 10;
const API_SIGNATURE = "RED OPS Cookie Endpoint";
const WAKE_ATTEMPTS = 8;
const WAKE_GAP_MS = 900;
const FETCH_TIMEOUT_MS = 25000;

let debounceTimer = null;
let pushInProgress = null;

// Читаем настройки из внутренней памяти расширения
async function getConfig() {
  const data = await chrome.storage.local.get(['serverUrl', 'syncKey']);
  return {
    serverUrl: String(data.serverUrl || "").replace(/\/+$/, ""),
    syncKey: String(data.syncKey || "").trim(),
  };
}

async function collectCookieHeader() {
  const cookies = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
  return {
    header: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    count: cookies.length,
  };
}

async function hasPanelPermission(serverUrl) {
  try {
    return await chrome.permissions.contains({ origins: [serverUrl + "/*"] });
  } catch {
    return false;
  }
}

async function saveStatus(status) {
  await chrome.storage.local.set({ lastPush: status });
}

function scheduleRetry() {
  chrome.alarms.create(ALARM_RETRY, { delayInMinutes: 1 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function wakeApi(serverUrl) {
  let last = "";
  for (let attempt = 1; attempt <= WAKE_ATTEMPTS; attempt += 1) {
    try {
      const { response, data } = await fetchJson(
        `${serverUrl}/api/cookie?wake=${Date.now()}`,
        { headers: { Accept: "application/json" }, cache: "no-store" },
        FETCH_TIMEOUT_MS
      );
      if (response.ok && data && data.ok === true && data.service === API_SIGNATURE) {
        return;
      }
      last = `HTTP ${response.status}${data ? ", JSON без подписи API" : ", HTML вместо API"}`;
    } catch (error) {
      last = error && error.message ? error.message : "сеть";
    }
    if (attempt < WAKE_ATTEMPTS) await sleep(WAKE_GAP_MS);
  }
  throw new Error(
    `Сервер отвечает не API (${last}). Зайдите на сайт АТК, чтобы расширение обновило настройки.`
  );
}

async function doPush(reason, attempt = 0) {
  const cfg = await getConfig(); // Ждем загрузки конфига из памяти

  if (!cfg.serverUrl || !cfg.syncKey) {
    const status = {
      at: Date.now(),
      ok: false,
      error: "Нет ключа синхронизации — просто зайдите на сайт RED ATK",
      reason,
      count: 0,
    };
    await saveStatus(status);
    return status;
  }

  const { header, count } = await collectCookieHeader();
  if (!header) {
    const status = {
      at: Date.now(),
      ok: false,
      error: "Cookie rs-red.com не найдены — войдите на сайт через Steam",
      reason,
      count: 0,
    };
    await saveStatus(status);
    return status;
  }

  const allowed = await hasPanelPermission(cfg.serverUrl);
  if (!allowed) {
    const status = {
      at: Date.now(),
      ok: false,
      error: "Браузер отозвал доступ к домену панели",
      reason,
      count,
    };
    await saveStatus(status);
    return status;
  }

  try {
    await wakeApi(cfg.serverUrl);

    const { response, data } = await fetchJson(
      `${cfg.serverUrl}/api/cookie`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ key: cfg.syncKey, cookie: header }),
        cache: "no-store",
      },
      FETCH_TIMEOUT_MS
    );

    if (!data) {
      throw new Error(`Ответ не в формате JSON (HTTP ${response.status})`);
    }
    if (!response.ok || data.ok !== true) {
      throw new Error(data.error || `API вернул HTTP ${response.status}`);
    }

    const status = {
      at: Date.now(),
      ok: true,
      error: null,
      reason,
      count,
      transport: "direct",
    };
    await saveStatus(status);
    return status;
  } catch (error) {
    const willRetry = attempt === 0;
    if (willRetry) scheduleRetry();
    const message = error && error.message ? error.message : "Неизвестная ошибка";
    const status = {
      at: Date.now(),
      ok: false,
      error: willRetry ? `${message}. Повторю через минуту` : message,
      reason,
      count,
      transport: "direct",
    };
    await saveStatus(status);
    return status;
  }
}

async function push(reason, attempt = 0) {
  if (pushInProgress) return pushInProgress;

  if (reason === "startup") {
    const { lastStartup } = await chrome.storage.local.get("lastStartup");
    if (lastStartup && Date.now() - lastStartup < 5 * 60 * 1000) {
      return; 
    }
    await chrome.storage.local.set({ lastStartup: Date.now() });
  }

  pushInProgress = doPush(reason, attempt);
  try {
    return await pushInProgress;
  } finally {
    pushInProgress = null;
  }
}

function ensureAlarm() {
  chrome.alarms.create(ALARM_PUSH, {
    periodInMinutes: PUSH_PERIOD_MINUTES,
    delayInMinutes: 1,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  push("startup");
});

chrome.windows.onCreated.addListener(() => {
  ensureAlarm();
  push("startup");
});

chrome.tabs.onCreated.addListener(() => {
  ensureAlarm();
  push("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PUSH) push("timer");
  else if (alarm.name === ALARM_RETRY) push("retry", 1);
});

chrome.cookies.onChanged.addListener((info) => {
  const domain = (info && info.cookie && info.cookie.domain) || "";
  if (!domain.includes(COOKIE_DOMAIN)) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => push("change"), 4000);
});

// Слушатель сообщений от popup.js и content.js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Перехват данных с сайта
  if (msg && msg.type === "SAVE_CONFIG") {
    chrome.storage.local.set({ serverUrl: msg.serverUrl, syncKey: msg.syncKey });
    return false;
  }

  if (msg && msg.type === "PUSH_NOW") {
    push("manual").then(sendResponse);
    return true;
  }
  
  if (msg && msg.type === "GET_STATUS") {
    (async () => {
      const cfg = await getConfig();
      const { lastPush = null } = await chrome.storage.local.get("lastPush");
      const { count } = await collectCookieHeader();
      const permission = cfg.serverUrl ? await hasPanelPermission(cfg.serverUrl) : false;
      sendResponse({ lastPush, count, permission });
    })();
    return true;
  }
  return false;
});