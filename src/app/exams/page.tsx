"use client";

/**
 * Раздел «Экзамены»: интерактивная шкала нормативов по специальностям бойца.
 *
 * Подразделение берётся из сессии (условный боец видит только свои вкладки:
 * у Танковой роты и Артдивизиона наборы разные), а сданные нормативы — из
 * одобренных рапортов. Источник — один запрос /api/member/dossier: он же
 * отдаёт «Кто на ВЧ» и допуск к технике, поэтому второй раз в БД не идём.
 *
 * Логика допусков не дублируется в разметке: вкладки, каскад специальностей,
 * сопоставление сданных нормативов и прогресс считает доменный модуль
 * src/lib/exams.ts — тот же, что проверяется тестами (tests/exams.test.ts).
 *
 * Кнопка «Сдать норматив» не ведёт на страницу: она открывает глобальное
 * модальное окно подачи рапорта (useReportLauncher) сразу на вкладке «Экзамены»
 * и с уже отмеченным нормативом. После отправки досье перезагружается, и бейдж
 * становится зелёным, как только штаб одобрит рапорт.
 */
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Award, CheckCheck, ClipboardList, GraduationCap, Lock, RefreshCw, ShieldAlert,
} from "lucide-react";
import { Section, Spinner, fmtDate } from "@/components/ui";
import { useReportLauncher } from "@/components/report-launcher";
import type { DossierMember, DossierService } from "@/components/dossier-panel";
import {
  examSpecialities,
  specialityProgress,
  type ExamRequirementStatus,
  type ExamSpeciality,
  type SpecialityProgress,
} from "@/lib/exams";

/** Ответ /api/member/dossier в части, нужной разделу */
type ExamsResponse = {
  ok: boolean;
  member: DossierMember;
  service: DossierService;
  serviceSummary: {
    qualifications: string[];
    qualificationDetails: { code: string; grade: string | null; at: string | null }[];
  };
  error?: string;
};

export default function ExamsPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <ExamsInner />
    </React.Suspense>
  );
}

function ExamsInner() {
  const { openReport } = useReportLauncher();

  const [data, setData] = useState<ExamsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** Состояние доступа (как в кабинете): нет сессии, нет связки, не зачислен */
  const [gate, setGate] = useState<"" | "no_session" | "not_linked" | "no_access">("");
  /** Активная вкладка специальности; ключ, а не индекс — вкладки зависят от подразделения */
  const [activeKey, setActiveKey] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/member/dossier", { cache: "no-store" });
      const body = (await res.json()) as ExamsResponse;

      if (res.status === 401) {
        setGate("no_session");
        return;
      }
      if (res.status === 409) {
        setGate("not_linked");
        return;
      }
      if (res.status === 403) {
        setGate("no_access");
        return;
      }
      if (!body?.ok) {
        setError(body?.error || "Не удалось загрузить нормативы");
        return;
      }
      setData(body);
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Вызов отложен на микрозадачу: синхронный setState в теле эффекта дал бы
    // каскадный рендер (та же схема на /profile и /reports)
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const services: readonly ExamSpeciality[] = examSpecialities(data?.member?.unit ?? null);

  /**
   * Экран состояния: сессии нет / штаб без связки / боец не зачислен.
   *
   * Сообщение объясняет, что именно делать, и не предлагает «Войти» тому, кто
   * уже вошёл — иначе клик возвращал бы его на ту же страницу (цикл, который
   * уже разбирали в кабинете).
   */
  if (gate || !data) {
    const isGuest = gate === "no_session";
    const text =
      gate === "not_linked"
        ? "Учётная запись панели не связана с бойцом в табеле. Свяжите аккаунт в разделе «Доступы» — нормативы подтянутся из личного дела."
        : gate === "no_access"
          ? "Раздел доступен бойцам, зачисленным в подразделение. Пока рапорт на рассмотрении, нормативы не начисляются."
          : error || "Войдите в личный кабинет, чтобы увидеть нормативы";
    return (
      <div className="mx-auto max-w-md pt-10 text-center">
        <div className="card p-6">
          <ShieldAlert size={32} className="mx-auto mb-3" style={{ color: "var(--dim)" }} />
          <h1 className="display text-lg font-bold mb-1.5">Экзамены</h1>
          <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
            {text}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {isGuest ? (
              <Link href="/login?next=%2Fexams" className="btn btn-primary px-4 py-2">
                Войти
              </Link>
            ) : gate === "not_linked" ? (
              <Link href="/users" className="btn btn-primary px-4 py-2">
                Открыть «Доступы»
              </Link>
            ) : null}
            <Link href="/" className="btn px-4 py-2" style={{ color: "var(--muted)" }}>
              На обзор
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const passed = data.serviceSummary.qualificationDetails ?? [];
  const progress = services.map((speciality) =>
    specialityProgress(speciality, data.member.unit, passed)
  );
  /** Активная вкладка: первая доступная, пока выбор не сделан или вкладка пропала */
  const active =
    progress.find((item) => item.speciality.key === activeKey) ?? progress[0] ?? null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">кабинет // экзамены</div>
          <h1 className="display text-[32px] font-black leading-tight sm:text-[38px]">Экзамены</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            {data.member.callsign} · подразделение: {data.member.unit || "не назначено"} · звание:{" "}
            {data.member.rank || "—"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} /> Обновить
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => openReport({ type: "exam", onSubmitted: () => void load() })}
          >
            <ClipboardList size={14} /> Все нормативы списком
          </button>
        </div>
      </header>

      {error && (
        <div className="card flex items-center gap-2.5 px-4 py-3" style={{ borderColor: "rgba(239,68,68,.45)" }}>
          <ShieldAlert size={16} style={{ color: "var(--red)" }} />
          <span className="text-[13px]" style={{ color: "var(--red)" }}>
            {error}
          </span>
        </div>
      )}

      {services.length === 0 ? (
        <Section title="Специальности" eyebrow="подразделение не назначено">
          <p className="px-5 py-6 text-[13px]" style={{ color: "var(--dim)" }}>
            Подразделение ещё не назначено — шкала специальностей появится после зачисления в роту
            или дивизион. Норматив можно подать уже сейчас: в разделе «Мои рапорты» доступен общий
            перечень.
          </p>
        </Section>
      ) : (
        <>
          {/* Сводка по всем вкладкам: видно, где боец ближе всего к допуску */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {progress.map((item) => (
              <div key={item.speciality.key} className="card px-4 py-3.5">
                <div className="label mb-1">{item.speciality.title}</div>
                <div
                  className="mono text-[20px] font-bold"
                  style={{ color: item.percent >= 100 ? "var(--green)" : "var(--text)" }}
                >
                  {item.passedCount} / {item.total}
                </div>
                <div className="mt-2">
                  <ProgressBar percent={item.percent} tone={item.percent >= 100 ? "green" : "red"} />
                </div>
              </div>
            ))}
          </div>

          {/* Вкладки специальностей: чипы, как в остальных переключателях панели.
              Заблокированная ступень (РСЗО без берета) помечается замком и
              подсказкой — прогресс по ней виден, но допуск не выдаётся */}
          <div className="flex flex-wrap gap-2">
            {progress.map((item) => {
              const isActive = active?.speciality.key === item.speciality.key;
              return (
                <button
                  key={item.speciality.key}
                  type="button"
                  className="chip"
                  onClick={() => setActiveKey(item.speciality.key)}
                  title={item.blocked ? item.blockedHint : undefined}
                  style={
                    isActive
                      ? { background: "var(--red-soft)", borderColor: "rgba(239,68,68,.45)", color: "#fff" }
                      : undefined
                  }
                >
                  {item.percent >= 100 && !item.blocked && (
                    <CheckCheck size={13} style={{ color: "var(--green)" }} />
                  )}
                  {item.blocked && <Lock size={13} style={{ color: "var(--amber)" }} />}
                  {item.speciality.title}
                </button>
              );
            })}
          </div>

          {active && (
            <SpecialityCard
              progress={active}
              onPass={(code) =>
                openReport({ type: "exam", exams: [code], onSubmitted: () => void load() })
              }
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Одна специальность: прогресс-бар, список нормативов и статусы.
 *
 * Строка «Сдано: 5 из 12 нормативов (41%)» собирается в доменном модуле
 * (specialityProgress) — её видно и над списком, и в сводке карточек, а
 * расхождение формулировок читалось бы как разные числа.
 */
function SpecialityCard({
  progress,
  onPass,
}: {
  progress: SpecialityProgress;
  onPass: (code: string) => void;
}) {
  const { speciality, statuses, percent, passedCount, total, summary, blocked, blockedHint } = progress;

  return (
    <Section
      title={speciality.title}
      eyebrow={speciality.hint}
      action={
        <span
          className="mono text-[12px]"
          style={{ color: percent >= 100 && !blocked ? "var(--green)" : "var(--dim)" }}
        >
          {passedCount} / {total}
        </span>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        {/* Заблокированная ступень: боец сдал нормативы, но допуск не выдаётся —
            говорим об этом прямо, а не оставляем его догадываться по бейджам */}
        {blocked && (
          <div
            className="flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[12.5px]"
            style={{ background: "rgba(255,176,32,.08)", color: "var(--amber)" }}
          >
            <Lock size={15} className="mt-0.5 flex-none" />
            <span>
              Ступень заблокирована: {blockedHint || "требуется сдача Экзамена на берет"}. Допуск
              будет выдан автоматически после сдачи.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="font-semibold">{summary}</span>
            {percent >= 100 && !blocked && (
              <span className="badge badge-green">
                <Award size={12} /> допуск готов
              </span>
            )}
          </div>
          <ProgressBar percent={percent} tone={percent >= 100 ? "green" : "red"} />
        </div>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {statuses.map((status) => (
            <ExamRow key={status.requirement.code} status={status} onPass={onPass} />
          ))}
        </div>
      </div>
    </Section>
  );
}

/**
 * Строка норматива: зелёный бейдж с оценкой и датой либо «Не сдано» с кнопкой.
 *
 * Состояний три (сдано с оценкой, сдано без оценки и не сдано), и выглядеть они
 * должны одинаково в обеих колонках — поэтому разметка живёт в одном компоненте,
 * а не копией в разметке специальности.
 */
function ExamRow({
  status,
  onPass,
}: {
  status: ExamRequirementStatus;
  onPass: (code: string) => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl px-3 py-2.5"
      style={{
        border: `1px solid ${status.passed ? "rgba(16,185,129,.35)" : "var(--stroke-soft)"}`,
        background: status.passed ? "rgba(16,185,129,.05)" : "transparent",
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium">{status.requirement.title}</span>
        {status.passed ? (
          <span className="badge badge-green ml-auto">
            <CheckCheck size={12} />
            {/* КМБТ и подобные нормативы идут без оценки — тогда пишем «Зачтено» */}
            {status.grade ? status.grade : "Зачтено"}
          </span>
        ) : (
          <span className="badge badge-reserve ml-auto">Не сдано</span>
        )}
      </div>

      {/* Дата сдачи — второй строкой: бейдж остаётся коротким, а боец видит,
          когда норматив зачтён */}
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"
        style={{ color: "var(--dim)" }}
      >
        {status.passed && <span>сдано: {fmtDate(status.at)}</span>}
        {/* Производный норматив: рапортом не сдаётся — закрывается сам, когда
            сданы все нормативы экзамена на берет */}
        {status.requirement.derived && !status.passed && (
          <span>засчитывается после всех нормативов экзамена на берет</span>
        )}
      </div>

      {/* Кнопки «Сдать норматив» у производного норматива нет: рапорт по нему
          валидатор отклонит, и боец только зря потратил бы время */}
      {!status.passed && !status.requirement.derived && (
        <button
          type="button"
          className="btn btn-sm btn-primary self-start"
          onClick={() => onPass(status.requirement.code)}
        >
          <GraduationCap size={13} /> Сдать норматив
        </button>
      )}
    </div>
  );
}

/** Полоса прогресса: тот же класс, что у выработки часов в составе */
function ProgressBar({ percent, tone }: { percent: number; tone: "green" | "red" }) {
  return (
    <div className="hours-track" style={{ width: "100%" }}>
      <div
        className="hours-fill"
        style={{
          width: `${Math.max(0, Math.min(100, percent))}%`,
          background: tone === "green" ? "var(--green)" : "var(--red)",
        }}
      />
    </div>
  );
}