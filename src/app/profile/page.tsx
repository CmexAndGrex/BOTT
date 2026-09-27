"use client";

/**
 * Личный кабинет бойца — личное дело (досье).
 *
 * Страница собирает всё, что боец сверяет о себе: шапку личного дела со статусом
 * службы, живой состав на сервере («Кто на ВЧ»), допуск к технике по званию или
 * нормативам, историю поданных рапортов, уточнение анкеты и смену пароля.
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
  CheckCircle2, KeyRound, Link2Off, MessageCircle, RefreshCw, ShieldAlert,
} from "lucide-react";
import { Section, Spinner } from "@/components/ui";
import {
  DossierHeader,
  GarrisonWidget,
  ReportModal,
  ServiceHistory,
  VehicleAccessGrid,
  type DossierMember,
  type DossierReport,
  type DossierService,
} from "@/components/dossier-panel";
import type { SessionMember } from "@/components/reports-panel";
import { PASSWORD_POLICY_HINT } from "@/lib/password-policy";
import { validateReportPayload, type ServiceReportType } from "@/lib/reports";
import { AGE_MAX, AGE_MIN, SPECIALIZATIONS } from "@/lib/recruits";
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
  const [gate, setGate] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // Смена пароля
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);

  // Анкета
  const [age, setAge] = useState("");
  const [armaExperience, setArmaExperience] = useState("");
  const [specialization, setSpecialization] = useState("");
  const [comment, setComment] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

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

      // 401/403 — разные ситуации, и бойцу нужно разное сообщение: «войдите» или
      // «кабинет доступен зачисленным». Показываем экран входа, а не «сбой сети».
      if (res.status === 401) {
        setGate("Войдите в личный кабинет, чтобы увидеть личное дело");
        return;
      }
      if (res.status === 403) {
        setGate("Личное дело доступно бойцам, зачисленным в подразделение");
        return;
      }
      if (!data?.ok) {
        setError(data?.error || "Не удалось загрузить личное дело");
        return;
      }

      setDossier(data);

      // Анкета живёт вне досье (её правит форма уточнения): отдельный запрос
      // сессии, иначе поля формы остались бы пустыми
      const session = await fetch("/api/member/session", { cache: "no-store" }).then((r) =>
        r.json()
      );
      const app = session?.member?.application || {};
      setAge(app.age ? String(app.age) : "");
      setArmaExperience(app.armaExperience || "");
      setSpecialization(app.specialization || "");
      setComment(app.comment || "");
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

  /** Подача рапорта из модального окна: тот же путь, что и на /reports */
  const handleSubmit = async (
    type: ServiceReportType,
    payload: unknown,
    reset: () => void
  ): Promise<void> => {
    setError("");
    setFlash("");

    // Проверка общим валидатором: формулировки ошибок совпадают с ответом API
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
      setReportOpen(false);
      await load();
    } catch {
      setError("Сбой сети");
    } finally {
      setSending(false);
    }
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

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setFlash("");
    setProfileBusy(true);
    try {
      const res = await fetch("/api/member/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ age, armaExperience, specialization, comment }),
      });
      const data = await res.json();
      if (data.ok) {
        setFlash("Данные анкеты обновлены");
        void load();
      } else {
        setError(data.error || "Не удалось сохранить анкету");
      }
    } catch {
      setError("Сбой сети");
    } finally {
      setProfileBusy(false);
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
    return (
      <div className="mx-auto max-w-md pt-10 text-center">
        <div className="card p-6">
          <ShieldAlert size={32} className="mx-auto mb-3" style={{ color: "var(--dim)" }} />
          <h1 className="display text-lg font-bold mb-1.5">Личный кабинет</h1>
          <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
            {gate}
          </p>
          <Link href="/login" className="btn btn-primary px-4 py-2">
            Войти
          </Link>
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

  // Модальному окну нужны те же данные, что и /reports: каталог нормативов
  // выбирается по подразделению, поэтому передаём карточку бойца
  const sessionMember: SessionMember = {
    id: dossier.member.id,
    callsign: dossier.member.callsign,
    rank: dossier.member.rank,
    unit: dossier.member.unit,
    status: dossier.member.status,
    statusLabel: dossier.service.label,
    role: "member",
    roleLabel: "",
    discordId: dossier.member.discordId,
  };

  const summary = dossier.serviceSummary;
  const noticeError = error || (urlNotice?.kind === "err" ? urlNotice.text : "");
  const noticeOk = flash || (urlNotice?.kind === "ok" ? urlNotice.text : "");

  return (
    <div className="flex flex-col gap-5">
      {noticeError && (
        <div
          className="card flex items-center gap-2.5 px-4 py-3"
          style={{ borderColor: "rgba(255,61,61,.45)" }}
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
          style={{ borderColor: "rgba(61,220,132,.4)" }}
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
        onReport={() => setReportOpen(true)}
        onLogout={handleLogout}
      />

      {/* Сводка службы: видно, сколько рапортов ждёт решения штаба */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="рапортов подано" value={String(summary.total)} />
        <StatTile label="на рассмотрении" value={String(summary.pending)} tone="amber" />
        <StatTile label="одобрено" value={String(summary.approved)} tone="green" />
        <StatTile label="нормативов сдано" value={String(summary.qualifications.length)} />
      </div>

      <GarrisonWidget onNotice={setFlash} />

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

      <Section title="Моя анкета" eyebrow="данные рапорта">
        <form onSubmit={handleProfileSave} className="flex flex-col gap-4 p-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="label mb-1.5 block">Возраст</label>
              <input
                type="number"
                className="input input-mono w-full"
                value={age}
                onChange={(e) => setAge(e.target.value)}
                min={AGE_MIN}
                max={AGE_MAX}
                required
              />
            </div>
            <div>
              <label className="label mb-1.5 block">Специализация</label>
              <input
                className="input w-full"
                list="profile-specializations"
                value={specialization}
                onChange={(e) => setSpecialization(e.target.value)}
                required
              />
              <datalist id="profile-specializations">
                {SPECIALIZATIONS.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </div>
          </div>
          <div>
            <label className="label mb-1.5 block">Опыт в Arma 3</label>
            <textarea
              className="input w-full"
              rows={3}
              value={armaExperience}
              onChange={(e) => setArmaExperience(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label mb-1.5 block">Комментарий</label>
            <textarea
              className="input w-full"
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <button type="button" className="btn btn-sm" onClick={() => void load()}>
              <RefreshCw size={14} /> Обновить досье
            </button>
            <button type="submit" className="btn btn-primary px-4 py-2" disabled={profileBusy}>
              {profileBusy ? <Spinner /> : "Сохранить"}
            </button>
          </div>
        </form>
      </Section>

      <ReportModal
        open={reportOpen}
        member={sessionMember}
        onSubmit={handleSubmit}
        onClose={() => setReportOpen(false)}
      />
      {sending && (
        <p className="text-center text-[11.5px]" style={{ color: "var(--dim)" }}>
          Отправляем рапорт…
        </p>
      )}
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