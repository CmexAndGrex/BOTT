/**
 * Обслуживание системы: резервные копии, ротация, изоляция ошибок синхронизации,
 * очистка устаревших данных и доступ к роутам (RBAC + CSRF).
 *
 * Проверяются боевые модули (src/lib/backup.ts, maintenance.ts, csrf.ts,
 * maintenance-guard.ts), а не копии правил в тесте: ошибка в границе «старше
 * 7 дней» стирает свежую копию, ошибка в политике очистки удаляет аудит, а
 * ослабленный гвард открывает обслуживание рядовому бойцу. Всё это замечается
 * только по факту — то есть уже после потери данных.
 *
 * Запуск: npm run test
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  BACKUP_FILE_PREFIX,
  backupFileName,
  buildTableExport,
  copyValue,
  createDatabaseBackup,
  escapeCopyText,
  listBackups,
  parseBackupFileName,
  rotateBackups,
  selectExpiredBackups,
  type BackupQuerySource,
} from "../src/lib/backup.ts";
import {
  AUDIT_CRITICAL_CATEGORIES,
  AUDIT_RETENTION_DAYS,
  MAINTENANCE_KEYS,
  auditCutoff,
  diskUsage,
  getMaintenanceHealth,
  isPrunableLogCategory,
  isSessionExpired,
  pruneExpiredSessionsAndLogs,
  readSyncStatus,
  syncStatusBadgeClass,
  syncStatusLabel,
  type MaintenanceStore,
} from "../src/lib/maintenance.ts";
import { canManageMaintenance, maintenanceDecision, MAINTENANCE_ROLES, requireMaintenance } from "../src/lib/maintenance-guard.ts";
import {
  BACKUP_INTERVAL_MS,
  MAINTENANCE_TICK_MS,
  PRUNE_INTERVAL_MS,
  SHEET_SYNC_INTERVAL_MS,
  maintenanceSchedule,
  runMaintenanceCycle,
  runSheetSync,
  startMaintenanceScheduler,
} from "../src/lib/sync-scheduler.ts";
import { GET as getMaintenance } from "../src/app/api/admin/maintenance/route.ts";
import { POST as postBackup } from "../src/app/api/admin/maintenance/backup/route.ts";
import { POST as postSync } from "../src/app/api/admin/maintenance/sync/route.ts";
import { POST as postPrune } from "../src/app/api/admin/maintenance/prune/route.ts";
import { isCrossSiteRequest, isUnsafeMethod } from "../src/lib/csrf.ts";
import { LoginThrottle } from "../src/lib/recruits.ts";
import { registerThrottle } from "../src/lib/throttle-registry.ts";

/** Временный каталог копий: тест не трогает рабочий ./backups */
function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "atk-backup-test-"));
}

/** Создаёт файл копии нужного «возраста» и размера */
function touchBackup(dir: string, at: Date, bytes = 16): string {
  const name = backupFileName(at, false);
  writeFileSync(path.join(dir, name), "x".repeat(bytes));
  return name;
}

/* ------------------------------------------------------------------ */
/* Имя файла и разбор даты                                             */
/* ------------------------------------------------------------------ */

describe("Имя файла копии: формат из ТЗ", () => {
  test("имя собирается как atk_backup_ГГГГ-ММ-ДД_ЧЧ-мм-сс.sql", () => {
    const at = new Date(2026, 8, 26, 14, 5, 9); // 26.09.2026 14:05:09
    assert.equal(backupFileName(at, false), "atk_backup_2026-09-26_14-05-09.sql");
  });

  test("с gzip имя получает расширение .sql.gz", () => {
    const at = new Date(2026, 8, 26, 14, 5, 9);
    assert.equal(backupFileName(at, true), "atk_backup_2026-09-26_14-05-09.sql.gz");
  });

  test("разбор возвращает тот же момент времени", () => {
    const at = new Date(2026, 0, 3, 4, 5, 6);
    const parsed = parseBackupFileName(backupFileName(at, false));
    assert.ok(parsed);
    assert.equal(parsed.getTime(), at.getTime());
  });

  test("чужие файлы не считаются копиями", () => {
    for (const name of [
      "atk_backup.sql",
      "atk_backup_2026-09-26.sql",
      "dump.sql",
      "atk_backup_26-09-2026_14-05-09.sql",
    ]) {
      assert.equal(parseBackupFileName(name), null, `«${name}» не должен считаться копией`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Ротация: что удаляется, что остаётся                                */
/* ------------------------------------------------------------------ */

describe("Ротация копий — срок хранения 7 дней", () => {
  const now = new Date(2026, 8, 26, 12, 0, 0);

  test("файлы старше 7 дней помечаются к удалению, свежие — нет", () => {
    const names = [
      backupFileName(new Date(2026, 8, 26, 11, 0, 0), false), // сегодня — оставить
      backupFileName(new Date(2026, 8, 25, 11, 0, 0), false), // вчера — оставить
      backupFileName(new Date(2026, 8, 19, 12, 0, 1), false), // 7 дней — оставить (на секунду свежее границы)
      backupFileName(new Date(2026, 8, 19, 11, 59, 59), false), // 7 дней + 1 с — удалить
      backupFileName(new Date(2026, 8, 10, 12, 0, 0), false), // 16 дней — удалить
    ];

    const expired = selectExpiredBackups(names, 7, now);

    assert.deepEqual(expired, [names[3], names[4]]);
    assert.ok(!expired.includes(names[0]), "свежая копия удаляться не должна");
    assert.ok(!expired.includes(names[1]), "вчерашняя копия удаляться не должна");
    assert.ok(!expired.includes(names[2]), "копия ровно на границе срока должна остаться");
  });

  test("срок хранения действует и на сжатые файлы", () => {
    const names = [
      backupFileName(new Date(2026, 8, 1, 10, 0, 0), true),
      backupFileName(new Date(2026, 8, 26, 10, 0, 0), true),
    ];
    assert.deepEqual(selectExpiredBackups(names, 7, now), [names[0]]);
  });

  test("другой срок хранения меняет границу", () => {
    const names = [
      backupFileName(new Date(2026, 8, 17, 12, 0, 0), false), // 9 дней назад
      backupFileName(new Date(2026, 8, 14, 12, 0, 0), false), // 12 дней назад
      backupFileName(new Date(2026, 8, 25, 12, 0, 0), false), // 1 день назад
    ];
    // При хранении 30 дней не удаляется ничего
    assert.deepEqual(selectExpiredBackups(names, 30, now), []);
    // При хранении 7 дней удаляются только те, что старше недели
    assert.deepEqual(selectExpiredBackups(names, 7, now), [names[0], names[1]]);
  });

  test("чужие файлы в каталоге не удаляются никогда", () => {
    const names = ["manual-copy.sql", "atk_backup_old.sql", "readme.txt"];
    assert.deepEqual(selectExpiredBackups(names, 1, now), []);
  });

  test("политика не может обнулиться: минимум одни сутки хранения", () => {
    // Иначе «retentionDays = 0» удалял бы копию сразу после создания
    const fresh = backupFileName(new Date(2026, 8, 26, 11, 0, 0), false);
    assert.deepEqual(selectExpiredBackups([fresh], 0, now), []);
  });
});

describe("Ротация копий — работа с диском", () => {
  let dir = "";

  before(() => {
    dir = tempDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rotateBackups удаляет только устаревшие и возвращает их имена", () => {
    const now = new Date(2026, 8, 26, 12, 0, 0);
    const fresh = touchBackup(dir, new Date(2026, 8, 26, 6, 0, 0));
    const old1 = touchBackup(dir, new Date(2026, 8, 1, 6, 0, 0));
    const old2 = touchBackup(dir, new Date(2026, 7, 15, 6, 0, 0));

    const removed = rotateBackups(7, dir, now);

    assert.equal(removed.length, 2);
    assert.ok(removed.includes(old1) && removed.includes(old2));
    assert.ok(existsSync(path.join(dir, fresh)), "свежая копия должна остаться на диске");
    assert.ok(!existsSync(path.join(dir, old1)));
    assert.ok(!existsSync(path.join(dir, old2)));
  });

  test("ротация не падает на отсутствующем каталоге", () => {
    assert.deepEqual(rotateBackups(7, path.join(dir, "нет-такого-каталога")), []);
  });
});

/* ------------------------------------------------------------------ */
/* Значения COPY: восстановление не должно ломаться на спецсимволах   */
/* ------------------------------------------------------------------ */

describe("Экранирование значений для COPY", () => {
  test("NULL пишется как \\N, а булево — как t/f", () => {
    assert.equal(copyValue(null), "\\N");
    assert.equal(copyValue(undefined), "\\N");
    assert.equal(copyValue(true), "t");
    assert.equal(copyValue(false), "f");
  });

  test("табуляция и перевод строки не разрывают строку данных", () => {
    // Иначе один боец с переводом строки в комментарии превратился бы в две
    // строки COPY, и восстановление упало бы на «extra data after last
    // expected column».
    assert.equal(escapeCopyText("a\tb"), "a\\tb");
    assert.equal(escapeCopyText("a\nb"), "a\\nb");
    assert.equal(escapeCopyText("a\r\nb"), "a\\r\\nb");
  });

  test("обратный слеш экранируется первым", () => {
    assert.equal(escapeCopyText("C:\\path"), "C:\\\\path");
    // Последовательность вида \t в данных не должна стать табуляцией
    assert.equal(escapeCopyText("\\t"), "\\\\t");
  });

  test("дата уходит ISO-строкой, а не локальным форматом", () => {
    const value = copyValue(new Date("2026-09-26T14:05:09.000Z"));
    assert.equal(value, "2026-09-26T14:05:09.000Z");
  });

  test("jsonb пишется текстом JSON, а не [object Object]", () => {
    assert.equal(copyValue({ rank: "Курсант" }), '{"rank":"Курсант"}');
  });

  test("числа не меняют формат", () => {
    assert.equal(copyValue(42), "42");
    assert.equal(copyValue(3.5), "3.5");
    assert.equal(copyValue(0), "0");
  });
});

/* ------------------------------------------------------------------ */
/* Резервный экспорт «таблица за таблицей»                             */
/* ------------------------------------------------------------------ */

/**
 * Подставной источник запросов: отвечает так же, как ответил бы PostgreSQL на
 * запросы к каталогу. Позволяет проверить сборку дампа без живой базы.
 */
function fakeSource(
  tables: Record<
    string,
    {
      columns: { name: string; type: string; notNull?: boolean; defaultExpr?: string | null }[];
      pk?: string[];
      rows?: Record<string, unknown>[];
    }
  >
): BackupQuerySource {
  return {
    async query(text, values) {
      if (text.includes("information_schema.tables")) {
        return { rows: Object.keys(tables).map((table_name) => ({ table_name })) };
      }
      // Имя таблицы приходит либо параметром (запросы к каталогу), либо прямо в
      // тексте запроса — так же, как это делает боевой код для SELECT *.
      const fromText = /(?:FROM|=")\s*"([^"]+)"/.exec(text);
      const table = String((values ?? [])[0] ?? fromText?.[1] ?? "");
      if (text.includes("pg_catalog.pg_attribute") && text.includes("attnotnull")) {
        return {
          rows: (tables[table]?.columns ?? []).map((c) => ({
            name: c.name,
            type: c.type,
            not_null: c.notNull === true,
            default_expr: c.defaultExpr ?? null,
          })),
        };
      }
      if (text.includes("indisprimary")) {
        return { rows: (tables[table]?.pk ?? []).map((name) => ({ name })) };
      }
      if (text.startsWith("SELECT * FROM")) {
        return { rows: tables[table]?.rows ?? [] };
      }
      throw new Error(`неожиданный запрос: ${text.slice(0, 60)}`);
    },
  };
}

describe("Резервный экспорт таблиц (когда pg_dump недоступен)", () => {
  const source = fakeSource({
    division_members: {
      columns: [
        { name: "id", type: "integer", notNull: true, defaultExpr: "nextval('division_members_id_seq'::regclass)" },
        { name: "name", type: "text", notNull: true },
        { name: "vacation", type: "boolean", notNull: true, defaultExpr: "false" },
        { name: "application_data", type: "jsonb" },
      ],
      pk: ["id"],
      rows: [
        { id: 1, name: "Гром", vacation: false, application_data: { age: 25 } },
        { id: 2, name: "Скиф", vacation: true, application_data: null },
      ],
    },
    bot_settings: {
      columns: [
        { name: "key", type: "text", notNull: true },
        { name: "value", type: "text", notNull: true, defaultExpr: "''::text" },
      ],
      pk: ["key"],
      rows: [{ key: "timezone", value: "Europe/Moscow" }],
    },
  });

  test("в дамп попадают схема, ключи и данные всех таблиц", async () => {
    const { sql, tables } = await buildTableExport(source);

    assert.equal(tables, 2);
    assert.match(sql, /CREATE TABLE "division_members"/);
    assert.match(sql, /CREATE TABLE "bot_settings"/);
    // Первичный ключ обязателен: без него ON CONFLICT при следующей
    // синхронизации вставил бы дубли вместо обновления.
    assert.match(sql, /PRIMARY KEY \("id"\)/);
    assert.match(sql, /PRIMARY KEY \("key"\)/);
    assert.match(sql, /COPY "division_members" \("id", "name", "vacation", "application_data"\) FROM stdin;/);
  });

  test("значения экранированы и NULL не теряется", async () => {
    const { sql } = await buildTableExport(source);
    // Строка с id=2: application_data = NULL → \N
    assert.match(sql, /2\tСкиф\tt\t\\N/);
    // jsonb превращён в текст JSON, а не в [object Object]
    assert.match(sql, /\{"age":25\}/);
  });

  test("каждая таблица завершается терминатором COPY", async () => {
    const { sql } = await buildTableExport(source);
    const terminators = sql.split("\n").filter((line) => line === "\\.");
    assert.equal(terminators.length, 2, "после каждого COPY должна быть строка «\\.»");
  });

  test("пустая таблица не получает блок COPY", async () => {
    const empty = fakeSource({
      empty_table: { columns: [{ name: "id", type: "integer" }], pk: ["id"], rows: [] },
    });
    const { sql, tables } = await buildTableExport(empty);
    assert.equal(tables, 1);
    assert.match(sql, /CREATE TABLE "empty_table"/);
    assert.doesNotMatch(sql, /COPY "empty_table"/);
  });

  test("таблица без колонок пропускается, а не роняет экспорт", async () => {
    const weird = fakeSource({
      broken: { columns: [], rows: [] },
      ok: { columns: [{ name: "id", type: "integer" }], rows: [{ id: 7 }] },
    });
    const { tables } = await buildTableExport(weird);
    assert.equal(tables, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Создание копии: файл, метаданные, ротация                           */
/* ------------------------------------------------------------------ */

describe("createDatabaseBackup — снятие копии", () => {
  const source = fakeSource({
    bot_settings: {
      columns: [
        { name: "key", type: "text", notNull: true },
        { name: "value", type: "text", notNull: true },
      ],
      pk: ["key"],
      rows: [{ key: "timezone", value: "Europe/Moscow" }],
    },
  });

  let dir = "";

  before(() => {
    dir = tempDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("дамп записывается в каталог под именем по маске", async () => {
    const at = new Date(2026, 8, 26, 14, 5, 9);
    const result = await createDatabaseBackup({ source, dir, now: at, usePgDump: false });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.fileName, "atk_backup_2026-09-26_14-05-09.sql.gz");
    assert.equal(result.mode, "table-export");
    assert.equal(result.tables, 1);
    assert.ok(result.sizeBytes > 0, "пустой дамп бесполезен");
    assert.ok(existsSync(path.join(dir, result.fileName as string)) || existsSync(result.path));
  });

  test("файл читается и содержит данные, а не только заголовок", async () => {
    const at = new Date(2026, 8, 26, 15, 5, 9);
    const result = await createDatabaseBackup({ source, dir, now: at, usePgDump: false });
    assert.equal(result.ok, true);

    // Дамп сжат gzip — распаковываем так же, как это сделает администратор
    const raw = readFileSync(result.path);
    const { gunzipSync } = await import("node:zlib");
    const sql = gunzipSync(raw).toString("utf8");

    assert.match(sql, /CREATE TABLE "bot_settings"/);
    assert.match(sql, /timezone\tEurope\/Moscow/);
  });

  test("создание копии подчищает файлы старше срока хранения", async () => {
    const oldDir = tempDir();
    try {
      const stale = touchBackup(oldDir, new Date(2020, 0, 1, 10, 0, 0));
      const at = new Date(2026, 8, 26, 16, 0, 0);

      const result = await createDatabaseBackup({ source, dir: oldDir, now: at, usePgDump: false });

      assert.equal(result.ok, true, result.error);
      assert.ok(!existsSync(path.join(oldDir, stale)), "старая копия должна быть удалена");
      assert.equal(listBackups(oldDir).length, 1, "в каталоге должна остаться только новая копия");
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  test("сбой источника не оставляет пустой файл-обманку", async () => {
    const badDir = tempDir();
    try {
      const broken: BackupQuerySource = {
        query: async () => {
          throw new Error("база недоступна");
        },
      };
      const result = await createDatabaseBackup({ source: broken, dir: badDir, usePgDump: false });

      assert.equal(result.ok, false);
      assert.match(String(result.error), /база недоступна/);
      // Файл не должен появиться: иначе панель показала бы «копия есть» там,
      // где восстанавливать нечего.
      assert.equal(listBackups(badDir).length, 0);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});

describe("listBackups — список копий для панели", () => {
  let dir = "";

  before(() => {
    dir = tempDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("отсутствие каталога — пустой список, а не ошибка", () => {
    assert.deepEqual(listBackups(path.join(dir, "нет-каталога")), []);
  });

  test("файл отдаётся с размером в МБ, временем и признаком готовности", () => {
    touchBackup(dir, new Date(2026, 8, 20, 10, 0, 0), 1024 * 1024 * 2);

    const [file] = listBackups(dir);
    assert.ok(file);
    assert.equal(file.name, `${BACKUP_FILE_PREFIX}2026-09-20_10-00-00.sql`);
    assert.equal(file.sizeBytes, 1024 * 1024 * 2);
    assert.equal(file.sizeMb, 2);
    assert.equal(file.compressed, false);
    assert.equal(file.ready, true);
  });

  test("копии сортируются от свежей к старой", () => {
    const freshDir = tempDir();
    try {
      touchBackup(freshDir, new Date(2026, 8, 10, 10, 0, 0));
      touchBackup(freshDir, new Date(2026, 8, 26, 10, 0, 0));
      touchBackup(freshDir, new Date(2026, 8, 18, 10, 0, 0));

      const names = listBackups(freshDir).map((f) => f.name);
      assert.deepEqual(names, [
        `${BACKUP_FILE_PREFIX}2026-09-26_10-00-00.sql`,
        `${BACKUP_FILE_PREFIX}2026-09-18_10-00-00.sql`,
        `${BACKUP_FILE_PREFIX}2026-09-10_10-00-00.sql`,
      ]);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("пустой файл помечается как неготовый", () => {
    const emptyDir = tempDir();
    try {
      touchBackup(emptyDir, new Date(2026, 8, 26, 10, 0, 0), 0);
      const [file] = listBackups(emptyDir);
      assert.ok(file);
      assert.equal(file.ready, false, "пустую копию нельзя считать готовой");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("посторонние файлы в каталоге не показываются", () => {
    const otherDir = tempDir();
    try {
      writeFileSync(path.join(otherDir, "notes.txt"), "не копия");
      writeFileSync(path.join(otherDir, "atk_backup_manual.sql"), "не копия");
      assert.deepEqual(listBackups(otherDir), []);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Политика очистки                                                    */
/* ------------------------------------------------------------------ */

describe("Политика очистки: что удаляется, что остаётся навсегда", () => {
  test("значимые категории журнала не обрезаются по сроку", () => {
    // Вход в панель и кабинет: по нему разбирают «кто зашёл под чужим позывным»
    assert.equal(isPrunableLogCategory("auth"), false);
    assert.equal(isPrunableLogCategory("login"), false);
    // Правки состава, настроек и выкладок видны пользователям, вопрос «кто
    // поменял» возникает и через полгода
    assert.equal(isPrunableLogCategory("edit"), false);
  });

  test("служебные записи обрезаются", () => {
    assert.equal(isPrunableLogCategory("system"), true);
    assert.equal(isPrunableLogCategory("sync"), true);
    assert.equal(isPrunableLogCategory(null), true);
    assert.equal(isPrunableLogCategory(""), true);
  });

  test("категория сравнивается без учёта регистра", () => {
    assert.equal(isPrunableLogCategory("AUTH"), false);
    assert.equal(isPrunableLogCategory("Edit"), false);
  });

  test("список критических категорий не пуст и совпадает с проверкой", () => {
    assert.ok(AUDIT_CRITICAL_CATEGORIES.length >= 3);
    for (const category of AUDIT_CRITICAL_CATEGORIES) {
      assert.equal(isPrunableLogCategory(category), false, `${category} должна быть защищена`);
    }
  });

  test("срок хранения аудита — 60 дней", () => {
    assert.equal(AUDIT_RETENTION_DAYS, 60);
  });

  test("граница срока считается от переданного момента", () => {
    const now = new Date(2026, 8, 26, 12, 0, 0);
    const cutoff = auditCutoff(now);
    const days = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    assert.equal(Math.round(days), 60);
  });

  test("некорректный срок заменяется значением по умолчанию", () => {
    const now = new Date(2026, 8, 26, 12, 0, 0);
    for (const bad of [0, -5, NaN]) {
      const days = (now.getTime() - auditCutoff(now, bad).getTime()) / (24 * 60 * 60 * 1000);
      assert.equal(Math.round(days), AUDIT_RETENTION_DAYS, `срок ${bad} должен быть отклонён`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Очистка: сессии, журнал, ограничители входа                         */
/* ------------------------------------------------------------------ */

/** Подставное хранилище: считает, что именно и с какой границей удалили */
function fakeStore(overrides: Partial<MaintenanceStore> = {}): MaintenanceStore & {
  sessionCalls: Date[];
  logCalls: Date[];
} {
  const sessionCalls: Date[] = [];
  const logCalls: Date[] = [];
  return {
    sessionCalls,
    logCalls,
    async deleteExpiredSessions(now) {
      sessionCalls.push(now);
      return 3;
    },
    async deleteOldAuditLogs(cutoff) {
      logCalls.push(cutoff);
      return 12;
    },
    ...overrides,
  };
}

describe("pruneExpiredSessionsAndLogs — очистка устаревших данных", () => {
  test("удаляет сессии и старый незначительный журнал, возвращает счётчики", async () => {
    const store = fakeStore();
    const now = new Date(2026, 8, 26, 12, 0, 0);

    const result = await pruneExpiredSessionsAndLogs({ store, now });

    assert.equal(result.ok, true);
    assert.equal(result.sessions, 3);
    assert.equal(result.logs, 12);
    assert.equal(result.retentionDays, AUDIT_RETENTION_DAYS);
    assert.equal(result.ranAt, now.toISOString());

    // Граница журнала передаётся из политики, а не считается в хранилище:
    // иначе срок хранения разошёлся бы в двух местах
    assert.equal(store.logCalls.length, 1);
    const expectedCutoff = auditCutoff(now, AUDIT_RETENTION_DAYS).getTime();
    assert.equal(store.logCalls[0].getTime(), expectedCutoff);
  });

  test("сбой удаления сессий не отменяет очистку журнала", async () => {
    const store = fakeStore({
      deleteExpiredSessions: async () => {
        throw new Error("таблица сессий заблокирована");
      },
    });

    const result = await pruneExpiredSessionsAndLogs({ store });

    assert.equal(result.ok, false);
    assert.equal(result.sessions, 0, "счётчик сессий остаётся нулевым");
    assert.equal(result.logs, 12, "журнал должен быть очищен несмотря на сбой");
    assert.match(String(result.error), /сессии/);
  });

  test("сбой удаления журнала не мешает очистке сессий", async () => {
    const store = fakeStore({
      deleteOldAuditLogs: async () => {
        throw new Error("журнал занят");
      },
    });

    const result = await pruneExpiredSessionsAndLogs({ store });

    assert.equal(result.ok, false);
    assert.equal(result.sessions, 3);
    assert.equal(result.logs, 0);
    assert.match(String(result.error), /журнал/);
  });

  test("оба сбоя попадают в сообщение, а не теряются", async () => {
    const store: MaintenanceStore = {
      deleteExpiredSessions: async () => {
        throw new Error("первая ошибка");
      },
      deleteOldAuditLogs: async () => {
        throw new Error("вторая ошибка");
      },
    };

    const result = await pruneExpiredSessionsAndLogs({ store });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /первая ошибка/);
    assert.match(String(result.error), /вторая ошибка/);
  });

  test("переданный срок хранения используется вместо значения по умолчанию", async () => {
    const store = fakeStore();
    const now = new Date(2026, 8, 26, 12, 0, 0);

    await pruneExpiredSessionsAndLogs({ store, now, retentionDays: 30 });

    const expectedCutoff = auditCutoff(now, 30).getTime();
    assert.equal(store.logCalls[0].getTime(), expectedCutoff);
  });
});

describe("Срок действия сессии", () => {
  test("сессия с прошедшей датой считается истёкшей", () => {
    const now = new Date(2026, 8, 26, 12, 0, 0);
    assert.equal(isSessionExpired(new Date(2026, 8, 26, 11, 59, 59), now), true);
  });

  test("действующая сессия не удаляется", () => {
    const now = new Date(2026, 8, 26, 12, 0, 0);
    assert.equal(isSessionExpired(new Date(2026, 8, 26, 12, 0, 1), now), false);
    assert.equal(isSessionExpired(new Date(2026, 8, 27, 12, 0, 0), now), false);
  });

  test("ровно текущий момент — уже истёкшая (граница не в пользу сессии)", () => {
    const now = new Date(2026, 8, 26, 12, 0, 0);
    assert.equal(isSessionExpired(new Date(now.getTime()), now), true);
  });
});

describe("Очистка ограничителей входа (записи в памяти процесса)", () => {
  test("снятая блокировка старше суток удаляется", () => {
    const throttle = new LoginThrottle(5, 60_000);
    const dayMs = 24 * 60 * 60 * 1000;
    const now = 10 * dayMs;

    throttle.registerFailure("ip:гром", now - dayMs - 1000);
    assert.equal(throttle.size, 1);

    assert.equal(throttle.pruneExpired(now), 1);
    assert.equal(throttle.size, 0);
  });

  test("действующая блокировка сохраняется — иначе снялась бы защита", () => {
    const throttle = new LoginThrottle(5, 30 * 60 * 1000);
    const now = 10 * 24 * 60 * 60 * 1000;

    // Блокировка выдана «сейчас» и живёт 30 минут, хотя запись пришла давно
    throttle.registerFailure("ip:скиф", now);
    for (let i = 0; i < 4; i++) throttle.registerFailure("ip:скиф", now);
    assert.equal(throttle.check("ip:скиф", now).locked, true);

    assert.equal(throttle.pruneExpired(now), 0);
    assert.equal(throttle.check("ip:скиф", now).locked, true, "блокировка должна остаться");
  });

  test("свежие записи не трогаются", () => {
    const throttle = new LoginThrottle(5, 30 * 60 * 1000);
    const now = Date.now();
    throttle.registerFailure("ip:новый", now);

    assert.equal(throttle.pruneExpired(now), 0);
    assert.equal(throttle.size, 1);
  });

  test("очистка идёт через реестр: роут не остаётся в стороне", async () => {
    // Роуты создают ограничитель через registerThrottle, иначе очистка из
    // панели не дотянулась бы до их счетчиков.
    const dayMs = 24 * 60 * 60 * 1000;
    const throttle = registerThrottle(new LoginThrottle(5, 60_000));
    const now = Date.now();
    throttle.registerFailure("ip:забытый", now - dayMs - 1000);

    const store = fakeStore();
    const result = await pruneExpiredSessionsAndLogs({ store, now: new Date(now) });

    assert.ok(result.throttles >= 1, "очистка должна затронуть хотя бы эту запись");
    assert.equal(throttle.size, 0, "запись в реестре должна быть удалена");
  });
});

/* ------------------------------------------------------------------ */
/* Состояние: статусы, диск, сводка                                    */
/* ------------------------------------------------------------------ */

describe("Статус синхронизации: разбор значения из настроек", () => {
  test("«ok»/«success» — синхронизировано", () => {
    assert.equal(readSyncStatus("ok"), "ok");
    assert.equal(readSyncStatus("success"), "ok");
    assert.equal(readSyncStatus("OK"), "ok");
  });

  test("«error»/«failed» — ошибка", () => {
    assert.equal(readSyncStatus("error"), "error");
    assert.equal(readSyncStatus("failed"), "error");
  });

  test("пустое или неизвестное значение — «ещё не запускалась»", () => {
    // Мусор в настройке не должен выглядеть как успешная синхронизация
    for (const value of ["", null, undefined, "что-то"]) {
      assert.equal(readSyncStatus(value), "never");
    }
  });

  test("подписи и цвета бейджей соответствуют ТЗ", () => {
    assert.equal(syncStatusLabel("ok"), "Синхронизировано");
    assert.equal(syncStatusLabel("error"), "Ошибка");
    assert.equal(syncStatusBadgeClass("ok"), "badge-green");
    assert.equal(syncStatusBadgeClass("error"), "badge-red");
    assert.equal(syncStatusBadgeClass("never"), "badge-amber");
  });

  test("ключи метаданных названы так, как требует ТЗ", () => {
    assert.equal(MAINTENANCE_KEYS.lastSheetSyncAt, "last_sheet_sync_at");
    assert.equal(MAINTENANCE_KEYS.lastSyncStatus, "last_sync_status");
    assert.equal(MAINTENANCE_KEYS.lastBackupAt, "last_backup_at");
  });
});

describe("diskUsage — оценка занятого места", () => {
  test("суммирует размер файлов и считает их количество", () => {
    const usage = diskUsage(
      ".",
      [
        { name: "a", path: "a", sizeBytes: 1024 * 1024, sizeMb: 1, createdAt: "", compressed: false, ready: true },
        { name: "b", path: "b", sizeBytes: 1024 * 1024 * 2, sizeMb: 2, createdAt: "", compressed: true, ready: true },
      ]
    );
    assert.equal(usage.backupsCount, 2);
    assert.equal(usage.backupsMb, 3);
    assert.equal(usage.dir, ".");
  });

  test("пустой список — нули, а не ошибка", () => {
    const usage = diskUsage(".", []);
    assert.equal(usage.backupsCount, 0);
    assert.equal(usage.backupsMb, 0);
  });

  test("раздел опрашивается и даёт свободное место (если доступен)", () => {
    const usage = diskUsage(".", []);
    // На диске без statfs (сетевой том) значения null — это допустимо,
    // но когда раздел доступен, «н/д» показывать нельзя.
    if (usage.freeMb !== null) {
      assert.ok(usage.freeMb > 0, "свободное место должно быть положительным");
      assert.ok(usage.usedPercent !== null && usage.usedPercent >= 0 && usage.usedPercent <= 100);
    }
  });

  test("недоступный каталог не роняет оценку", () => {
    const usage = diskUsage(path.join(tmpdir(), "нет-такого-раздела-atk"), []);
    assert.equal(usage.freeMb, null);
    assert.equal(usage.usedPercent, null);
  });
});

describe("getMaintenanceHealth — сводка для карточки панели", () => {
  test("сводка собирается из настроек и списка копий", async () => {
    const dir = tempDir();
    try {
      touchBackup(dir, new Date(2026, 8, 26, 10, 0, 0), 1024);

      const settings = new Map<string, string>([
        [MAINTENANCE_KEYS.lastSheetSyncAt, "2026-09-26T10:00:00.000Z"],
        [MAINTENANCE_KEYS.lastSyncStatus, "ok"],
        [MAINTENANCE_KEYS.lastBackupAt, "2026-09-26T10:00:00.000Z"],
        [MAINTENANCE_KEYS.lastBackupFile, "atk_backup_2026-09-26_10-00-00.sql (0.00 МБ)"],
        [MAINTENANCE_KEYS.lastPruneAt, "2026-09-25T03:00:00.000Z"],
      ]);

      const health = await getMaintenanceHealth({ dir, settings });

      assert.equal(health.ok, true);
      assert.equal(health.database, true);
      assert.equal(health.lastSyncStatus, "ok");
      assert.equal(health.lastSyncLabel, "Синхронизировано");
      assert.equal(health.lastSyncAt, "2026-09-26T10:00:00.000Z");
      assert.equal(health.lastBackupAt, "2026-09-26T10:00:00.000Z");
      assert.match(String(health.lastBackupFile), /atk_backup_2026-09-26/);
      assert.equal(health.lastPruneAt, "2026-09-25T03:00:00.000Z");
      assert.equal(health.backups.length, 1);
      assert.equal(health.disk.backupsCount, 1);
      assert.deepEqual(health.warnings, []);
      assert.ok(health.uptimeSec >= 0);
      assert.ok(health.retentionDays >= 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("пустые настройки — состояние «ещё не запускалась», без ошибок", async () => {
    const dir = tempDir();
    try {
      const health = await getMaintenanceHealth({ dir, settings: new Map<string, string>() });

      assert.equal(health.lastSyncStatus, "never");
      assert.equal(health.lastSyncLabel, "Ещё не запускалась");
      assert.equal(health.lastSyncAt, null);
      assert.equal(health.lastBackupAt, null);
      assert.equal(health.lastBackupFile, null);
      assert.deepEqual(health.backups, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("отсутствующий каталог копий не превращается в ошибку сервера", async () => {
    const health = await getMaintenanceHealth({
      dir: path.join(tmpdir(), "atk-нет-каталога"),
      settings: new Map<string, string>(),
    });
    assert.equal(health.ok, true);
    assert.deepEqual(health.backups, []);
  });
});

/* ------------------------------------------------------------------ */
/* Изоляция ошибок синхронизации ШДС                                   */
/* ------------------------------------------------------------------ */

describe("runSheetSync — ошибка Google не роняет приложение", () => {
  test("недоступный Google даёт ok:false и статус error, но не бросает", async () => {
    // Настройки сервисного аккаунта пусты и файла-паспорта нет: getDoc() внутри
    // syncShdsRoster бросает ошибку — ровно тот случай, когда внешний сервис
    // «не отвечает», и процесс не должен упасть.
    const result = await runSheetSync("test");

    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    assert.equal(result.updated, 0);
    assert.ok(result.detail.length > 0, "администратору нужна причина, а не пустое сообщение");
    assert.ok(result.error, "ошибка должна быть заполнена для журнала");
  });

  test("функция никогда не выбрасывает исключение наружу", async () => {
    // Проверяем именно контракт «никогда не reject»: вызывающий код
    // (роут и планировщик) на него опирается.
    await assert.doesNotReject(async () => {
      await runSheetSync("test");
    });
  });

  test("цикл обслуживания переживает недоступную синхронизацию", async () => {
    // Источник ошибки не важен: цикл ловит любой сбой задачи и продолжает.
    const report = await runMaintenanceCycle({
      force: { sheetSync: true },
      now: new Date(2026, 8, 26, 12, 0, 0),
    });

    assert.ok(Array.isArray(report.errors));
    // Цикл вернул отчёт, а не упал: именно это требуется от фоновой задачи
    assert.equal(typeof report.sheetSync, "boolean");
  });
});

/* ------------------------------------------------------------------ */
/* Доступ: RBAC и CSRF                                                 */
/* ------------------------------------------------------------------ */

/** Запрос к роуту обслуживания: те же заголовки, что шлёт браузер панели */
function maintenanceRequest(
  path: string,
  options: { method?: string; cookie?: string; origin?: string; fetchSite?: string } = {}
): NextRequest {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  headers.set("host", "panel.example");

  return new NextRequest(new URL(path, "http://panel.example"), {
    method: options.method ?? "GET",
    headers,
  });
}

/** Читает JSON-ответ роута и его код */
async function readResponse(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

describe("RBAC: обслуживание доступно только администратору", () => {
  test("роль admin допускается, все прочие — нет", () => {
    assert.equal(canManageMaintenance("admin"), true);
    for (const role of ["officer", "member", "recruit", "guest", "", null, undefined, "Admin"]) {
      assert.equal(canManageMaintenance(role), false, `роль «${role}» не должна иметь доступ`);
    }
  });

  test("в списке допущенных ролей только администратор", () => {
    assert.deepEqual([...MAINTENANCE_ROLES], ["admin"]);
  });

  test("матрица решений: админ допускается в любой сессии, остальные — 403", () => {
    // Админ панели
    assert.equal(maintenanceDecision("admin", undefined), "allow");
    // Админ кабинета бойца
    assert.equal(maintenanceDecision(undefined, "admin"), "allow");
    // Командир панели и командир кабинета: вошли, но прав на обслуживание нет
    assert.equal(maintenanceDecision("officer", undefined), "forbidden");
    assert.equal(maintenanceDecision(undefined, "officer"), "forbidden");
    assert.equal(maintenanceDecision(undefined, "member"), "forbidden");
    assert.equal(maintenanceDecision(undefined, "recruit"), "forbidden");
    // Гость панели: сессия есть, роли штаба нет
    assert.equal(maintenanceDecision("guest", undefined), "forbidden");
    // Сессий нет вовсе
    assert.equal(maintenanceDecision(undefined, undefined), "unauthenticated");
  });

  test("рядовой боец получает 403, а не 401 (он вошёл, но не админ)", async () => {
    const req = maintenanceRequest("/api/admin/maintenance/backup", { method: "POST" });
    const auth = await requireMaintenance(req, {
      panel: async () => null,
      member: async () => ({ role: "member", callsign: "Гром" }) as never,
    });

    assert.equal(auth.ok, false);
    if (!auth.ok) {
      assert.equal(auth.response.status, 403, "требование ТЗ: рядовому бойцу — 403 Forbidden");
    }
  });

  test("командир панели тоже получает 403", async () => {
    const req = maintenanceRequest("/api/admin/maintenance", { method: "GET" });
    const auth = await requireMaintenance(req, {
      panel: async () => ({ role: "officer", username: "commander" }),
    });

    assert.equal(auth.ok, false);
    if (!auth.ok) assert.equal(auth.response.status, 403);
  });

  test("администратор получает доступ и подпись для журнала", async () => {
    const req = maintenanceRequest("/api/admin/maintenance", { method: "GET" });
    const auth = await requireMaintenance(req, {
      panel: async () => ({ role: "admin", username: "Куратор" }),
    });

    assert.equal(auth.ok, true);
    if (auth.ok) assert.equal(auth.username, "Куратор");
  });

  test("запрос без сессии получает 401 на всех четырёх роутах", async () => {
    const routes = [
      { name: "GET состояния", method: "GET", fn: getMaintenance },
      { name: "backup", method: "POST", fn: postBackup },
      { name: "sync", method: "POST", fn: postSync },
      { name: "prune", method: "POST", fn: postPrune },
    ];

    for (const route of routes) {
      const req = maintenanceRequest("/api/admin/maintenance", { method: route.method });
      const { status } = await readResponse(await route.fn(req));
      assert.equal(status, 401, `роут ${route.name} должен требовать авторизацию`);
    }
  });

  test("межсайтовый POST к обслуживанию отклоняется (CSRF)", async () => {
    const req = maintenanceRequest("/api/admin/maintenance/backup", {
      method: "POST",
      origin: "http://evil.example",
    });
    const auth = await requireMaintenance(req, {
      panel: async () => ({ role: "admin", username: "Куратор" }),
    });

    assert.equal(auth.ok, false);
    if (!auth.ok) {
      assert.equal(auth.response.status, 403);
      const body = (await auth.response.json()) as { error?: string };
      assert.match(String(body.error), /чужого источника/);
    }
  });

  test("CSRF-проверка не мешает своему сайту: администратор проходит", async () => {
    const req = maintenanceRequest("/api/admin/maintenance/backup", {
      method: "POST",
      origin: "http://panel.example",
      fetchSite: "same-origin",
    });
    const auth = await requireMaintenance(req, {
      panel: async () => ({ role: "admin", username: "Куратор" }),
    });

    assert.equal(auth.ok, true);
  });

  test("проверка источника не применяется к GET: чтение состояния безопасно", async () => {
    const req = maintenanceRequest("/api/admin/maintenance", {
      method: "GET",
      origin: "http://evil.example",
    });
    const auth = await requireMaintenance(req, {
      panel: async () => ({ role: "admin", username: "Куратор" }),
    });

    assert.equal(auth.ok, true, "GET состояние не меняет, поэтому источник не проверяем");
  });

  test("межсайтовый запрос от рядового бойца отклоняется по правам, а не по источнику", async () => {
    // Важно для безопасности: по тексту ответа нельзя выяснить, кто админ.
    const req = maintenanceRequest("/api/admin/maintenance/backup", {
      method: "POST",
      origin: "http://evil.example",
    });
    const auth = await requireMaintenance(req, {
      member: async () => ({ role: "member", callsign: "Гром" }) as never,
    });

    assert.equal(auth.ok, false);
    if (!auth.ok) {
      const body = (await auth.response.json()) as { error?: string };
      assert.match(String(body.error), /Недостаточно прав/);
    }
  });

  test("межсайтовый запрос без сессии получает 401", async () => {
    const req = maintenanceRequest("/api/admin/maintenance/backup", {
      method: "POST",
      origin: "http://evil.example",
    });
    const auth = await requireMaintenance(req, { panel: async () => null, member: async () => null });

    assert.equal(auth.ok, false);
    if (!auth.ok) assert.equal(auth.response.status, 401);
  });

  test("сбой доступа к БД даёт 503, а не «нет прав»", async () => {
    const req = maintenanceRequest("/api/admin/maintenance", { method: "GET" });
    const auth = await requireMaintenance(req, {
      panel: async () => {
        throw new Error("connection refused");
      },
    });

    assert.equal(auth.ok, false);
    if (!auth.ok) assert.equal(auth.response.status, 503);
  });

  test("предикат источника: чужой Origin и cross-site отсекаются", () => {
    assert.equal(
      isCrossSiteRequest(
        maintenanceRequest("/api/admin/maintenance/backup", {
          method: "POST",
          origin: "http://evil.example",
        })
      ),
      true
    );
    assert.equal(
      isCrossSiteRequest(
        maintenanceRequest("/api/admin/maintenance/backup", {
          method: "POST",
          fetchSite: "cross-site",
        })
      ),
      true
    );
    // Поддомен — тоже другой сайт
    assert.equal(
      isCrossSiteRequest(
        maintenanceRequest("/api/admin/maintenance", { origin: "http://evil.panel.example" })
      ),
      true
    );
  });

  test("предикат источника: свой сайт и не-браузерный клиент пропускаются", () => {
    assert.equal(
      isCrossSiteRequest(maintenanceRequest("/api/admin/maintenance", { origin: "http://panel.example" })),
      false
    );
    assert.equal(
      isCrossSiteRequest(maintenanceRequest("/api/admin/maintenance", { fetchSite: "same-origin" })),
      false
    );
    assert.equal(
      isCrossSiteRequest(maintenanceRequest("/api/admin/maintenance", { fetchSite: "same-site" })),
      false
    );
    // curl и скрипты мониторинга заголовков Origin/Sec-Fetch-Site не шлют
    assert.equal(isCrossSiteRequest(maintenanceRequest("/api/admin/maintenance")), false);
  });

  test("проверка источника применяется только к методам, меняющим состояние", () => {
    assert.equal(isUnsafeMethod("POST"), true);
    assert.equal(isUnsafeMethod("put"), true);
    assert.equal(isUnsafeMethod("PATCH"), true);
    assert.equal(isUnsafeMethod("DELETE"), true);
    assert.equal(isUnsafeMethod("GET"), false);
    assert.equal(isUnsafeMethod("HEAD"), false);
  });

  test("нечитаемый Origin считается подозрительным, а не пропускается", () => {
    // Значение заголовка обязано быть латинским (ByteString), поэтому
    // «нечитаемый» Origin задаём строкой без схемы — именно так выглядит
    // подделка от не-браузерного клиента.
    const req = new NextRequest(new URL("http://panel.example/api/admin/maintenance"), {
      method: "POST",
      headers: { origin: "panel.example", host: "panel.example" },
    });
    assert.equal(isCrossSiteRequest(req), true, "Origin без схемы не разбирается — отказ");
  });
});

/* ------------------------------------------------------------------ */
/* Роуты и планировщик: контракт                                        */
/* ------------------------------------------------------------------ */

describe("Роуты обслуживания: контракт администратора", () => {
  test("роуты объявляют обязательные экспорты и работают на узле, а не в edge", async () => {
    const modules = [
      { name: "состояние", mod: await import("../src/app/api/admin/maintenance/route.ts") },
      { name: "backup", mod: await import("../src/app/api/admin/maintenance/backup/route.ts") },
      { name: "sync", mod: await import("../src/app/api/admin/maintenance/sync/route.ts") },
      { name: "prune", mod: await import("../src/app/api/admin/maintenance/prune/route.ts") },
    ];

    for (const { name, mod } of modules) {
      assert.equal(mod.runtime, "nodejs", `роут ${name} использует Node-модули (fs, child_process)`);
      assert.equal(typeof mod.dynamic, "string", `роут ${name} должен быть динамическим`);
    }
  });

  test("POST-роуты не отдают 200 без сессии — ни один", async () => {
    // 200 означал бы, что кнопка обслуживания доступна анонимно
    const posts = [postBackup, postSync, postPrune];
    for (const handler of posts) {
      const req = maintenanceRequest("/api/admin/maintenance/backup", { method: "POST" });
      const { status } = await readResponse(await handler(req));
      assert.notEqual(status, 200);
    }
  });
});

describe("Планировщик обслуживания: запуск", () => {
  test("стартует один раз и не дублирует таймеры при повторном вызове", () => {
    // Флаг в globalThis: instrumentation.ts выполняется на каждый инстанс, и без
    // защиты интервалы удвоились бы (двойные копии, двойная ротация).
    const before = globalThis.__atkMaintenanceStarted;
    try {
      globalThis.__atkMaintenanceStarted = undefined;
      startMaintenanceScheduler();
      assert.equal(globalThis.__atkMaintenanceStarted, true);
      // Повторный вызов ничего не меняет и не бросает
      startMaintenanceScheduler();
      assert.equal(globalThis.__atkMaintenanceStarted, true);
    } finally {
      globalThis.__atkMaintenanceStarted = before;
    }
  });

  test("интервалы задач разумны: синхронизация чаще, чем суточные операции", () => {
    assert.ok(SHEET_SYNC_INTERVAL_MS <= BACKUP_INTERVAL_MS);
    assert.ok(BACKUP_INTERVAL_MS === 24 * 60 * 60 * 1000);
    assert.ok(PRUNE_INTERVAL_MS === 24 * 60 * 60 * 1000);
    assert.ok(MAINTENANCE_TICK_MS <= SHEET_SYNC_INTERVAL_MS);
  });

  test("прогноз показывает, когда запустится каждая задача", () => {
    const now = Date.now();
    const map = new Map<string, string>([
      [MAINTENANCE_KEYS.lastSheetSyncAt, new Date(now - 60_000).toISOString()],
      [MAINTENANCE_KEYS.lastBackupAt, new Date(now - 60_000).toISOString()],
    ]);

    const schedule = maintenanceSchedule(map, now);

    assert.ok(schedule.sheetSyncIn > 0 && schedule.sheetSyncIn <= SHEET_SYNC_INTERVAL_MS);
    assert.ok(schedule.backupIn > 0 && schedule.backupIn <= BACKUP_INTERVAL_MS);
    // Очистка ещё не запускалась — она нужна немедленно
    assert.equal(schedule.pruneIn, 0);
  });
});