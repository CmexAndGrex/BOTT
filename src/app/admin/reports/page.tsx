"use client";

/**
 * Раздел модерации «Рапорты и Заявки» (/admin/reports).
 *
 * Две очереди на одной странице: заявки на вступление и рапорты действующего
 * состава. Фильтры — по статусу и типу рапорта; решения принимаются прямо здесь,
 * а сообщение с кнопками в Discord обновляется тем же вызовом, что и при нажатии
 * кнопки (src/lib/review.ts) — источников входа два, а правило одно.
 *
 * Разметка очередей вынесена в components/review-queue.tsx: страница описывает
 * состояния (загрузка, фильтры, решения), а не «простыню» таблиц.
 */
import React, { useCallback, useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, ThumbsDown } from "lucide-react";
import { Spinner } from "@/components/ui";
import {
  RecruitsQueue,
  ReportsQueue,
  type RecruitRow,
  type ReportRow,
} from "@/components/review-queue";
import {
  REPORT_TYPE_META,
  REVIEW_STATUS_LABELS,
  type ReviewStatus,
  type ServiceReportType,
} from "@/lib/reports";

const STATUS_FILTERS: { key: ReviewStatus | "all"; label: string }[] = [
  { key: "pending", label: REVIEW_STATUS_LABELS.pending },
  { key: "approved", label: REVIEW_STATUS_LABELS.approved },
  { key: "rejected", label: REVIEW_STATUS_LABELS.rejected },
  { key: "all", label: "Все" },
];

export default function AdminReportsPage() {
  const [tab, setTab] = useState<"reports" | "recruits">("reports");
  const [status, setStatus] = useState<ReviewStatus | "all">("pending");
  const [type, setType] = useState<ServiceReportType | "all">("all");
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [recruits, setRecruits] = useState<RecruitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  /** Комментарии к решениям: ключ «scope-id» → текст (причина отказа) */
  const [comments, setComments] = useState<Record<string, string>>({});

  const load = useCallback(
    async (nextStatus: ReviewStatus | "all", nextType: ServiceReportType | "all") => {
      setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({ status: nextStatus });
        if (nextType !== "all") query.set("type", nextType);
        const res = await fetch(`/api/admin/reports?${query.toString()}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setError(data.error || "Не удалось загрузить очередь");
          return;
        }
        setReports(data.reports ?? []);
        setRecruits(data.recruits ?? []);
      } catch {
        setError("Сбой сети");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    // Отложено на микрозадачу: синхронный setState в теле эффекта вызвал бы
    // каскадный рендер (та же схема в /admin/recruits)
    const timer = window.setTimeout(() => {
      void load(status, type);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [status, type, load]);

  /** Решение по записи: тот же путь, что и у кнопок Discord */
  const decide = async (
    scope: "recruit" | "report",
    id: number,
    action: "approve" | "reject"
  ) => {
    const key = `${scope}-${id}`;
    setBusy(key);
    setError("");
    setFlash("");
    try {
      const res = await fetch("/api/admin/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, action, id, comment: comments[key] || "" }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Не удалось применить решение");
        return;
      }
      setFlash(data.message || "Решение применено");
      await load(status, type);
    } catch {
      setError("Сбой сети");
    } finally {
      setBusy(null);
    }
  };

  const setComment = (key: string, value: string) =>
    setComments((prev) => ({ ...prev, [key]: value }));

  const chipStyle = (active: boolean) =>
    active
      ? {
          borderColor: "rgba(255,61,61,.5)",
          background: "var(--red-soft)",
          color: "#fff",
          cursor: "pointer" as const,
        }
      : { cursor: "pointer" as const };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">штаб // модерация</div>
          <h1 className="display text-[32px] font-black leading-tight sm:text-[38px]">
            Рапорты и заявки
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Решения применяются сразу: заявка зачисляет бойца и высылает доступ, рапорт пишется в
            ШДС. Сообщение с кнопками в Discord обновляется синхронно.
          </p>
        </div>
        <button onClick={() => void load(status, type)} className="btn btn-sm" disabled={loading}>
          <RefreshCw size={14} /> Обновить
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div
          className="flex gap-1.5 rounded-xl border p-1"
          style={{ borderColor: "var(--stroke)", background: "rgba(255,255,255,0.02)" }}
        >
          <button onClick={() => setTab("reports")} className="chip" style={chipStyle(tab === "reports")}>
            Рапорты состава ({reports.length})
          </button>
          <button onClick={() => setTab("recruits")} className="chip" style={chipStyle(tab === "recruits")}>
            Заявки на вступление ({recruits.length})
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((item) => (
            <button
              key={item.key}
              onClick={() => setStatus(item.key)}
              className="chip"
              style={chipStyle(status === item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "reports" && (
          <select
            className="select"
            style={{ width: 240 }}
            value={type}
            onChange={(e) => setType(e.target.value as ServiceReportType | "all")}
          >
            <option value="all">Все типы рапортов</option>
            {REPORT_TYPE_META.map((item) => (
              <option key={item.type} value={item.type}>
                {item.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {flash && <NoticeRow kind="ok" text={flash} />}
      {error && <NoticeRow kind="err" text={error} />}

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Spinner />
        </div>
      ) : tab === "reports" ? (
        <ReportsQueue
          rows={reports}
          busy={busy}
          comments={comments}
          onComment={setComment}
          onDecide={(id, action) => void decide("report", id, action)}
        />
      ) : (
        <RecruitsQueue
          rows={recruits}
          busy={busy}
          comments={comments}
          onComment={setComment}
          onDecide={(id, action) => void decide("recruit", id, action)}
        />
      )}
    </div>
  );
}

/** Строка уведомления: результат решения или ошибка */
function NoticeRow({ kind, text }: { kind: "ok" | "err"; text: string }) {
  return (
    <div
      className="card flex items-center gap-2.5 px-4 py-3"
      style={{ borderColor: kind === "ok" ? "rgba(61,220,132,.4)" : "rgba(255,61,61,.45)" }}
    >
      {kind === "ok" ? (
        <CheckCircle2 size={16} style={{ color: "var(--green)" }} />
      ) : (
        <ThumbsDown size={16} style={{ color: "var(--red)" }} />
      )}
      <span className="text-[13px]" style={{ color: kind === "ok" ? "var(--muted)" : "var(--red)" }}>
        {text}
      </span>
    </div>
  );
}