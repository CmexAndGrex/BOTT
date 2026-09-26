"use client";

/**
 * Панель обслуживания системы: синхронизация ШДС, резервные копии, очистка.
 *
 * Вынесена из страницы настроек отдельным компонентом: страница /settings уже
 * описывает настройки (то, что сохраняется кнопкой «Сохранить всё»), а здесь —
 * действия с мгновенным эффектом. Смешав их, легко нажать «Сохранить всё»
 * вместо «Создать резервную копию» и наоборот.
 *
 * Все три действия меняют состояние базы или диска, поэтому:
 *   * запросы идут POST-ом (CSRF с middleware и из роутов);
 *   * кнопки блокируются на время выполнения — иначе двойной клик снял бы две
 *     копии подряд, а вторая ротация удалила бы первую как «лишнюю»;
 *   * результат показывается устойчивым сообщением, а не только всплывашкой.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  Timer,
  Trash2,
  XCircle,
} from "lucide-react";
import { Section, Spinner, fmtDateLong } from "@/components/ui";

/** Файл копии в ответе API (совпадает с BackupFile в src/lib/backup.ts) */
type BackupFileRow = {
  name: string;
  path: string;
  sizeBytes: number;
  sizeMb: number;
  createdAt: string;
  compressed: boolean;
  ready: boolean;
};

/** Сводка состояния из GET /api/admin/maintenance */
type Health = {
  ok: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: "ok" | "error" | "never";
  lastSyncLabel: string;
  lastBackupAt: string | null;
  lastBackupFile: string | null;
  lastPruneAt: string | null;
  retentionDays: number;
  auditRetentionDays: number;
  backups: BackupFileRow[];
  disk: {
    backupsMb: number;
    backupsCount: number;
    dir: string;
    freeMb: number | null;
    usedPercent: number | null;
  };
  uptimeSec: number;
  database: boolean;
  warnings: string[];
};

/** Сообщение о выполнении действия: цвет и текст */
type Notice = { ok: boolean; text: string };

/** Человекочитаемый размер: мегабайты для панели, килобайты для мелких файлов */
export function formatSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "0 КБ";
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} КБ`;
  return `${(kb / 1024).toFixed(2)} МБ`;
}

/** Длительность в человекочитаемом виде: для аптайма и прогноза задач */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} с`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} ч ${minutes % 60} мин` : `${hours} ч`;
  return `${Math.floor(hours / 24)} дн. ${hours % 24} ч`;
}

/** Карточка действия: описание, состояние и кнопка. Единый вид для трёх блоков */
function ActionCard({
  title,
  hint,
  status,
  action,
}: {
  title: string;
  hint: React.ReactNode;
  status?: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col justify-between gap-4 rounded-2xl border p-4"
      style={{ borderColor: "var(--stroke-soft)", background: "rgba(255,255,255,.02)" }}
    >
      <div>
        <div className="text-[13px] font-bold">{title}</div>
        <div className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
          {hint}
        </div>
        {status && <div className="mt-2.5">{status}</div>}
      </div>
      <div className="flex flex-wrap gap-2">{action}</div>
    </div>
  );
}

/** Строка «подпись — значение» в карточке */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className="mono text-[12.5px]">{value}</div>
    </div>
  );
}

export default function MaintenancePanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "backup" | "sync" | "prune">(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Счётчик перезагрузки: увеличение повторяет запрос состояния */
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * Загрузка состояния.
   *
   * Запрос живёт внутри эффекта (как на странице журнала): так первое чтение
   * приходит вместе с подпиской на интервал, а повторное обновление — через
   * reloadToken, и в разметке нет запроса «в обход» эффекта.
   */
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/admin/maintenance", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || "Не удалось получить состояние обслуживания");
          return;
        }
        setHealth(data.health as Health);
        setError(null);
      } catch {
        if (!cancelled) setError("Сбой сети при загрузке состояния обслуживания");
      }
    };

    load();
    // Обновляем раз в минуту: копия или синхронизация могли запуститься в фоне
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reloadToken]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Обновить состояние: увеличение счётчика перезапускает эффект выше */
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  /**
   * Общий вызов действия.
   *
   * Обработка ответа одна на все три кнопки: иначе «сервер вернул ошибку» и
   * «сеть пропала» выглядели бы в панели одинаково. Формулировки успеха и
   * неудачи различаются по действию — они заданы ТЗ.
   */
  const run = useCallback(
    async (kind: "backup" | "sync" | "prune", endpoint: string, successText: string, errorText: string) => {
      setBusy(kind);
      setNotice(null);
      try {
        const res = await fetch(endpoint, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          setNotice({ ok: true, text: data.message || successText });
        } else {
          setNotice({ ok: false, text: data.error || errorText });
        }
      } catch {
        setNotice({ ok: false, text: errorText });
      } finally {
        setBusy(null);
        // Перечитываем состояние: показываем реальный результат, а не предположение
        reload();
      }
    },
    [reload]
  );

  if (error) {
    return (
      <Section title="Обслуживание системы и Резервные копии" eyebrow="служебный раздел">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <XCircle size={16} style={{ color: "var(--red)" }} />
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {error}
          </span>
        </div>
      </Section>
    );
  }

  if (!health) {
    return (
      <Section title="Обслуживание системы и Резервные копии" eyebrow="служебный раздел">
        <div className="px-5 py-5">
          <div className="skeleton" style={{ height: 150 }} />
        </div>
      </Section>
    );
  }

  const syncBadge =
    health.lastSyncStatus === "ok"
      ? "badge badge-green"
      : health.lastSyncStatus === "error"
        ? "badge badge-red"
        : "badge badge-amber";

  return (
    <Section
      title="Обслуживание системы и Резервные копии"
      eyebrow="служебный раздел"
      action={
        <button className="btn btn-sm" onClick={reload} disabled={busy !== null} title="Обновить состояние">
          <RefreshCw size={13} />
          Обновить
        </button>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-5">
        {notice && (
          <div
            className="flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5"
            style={{
              borderColor: notice.ok ? "rgba(61,220,132,.4)" : "rgba(255,61,61,.45)",
              background: "rgba(255,255,255,.02)",
            }}
          >
            {notice.ok ? (
              <CheckCircle2 size={15} style={{ color: "var(--green)" }} />
            ) : (
              <XCircle size={15} style={{ color: "var(--red)" }} />
            )}
            <span className="text-[12.5px]" style={{ color: "var(--muted)" }}>
              {notice.text}
            </span>
          </div>
        )}

        {health.warnings.length > 0 && (
          <div
            className="flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5"
            style={{ borderColor: "rgba(255,176,32,.4)", background: "rgba(255,255,255,.02)" }}
          >
            <AlertTriangle size={15} className="mt-0.5 flex-none" style={{ color: "var(--amber)" }} />
            <span className="text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {health.warnings.join("; ")}
            </span>
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-3">
          <ActionCard
            title="Синхронизация ШДС"
            hint="Сверяет звания и подразделения состава с живой Google Таблицей. В фоне запускается сама — раз в час."
            status={
              <div className="flex flex-col gap-2">
                <span className={syncBadge}>{health.lastSyncLabel}</span>
                <div className="text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Последняя: {health.lastSyncAt ? fmtDateLong(health.lastSyncAt) : "не запускалась"}
                </div>
              </div>
            }
            action={
              <button
                className="btn btn-sm btn-primary"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "sync",
                    "/api/admin/maintenance/sync",
                    "Синхронизация с Google Таблицей завершена",
                    "Ошибка синхронизации с Google Таблицей"
                  )
                }
              >
                {busy === "sync" ? <Spinner /> : <RefreshCw size={13} />}
                Синхронизировать сейчас
              </button>
            }
          />

          <ActionCard
            title="Резервное копирование"
            hint="Снимает дамп базы в защищённый каталог. Автоматически — раз в сутки, старые копии удаляются по сроку хранения."
            status={
              <div className="flex flex-col gap-2">
                <span className="badge badge-green">Хранение: {health.retentionDays} дней</span>
                <div className="text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Последняя: {health.lastBackupAt ? fmtDateLong(health.lastBackupAt) : "ещё не создавалась"}
                </div>
                {health.lastBackupFile && (
                  <div className="mono text-[11px] break-all" style={{ color: "var(--dim)" }}>
                    {health.lastBackupFile}
                  </div>
                )}
              </div>
            }
            action={
              <button
                className="btn btn-sm btn-primary"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "backup",
                    "/api/admin/maintenance/backup",
                    "Резервная копия успешно создана",
                    "Ошибка при создании копии"
                  )
                }
              >
                {busy === "backup" ? <Spinner /> : <Database size={13} />}
                Создать резервную копию
              </button>
            }
          />

          <ActionCard
            title="Очистка данных"
            hint={
              <>
                Удаляет сессии с истёкшим сроком и незначительные записи журнала старше{" "}
                {health.auditRetentionDays} дней. Вход в панель и правки состава сохраняются всегда.
              </>
            }
            status={
              <div className="text-[11.5px]" style={{ color: "var(--dim)" }}>
                Последняя: {health.lastPruneAt ? fmtDateLong(health.lastPruneAt) : "ещё не запускалась"}
              </div>
            }
            action={
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "prune",
                    "/api/admin/maintenance/prune",
                    "Очистка устаревших сессий завершена",
                    "Ошибка при очистке данных"
                  )
                }
              >
                {busy === "prune" ? <Spinner /> : <Trash2 size={13} />}
                Очистить устаревшие сессии
              </button>
            }
          />
        </div>

        {/* Состояние и занятое место */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact
            label="Каталог копий"
            value={<span className="break-all">{health.disk.dir}</span>}
          />
          <Fact label="Файлов в каталоге" value={`${health.disk.backupsCount} (${health.disk.backupsMb} МБ)`} />
          <Fact
            label="Свободно на диске"
            value={health.disk.freeMb === null ? "н/д" : `${health.disk.freeMb} МБ`}
          />
          <Fact label="Аптайм сервера" value={formatDuration(health.uptimeSec)} />
        </div>

        {/* Список копий */}
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="label">Доступные резервные копии</div>
            <span className="chip">
              <HardDrive size={12} />
              {health.disk.backupsCount}
            </span>
          </div>

          {health.backups.length === 0 ? (
            <div
              className="flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12px] leading-relaxed"
              style={{ borderColor: "var(--stroke-soft)", background: "rgba(255,255,255,.02)", color: "var(--muted)" }}
            >
              <Timer size={14} className="mt-0.5 flex-none" style={{ color: "var(--dim)" }} />
              <span>
                Копий пока нет. Первая создастся автоматически в течение суток — или нажмите
                «Создать резервную копию».
              </span>
            </div>
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: "var(--stroke-soft)" }}>
              {health.backups.map((file) => (
                <div
                  key={file.name}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                  style={{ borderColor: "var(--stroke-soft)" }}
                >
                  <div className="min-w-0">
                    <div className="mono text-[12px] break-all">{file.name}</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: "var(--dim)" }}>
                      {fmtDateLong(file.createdAt)}
                      {file.compressed ? " · сжат" : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="mono text-[12px]" style={{ color: "var(--muted)" }}>
                      {formatSize(file.sizeBytes)}
                    </span>
                    {/* Готовность: пустой файл восстановить нельзя — показываем это явно */}
                    <span className={file.ready ? "badge badge-green" : "badge badge-red"}>
                      {file.ready ? "готова" : "пустая"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          className="flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12px] leading-relaxed"
          style={{ borderColor: "var(--stroke-soft)", background: "rgba(255,255,255,.025)", color: "var(--muted)" }}
        >
          <Database size={14} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
          <span>
            Восстановление выполняется на сервере вручную:{" "}
            <span className="kbd">gunzip -c backups/atk_backup_ДАТА.sql.gz | psql $DATABASE_URL</span>. Файлы лежат
            в каталоге <span className="kbd">{health.disk.dir}</span> и намеренно не отдаются через панель — дамп
            содержит персональные данные состава.
          </span>
        </div>
      </div>
    </Section>
  );
}