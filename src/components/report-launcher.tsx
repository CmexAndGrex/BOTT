"use client";

/**
 * Глобальная подача рапорта: модальное окно поверх любой страницы.
 *
 * Раньше пункт «Подать рапорт» в сайдбаре раскрывал список ссылок
 * /reports/exam, /reports/role и т.д. — маршрутов с динамическим сегментом
 * в проекте нет, и каждый клик давал 404. Теперь окно подачи живёт в
 * корневом Shell (report-launcher.tsx): кнопка открывает ReportModal прямо
 * поверх текущей страницы, никуда не уводя пользователя.
 *
 * Отправка повторяет путь страницы /reports и кабинета /profile: проверка
 * общим валидатором (validateReportPayload) → POST /api/member/reports.
 * Третий набор полей не создаётся — используется тот же ReportModal из
 * dossier-panel.tsx, что и в личном кабинете.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { ReportModal } from "@/components/dossier-panel";
import type { SessionMember } from "@/components/reports-panel";
import { validateReportPayload, type ServiceReportType } from "@/lib/reports";

/** Параметры открытия окна подачи рапорта */
export type OpenReportOptions = {
  /** Открыть сразу на нужной вкладке (экзамены / отпуск / роль) */
  type?: ServiceReportType | null;
  /** Вызывается после успешной отправки — страница может обновить данные */
  onSubmitted?: () => void;
};

export type ReportLauncher = {
  /** Окно открыто сейчас */
  open: boolean;
  /** Открыть окно подачи рапорта (опционально — на конкретном типе) */
  openReport: (options?: OpenReportOptions) => void;
  /** Закрыть окно */
  closeReport: () => void;
};

const ReportLauncherContext = createContext<ReportLauncher | null>(null);

/**
 * Доступ к глобальному окну подачи рапорта.
 *
 * Вне провайдера возвращает безопасную заглушку (клики игнорируются), чтобы
 * компонент не падал при рендере в тестах или до подключения провайдера.
 */
export function useReportLauncher(): ReportLauncher {
  const ctx = useContext(ReportLauncherContext);
  if (ctx) return ctx;
  return { open: false, openReport: () => {}, closeReport: () => {} };
}

export function ReportLauncherProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  /** Активная вкладка окна: переживает закрытие — боец возвращается к той же форме */
  const [tab, setTab] = useState<ServiceReportType>("exam");
  const [onSubmitted, setOnSubmitted] = useState<(() => void) | null>(null);
  /** Карточка бойца для формы: подтягивается при первом открытии окна */
  const [member, setMember] = useState<SessionMember | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const openReport = useCallback((options?: OpenReportOptions) => {
    // Тип задан — открываем сразу на его вкладке (быстрые действия сайдбара,
    // кнопки на страницах). Тип не задан — оставляем вкладку прежней.
    if (options?.type) setTab(options.type);
    setOnSubmitted(() => options?.onSubmitted ?? null);
    setError("");
    setNotice("");
    setOpen(true);

    // Сессия бойца нужна форме (каталог нормативов зависит от подразделения).
    // Запрос вне setState-потока рендера — та же схема, что на /reports.
    void fetch("/api/member/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok && data.member) setMember(data.member as SessionMember);
      })
      .catch(() => {});
  }, []);

  const closeReport = useCallback(() => {
    setOpen(false);
    setError("");
    setNotice("");
  }, []);

  /** Отправка рапорта: валидация → POST → закрытие окна и колбэк страницы */
  const handleSubmit = useCallback(
    async (type: ServiceReportType, payload: unknown, reset: () => void) => {
      setError("");
      setNotice("");

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
        setNotice(data.notice || "Рапорт отправлен");
        reset();
        setOpen(false);
        onSubmitted?.();
      } catch {
        setError("Сбой сети");
      } finally {
        setSending(false);
      }
    },
    [onSubmitted],
  );

  const value = useMemo<ReportLauncher>(
    () => ({ open, openReport, closeReport }),
    [open, openReport, closeReport],
  );

  return (
    <ReportLauncherContext.Provider value={value}>
      {children}
      <ReportModal
        open={open}
        member={member}
        tab={tab}
        onTabChange={setTab}
        sending={sending}
        error={error}
        notice={notice}
        onSubmit={handleSubmit}
        onClose={closeReport}
      />
    </ReportLauncherContext.Provider>
  );
}
