"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  RefreshCw,
  ScrollText,
  XCircle,
  Zap,
} from "lucide-react";
import { Section, fmtDateLong } from "@/components/ui";

type LogRow = {
  id: number;
  createdAt: string;
  kind: string;
  title: string;
  detail: string;
  ok: boolean;
  error: string | null;
};

const KIND_META: Record<string, { label: string; cls: string; icon: typeof Zap }> = {
  operation: { label: "Операция", cls: "badge-red", icon: Zap },
  weekly: { label: "Онлайн", cls: "badge-amber", icon: Activity },
  sync: { label: "Синхронизация", cls: "badge-green", icon: RefreshCw },
};

export default function LogsPage() {
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/logs", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setLogs(data.logs ?? []);
      } catch {
        if (!cancelled) setLogs([]);
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const filtered = (logs ?? []).filter((l) => filter === "all" || l.kind === filter);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">история // события</div>
          <h1 className="display text-[34px] font-black leading-tight sm:text-[40px]">Журнал</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Все отправки пингов, проверок онлайна и синхронизаций.
          </p>
        </div>
        <div className="flex gap-1.5">
          {[
            { key: "all", label: "Все" },
            { key: "operation", label: "Операции" },
            { key: "weekly", label: "Онлайн" },
            { key: "sync", label: "Синх" },
          ].map((f) => (
            <button
              key={f.key}
              className="chip"
              style={
                filter === f.key
                  ? { borderColor: "rgba(255,61,61,.5)", background: "var(--red-soft)", color: "#fff", cursor: "pointer" }
                  : { cursor: "pointer" }
              }
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      <Section title="События" eyebrow={logs ? `${filtered.length} записей` : "загрузка"}>
        <div className="px-5 py-3">
          {!logs ? (
            <div className="flex flex-col gap-2 py-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton" style={{ height: 52 }} />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <ScrollText size={20} style={{ color: "var(--dim)" }} />
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Записей пока нет
              </p>
            </div>
          ) : (
            filtered.map((log) => {
              const meta = KIND_META[log.kind];
              const Icon = meta?.icon ?? ScrollText;
              return (
                <div key={log.id} className="log-line">
                  <span className="mt-1">
                    {log.ok ? (
                      <CheckCircle2 size={15} style={{ color: "var(--green)" }} />
                    ) : (
                      <XCircle size={15} style={{ color: "var(--red)" }} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold">{log.title}</span>
                      {meta && (
                        <span className={`badge ${meta.cls}`}>
                          <Icon size={10} />
                          {meta.label}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
                      {log.detail}
                    </div>
                    {log.error && (
                      <div
                        className="mt-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed"
                        style={{
                          borderColor: "rgba(255,61,61,.3)",
                          background: "rgba(255,61,61,.06)",
                          color: "#ff9c9c",
                        }}
                      >
                        {log.error}
                      </div>
                    )}
                  </div>
                  <span className="mono mt-0.5 whitespace-nowrap text-[11px]" style={{ color: "var(--dim)" }}>
                    {fmtDateLong(log.createdAt)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </Section>
    </div>
  );
}
