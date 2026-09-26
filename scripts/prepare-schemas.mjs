/**
 * Готовит локальные JSON-схемы в каталоге schemas/.
 *
 * Зачем: VS Code за схемой package.json / tsconfig.json обращается к
 * schemastore.org, а в этом окружении весь HTTPS идёт через фильтрующий прокси
 * (HTTP_PROXY/HTTPS_PROXY). Прокси отдаёт на schemastore.org «403 Filtered»,
 * поэтому редактор не может загрузить схему и в «Проблемах» появляется ошибка
 * «Не удалось загрузить схему из "https://www.schemastore.org/package"».
 *
 * Надёжное решение — локальная копия схемы + поле $schema в самом файле:
 * JSON-сервис VS Code сначала смотрит на $schema ВНУТРИ документа и, если оно
 * есть, вообще не обращается к встроенной привязке schemastore (проверено по
 * коду расширения json-language-features: getSchemaForResource сначала вызывает
 * getSchemaFromProperty и только при пустом результате идёт в сеть).
 *
 * Скрипт переписывает внешние $ref внутри схемы на локальные файлы: и
 * абсолютные ссылки на schemastore, так и «голые» имена вида "nodemon.json"
 * (VS Code трактует их как относительные к схеме package.json). После этого
 * схема полностью автономна и в сеть не ходит.
 *
 * Запуск: npm run schemas:prepare
 * Проверка результата: npm run schemas:check
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(import.meta.dirname, "..", "schemas");

/** Имена локальных схем, которые подставляются вместо внешних ссылок */
const LOCAL_BY_NAME = {
  "eslintrc.json": "eslintrc.json",
  "stylelintrc.json": "stylelintrc.json",
  "ava.json": "ava.json",
  "semantic-release.json": "semantic-release.json",
  "jscpd.json": "jscpd.json",
  "madge.json": "madge.json",
  "nodemon.json": "nodemon.json",
  "https://www.schemastore.org/prettierrc.json": "prettierrc.json",
  "https://www.schemastore.org/quikrun.json": "quikrun.json",
};

/**
 * Проверяем, что все нужные файлы на месте. Скачать их скрипт не может: именно
 * этот домен и блокируется прокси, поэтому загрузка делается вручную.
 */
const missingFiles = [...new Set(Object.values(LOCAL_BY_NAME))].filter(
  (f) => !existsSync(path.join(DIR, f))
);
if (missingFiles.length) {
  console.error(
    `[schemas] Не хватает файлов: ${missingFiles.join(", ")}\n` +
      "  Скачайте их в обход прокси (в PowerShell):\n" +
      '    cd schemas; curl.exe --noproxy "*" -O https://www.schemastore.org/<имя>.json'
  );
  process.exit(1);
}

const LOCAL_FILES = new Set(readdirSync(DIR));

/** Обходит объект и заменяет внешние $ref на локальные */
function rewriteRefs(node, stats) {
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefs(item, stats);
    return node;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
        // Ссылка уже локальная (повторный запуск) — это нормально
        if (LOCAL_FILES.has(value)) {
          stats.push(`= ${value} (уже локальная)`);
          continue;
        }
        const local = LOCAL_BY_NAME[value];
        if (local) {
          node[key] = local;
          stats.push(`→ ${value} → ${local}`);
        } else {
          stats.push(`! НЕ ОБРАБОТАНО: ${value}`);
        }
      } else {
        rewriteRefs(value, stats);
      }
    }
  }
  return node;
}

const target = path.join(DIR, "package.schema.json");
const schema = JSON.parse(readFileSync(target, "utf8"));
const stats = [];
rewriteRefs(schema, stats);

writeFileSync(target, JSON.stringify(schema, null, 2) + "\n", "utf8");

console.log("[schemas] package.schema.json: переписано ссылок:", stats.length);
for (const s of stats) console.log(`  ${s.startsWith("НЕ ") ? "✗" : "✓"} ${s}`);
console.log("\n[schemas] Файлы в каталоге:");
for (const f of readdirSync(DIR)) console.log(`  ${f}`);