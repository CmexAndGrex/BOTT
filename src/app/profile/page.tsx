"use client";

/**
 * Личный кабинет бойца — личное дело (досье).
 *
 * Страница собирает всё, что боец сверяет о себе: шапку личного дела со статусом
 * службы, живой состав на сервере («Кто на ВЧ»), допуск к технике по званию или
 * нормативам, историю поданных рапортов и смену пароля.
 *
 * Анкеты (возраст, специализация, опыт в Arma 3, комментарий) здесь больше нет:
 * это данные заявки на вступление, и правка их из кабинета расходилась с личным
 * делом — нормативы и допуски живут в разделе «Экзамены», а данные заявки
 * меняет штаб при рассмотрении. Роут PUT /api/member/profile оставлен: им
 * пользуются форма подачи заявления и модерация.
 *
 * Данные приходят одним запросом (/api/member/dossier): три отдельных обращения
 * дали бы «прыгающую» вёрстку и три раза дёргали БД. Разметка виджетов вынесена
 * в components/dossier-panel.tsx, чтобы страница читалась как последовательность
 * состояний: загрузка → нужен вход → досье.
 *
 * Проверка статуса и прав — на сервере (requireActiveMember): кандидат со
 * статусом pending не увидит кабинет, даже если откроет адрес вручную.
 */
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2, GraduationCap, KeyRound, Link2Off, MessageCircle, ShieldAlert,
} from "lucide-react";
import { Section, Spinner } from "@/components/ui";
import {
  DossierHeader,
  GarrisonWidget,
  ServiceHistory,
  VehicleAccessGrid,
  type DossierMember,
  type DossierReport,
  type DossierService,
} from "@/components/dossier-panel";
import { useReportLauncher } from "@/components/report-launcher";
import { PASSWORD_POLICY_HINT } from "@/lib/password-policy";
import type { VehicleAccessReport } from "@/lib/vehicles";

/** Ответ /api/member/dossier — то, что нужно интерфейсу */
type DossierResponse = {
  ok: boolean;
  member: DossierMember;
  service: DossierService;
  serviceSummary: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    firstAt: string | null;
    lastAt: string | null;
    qualifications: string[];
  };
  vehicles: VehicleAccessReport;
  reports: DossierReport[];
  error?: string;
  /** Состояние доступа (при отказе): no_session | not_linked | no_access */
  state?: string;
};

export default function ProfilePage() {
  // useSearchParams() требует границы Suspense при пререндере страницы
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <DossierPageInner />
    </React.Suspense>
  );
}

function DossierPageInner() {
  const [dossier, setDossier] = useState<DossierResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  /**
   * Состояние доступа к кабинету: пусто — доступ есть.
   *
   * Значения различимы намеренно. Раньше любой отказ (401) показывал одну
   * заглушку «Войдите в личный кабинет, чтобы увидеть личное дело» с кнопкой
   * «Войти», и авторизованный командир, чья учётная запись не была связана с
   * бойцом, ходил по кругу: /profile → /login → /profile → та же заглушка.
   * Теперь для штаба без связки показывается не «войдите», а «свяжите аккаунт»,
   * и вместо кнопки входа — переход в «Доступы», где связка и ставится.
   */
  const [gate, setGate] = useState<"" | "no_session" | "not_linked" | "no_access">("");
  /**
   * Подача рапорта — через глобальное окно из сайдбара.
   *
   * Раньше страница держала своё состояние модалки и свой обработчик отправки:
   * тот же код, что и в сайдбаре, только в двух местах. Теперь окно одно
   * (report-launcher.tsx), а страница лишь просит его открыть и, после
   * успешной отправки, обновляет досье — чтобы новый рапорт сразу появился в
   * «Мои рапорты».
   */
  const { openReport } = useReportLauncher();

  // Смена пароля
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);

  const params = useSearchParams();
  /**
   * Сообщения из адреса (?linked=1, ?error=...) считаем при отрисовке, а не в
   * эффекте: эффект со setState давал бы лишний повторный рендер, а его самого
   * пришлось бы ставить после ранних выходов — хук вызывать условно нельзя
   * (ошибка rules-of-hooks).
   */
  const urlNotice = React.useMemo(() => {
    if (params.get("linked") === "1") {
      return { kind: "ok" as const, text: "Discord привязан к аккаунту" };
    }
    const code = params.get("error");
    if (code === "discord_taken") {
      return { kind: "err" as const, text: "Этот Discord уже привязан к другому аккаунту" };
    }
    if (code === "oauth_session") {
      return { kind: "err" as const, text: "Сессия привязки потеряна, попробуйте снова" };
    }
    return null;
  }, [params]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/member/dossier", { cache: "no-store" });
      const data = (await res.json()) as DossierResponse;

      // Коды разные, и бойцу (или командиру) нужно разное действие:
      // 401 — сессии нет вовсе, надо войти;
      // 409 — вход выполнен, но учётная запись панели не связана с бойцом;
      // 403 — боец есть, но он не зачислен (рапорт на рассмотрении/отклонён).
      // Показываем экран состояния, а не «сбой сети».
      if (res.status === 401) {
        setGate("no_session");
        return;
      }
      if (res.status === 409 || data?.state === "not_linked") {
        setGate("not_linked");
        return;
      }
      if (res.status === 403) {
        setGate("no_access");
        return;
      }
      if (!data?.ok) {
        setError(data?.error || "Не удалось загрузить личное дело");
        return;
      }

      setDossier(data);
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Вызов отложен на микрозадачу: синхронный setState в теле эффекта дал бы
    // каскадный рендер (в проекте та же схема в /reports и /admin/recruits)
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /**
   * Открытие окна подачи рапорта из шапки личного дела.
   *
   * После успешной отправки досье перезагружается (onSubmitted) — новый рапорт
   * сразу виден в таблице «Мои рапорты», а счётчик «на рассмотрении» обновлён.
   * Ошибки и успех показывает само окно: страница их больше не дублирует.
   */
  const handleOpenReport = () => {
    openReport({ onSubmitted: () => void load() });
  };

  const handleLinkDiscord = async () => {
    setError("");
    try {
      const res = await fetch("/api/auth/discord?intent=link", { cache: "no-store" });
      const data = await res.json();
      if (data.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setError(data.error || "Не удалось начать привязку Discord");
    } catch {
      setError("Сбой сети");
    }
  };

  const handleUnlinkDiscord = async () => {
    if (!confirm("Отвязать Discord от аккаунта? Вход останется по паролю.")) return;
    setError("");
    setFlash("");
    try {
      const res = await fetch("/api/member/discord", { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setFlash("Discord отвязан");
        void load();
      } else {
        setError(data.error || "Не удалось отвязать Discord");
      }
    } catch {
      setError("Сбой сети");
    }
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setFlash("");
    setPasswordBusy(true);
    try {
      const res = await fetch("/api/member/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (data.ok) {
        setFlash("Пароль изменён. Остальные сессии отозваны");
        setCurrentPassword("");
        setNewPassword("");
      } else {
        setError(data.error || "Не удалось сменить пароль");
      }
    } catch {
      setError("Сбой сети");
    } finally {
      setPasswordBusy(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/member-logout", { method: "POST" });
    window.location.href = "/login";
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (gate) {
    /**
     * Экран состояния кабинета.
     *
     * «Войти» показываем только когда сессии действительно нет. Для остальных
     * состояний кнопка входа была бы ловушкой: человек уже авторизован (штаб без
     * связки) или вообще не может войти (рапорт на рассмотрении) — и клик
     * возвращал бы его на ту же страницу. Это и есть цикл из отчёта.
     */
    const isGuest = gate === "no_session";
    const title = isGuest ? "Личный кабинет" : "Личное дело";
    const text =
      gate === "no_session"
        ? "Войдите в личный кабинет, чтобы увидеть личное дело"
        : gate === "not_linked"
          ? "Вы вошли в панель, но её учётная запись не связана с бойцом в табеле. " +
            "Свяжите аккаунт с бойцом в разделе «Доступы» — после этого кабинет откроется сразу."
          : "Личное дело доступно бойцам, зачисленным в подразделение";

    return (
      <div className="mx-auto max-w-md pt-10 text-center">
        <div className="card p-6">
          <ShieldAlert size={32} className="mx-auto mb-3" style={{ color: "var(--dim)" }} />
          <h1 className="display text-lg font-bold mb-1.5">{title}</h1>
          <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
            {text}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {isGuest ? (
              // Возврат на кабинет после входа (?next=/profile): без него вход
              // уводил в панель, и человек шёл в кабинет заново — по кругу.
              <Link href="/login?next=%2Fprofile" className="btn btn-primary px-4 py-2">
                Войти
              </Link>
            ) : gate === "not_linked" ? (
              <Link href="/users" className="btn btn-primary px-4 py-2">
                Открыть «Доступы»
              </Link>
            ) : null}
            {!isGuest && (
              <Link href="/" className="btn px-4 py-2" style={{ color: "var(--muted)" }}>
                На обзор
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!dossier) {
    return (
      <div className="card px-5 py-6">
        <div className="flex items-center gap-2.5">
          <ShieldAlert size={16} style={{ color: "var(--red)" }} />
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {error || "Личное дело недоступно"}
          </span>
        </div>
      </div>
    );
  }

  const summary = dossier.serviceSummary;
  const noticeError = error || (urlNotice?.kind === "err" ? urlNotice.text : "");
  const noticeOk = flash || (urlNotice?.kind === "ok" ? urlNotice.text : "");

  return (
    <div className="flex flex-col gap-5">
      {noticeError && (
        <div
          className="card flex items-center gap-2.5 px-4 py-3"
          style={{ borderColor: "rgba(239,68,68,.45)" }}
        >
          <ShieldAlert size={16} style={{ color: "var(--red)" }} />
          <span className="text-[13px]" style={{ color: "var(--red)" }}>
            {noticeError}
          </span>
        </div>
      )}
      {noticeOk && (
        <div
          className="card flex items-center gap-2.5 px-4 py-3"
          style={{ borderColor: "rgba(16,185,129,.4)" }}
        >
          <CheckCircle2 size={16} style={{ color: "var(--green)" }} />
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {noticeOk}
          </span>
        </div>
      )}

      <DossierHeader
        member={dossier.member}
        service={dossier.service}
        onReport={handleOpenReport}
        onLogout={handleLogout}
      />

      {/* Сводка службы: видно, сколько рапортов ждёт решения штаба */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="рапортов подано" value={String(summary.total)} />
        <StatTile label="на рассмотрении" value={String(summary.pending)} tone="amber" />
        <StatTile label="одобрено" value={String(summary.approved)} tone="green" />
        <StatTile label="нормативов сдано" value={String(summary.qualifications.length)} />
      </div>

      {/* Ссылка на шкалу нормативов: счётчик «нормативов сдано» сам по себе не
          объясняет, что осталось сдать — детали в разделе «Экзамены» */}
      {dossier.member.unit && (
        <Link
          href="/exams"
          className="card card-hover flex flex-wrap items-center justify-between gap-3 px-5 py-4"
        >
          <span className="flex items-center gap-3">
            <GraduationCap size={18} style={{ color: "var(--red)" }} />
            <span>
              <span className="label block">шкала нормативов</span>
              <span className="text-[13px] font-semibold">
                Экзамены по специальностям {dossier.member.unit}
              </span>
            </span>
          </span>
          <span className="text-[12px]" style={{ color: "var(--dim)" }}>
            открыть →
          </span>
        </Link>
      )}

      <GarrisonWidget onNotice={setFlash} memberId={dossier.member.id} />

      <VehicleAccessGrid report={dossier.vehicles} />

      <ServiceHistory reports={dossier.reports} />

      <Section title="Discord" eyebrow="способы входа">
        <div className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="flex items-center gap-3">
            <MessageCircle
              size={18}
              style={{ color: dossier.member.discordId ? "var(--green)" : "var(--dim)" }}
            />
            <div>
              <div className="text-sm font-medium">
                {dossier.member.discordId ? "Аккаунт Discord привязан" : "Discord не привязан"}
              </div>
              <div className="text-[11.5px] mono" style={{ color: "var(--dim)" }}>
                {dossier.member.discordId || "вход возможен только по позывному и паролю"}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleLinkDiscord} className="btn btn-sm">
              {dossier.member.discordId ? "Привязать другой" : "Привязать Discord"}
            </button>
            {dossier.member.discordId && (
              <button
                onClick={handleUnlinkDiscord}
                className="btn btn-sm"
                style={{
                  color: "var(--amber)",
                  borderColor: "transparent",
                  background: "var(--amber-soft)",
                }}
              >
                <Link2Off size={14} /> Отвязать
              </button>
            )}
          </div>
        </div>
      </Section>

      <Section title="Безопасность" eyebrow="пароль кабинета">
        <form onSubmit={handlePassword} className="grid grid-cols-1 gap-4 p-5 md:grid-cols-3">
          <div>
            <label className="label mb-1.5 block">
              Текущий пароль (пусто, если вход только по Discord)
            </label>
            <input
              type="password"
              className="input input-mono w-full"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className="label mb-1.5 block">Новый пароль</label>
            <input
              type="password"
              className="input input-mono w-full"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="НадёжныйПароль123"
              required
            />
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary w-full" disabled={passwordBusy}>
              {passwordBusy ? <Spinner /> : <KeyRound size={15} />} Сменить
            </button>
          </div>
          <p className="text-[11.5px] md:col-span-3" style={{ color: "var(--dim)" }}>
            {PASSWORD_POLICY_HINT} После смены пароля остальные устройства выходят автоматически.
          </p>
        </form>
      </Section>
    </div>
  );
}

/** Плитка сводки службы: подпись и число */
function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "green" | "amber";
}) {
  const color =
    tone === "green" ? "var(--green)" : tone === "amber" ? "var(--amber)" : "var(--text)";
  return (
    <div className="card px-4 py-3.5">
      <div className="label mb-1">{label}</div>
      <div className="mono text-[20px] font-bold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}