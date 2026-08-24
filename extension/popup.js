const $ = (id) => document.getElementById(id);
const CONFIG = (typeof self !== "undefined" && self.RSRED_CONFIG) || {};

const REASONS = {
  manual: "вручную",
  timer: "по таймеру",
  change: "cookie изменилась",
  retry: "повтор после сбоя",
  install: "при установке",
  startup: "при запуске браузера",
};

function fmt(at) {
  try {
    return new Date(at).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function render(lastPush, count, permission) {
  if (typeof count === "number") $("count").textContent = String(count);
  const permissionEl = $("permission");
  permissionEl.textContent = permission ? "выдан" : "отозван";
  permissionEl.style.color = permission ? "#7fe6ae" : "#ff9c9c";

  const el = $("status");
  if (!lastPush) {
    el.className = "st muted";
    el.textContent =
      "Готов к работе. Cookie отправятся сами при входе на rs-red.com и каждые 10 минут.";
    return;
  }
  if (lastPush.ok) {
    el.className = "st ok";
    el.textContent = `Отправлено ${fmt(lastPush.at)} · ${lastPush.count ?? "—"} cookie · ${
      REASONS[lastPush.reason] || "авто"
    }`;
  } else {
    el.className = "st err";
    el.textContent = `Ошибка ${fmt(lastPush.at)}: ${lastPush.error || "неизвестно"}`;
  }
}

async function refreshStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) {
      render(null, 0, false);
      return;
    }
    render(resp && resp.lastPush, resp && resp.count, !!(resp && resp.permission));
  });
}

function init() {
  $("server").textContent = CONFIG.serverUrl || "не сгенерирован";
  $("key").textContent = CONFIG.syncKeyMasked || "не сгенерирован";
  refreshStatus();
}

$("push").addEventListener("click", () => {
  const btn = $("push");
  btn.disabled = true;
  btn.textContent = "Отправка…";
  chrome.runtime.sendMessage({ type: "PUSH_NOW" }, (resp) => {
    btn.disabled = false;
    btn.textContent = "Отправить сейчас";
    if (chrome.runtime.lastError) {
      render({ ok: false, at: Date.now(), error: chrome.runtime.lastError.message }, 0, false);
      return;
    }
    render(resp, resp && resp.count, true);
  });
});

init();
