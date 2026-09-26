/**
 * Обслуживание системы: сроки хранения, очистка и сводка состояния.
 *
 * Зачем отдельный модуль: правила «что и когда удаляем» и «что показываем в
 * панели» должны быть проверяемы без базы и без файловой системы — ошибка в них
 * приводит либо к потере аудита, либо к переполнению диска, а заметить это по
 * факту уже поздно. Поэтому здесь чистая политика (сроки, критические
 * категории, сборка сводки), а обращения к БД и диску вынесены в тонкие
 * обёртки с подстановкой хранилища в тестах.
 */
import { statfsSync } from "node:fs";
import { and, lt, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { logs, memberSessions } from "@/db/schema";
import { backupDir, listBackups, retentionDaysFromEnv, type BackupFile } from "@/lib/backup";
import { getSettings, setSettingQuiet } from "@/lib/settings";
import { pruneRegisteredThrottles } from "@/lib/throttle-registry";

/**
 * Метаданные обслуживания в bot_settings.
 *
 * Лежат в настройках, а не в bot_logs: карточке панели нужно последнее
 * значение каждого показателя, а журнал хранит историю и обрезается по сроку —
 * «последняя синхронизация» из него однажды исчезла бы.
 */
export const MAINTENANCE_KEYS = {
  /** Когда последний раз синхронизировали состав с Google Таблицей */
  lastSheetSyncAt: "last_sheet_sync_at",
  /** Итог последней синхронизации ШДС: short-код состояния */
  lastSyncStatus: "last_sync_status",
  /** Когда снята последняя резервная копия */
  lastBackupAt: "last_backup_at",
  /** Имя и размер последней копии (для подписи в карточке) */
  lastBackupFile: "last_backup_file",
  /** Когда последний раз чистили сессии и журнал */
  lastPruneAt: "last_prune_at",
} as const;

/** Итог синхронизации: отображается бейджем в карточке */
export type SyncStatus = "ok" | "error" | "never";

/** Статус синхронизации по значению настройки */
export function readSyncStatus(value: string | null | undefined): SyncStatus {
  const v = (value || "").trim().toLowerCase();
  if (v === "ok" || v === "success") return "ok";
  if (v === "error" || v === "failed") return "error";
  return "never";
}

/** Подпись состояния для интерфейса */
export function syncStatusLabel(status: SyncStatus): string {
  if (status === "ok") return "Синхронизировано";
  if (status === "error") return "Ошибка";
  return "Ещё не запускалась";
}

/** CSS-класс бейджа: зелёный/красный/приглушённый */
export function syncStatusBadgeClass(status: SyncStatus): string {
  if (status === "ok") return "badge-green";
  if (status === "error") return "badge-red";
  return "badge-amber";
}

/* ------------------------------------------------------------------ */
/* Политика хранения                                                   */
/* ------------------------------------------------------------------ */

/**
 * Срок хранения незначительных записей аудита, дней.
 *
 * 60 дней — компромисс: журнал используется для разбора инцидентов за последние
 * недели, а таблица растёт от каждого пинга и синхронизации. Значимые записи
 * (вход, изменение состава и настроек) не удаляются вообще — см. ниже.
 */
export const AUDIT_RETENTION_DAYS = 60;

/**
 * Категории, которые НЕ обрезаются по сроку.
 *
 * `auth`/`login` — входы в панель и кабинет: по ним разбирают «кто зашёл под
 * чужой учётной записью», и потерять их значит потерять саму возможность
 * расследования. `edit` — правки состава, настроек и выкладок: изменения
 * видимы пользователям, и вопрос «кто это поменял» возникает и через полгода.
 */
export const AUDIT_CRITICAL_CATEGORIES = ["auth", "login", "edit"] as const;

/** Обрезается ли категория журнала по сроку хранения */
export function isPrunableLogCategory(category: string | null | undefined): boolean {
  const c = (category || "system").trim().toLowerCase();
  return !(AUDIT_CRITICAL_CATEGORIES as readonly string[]).includes(c);
}

/** Момент, раньше которого незначительные записи журнала удаляются */
export function auditCutoff(now: Date = new Date(), retentionDays: number = AUDIT_RETENTION_DAYS): Date {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : AUDIT_RETENTION_DAYS;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Истёк ли срок действия сессии на момент проверки */
export function isSessionExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/* ------------------------------------------------------------------ */
/* Хранилище: обращения к БД и диску                                   */
/* ------------------------------------------------------------------ */

/**
 * Хранилище сведений обслуживания.
 *
 * Интерфейс нужен, чтобы тест проверял политику очистки, не поднимая базу:
 * подставляется подставной объект, а боевой код остаётся ровно тем же.
 */
export type MaintenanceStore = {
  /** Удаляет сессии бойцов с истёкшим сроком, возвращает число удалённых */
  deleteExpiredSessions: (now: Date) => Promise<number>;
  /** Удаляет незначительные записи журнала старше cutoff */
  deleteOldAuditLogs: (cutoff: Date) => Promise<number>;
};

/** Боевое хранилище поверх drizzle */
export const dbMaintenanceStore: MaintenanceStore = {
  async deleteExpiredSessions(now) {
    const removed = await db
      .delete(memberSessions)
      .where(lt(memberSessions.expiresAt, now))
      .returning({ id: memberSessions.id });
    return removed.length;
  },
  async deleteOldAuditLogs(cutoff) {
    // Категория значимой записи хранится текстом (varchar), поэтому фильтр
    // «не критичное» выражен через notInArray: сравнение идёт в БД, а не в
    // приложении — иначе пришлось бы вытянуть всю таблицу в память.
    const removed = await db
      .delete(logs)
      .where(and(lt(logs.createdAt, cutoff), notInArray(logs.category, [...AUDIT_CRITICAL_CATEGORIES])))
      .returning({ id: logs.id });
    return removed.length;
  },
};

/** Итог очистки: показывается в карточке панели и пишется в журнал */
export type PruneResult = {
  ok: boolean;
  sessions: number;
  logs: number;
  throttles: number;
  retentionDays: number;
  ranAt: string;
  error?: string;
};

/**
 * Чистит устаревшие сессии, журнал и записи ограничителей входа.
 *
 * Ошибки не пробрасываются: роут обслуживания должен вернуть понятный ответ, а
 * панель — показать, что именно не получилось. Отказ одного шага не отменяет
 * остальные, иначе одно «залипшее» удаление остановило бы всю чистку.
 */
export async function pruneExpiredSessionsAndLogs(
  options: { store?: MaintenanceStore; now?: Date; retentionDays?: number } = {}
): Promise<PruneResult> {
  const now = options.now ?? new Date();
  const store = options.store ?? dbMaintenanceStore;
  const retentionDays = options.retentionDays ?? AUDIT_RETENTION_DAYS;
  const cutoff = auditCutoff(now, retentionDays);

  const result: PruneResult = {
    ok: true,
    sessions: 0,
    logs: 0,
    throttles: 0,
    retentionDays,
    ranAt: now.toISOString(),
  };

  try {
    result.sessions = await store.deleteExpiredSessions(now);
  } catch (e) {
    result.ok = false;
    result.error = `сессии: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    result.logs = await store.deleteOldAuditLogs(cutoff);
  } catch (e) {
    result.ok = false;
    const message = e instanceof Error ? e.message : String(e);
    result.error = result.error ? `${result.error}; журнал: ${message}` : `журнал: ${message}`;
  }

  // Записи ограничителей живут в памяти процесса: без этого шага «очистка
  // устаревших сессий» не снимала бы протухшие блокировки входа.
  result.throttles = pruneRegisteredThrottles(now.getTime());

  try {
    await setSettingQuiet(MAINTENANCE_KEYS.lastPruneAt, result.ranAt);
    await db.insert(logs).values({
      kind: "system",
      title: result.ok ? "Очистка устаревших данных" : "Очистка данных с ошибками",
      detail:
        `Сессий удалено: ${result.sessions}, записей журнала старше ${retentionDays} дн.: ${result.logs}, ` +
        `записей ограничителей входа: ${result.throttles}` +
        (result.error ? `. Ошибки: ${result.error}` : ""),
      ok: result.ok,
      error: result.error ?? null,
    });
  } catch {
    // Журнал не должен срывать саму очистку: данные уже удалены
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Сводка состояния                                                    */
/* ------------------------------------------------------------------ */

/** Оценка занятого места под копии */
export type DiskUsage = {
  /** Суммарный размер копий, МБ */
  backupsMb: number;
  /** Сколько копий лежит в каталоге */
  backupsCount: number;
  /** Каталог копий */
  dir: string;
  /** Свободно на разделе с каталогом, МБ (null — раздел не опросить) */
  freeMb: number | null;
  /** Занято на разделе, % (null — раздел не опросить) */
  usedPercent: number | null;
};

/** Сводка для карточки обслуживания */
export type MaintenanceHealth = {
  /** Состояние процесса: false только при недоступной БД */
  ok: boolean;
  /** Последняя синхронизация ШДС (ISO) или null */
  lastSyncAt: string | null;
  /** Итог последней синхронизации */
  lastSyncStatus: SyncStatus;
  /** Подпись статуса для интерфейса */
  lastSyncLabel: string;
  /** Последняя резервная копия (ISO) или null */
  lastBackupAt: string | null;
  /** Имя и размер последней копии */
  lastBackupFile: string | null;
  /** Когда последний раз чистили данные (ISO) или null */
  lastPruneAt: string | null;
  /** Сколько дней храним копии */
  retentionDays: number;
  /** Сколько дней храним незначительный аудит */
  auditRetentionDays: number;
  /** Список копий */
  backups: BackupFile[];
  /** Занятое место */
  disk: DiskUsage;
  /** Время работы процесса, секунды */
  uptimeSec: number;
  /** Отвечает ли БД */
  database: boolean;
  /** Что именно не сработало (для диагностики) */
  warnings: string[];
};

/** Оценка диска по каталогу копий. Ошибки опроса не роняют сводку */
export function diskUsage(dir: string, backups: BackupFile[]): DiskUsage {
  const backupsMb = Math.round(backups.reduce((sum, f) => sum + f.sizeBytes, 0) / (1024 * 1024) * 100) / 100;
  const base: DiskUsage = {
    backupsMb,
    backupsCount: backups.length,
    dir,
    freeMb: null,
    usedPercent: null,
  };

  try {
    // statfsSync есть и на Windows, и в alpine-образе. Раздел может быть
    // недоступен (сетевой том, ограничения контейнера) — тогда честно отдаём
    // null, а не выдуманный ноль.
    const stats = statfsSync(dir);
    const blockSize = Number(stats.bsize);
    const total = Number(stats.blocks) * blockSize;
    const free = Number(stats.bavail) * blockSize;
    if (total > 0) {
      base.freeMb = Math.round((free / (1024 * 1024)) * 100) / 100;
      base.usedPercent = Math.round(((total - free) / total) * 1000) / 10;
    }
  } catch {
    // Раздел не опросить — оставляем null
  }

  return base;
}

/**
 * Собирает сводку состояния системы.
 *
 * Ни один источник не обязателен: недоступная БД, отсутствующий каталог копий и
 * не заданные настройки дают частичную сводку с предупреждениями, а не ошибку
 * 500. Так администратор видит, что именно сломалось, вместо «сервер ответил
 * ошибкой» — а кнопки обслуживания остаются доступны.
 */
export async function getMaintenanceHealth(
  options: { dir?: string; settings?: Map<string, string> } = {}
): Promise<MaintenanceHealth> {
  const warnings: string[] = [];

  let map = options.settings ?? null;
  let database = true;
  if (!map) {
    try {
      map = await getSettings(true);
    } catch (e) {
      database = false;
      warnings.push(`настройки недоступны: ${e instanceof Error ? e.message : String(e)}`);
      map = new Map<string, string>();
    }
  }

  const dir = options.dir ?? backupDir();
  let backups: BackupFile[] = [];
  try {
    backups = listBackups(dir);
  } catch (e) {
    warnings.push(`каталог копий недоступен: ${e instanceof Error ? e.message : String(e)}`);
  }

  const status = readSyncStatus(map.get(MAINTENANCE_KEYS.lastSyncStatus));

  return {
    ok: database,
    lastSyncAt: map.get(MAINTENANCE_KEYS.lastSheetSyncAt) || null,
    lastSyncStatus: status,
    lastSyncLabel: syncStatusLabel(status),
    lastBackupAt: map.get(MAINTENANCE_KEYS.lastBackupAt) || null,
    lastBackupFile: map.get(MAINTENANCE_KEYS.lastBackupFile) || null,
    lastPruneAt: map.get(MAINTENANCE_KEYS.lastPruneAt) || null,
    retentionDays: retentionDaysFromEnv(),
    auditRetentionDays: AUDIT_RETENTION_DAYS,
    backups,
    disk: diskUsage(dir, backups),
    uptimeSec: Math.round(process.uptime()),
    database,
    warnings,
  };
}