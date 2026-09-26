"use client";

/**
 * Подача рапорта на вступление.
 *
 * Если кандидат перед этим нажал «Войти через Discord», поля Discord ID и
 * аватар подтягиваются автоматически (контакт хранится в httpOnly-cookie,
 * выставленной нашим callback). Без Discord поле можно вписать вручную — ID
 * проверит модератор — или оставить пустым и заполнить позже.
 *
 * Пароль нужен сразу: это резервный вход, если с доступом к Discord возникнут
 * проблемы. Требования те же, что и в панели (см. password-policy.ts).
 */
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList, ShieldAlert, CheckCircle2, MessageCircle } from "lucide-react";
import { Spinner } from "@/components/ui";
import { PASSWORD_POLICY_HINT } from "@/lib/password-policy";
import { AGE_MAX, AGE_MIN, PENDING_NOTICE, SPECIALIZATIONS } from "@/lib/recruits";

type Draft = { discord: { id: string; avatarUrl: string | null } | null };

export default function ApplyPage() {
  const [callsign, setCallsign] = useState("");
  const [password, setPassword] = useState("");
  const [age, setAge] = useState("");
  const [armaExperience, setArmaExperience] = useState("");
  const [specialization, setSpecialization] = useState("");
  const [comment, setComment] = useState("");
  const [discordId, setDiscordId] = useState("");
  const [discordTag, setDiscordTag] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [sending, setSending] = useState(false);
  const [discordAvatar, setDiscordAvatar] = useState<string | null>(null);
  const [discordLinked, setDiscordLinked] = useState(false);

  // Контакт Discord: если он есть, поле ID заполнено и менять его не нужно
  useEffect(() => {
    let cancelled = false;
    fetch("/api/apply", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: Draft) => {
        if (cancelled || !data?.discord) return;
        setDiscordId(data.discord.id);
        setDiscordAvatar(data.discord.avatarUrl);
        setDiscordLinked(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSending(true);

    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callsign,
          password,
          age,
          armaExperience,
          specialization,
          comment,
          // Поле уходит как есть: сервер сам решает, доверять cookie или вводу
          discordId: discordLinked ? "" : discordId,
          // Логин/глобальное имя Discord: офицер по нему найдёт кандидата
          discordTag,
        }),
      });
      const data = await res.json();

      if (data.ok) {
        setDone(true);
      } else {
        setError(data.error || "Не удалось отправить рапорт");
      }
    } catch {
      setError("Сбой сети");
    } finally {
      setSending(false);
    }
  };

  if (done) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-4">
        <div className="card w-full max-w-md px-6 py-8 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-4" style={{ color: "var(--green)" }} />
          <h1 className="display text-xl font-bold mb-2">Рапорт отправлен</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {PENDING_NOTICE}. Как только штаб примет решение, вы сможете войти в личный кабинет
            своим позывным: <span className="mono font-bold">{callsign}</span>
          </p>
          <Link href="/login" className="btn mt-6 w-full inline-flex justify-center">
            Вернуться ко входу
          </Link>
        </div>
      </div>
    );
  }
return (
    <div className="mx-auto w-full max-w-2xl">
      <header className="mb-6">
        <div className="eyebrow mb-2">набор // новобранец</div>
        <h1 className="display text-[30px] font-black leading-tight flex items-center gap-3">
          <ClipboardList className="text-red-500" size={32} /> Рапорт на вступление
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          Заполните анкету — штаб рассмотрит её и зачислит вас в подразделение. Позывной и пароль
          нужны для входа в личный кабинет.
        </p>
      </header>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <ShieldAlert size={16} />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="card flex flex-col gap-5 p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="label mb-1.5 block">Позывной (он же логин)</label>
            <input
              className="input input-mono w-full"
              value={callsign}
              onChange={(e) => setCallsign(e.target.value)}
              placeholder="Скиф"
              minLength={3}
              maxLength={32}
              required
            />
          </div>
          <div>
            <label className="label mb-1.5 block">Пароль</label>
            <input
              type="password"
              className="input input-mono w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="НадёжныйПароль123"
              autoComplete="new-password"
              required
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
              {PASSWORD_POLICY_HINT}
            </p>
          </div>
        </div>

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
              placeholder="18"
              required
            />
          </div>
          <div>
            <label className="label mb-1.5 block">Специализация</label>
            <input
              className="input w-full"
              list="specializations"
              value={specialization}
              onChange={(e) => setSpecialization(e.target.value)}
              placeholder="Танкист (наводчик)"
              required
            />
            <datalist id="specializations">
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
            placeholder="600 часов, 3 года, участвовал в операциях на серверах..."
            required
          />
        </div>

        <div>
          <label className="label mb-1.5 block">
            Discord — логин или имя{discordLinked ? " (определён автоматически)" : ""}
          </label>
          <input
            className="input w-full"
            value={discordTag}
            onChange={(e) => setDiscordTag(e.target.value)}
            placeholder="например atk_recruit или Иван#0000"
            readOnly={discordLinked}
          />
          <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
            {discordLinked
              ? "Логин подставлен из вашего профиля Discord"
              : "Укажите логин (без @) — офицер свяжется с вами после рассмотрения рапорта"}
          </p>
        </div>

        <div>
          <label className="label mb-1.5 block">
            Discord ID {discordLinked ? "(получен автоматически)" : "(можно оставить пустым)"}
          </label>
          <div className="flex items-center gap-3">
            {discordAvatar && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={discordAvatar}
                alt="Discord"
                width={36}
                height={36}
                style={{ borderRadius: "50%", border: "1px solid var(--stroke-soft)" }}
              />
            )}
            <input
              className="input input-mono w-full"
              value={discordId}
              onChange={(e) => setDiscordId(e.target.value)}
              placeholder="123456789012345678"
              readOnly={discordLinked}
            />
          </div>
          <p
            className="mt-1.5 text-[11.5px] flex items-center gap-1.5"
            style={{ color: "var(--dim)" }}
          >
            <MessageCircle size={13} />
            {discordLinked
              ? "Аккаунт Discord привязан: ID и аватар подставлены из вашего профиля"
              : "Нет Discord? Оставьте поле пустым — командир впишет ID вручную после проверки"}
          </p>
        </div>

        <div>
          <label className="label mb-1.5 block">Комментарий (необязательно)</label>
          <textarea
            className="input w-full"
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Опыт в других подразделениях, удобное время для операций..."
          />
        </div>

        <div
          className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"
          style={{ borderColor: "var(--stroke-soft)" }}
        >
          <Link href="/login" className="text-[13px]" style={{ color: "var(--muted)" }}>
            Уже есть аккаунт — войти
          </Link>
          <button type="submit" className="btn btn-primary px-5 py-2" disabled={sending}>
            {sending ? <Spinner /> : "Отправить рапорт"}
          </button>
        </div>
      </form>
    </div>
  );
}