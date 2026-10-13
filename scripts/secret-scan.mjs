#!/usr/bin/env node
/**
 * secret-scan.mjs — поиск утечек секретов в файлах под контролем версий.
 *
 * Зачем собственный сканер, а не только внешний gitleaks в CI:
 *   1. работает локально без установки бинарника и без сети — его можно
 *      запускать перед коммитом и на машинах без Docker;
 *   2. проверяет ровно те форматы секретов, которые реально встречаются в
 *      проекте (паспорт Google, токен Discord-бота, cookie rs-red, ключ
 *      синхронизации расширения), поэтому даёт меньше ложных срабатываний;
 *   3. в CI вызывается первой проверкой — сборка не начнётся, пока сканер
 *      не подтвердит, что секреты не попали под контроль версий.
 *
 * Секреты ищутся среди ОТСЛЕЖИВАЕМЫХ файлов (git ls-files): незакоммиченный
 * дамп на диске — это локальная проблема, а вот попавший в историю секрет
 * скомпрометирован для всех, кто клонирует репозиторий.
 *
 * Запуск: node scripts/secret-scan.mjs
 * Выход:  0 — чисто; 1 — найден хотя бы один секрет.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** Файлы-исключения: известные заглушки-примеры, а не боевые секреты */
const ALLOWED_PATHS = new Set([
  ".env.example",
  "scripts/secret-scan.mjs",
  ".gitignore",
]);

/** Двоичные расширения и служебные каталоги — не читаем как текст */
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".avif", ".bmp", ".svg",
  ".zip", ".gz", ".pdf", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".webm",
]);
const SKIP_DIR_PREFIXES = [".next/", "node_modules/", "coverage/", "backups/"];

/** Ограничение размера: большие файлы не сканируем построчно (экономия памяти) */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Правила поиска. Каждое описывает один класс секрета.
 * `allow` при необходимости ослабляет правило для строк-заглушек.
 */
const RULES = [
  {
    name: "Google Service Account private key",
    re: /-----BEGIN (RSA |EC |)PRIVATE KEY-----/,
    hint: "паспорт сервисного аккаунта Google (ключ доступа к Google Таблице)",
  },
  {
    name: "Discord bot token",
    // Токен бота: <base64 id>.<base64 ts>.<base64 hmac>, первый символ M (bot)
    re: /\b[MN][A-Za-z\d_-]{22,}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,}\b/,
    hint: "токен Discord-бота (доступ к серверу: роли, сообщения)",
  },
  {
    name: "Google API key",
    re: /AIza[0-9A-Za-z_-]{35}/,
    hint: "API-ключ Google (AIza…)",
  },
  {
    name: "rs-red session cookie",
    re: /rs\.sid=s%3A/,
    hint: "сессионная cookie Steam-входа rs-red.com",
  },
  {
    name: "Discord webhook URL with real id",
    re: /discord(?:app)?\.com\/api\/webhooks\/\d{15,}\/[A-Za-z0-9_-]{60,}/,
    hint: "боевой URL вебхука Discord",
  },
  {
    name: "Assigned secret-looking literal",
    // Ключи вида secret/token/password/api_key = ЗАКАВЫЧЕННЫЙ литерал 16+ симв.
    //
    // Кавычки обязательны намеренно: реальные секреты присваиваются строкой
    // (`const token = "MTUz…"`), тогда как `password: decodeURIComponent(...)`,
    // `tempPassword = generateTempPassword()` и `DEV_ADMIN_PASSWORD_DEFAULT` —
    // это вызовы функций и ссылки на константы, а не секреты. Без этого условия
    // сканер тонул бы в ложных срабатываниях и им перестали бы пользоваться.
    re: /(?:secret|token|password|passwd|api[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*["'`]([A-Za-z0-9+/_\-]{16,})["'`]/i,
    hint: "похоже на секрет/токен в присваивании строки",
  },
];

/** Значения-заглушки: их наличие в тексте отменяет срабатывание правила */
const PLACEHOLDER_RE =
  /(replace[_-]?me|your[_-]|example|placeholder|your_|xxxx|yyyy|zzzz|changeme|change_me|•|\.\.\.|dummy|sample|todo)/i;

/** Список отслеживаемых файлов */
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch (e) {
    console.error("[secret-scan] Не удалось получить git ls-files:", e.message);
    process.exit(2);
  }
}

/** Стоит ли вообще открывать файл */
function shouldScan(file) {
  if (ALLOWED_PATHS.has(file)) return false;
  if (SKIP_DIR_PREFIXES.some((p) => file.startsWith(p))) return false;
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";
  if (SKIP_EXTENSIONS.has(ext)) return false;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return false;
  } catch {
    return false;
  }
  return true;
}

const findings = [];

for (const file of trackedFiles()) {
  if (!shouldScan(file)) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // двоичный или недоступный файл
  }

  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!rule.re.test(line)) continue;
      // Строки-заглушки не считаем секретом (пример окружения, документация)
      if (PLACEHOLDER_RE.test(line)) continue;
      findings.push({
        file,
        line: i + 1,
        rule: rule.name,
        hint: rule.hint,
        // Значение обрезаем: отчёт не должен сам разносить секрет дальше
        snippet: line.trim().slice(0, 120),
      });
    }
  }
}

if (findings.length === 0) {
  console.log("[secret-scan] Секретов в отслеживаемых файлах не найдено.");
  process.exit(0);
}

// Дедуплицируем по файл+строка+правило (одна строка может ловиться один раз)
const seen = new Set();
const unique = findings.filter((f) => {
  const key = `${f.file}:${f.line}:${f.rule}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.error(`[secret-scan] НАЙДЕНО потенциальных утечек: ${unique.length}\n`);
for (const f of unique) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    правило: ${f.rule} — ${f.hint}`);
  console.error(`    фрагмент: ${f.snippet}`);
  console.error("");
}
console.error(
  "[secret-scan] Удалите секрет из файла и истории (git filter-repo/BFG), " +
    "затем ротируйте значение. См. SECURITY.md (разделы «Ротация секретов» " +
    "и «Очистка git-истории»)."
);
process.exit(1);
