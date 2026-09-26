/**
 * Загрузчик для тестов (node --import ./tests/setup.mjs).
 *
 * Зачем: тесты запускаются нативным node:test поверх TypeScript, без сборки.
 * Node умеет исполнять .ts напрямую, но НЕ умеет разрешать алиасы Next.js
 * («@/lib/settings»). Боевые модули (bot.ts, gsheets.ts, roles.ts) импортируют
 * друг друга именно так, поэтому без этого хука их нельзя протестировать
 * напрямую — а тестировать нужно боевой код, а не его копию в тесте.
 *
 * Хук подменяет только спецификаторы, начинающиеся с «@/», и добавляет
 * недостающее расширение .ts. Всё остальное уходит в стандартный resolve.
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** Файл (не каталог) — existsSync тут не годится: «@/db» это папка */
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Дописывает .ts / .tsx / /index.ts, если расширения нет.
 * Каталог сам по себе модулем не является — для «@/db» нужен «@/db/index.ts».
 */
function withExtension(base) {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}.mjs`]) {
    if (isFile(candidate)) return candidate;
  }
  const index = path.join(base, "index.ts");
  if (isFile(index)) return index;
  return base;
}

// Тесты не ходят в БД, но модуль src/db/index.ts падает при импорте, если
// DATABASE_URL не задан. Подставляем заведомо нерабочую строку: пул ленивый
// и не открывает соединение, пока не выполнен первый запрос.
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = withExtension(path.join(root, "src", specifier.slice(2)));
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});