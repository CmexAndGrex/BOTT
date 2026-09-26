"use client";

/**
 * Личный кабинет бойца.
 *
 * Доступен только бойцам со статусом «в строю» или «в отпуске» (проверка на
 * сервере — requireActiveMember). Здесь карточка бойца, привязка Discord для
 * тех, кто вошёл по паролю, смена пароля и уточнение анкеты.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ShieldAlert, CheckCircle2, MessageCircle, KeyRound, Link2Off } from "lucide-react";
import { Section, Spinner } from "@/components/ui";
import { PASSWORD_POLICY_HINT } from "@/lib/password-policy";
import { AGE_MAX, AGE_MIN, SPECIALIZATIONS } from "@/lib/recruits";

type Member = {
  id: number;
  callsign: string;
  rank: string;
  unit: string | null;
  status: string;
  statusLabel: string;
  roleLabel: string;
  avatarUrl: string | null;
  discordId: string | null;
  hasDiscord: boolean;
  hasPassword: boolean;
  createdAt: string;
  application: {
    age?: number;
    armaExperience?: string;
    specialization?: string;
    comment?: string;
  };
};

export default function ProfilePage() {
  // useSearchParams() требует границы Suspense при пререндере страницы
  return (
    <React.Suspense fallback={<div className="flex min-h-[60vh] items-center justify-center"><Spinner /></div>}>
      <ProfileCard />
    </React.Suspense>
  );
}

function ProfileCard() {
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [gate, setGate] = useState("");

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
  const urlNotice = useMemo(() => {
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
      const res = await fetch("/api/member/session", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) {
        setGate("Войдите в личный кабинет, чтобы увидеть карточку бойца");
        return;
      }
      setMember(data.member);
      const app = data.member.application || {};
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
    // Загрузка идёт асинхронно (через промис), состояние меняется уже после
    // ответа сети — синхронного setState в теле эффекта нет
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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
        load();
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
        load();
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
          <ShieldAlert size={32} className="mx-auto mb-3" style={{ color: "var(--amber)" }} />
          <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
            {gate}
          </p>
          <Link href="/login" className="btn btn-primary w-full inline-flex justify-center">
            Войти
          </Link>
        </div>
      </div>
    );
  }

  if (!member) return null;

  const onVacation = member.status === "vacation";
  const shownError = urlNotice?.kind === "err" ? urlNotice.text : error;
  const shownFlash = flash || (urlNotice?.kind === "ok" ? urlNotice.text : "");

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {member.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={member.avatarUrl}
              alt={member.callsign}
              width={64}
              height={64}
              style={{ borderRadius: "50%", border: "2px solid var(--stroke-soft)" }}
            />
          ) : (
            <div
              className="flex items-center justify-center mono font-bold"
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: "var(--red-soft)",
                color: "var(--red)",
                fontSize: 22,
              }}
            >
              {member.callsign.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div>
            <div className="eyebrow mb-1">личный кабинет // боец</div>
            <h1 className="display text-[30px] font-black leading-tight">{member.callsign}</h1>
            <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              {member.roleLabel} · в системе с{" "}
              {new Date(member.createdAt).toLocaleDateString("ru-RU")}
            </p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="btn btn-sm"
          style={{ background: "rgba(255,61,61,0.1)", borderColor: "transparent", color: "var(--red)" }}
        >
          Выйти
        </button>
      </header>

      {shownError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <ShieldAlert size={16} />
          {shownError}
        </div>
      )}
      {shownFlash && (
        <div
          className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"
          style={{
            borderColor: "rgba(61,220,132,.3)",
            background: "var(--green-soft)",
            color: "var(--green)",
          }}
        >
          <CheckCircle2 size={16} />
          {shownFlash}
        </div>
      )}

      <Section title="Карточка бойца" eyebrow="табель">
        <div className="grid grid-cols-2 gap-4 p-5 md:grid-cols-4">
          <div>
            <div className="label mb-1">Позывной</div>
            <div className="mono font-bold">{member.callsign}</div>
          </div>
          <div>
            <div className="label mb-1">Звание</div>
            <div className="font-semibold">{member.rank || "—"}</div>
          </div>
          <div>
            <div className="label mb-1">Подразделение</div>
            <div className="font-semibold">{member.unit || "не назначено"}</div>
          </div>
          <div>
            <div className="label mb-1">Статус</div>
            <span className={`badge ${onVacation ? "badge-amber" : "badge-green"}`}>
              {member.statusLabel}
            </span>
          </div>
        </div>
      </Section>

      <Section title="Discord" eyebrow="способы входа">
        <div className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="flex items-center gap-3">
            <MessageCircle
              size={18}
              style={{ color: member.hasDiscord ? "var(--green)" : "var(--dim)" }}
            />
            <div>
              <div className="text-sm font-medium">
                {member.hasDiscord ? "Аккаунт Discord привязан" : "Discord не привязан"}
              </div>
              <div className="text-[11.5px] mono" style={{ color: "var(--dim)" }}>
                {member.hasDiscord
                  ? member.discordId
                  : "вход возможен только по позывному и паролю"}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleLinkDiscord} className="btn btn-sm">
              {member.hasDiscord ? "Привязать другой" : "Привязать Discord"}
            </button>
            {member.hasDiscord && member.hasPassword && (
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

      <Section title="Смена пароля" eyebrow="безопасность">
        <form onSubmit={handlePassword} className="grid grid-cols-1 gap-4 p-5 md:grid-cols-3">
          <div>
            <label className="label mb-1.5 block">
              {member.hasPassword ? "Текущий пароль" : "Текущий пароль (ещё не задан)"}
            </label>
            <input
              type="password"
              className="input input-mono w-full"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              required={member.hasPassword}
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
          <div className="flex justify-end">
            <button type="submit" className="btn btn-primary px-4 py-2" disabled={profileBusy}>
              {profileBusy ? <Spinner /> : "Сохранить"}
            </button>
          </div>
        </form>
      </Section>
    </div>
  );
}