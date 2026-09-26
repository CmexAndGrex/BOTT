/**
 * Проверка, что фикс проблемы schemastore применён корректно:
 * 1) package.json указывает на локальную схему через $schema;
 * 2) локальная схема существует, валидна и БЕЗ внешних $ref;
 * 3) все файлы, на которые ссылается схема, реально лежат в schemas/.
 *
 * Запуск: node scripts/check-schemas.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCHEMAS = path.join(ROOT, "schemas");

let failed = 0;
const ok = (label) => console.log(`  OK   ${label}`);
const bad = (label) => {
  failed++;
  console.log(`  FAIL ${label}`);
};

console.log("=== 1. package.json → $schema ===");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (!pkg.$schema) {
  bad("в package.json нет поля $schema — VS Code снова пойдёт в schemastore.org");
} else {
  ok(`$schema = ${pkg.$schema}`);
  const target = path.resolve(ROOT, pkg.$schema);
  if (existsSync(target)) ok(`файл схемы существует: ${pkg.$schema}`);
  else bad(`файл схемы НЕ найден: ${pkg.$schema}`);
}

console.log("\n=== 2. Локальная схема package.schema.json ===");
const schemaPath = path.join(SCHEMAS, "package.schema.json");
if (!existsSync(schemaPath)) {
  bad("schemas/package.schema.json отсутствует");
} else {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  ok(`валидна, properties: ${Object.keys(schema.properties || {}).length}`);

  // Собираем все $ref, кроме локальных якорей (#...)
  const refs = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) refs.push(v);
        else walk(v);
      }
    }
  };
  walk(schema);

  const external = refs.filter((r) => /^https?:/i.test(r));
  if (external.length) bad(`остались внешние ссылки: ${external.join(", ")}`);
  else ok(`внешних ссылок нет (всего $ref: ${refs.length})`);

  const missing = [...new Set(refs)].filter((r) => !existsSync(path.join(SCHEMAS, r)));
  if (missing.length) bad(`файлы не найдены: ${missing.join(", ")}`);
  else ok("все локальные ссылки указывают на существующие файлы");
}

console.log("=== 3. Состав каталога schemas/ ===");
const files = readdirSync(SCHEMAS);
ok(`файлов: ${files.length}`);
for (const f of files) {
  try {
    JSON.parse(readFileSync(path.join(SCHEMAS, f), "utf8"));
    console.log(`       ${f}`);
  } catch {
    bad(`${f} — невалидный JSON`);
  }
}

console.log("\n=== 4. tsconfig.json → $schema (та же проблема с schemastore) ===");
const tsconfigRaw = readFileSync(path.join(ROOT, "tsconfig.json"), "utf8");
// tsconfig допускает комментарии, поэтому читаем как JSONC — ищем поле регуляркой
const tsMatch = tsconfigRaw.match(/"\$schema"\s*:\s*"([^"]+)"/);
if (!tsMatch) {
  bad("в tsconfig.json нет $schema — VS Code пойдёт в schemastore.org/tsconfig");
} else {
  ok(`$schema = ${tsMatch[1]}`);
  if (existsSync(path.resolve(ROOT, tsMatch[1]))) ok("файл схемы tsconfig существует");
  else bad(`файл схемы tsconfig не найден: ${tsMatch[1]}`);
}

console.log(
  failed === 0
    ? "\nИтог: фикс применён корректно, сеть для схем package.json больше не нужна."
    : `\nИтог: проблем — ${failed}.`
);
process.exit(failed === 0 ? 0 : 1);