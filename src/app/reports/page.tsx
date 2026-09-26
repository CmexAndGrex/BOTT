"use client";

/**
 * Подача рапорта в личном кабинете бойца (/reports).
 *
 * Один маршрут на все типы: тип приходит из адреса (/reports/exam), форма
 * перерисовывается под него. Проверка на клиенте идёт тем же валидатором, что и
 * на сервере (validateReportPayload), поэтому боец видит требование сразу, а не
 * после отправки, и формулировки ошибок совпадают с ответом API.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, ClipboardList, RefreshCw, ThumbsDown } from "lucide-react";
import { Spinner } from "@/components/ui";
import {
  MyReports,
  ReportForm,
  type ReportRow,
  type SessionMember,
} from "@/components/reports-panel";
import { REPORT_TYPE_META, validateReportPayload, type ServiceReportType } from "@/lib/reports";
import { STATUS_LABELS } from "@/lib/recruits";

export default function ReportsPage() {
  // useParams требует границы Suspense при пререндере страницы
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <ReportsInner />
    </React.Suspense>
  );
}

function ReportsInner() {
  const params = useParams<{ type?: string }>();
  const router = useRouter();

  /** Тип из адреса. Неизвестный — «не выбран»: страница не падает с 404 */
  const typeFromUrl = useMemo<ServiceReportType | null>(() => {
    const raw = Array.isArray(params?.type) ? params.type[0] : params?.type;
    const found = REPORT_TYPE_META.find((m) => m.type === raw);
    return found ? found.type : null;
  }, [params]);

  const [member, setMember] = useState<SessionMember | null>(null);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState("");
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const session = await fetch("/api/member/session", { cache: "no-store" }).then((r) => r.json());
      if (!session?.ok) {
        setGate("Войдите в личный кабинет, чтобы подать рапорт");
        return;
      }
      setMember(session.member);
      const mine = await fetch("/api/member/reports", { cache: "no-store" }).then((r) => r.json());
      setReports(mine?.reports ?? []);
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Вызов отложен на микрозадачу: синхронный setState в теле эффекта дал бы
    // каскадный рендер (в проекте та же схема в /admin/recruits)
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /** Отправка рапорта: валидация → POST → перезагрузка списка */
  const handleSubmit = async (
    type: ServiceReportType,
    payload: unknown,
    reset: () => void
  ): Promise<void> => {
    setError("");
    setFlash("");

    const validation = validateReportPayload(type, payload);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setSending(true);
    try {
      const res = await fetch("/api/member/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, payload: validation.payload }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Не удалось подать рапорт");
        return;
      }
      setFlash(data.notice || "Рапорт отправлен");
      reset();
      await load();
    } catch {
      setError("Сбой сети");
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (gate) {
    return <GateNotice text={gate} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">кабинет // рапорты</div>
          <h1 className="display text-[32px] font-black leading-tight sm:text-[38px]">Рапорты</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            {member?.callsign} ·{" "}
            {STATUS_LABELS[member?.status as keyof typeof STATUS_LABELS] ?? member?.statusLabel} ·
            подразделение: {member?.unit || "не назначено"}
          </p>
        </div>
        <button onClick={() => void load()} className="btn btn-sm" disabled={loading}>
          <RefreshCw size={14} /> Обновить
        </button>
      </header>

      {flash && (
        <div className="card flex items-center gap-2.5 px-4 py-3" style={{ borderColor: "rgba(61,220,132,.4)" }}>
          <CheckCircle2 size={16} style={{ color: "var(--green)" }} />
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {flash}
          </span>
        </div>
      )}
      {error && (
        <div className="card flex items-center gap-2.5 px-4 py-3" style={{ borderColor: "rgba(255,61,61,.45)" }}>
          <ThumbsDown size={16} style={{ color: "var(--red)" }} />
          <span className="text-[13px]" style={{ color: "var(--red)" }}>
            {error}
          </span>
        </div>
      )}

      <ReportForm
        member={member}
        type={typeFromUrl}
        sending={sending}
        onPickType={(next) => router.push(`/reports/${next}`)}
        onSubmit={handleSubmit}
      />

      <MyReports reports={reports} />
    </div>
  );
}

/** Экран «нужен вход»: страница бесполезна без сессии кабинета */
function GateNotice({ text }: { text: string }) {
  return (
    <div className="card px-6 py-8 text-center">
      <ClipboardList size={34} className="mx-auto mb-3" style={{ color: "var(--dim)" }} />
      <h1 className="display text-lg font-bold mb-1.5">Рапорты доступны бойцам</h1>
      <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
        {text}
      </p>
      <Link href="/login" className="btn btn-primary px-4 py-2">
        Войти
      </Link>
    </div>
  );
}