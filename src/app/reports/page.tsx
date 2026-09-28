"use client";

/**
 * Подача рапорта в личном кабинете бойца (/reports).
 *
 * Один маршрут на все типы: тип приходит из query-параметра (/reports?type=exam),
 * форма перерисовывается под него. Проверка на клиенте идёт тем же валидатором,
 * что и на сервере (validateReportPayload), поэтому боец видит требование сразу,
 * а не после отправки, и формулировки ошибок совпадают с ответом API.
 *
 * Раньше тип жил в пути (/reports/exam), но динамического сегмента у страницы
 * нет — любой такой адрес отдавал 404. Теперь выбор типа меняет query-параметр
 * без перезагрузки страницы, а старые ссылки ловит редирект /reports/[type].
 *
 * Подать рапорт можно и не уходя со страницы: кнопка в сайдбаре открывает то же
 * модальное окно (report-launcher.tsx) поверх любой страницы.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, ClipboardList, FilePlus2, RefreshCw, ThumbsDown } from "lucide-react";
import { Spinner } from "@/components/ui";
import { useReportLauncher } from "@/components/report-launcher";
import {
  MyReports,
  ReportForm,
  type ReportRow,
  type SessionMember,
} from "@/components/reports-panel";
import { REPORT_TYPE_META, validateReportPayload, type ServiceReportType } from "@/lib/reports";
import { STATUS_LABELS } from "@/lib/recruits";

export default function ReportsPage() {
  // useParams/useSearchParams требуют границы Suspense при пререндере страницы
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { openReport } = useReportLauncher();

  /**
   * Тип из адреса. Неизвестный — «не выбран»: страница не падает с 404.
   *
   * Шаг выбора типа держим в локальном состоянии, а не только в адресе: клик по
   * карточке типа обязан показывать форму мгновенно, без ожидания навигации,
   * но при этом адрес обновляется — ссылкой на конкретный тип можно поделиться.
   */
  const typeFromUrl = useMemo<ServiceReportType | null>(() => {
    const raw = searchParams.get("type");
    const found = REPORT_TYPE_META.find((m) => m.type === raw);
    return found ? found.type : null;
  }, [searchParams]);

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

  /**
   * Выбор типа рапорта.
   *
   * `null` — вернуться к списку типов (кнопка «Другой тип»). Тип живёт в
   * query-параметре, а не в пути: /reports?type=exam. Адрес меняем через
   * router.replace — без записи в историю, чтобы кнопка «назад» не гоняла
   * бойца по шагам выбора типа.
   */
  const handlePickType = (next: ServiceReportType | null) => {
    router.replace(next ? `/reports?type=${next}` : "/reports", { scroll: false });
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
        <div className="flex flex-wrap items-center gap-2">
          {/* Быстрая подача тем же окном, что и в сайдбаре: страница остаётся
              на месте, история подач обновится после успешной отправки */}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => openReport({ onSubmitted: () => void load() })}
          >
            <FilePlus2 size={14} /> Подать рапорт
          </button>
          <button onClick={() => void load()} className="btn btn-sm" disabled={loading}>
            <RefreshCw size={14} /> Обновить
          </button>
        </div>
      </header>

      {flash && (
        <div className="card flex items-center gap-2.5 px-4 py-3" style={{ borderColor: "rgba(16,185,129,.4)" }}>
          <CheckCircle2 size={16} style={{ color: "var(--green)" }} />
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {flash}
          </span>
        </div>
      )}
      {error && (
        <div className="card flex items-center gap-2.5 px-4 py-3" style={{ borderColor: "rgba(239,68,68,.45)" }}>
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
        onPickType={handlePickType}
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