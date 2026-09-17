/**
 * Бюджет проблем ESLint.
 *
 * Зачем: в проекте есть унаследованные замечания react-hooks (предупреждения
 * о setState внутри эффектов и создании компонентов в рендере). Их исправление
 * — отдельная задача, но допускать ПОЯВЛЕНИЕ новых нельзя. Скрипт падает
 * только если число проблем выросло выше зафиксированного бюджета, поэтому
 * шаг линта в CI реально защищает от регрессий и при этом не красный из-за
 * старого долга.
 *
 * Запуск: node scripts/lint-budget.mjs
 * Переопределить бюджет: LINT_BUDGET=20 node scripts/lint-budget.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Текущее состояние: 10 errors + 4 warnings. Уменьшайте по мере исправлений. */
const BASELINE = 14;

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const budget = Number(process.env.LINT_BUDGET ?? BASELINE);
const eslintBin = path.join(root, "node_modules", "eslint", "bin", "eslint.js");

/** JSON-отчёт ESLint. Ненулевой код возврата — это найденные проблемы, не сбой. */
function runEslint() {
  try {
    return execFileSync(process.execPath, [eslintBin, ".", "-f", "json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // ESLint завершается с кодом 1, когда есть ошибки: отчёт всё равно в stdout
    if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout;
    throw err;
  }
}

let report;
try {
  report = JSON.parse(runEslint());
} catch (err) {
  console.error("[lint-budget] Не удалось получить отчёт ESLint:", err.message);
  process.exit(2);
}

let errors = 0;
let warnings = 0;
for (const file of report) {
  errors += file.errorCount ?? 0;
  warnings += file.warningCount ?? 0;
}
const total = errors + warnings;

console.log(
  `[lint-budget] проблем: ${total} (ошибок ${errors}, предупреждений ${warnings}); бюджет: ${budget}`
);

if (total > budget) {
  console.error(
    `\n[lint-budget] Провал: новых замечаний ESLint стало больше бюджета на ${total - budget}.\n` +
      "Исправьте их (или осознанно поднимите LINT_BUDGET, если долг сокращается не сразу)."
  );
  // Печатаем сами замечания, чтобы не гонять линт второй раз
  for (const file of report) {
    if (!file.messages?.length) continue;
    const rel = path.relative(root, file.filePath);
    for (const m of file.messages) {
      console.error(`  ${rel}:${m.line}:${m.column}  ${m.severity === 2 ? "error" : "warning"}  ${m.message}`);
    }
  }
  process.exit(1);
}

console.log("[lint-budget] В пределах бюджета — новых регрессий нет.");