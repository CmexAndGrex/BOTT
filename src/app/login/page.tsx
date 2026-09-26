"use client";

/**
 * Страница входа бойца.
 *
 * Два способа: основной быстрый — Discord (автоматически подтягивает ID, ник и
 * аватар), резервный — позывной и пароль, если с доступом к Discord проблемы.
 * Ошибки приходят кодом (?error=oauth_state и подобные): текст подбираем сами,
 * чтобы в интерфейс нельзя было подставить чужую строку.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Radar, ShieldAlert, MessageCircle, KeyRound, Info } from "lucide-react";
import { Spinner } from "@/components/ui";

/** Расшифровка кодов ошибок входа (ключи совпадают с ?error= из callback) */
const ERROR_TEXT: Record<string, string> = {
  oauth_state: "Сессия входа через Discord устарела. Попробуйте ещё раз",
  oauth_cancelled: "Вход через Discord отменён",
  oauth_failed: "Не удалось завершить вход через Discord. Попробуйте позже",
  oauth_session: "Сессия входа потеряна. Войдите заново",
  discord_taken: "Этот Discord уже привязан к другому аккаунту",
  pending: "Ваш рапорт находится на рассмотрении штаба",
  dismissed: "Рапорт отклонён. Свяжитесь с командирским составом",
};

export default function LoginPage() {
  // useSearchParams() требует границы Suspense при пререндере страницы,
  // поэтому форма вынесена в отдельный компонент (см. ниже)
  return (
    <React.Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Spinner /></div>}>
      <LoginForm />
    </React.Suspense>
  );
}

function LoginForm() {
  const [callsign, setCallsign] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [discordLoading, setDiscordLoading] = useState(false);
  const [discordReady, setDiscordReady] = useState<boolean | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * Сообщения из адреса (?error=... после возврата из Discord, ?applied=1 после
   * рапорта) считаем при отрисовке: эффект со setState вызывал бы лишний
   * каскад рендеров, а синхронный setState в эффекте — признак лишнего
   * состояния. Текст подбираем по коду сами, чужую строку в интерфейс не берём.
   */
  const urlNotice = useMemo(() => {
    const code = searchParams.get("error");
    if (code) return ERROR_TEXT[code] || "Не удалось выполнить вход";
    if (searchParams.get("applied") === "1") {
      return "Рапорт отправлен. Ваш рапорт находится на рассмотрении штаба";
    }
    return "";
  }, [searchParams]);

  // Проверяем, настроен ли вход через Discord: если нет — не показываем
  // кнопку-обманку, а прямо сообщаем, чего не хватает администратору
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetch("/api/auth/discord", { cache: "no-store" })
        .then((res) => {
          if (!cancelled) setDiscordReady(res.status !== 503);
        })
        .catch(() => {
          if (!cancelled) setDiscordReady(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const handleDiscord = useCallback(async () => {
    setError("");
    setDiscordLoading(true);
    try {
      const res = await fetch("/api/auth/discord", { cache: "no-store" });
      const data = await res.json();
      if (data.ok && data.url) {
        // Уходим на согласие в Discord; возврат — на /api/auth/discord/callback
        window.location.href = data.url;
        return;
      }
      setError(data.error || "Вход через Discord недоступен");
    } catch {
      setError("Сбой сети");
    } finally {
      setDiscordLoading(false);
    }
  }, []);

  /**
   * Вход по логину и паролю.
   *
   * Сначала проверяем бойца (members), затем — аккаунт панели (users). Так одна
   * форма обслуживает и бойцов, и командиров с администраторами: у учётной
   * записи панели может не быть рапорта вовсе, и отдельная страница входа
   * заставляла бы администратора помнить второй адрес. Бойцу доступен только
   * личный кабинет, поэтому переходы разные.
   */
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);

    try {
      const memberRes = await fetch("/api/auth/member-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callsign, password }),
      });
      const memberData = await memberRes.json();

      if (memberData.ok) {
        router.push("/profile");
        router.refresh();
        return;
      }

      // Рапорт на рассмотрении/отклонён — это состояние, а не ошибка ввода
      if (memberData.status === "pending" || memberData.status === "dismissed") {
        setNotice(memberData.error || "Доступ закрыт до решения штаба");
        return;
      }

      // Не боец (или пароль не его) — пробуем аккаунт панели
      const panelRes = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: callsign, password }),
      });
      const panelData = await panelRes.json();

      if (panelData.ok) {
        router.push("/");
        router.refresh();
        return;
      }

      setError(panelData.error || memberData.error || "Неверный позывной или пароль");
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  };

  const discordHint = useMemo(() => {
    if (discordReady === null) return "Проверяем настройки входа…";
    // Командиру и администратору Discord сразу открывает панель: привязка
    // выполняется в разделе «Доступы», поэтому подсказка честно об этом говорит
    if (discordReady) return "Бойцам — кабинет с ID и аватаром, командирам — сразу панель";
    return "Вход через Discord не настроен администратором";
  }, [discordReady]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      {/* Фоновые эффекты из вашего дизайна */}
      <div className="fx-bg fx-grid" />
      <div className="fx-bg fx-glow-red" />
      <div className="fx-bg fx-noise" />

      <div className="card relative z-10 w-full max-w-md px-6 py-8 shadow-2xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div
            className="mb-4 flex items-center justify-center"
            style={{ width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg, #ff5148, #b41d1d 70%)" }}
          >
            <Radar size={24} color="#fff" />
          </div>
          <h1 className="display text-2xl font-bold">ATK RED</h1>
          <p className="text-sm mt-1 text-[var(--muted)]">Вход для бойцов подразделения</p>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            <ShieldAlert size={16} />
            {error}
          </div>
        )}
        {(notice || urlNotice) && (
          <div
            className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
            style={{ color: "var(--amber)" }}
          >
            <Info size={16} />
            {notice || urlNotice}
          </div>
        )}

        {/* Основной способ входа */}
        <button
          type="button"
          onClick={handleDiscord}
          disabled={discordLoading || discordReady === false}
          className="btn btn-primary w-full flex items-center justify-center gap-2"
        >
          {discordLoading ? <Spinner /> : <MessageCircle size={16} />}
          Войти через Discord
        </button>
        <p className="mt-2 text-[11.5px] text-center" style={{ color: "var(--dim)" }}>
          {discordHint}
        </p>

        <div className="my-5 flex items-center gap-3">
          <span className="h-px flex-1" style={{ background: "var(--stroke-soft)" }} />
          <span className="label">или</span>
          <span className="h-px flex-1" style={{ background: "var(--stroke-soft)" }} />
        </div>

        {/* Резервный способ входа */}
        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          <div>
            <label className="label mb-1.5 block">Позывной (логин)</label>
            <input
              type="text"
              className="input input-mono"
              placeholder="Скиф"
              autoComplete="username"
              value={callsign}
              onChange={(e) => setCallsign(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label mb-1.5 block">Пароль</label>
            <input
              type="password"
              className="input input-mono"
              placeholder="••••••••"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            className="btn w-full flex items-center justify-center gap-2"
            disabled={loading}
          >
            {loading ? <Spinner /> : <KeyRound size={16} />}
            Войти по паролю
          </button>
        </form>

        <div className="mt-6 border-t pt-4 text-center" style={{ borderColor: "var(--stroke-soft)" }}>
          <Link href="/apply" className="text-[13px] font-semibold" style={{ color: "var(--red)" }}>
            Подать рапорт на вступление →
          </Link>
        </div>
      </div>
    </div>
  );
}
