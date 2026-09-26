/**
 * Резервное копирование базы и ротация дампов.
 *
 * Зачем отдельный модуль, а не скрипт в cron контейнера: дамп должен уметь
 * снимать и планировщик (по расписанию), и администратор кнопкой в панели.
 * Скрипт в docker-compose пришлось бы дублировать, и «кнопка» с «расписанием»
 * начали бы писать файлы с разными именами — а ротация перестала бы их
 * находить и удалять.
 *
 * Два режима съёма:
 *   1. `pg_dump` — если утилита есть в образе (полная схема: таблицы, ключи,
 *      индексы, последовательности). Это основной путь.
 *   2. Резервный экспорт «таблица за таблицей» через сам пул: в slim-образах
 *      postgresql-client может отсутствовать, и без запасного пути копия просто
 *      не создавалась бы — то есть защита от потери данных не работала бы ровно
 *      там, где она нужнее всего.
 *
 * Имя файла: atk_backup_YYYY-MM-DD_HH-mm-ss.sql (или .sql.gz) — формат выбран
 * так, чтобы файлы сортировались по имени и дата читалась человеком без
 * дополнительных утилит.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { escapeIdentifier } from "pg";
import { db, pool } from "@/db";
import { logs } from "@/db/schema";
import { setSettingQuiet } from "@/lib/settings";

/** Каталог копий по умолчанию (в Docker переопределяется томом) */
export const DEFAULT_BACKUP_DIR = "./backups";

/** Срок хранения копий по умолчанию, дней */
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * Префикс и маска имени дампа.
 * Маска одна на весь проект: по ней же работает ротация, поэтому «своё» имя
 * файла, придуманное где-то ещё, не будет удалено как устаревшее.
 */
export const BACKUP_FILE_PREFIX = "atk_backup_";
export const BACKUP_FILE_RE = /^atk_backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.sql(\.gz)?$/;

/** Каталог копий: BACKUP_DIR из окружения либо ./backups рядом с приложением */
export function backupDir(): string {
  const fromEnv = (process.env.BACKUP_DIR || "").trim();
  return fromEnv || DEFAULT_BACKUP_DIR;
}

/** Сколько дней храним копии (BACKUP_RETENTION_DAYS, по умолчанию 7) */
export function retentionDaysFromEnv(): number {
  const parsed = parseInt((process.env.BACKUP_RETENTION_DAYS || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

/** Сжимать ли дамп (BACKUP_COMPRESS=false отключает gzip) */
function compressionEnabled(): boolean {
  return (process.env.BACKUP_COMPRESS || "").trim().toLowerCase() !== "false";
}

/**
 * Создаёт каталог копий. Идемпотентно: повторный вызов — не ошибка.
 * Права 0o700: дампы содержат персональные данные состава, читать их должен
 * только владелец процесса (в Docker — пользователь nextjs).
 */
export function ensureBackupDir(dir: string = backupDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Две цифры с ведущим нулём */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Имя дампа по моменту времени.
 * Локальное время, а не UTC: администратор сопоставляет файл с событиями в
 * журнале панели, а там время пояса сервера (TZ из docker-compose).
 */
export function backupFileName(at: Date = new Date(), gzip = compressionEnabled()): string {
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return `${BACKUP_FILE_PREFIX}${stamp}.sql${gzip ? ".gz" : ""}`;
}

/** Момент создания из имени файла. null — имя не по нашей маске */
export function parseBackupFileName(name: string): Date | null {
  const m = BACKUP_FILE_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const parsed = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Описание файла копии для интерфейса и ответов API */
export type BackupFile = {
  /** Имя файла без каталога */
  name: string;
  /** Абсолютный путь — нужен для восстановления из консоли сервера */
  path: string;
  /** Размер в байтах */
  sizeBytes: number;
  /** Размер в мегабайтах с двумя знаками (для карточки в панели) */
  sizeMb: number;
  /** Момент создания из имени файла (ISO) */
  createdAt: string;
  /** Сжат ли дамп (.sql.gz) */
  compressed: boolean;
  /** Готов ли файл к чтению/восстановлению: существует и не пустой */
  ready: boolean;
};

/**
 * Чистая функция ротации: какие файлы подлежат удалению.
 *
 * Вынесена из rotateBackups отдельно, чтобы её проверял тест без файловой
 * системы: ошибка в границе «старше 7 дней» стирает свежую копию, и заметить
 * это можно было бы только по факту потери данных.
 *
 * Файлы, чьё имя не совпадает с маской (например, чужая копия, положенная
 * администратором вручную), не удаляются никогда — ротация касается только
 * собственных дампов.
 */
export function selectExpiredBackups(
  names: string[],
  retentionDays: number,
  now: Date = new Date()
): string[] {
  // Ровно сутки в миллисекундах; календарные дни не считаем, потому что при
  // переходе на летнее время сутки могут длиться 23 или 25 часов.
  const msPerDay = 24 * 60 * 60 * 1000;
  const cutoff = now.getTime() - Math.max(1, retentionDays) * msPerDay;

  return names.filter((name) => {
    const createdAt = parseBackupFileName(name);
    if (!createdAt) return false;
    return createdAt.getTime() < cutoff;
  });
}

/** Удаляет копии старше срока хранения. Возвращает имена удалённых файлов */
export function rotateBackups(
  retentionDays: number = retentionDaysFromEnv(),
  dir: string = backupDir(),
  now: Date = new Date()
): string[] {
  if (!existsSync(dir)) return [];

  const names = readdirSync(dir).filter((n) => BACKUP_FILE_RE.test(n));
  const expired = selectExpiredBackups(names, retentionDays, now);
  const removed: string[] = [];

  for (const name of expired) {
    try {
      unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // Файл уже удалён другим процессом или занят: ротация не должна падать,
      // иначе следующая по расписанию копия не создастся вовсе.
    }
  }
  return removed;
}

/** Список копий: свежие сверху. Отсутствие каталога — пустой список */
export function listBackups(dir: string = backupDir()): BackupFile[] {
  if (!existsSync(dir)) return [];

  const files: BackupFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!BACKUP_FILE_RE.test(name)) continue;
    const full = path.join(dir, name);
    const createdAt = parseBackupFileName(name);
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(full).size;
    } catch {
      continue; // файл исчез между чтением каталога и stat — пропускаем
    }
    files.push({
      name,
      path: full,
      sizeBytes,
      sizeMb: Math.round((sizeBytes / (1024 * 1024)) * 100) / 100,
      createdAt: (createdAt ?? new Date(0)).toISOString(),
      compressed: name.endsWith(".gz"),
      // Пустой дамп восстановить нельзя: считать его готовым — значит показать
      // администратору «копия есть» там, где restore даст пустую базу.
      ready: sizeBytes > 0,
    });
  }

  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ------------------------------------------------------------------ */
/* Генерация дампа                                                     */
/* ------------------------------------------------------------------ */

/** Источник запросов: пул приложения или подставной объект в тестах */
export type BackupQuerySource = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** Результат съёма копии */
export type BackupResult = {
  ok: boolean;
  fileName: string;
  path: string;
  sizeBytes: number;
  sizeMb: number;
  createdAt: string;
  /** Каким способом снят дамп */
  mode: "pg_dump" | "table-export";
  /** Сколько таблиц попало в резервный экспорт (для pg_dump — 0) */
  tables: number;
  durationMs: number;
  error?: string;
};

/** Экранирование текста под COPY ... FROM stdin (табуляция, перевод строки) */
export function escapeCopyText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** Значение для формата COPY: NULL, escape-последовательности, буферы */
export function copyValue(value: unknown): string {
  if (value === null || value === undefined) return "\\N";
  // Даты — ISO-строкой: при восстановлении postgres разберёт её однозначно,
  // тогда как локальный формат зависит от настройки DateStyle сервера.
  if (value instanceof Date) return escapeCopyText(value.toISOString());
  // bytea в текстовом COPY записывается как hex с префиксом \x, а сам обратный
  // слеш кодируется как \\ — иначе восстановление прочитает литерал «x...».
  if (Buffer.isBuffer(value)) return `\\\\x${value.toString("hex")}`;
  if (typeof value === "boolean") return value ? "t" : "f";
  // jsonb/json приходят объектами — в COPY кладём их текстом JSON
  if (typeof value === "object") return escapeCopyText(JSON.stringify(value));
  return escapeCopyText(String(value));
}

/** Пробуем pg_dump из PATH — в slim-образе его может не быть */
export function pgDumpAvailable(): boolean {
  try {
    const probe = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * Аргументы pg_dump из DATABASE_URL.
 *
 * Хост, порт и логин передаём флагами, а пароль — переменной PGPASSWORD: так
 * он не попадает в список аргументов процесса, который видно в `ps` любому
 * пользователю контейнера.
 */
function pgDumpArgs(databaseUrl: string): { args: string[]; password: string } | null {
  try {
    const url = new URL(databaseUrl);
    return {
      args: [
        "--no-owner",
        "--no-privileges",
        "--clean",
        "--if-exists",
        "-h", url.hostname,
        "-p", url.port || "5432",
        "-U", decodeURIComponent(url.username),
        "-d", url.pathname.replace(/^\//, ""),
      ],
      password: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
}

/** Дамп через pg_dump. Ошибки возвращаем значением, а не бросаем наружу */
function dumpWithPgDump(): { sql: string } | { error: string } {
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) return { error: "Не задан DATABASE_URL" };

  const parsed = pgDumpArgs(databaseUrl);
  if (!parsed) return { error: "Не удалось разобрать DATABASE_URL" };

  const result = spawnSync("pg_dump", parsed.args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: parsed.password },
  });

  if (result.error) return { error: result.error.message };
  if (result.status !== 0) {
    const tail = (result.stderr || "").trim().split("\n").filter(Boolean).slice(-1)[0];
    return { error: tail || "pg_dump завершился с ошибкой" };
  }
  if (!result.stdout || !result.stdout.trim()) return { error: "pg_dump вернул пустой дамп" };
  return { sql: result.stdout };
}

/* ------------------------------------------------------------------ */
/* Резервный экспорт «таблица за таблицей»                             */
/* ------------------------------------------------------------------ */

/** Таблицы публичной схемы приложения */
async function listBaseTables(source: BackupQuerySource): Promise<string[]> {
  const { rows } = await source.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  return rows.map((r) => String(r.table_name));
}

/** Колонки таблицы: имя, тип, NOT NULL, значение по умолчанию */
async function listColumns(
  source: BackupQuerySource,
  table: string
): Promise<{ name: string; type: string; notNull: boolean; defaultExpr: string | null }[]> {
  const { rows } = await source.query(
    `SELECT a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table]
  );
  return rows.map((r) => ({
    name: String(r.name),
    type: String(r.type),
    notNull: r.not_null === true,
    defaultExpr: r.default_expr == null ? null : String(r.default_expr),
  }));
}

/**
 * Колонки первичного ключа: без них таблица восстановится без уникальности, и
 * повторный запуск синхронизации получил бы дубли вместо ON CONFLICT.
 */
async function primaryKeyColumns(source: BackupQuerySource, table: string): Promise<string[]> {
  const { rows } = await source.query(
    `SELECT a.attname AS name
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY a.attnum`,
    [table]
  );
  return rows.map((r) => String(r.name));
}

/** Идентификатор — через escapeIdentifier: имена приходят из каталога БД */
function quoteIdent(name: string): string {
  return escapeIdentifier(name);
}

/**
 * Резервный экспорт: упрощённая схема + данные каждой таблицы через COPY.
 *
 * Оговорка по полноте: внешние ключи, индексы и последовательности в этом
 * режиме не восстанавливаются — он рассчитан на возврат данных «здесь и
 * сейчас», когда pg_dump в образе нет. Полную схему даёт pg_dump либо миграции
 * drizzle (каталог drizzle/), которые применяются сервисом migrate.
 */
export async function buildTableExport(
  source: BackupQuerySource
): Promise<{ sql: string; tables: number }> {
  const tables = await listBaseTables(source);
  const chunks: string[] = [
    "-- Резервная копия ATK BOT (режим «таблица за таблицей»)",
    `-- Снято: ${new Date().toISOString()}`,
    "-- ВНИМАНИЕ: внешние ключи и индексы не восстанавливаются — схему дают миграции drizzle.",
    "",
    "SET statement_timeout = 0;",
    "SET client_encoding = 'UTF8';",
    "",
  ];

  let exported = 0;
  for (const table of tables) {
    const columns = await listColumns(source, table);
    if (!columns.length) continue;
    const pk = await primaryKeyColumns(source, table);

    const columnDefs = columns.map((c) => {
      const parts = [`  ${quoteIdent(c.name)} ${c.type}`];
      if (c.defaultExpr) parts.push(`DEFAULT ${c.defaultExpr}`);
      if (c.notNull) parts.push("NOT NULL");
      return parts.join(" ");
    });
    if (pk.length) columnDefs.push(`  PRIMARY KEY (${pk.map(quoteIdent).join(", ")})`);

    chunks.push(`DROP TABLE IF EXISTS ${quoteIdent(table)} CASCADE;`);
    chunks.push(`CREATE TABLE ${quoteIdent(table)} (\n${columnDefs.join(",\n")}\n);`);

    const { rows } = await source.query(`SELECT * FROM ${quoteIdent(table)}`);
    const names = columns.map((c) => c.name);
    if (rows.length) {
      chunks.push(`COPY ${quoteIdent(table)} (${names.map(quoteIdent).join(", ")}) FROM stdin;`);
      for (const row of rows) {
        chunks.push(names.map((n) => copyValue(row[n])).join("\t"));
      }
      // Терминатор COPY — строка из одного обратного слеша и точки
      chunks.push("\\.");
    }
    chunks.push("");
    exported++;
  }

  return { sql: chunks.join("\n"), tables: exported };
}

/* ------------------------------------------------------------------ */
/* Съём копии                                                          */
/* ------------------------------------------------------------------ */

/** Журнал обслуживания: неудачный бэкап должен быть виден в панели */
async function logBackup(
  title: string,
  detail: string,
  ok: boolean,
  error: string | null
): Promise<void> {
  try {
    await db.insert(logs).values({ kind: "system", title, detail, ok, error });
  } catch {
    // Журнал не должен ломать сам бэкап: файл уже на диске
  }
}

/**
 * Создаёт дамп базы, кладёт его в каталог копий и обновляет метаданные.
 *
 * Порядок шагов важен: сначала пробуем pg_dump (полная схема), и только если
 * утилиты нет или она упала — переходим на экспорт таблиц. Писать «полупустой»
 * файл нельзя: администратор будет считать, что копия есть.
 *
 * @param options.source источник запросов (в тестах — подставной объект)
 * @param options.dir    каталог копий (по умолчанию BACKUP_DIR)
 * @param options.now    момент времени (для предсказуемого имени в тестах)
 * @param options.usePgDump  false — сразу резервный экспорт. Нужно тем, кто
 *        снимает копию в среде без клиента PostgreSQL, и тестам: иначе
 *        результат зависел бы от того, есть ли pg_dump в PATH у машины.
 */
export async function createDatabaseBackup(
  options: {
    source?: BackupQuerySource;
    dir?: string;
    now?: Date;
    usePgDump?: boolean;
  } = {}
): Promise<BackupResult> {
  const startedAt = Date.now();
  const dir = options.dir ?? backupDir();
  const now = options.now ?? new Date();
  const fileName = backupFileName(now);
  const fullPath = path.join(dir, fileName);

  const base: BackupResult = {
    ok: false,
    fileName,
    path: fullPath,
    sizeBytes: 0,
    sizeMb: 0,
    createdAt: now.toISOString(),
    mode: "table-export",
    tables: 0,
    durationMs: 0,
  };

  try {
    ensureBackupDir(dir);

    let sql = "";
    let mode: BackupResult["mode"] = "pg_dump";
    let tables = 0;
    let dumpError = "";

    if (options.usePgDump === false) {
      dumpError = "pg_dump отключён параметром вызова";
    } else if (pgDumpAvailable()) {
      const dumped = dumpWithPgDump();
      if ("sql" in dumped) {
        sql = dumped.sql;
      } else {
        dumpError = dumped.error;
        console.warn(`[backup] pg_dump не сработал (${dumped.error}) — использую резервный экспорт`);
      }
    } else {
      dumpError = "pg_dump не найден в PATH";
    }

    if (!sql) {
      // Резервный путь: экспорт через пул приложения. Пул берём у драйвера
      // напрямую, а не через db.execute: нужен текстовый протокол с параметрами
      // для запросов к каталогу PostgreSQL.
      const source =
        options.source ?? { query: (text, values) => pool.query(text, values as never[]) };
      const exported = await buildTableExport(source);
      sql = exported.sql;
      tables = exported.tables;
      mode = "table-export";
    }

    const payload = compressionEnabled()
      ? gzipSync(Buffer.from(sql, "utf8"))
      : Buffer.from(sql, "utf8");
    writeFileSync(fullPath, payload, { mode: 0o600 });
    const sizeBytes = statSync(fullPath).size;

    // Ротация сразу после успешной копии: диск не должен расти бесконечно
    const retention = retentionDaysFromEnv();
    const removed = rotateBackups(retention, dir, now);

    // Метаданные для панели: карточке нужно последнее значение, а не история.
    // Запись обёрнута в try: копия уже лежит на диске, и недоступность настроек
    // (или БД) не должна превращать успешный бэкап в «ошибку создания».
    try {
      await setSettingQuiet("last_backup_at", now.toISOString());
      await setSettingQuiet(
        "last_backup_file",
        `${fileName} (${(sizeBytes / (1024 * 1024)).toFixed(2)} МБ, способ: ${mode})`
      );
    } catch (e) {
      console.warn(
        `[backup] Копия ${fileName} создана, но метаданные не записаны: ${
          e instanceof Error ? e.message : e
        }`
      );
    }

    const result: BackupResult = {
      ...base,
      ok: true,
      sizeBytes,
      sizeMb: Math.round((sizeBytes / (1024 * 1024)) * 100) / 100,
      mode,
      tables,
      durationMs: Date.now() - startedAt,
    };

    await logBackup(
      "Резервная копия создана",
      `Файл ${fileName}, ${result.sizeMb} МБ, способ: ${mode}` +
        (tables ? `, таблиц: ${tables}` : "") +
        (removed.length
          ? `, удалено устаревших: ${removed.length} (хранение ${retention} дн.)`
          : "") +
        (mode === "table-export" && dumpError ? `, pg_dump: ${dumpError}` : ""),
      true,
      null
    );

    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logBackup("Резервная копия не создана", `Ошибка: ${message}`, false, message);
    return { ...base, durationMs: Date.now() - startedAt, error: message };
  }
}