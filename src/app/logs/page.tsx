"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  RefreshCw,
  ScrollText,
  XCircle,
  Zap,
  Edit3,
  ChevronDown,
  ChevronRight,
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
  category?: string;
  author?: string | null;
  action?: string;
  details?: any;
};

const KIND_META: Record<string, { label: string; cls: string; icon: typeof Zap }> = {
  operation: { label: "Операция", cls: "badge-red", icon: Zap },
  weekly: { label: "Онлайн", cls: "badge-amber", icon: Activity },
  sync: { label: "Синхронизация", cls: "badge-green", icon: RefreshCw },
};

export default function LogsPage() {
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [mainTab, setMainTab] = useState<"system" | "edit">("system");
  const [filter, setFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

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

  const filtered = (logs ?? []).filter((l) => {
    const cat = l.category || "system";
    if (mainTab === "edit") return cat === "edit";
    if (cat !== "system") return false;
    return filter === "all" || l.kind === filter;
  });

  const toggleRow = (id: number) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">история // события</div>
          <h1 className="display text-[34px] font-black leading-tight sm:text-[40px]">Журнал</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            {mainTab === "system"
              ? "Все отправки пингов, проверок онлайна и синхронизаций."
              : "История административных изменений и редактирования данных на сайте."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Главные вкладки */}
          <div className="flex gap-1.5 bg-[#121214] p-1 rounded-xl border border-gray-800">
            <button
              onClick={() => { setMainTab("system"); setExpandedId(null); }}
              className="chip transition-all"
              style={
                mainTab === "system"
                  ? { borderColor: "rgba(255,61,61,.5)", background: "var(--red-soft)", color: "#fff", cursor: "pointer" }
                  : { cursor: "pointer", color: "var(--muted)" }
              }
            >
              Сайт
            </button>
            <button
              onClick={() => { setMainTab("edit"); setExpandedId(null); }}
              className="chip transition-all"
              style={
                mainTab === "edit"
                  ? { borderColor: "rgba(255,61,61,.5)", background: "var(--red-soft)", color: "#fff", cursor: "pointer" }
                  : { cursor: "pointer", color: "var(--muted)" }
              }
            >
              Редактирование
            </button>
          </div>

          {/* Подфильтры для вкладки "Сайт" */}
          {mainTab === "system" && (
            <div className="flex gap-1.5">
              {[
                { key: "all", label: "Все" },
                { key: "operation", label: "Операции" },
                { key: "weekly", label: "Онлайн" },
                { key: "sync", label: "Синхронизация" },
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
          )}
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
              const isEdit = (log.category || "system") === "edit";

              if (isEdit) {
                const isExpanded = expandedId === log.id;
                return (
                  <div key={log.id} className="flex flex-col py-3.5 border-b border-gray-800/40 last:border-none">
                    <div
                      onClick={() => log.details && toggleRow(log.id)}
                      className={`flex items-center justify-between gap-4 transition-colors ${
                        log.details ? "cursor-pointer hover:opacity-80" : "cursor-default"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <span className="mt-0.5 text-red-500 shrink-0">
                          <Edit3 size={15} />
                        </span>
                        <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-[13px] font-semibold text-red-400">
                            {log.author || "Командир"}
                          </span>
                          <span className="text-[13px] text-gray-200">
                            {log.action || log.title}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 shrink-0">
                        <span className="mono text-[11px]" style={{ color: "var(--dim)" }}>
                          {fmtDateLong(log.createdAt)}
                        </span>
                        {log.details && (
                          <span style={{ color: "var(--dim)" }}>
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </span>
                        )}
                      </div>
                    </div>

                    {isExpanded && log.details && (
                      <div
                        className="mt-3 ml-7 rounded-lg border px-4 py-3.5"
                        style={{
                          borderColor: "rgba(255,255,255,0.08)",
                          background: "rgba(0,0,0,0.3)",
                          color: "var(--muted)",
                        }}
                      >
                        <div className="font-sans text-xs font-semibold text-gray-300 mb-2.5">
                          Детали изменения:
                        </div>
                        <div className="font-mono text-[11px] space-y-1.5 pb-0.5" style={{ lineHeight: "1.8" }}>
                          {typeof log.details === "object" ? (
                            Object.entries(log.details).map(([key, value]) => (
                              <div key={key} className="flex gap-2">
                                <span style={{ color: "var(--dim)" }}>• {key}:</span>
                                <span className="text-gray-200">{String(value)}</span>
                              </div>
                            ))
                          ) : (
                            <div>{String(log.details)}</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

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