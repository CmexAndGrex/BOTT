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
import { Radar, ShieldAlert, MessageCircle, KeyRound, Info, FlaskConical, UserRound } from "lucide-react";
import { Spinner } from "@/components/ui";
import { safeRedirectPath } from "@/lib/validation";

/** Расшифровка кодов ошибок входа (ключи совпадают с ?error= из callback) */
const ERROR_TEXT: Record<string, string> = {
  oauth_state: "Сессия входа через Discord устарела. Попробуйте ещё раз",
  oauth_cancelled: "Вход через Discord отменён",
  oauth_failed: "Не удалось завершить вход через Discord. Попробуйте позже",
  oauth_session: "Сессия входа потеряна. Войдите заново",
  discord_taken: "Этот Discord уже привязан к другому аккаунту",
  // Discord подтверждён, но бойца с таким ID в табеле нет — объясняем, что делать
  discord_not_linked:
    "Ваш Discord аккаунт не привязан ни к одному бойцу подразделения. Обратитесь к комсоставу",
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
  /** Учётные записи для быстрого входа: пусто — блок «Dev Login» не показываем */
  const [devAccounts, setDevAccounts] = useState<
    { key: string; label: string; hint: string; callsign: string; rank: string; unit: string }[]
  >([]);
  const [devBusy, setDevBusy] = useState<string>("");
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * Куда уйти после успешного входа.
   *
   * По умолчанию — как раньше: боец в кабинет, штаб в панель. Если страница
   * пришла с `?next=` (например, боец нажал «Войти» на /profile), возвращаемся
   * туда: без этого вход уводил на «/», и человек, кликнувший «Войти» в
   * кабинете, снова попадал в кабинет через меню — цикл из отчёта.
   *
   * Путь проверяется safeRedirectPath: значение приходит из адреса, а значит
   * может быть чужим доменом («//evil.com»), и возврат после входа превратился
   * бы в открытый редирект.
   */
  const nextPath = safeRedirectPath(searchParams.get("next"), "");

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

  /**
   * Список кнопок Dev Login.
   *
   * Спрашиваем сервер, а не сверяем NODE_ENV на клиенте: переменная окружения
   * в браузер не попадает (если не объявлена как NEXT_PUBLIC_), а решение о
   * доступности отладочного входа обязан принимать сервер. Нет блока в ответе
   * (или 404) — значит режим боевой, и ничего лишнего на форме не появится.
   */
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetch("/api/auth/dev-login", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data?.ok && Array.isArray(data.accounts)) {
            setDevAccounts(data.accounts);
          }
        })
        .catch(() => {
          // Отладочный блок — не критичный: молча остаёмся без него
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  /**
   * Быстрый вход под dev-аккаунтом.
   *
   * Сессию выпускает сервер (подписанный JWT + запись в БД): подстановка cookie
   * на клиенте не сработала бы — гварды читают роль и статус из базы.
   */
  const handleDevLogin = useCallback(
    async (key: string) => {
      setError("");
      setNotice("");
      setDevBusy(key);
      try {
        const res = await fetch("/api/auth/dev-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ as: key }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setError(data.error || "Не удалось выполнить dev-вход");
          return;
        }
        router.push(nextPath || data.redirectTo || "/profile");
        router.refresh();
      } catch {
        setError("Сбой сети");
      } finally {
        setDevBusy("");
      }
    },
    [router, nextPath]
  );

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
        router.push(nextPath || "/profile");
        router.refresh();
        return;
      }

      /**
       * Боец найден, но пароля у него нет. Это не «неверные данные»: идти в
       * проверку аккаунта панели бессмысленно, а текст должен объяснить, что
       * делать (войти через Discord или попросить штаб задать пароль).
       */
      if (memberData.code === "no_password") {
        setNotice(memberData.error || "Пароль ещё не установлен");
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
        // Штаб после входа идёт в панель («/»), но если он пришёл из кабинета
        // (?next=/profile), возвращаем его туда: вход в панель открывает и
        // личное дело сразу, второй раз вводить данные не нужно.
        router.push(nextPath || "/");
        router.refresh();
        return;
      }

      // Обе ветки (боец и панель) отказали — это неверные учётные данные.
      // Плашку показываем с формулировкой ТЗ, а не с серверной строкой: у
      // member-login и /api/auth тексты разные, и боец видел бы то один, то
      // другой. Технические причины (429 — блокировка, 500 — сбой) оставляем
      // серверными: их подменять нельзя, иначе потеряется смысл ответа.
      const serverMessage =
        (typeof panelData.error === "string" && panelData.error) ||
        (typeof memberData.error === "string" && memberData.error) ||
        "";
      const isTechnical =
        panelRes.status === 500 ||
        memberRes.status === 500 ||
        panelRes.status === 429 ||
        memberRes.status === 429;

      setError(isTechnical && serverMessage ? serverMessage : "Неверный позывной или пароль");
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
      {/* Фоновые слои: бордовый отсвет и шум. Квадратной сетки нет — фон
          держат арт-обои и радиальная виньетка из BackgroundSlideshow */}
      <div className="fx-bg fx-glow-red" />
      <div className="fx-bg fx-noise" />

      <div className="card relative z-10 w-full max-w-md px-6 py-8 shadow-2xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div
            className="mb-4 flex items-center justify-center"
            style={{ width: 48, height: 48, borderRadius: 14, background: "var(--red-grad)", boxShadow: "var(--red-glow)" }}
          >
            <Radar size={24} color="#fff" />
          </div>
          <h1 className="display text-2xl font-bold">ATK RED</h1>
          <p className="text-sm mt-1 text-[var(--muted)]">Вход для бойцов подразделения</p>
        </div>

        {error && (
          <div className="alert-red mb-4 flex items-center gap-2 rounded-xl px-3 py-2 text-sm">
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
            {/* Логин — позывной, ФИО из табеля или ник Discord: бойцы помнят
                себя по-разному, а у части состава позывного нет вовсе */}
            <label className="label mb-1.5 block">Позывной, ФИО или логин</label>
            <input
              type="text"
              className="input input-mono"
              placeholder="Скиф / Вамилов И.В."
              autoComplete="username"
              value={callsign}
              onChange={(e) => setCallsign(e.target.value)}
              required
            />
            <p className="mt-1.5 text-[11px]" style={{ color: "var(--dim)" }}>
              Можно ввести позывной, ФИО из табеля или логин панели
            </p>
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

        {/* Режим разработки: быстрый вход под готовыми аккаунтами.
            Блок появляется только когда сервер подтвердил доступность:
            /api/auth/dev-login отвечает 404, если NODE_ENV=production ИЛИ не
            задан ENABLE_DEV_LOGIN=true (правило «двух ключей» в dev-accounts.ts) */}
        {devAccounts.length > 0 && (
          <div
            className="mt-6 rounded-xl border px-3 py-3"
            style={{ borderColor: "rgba(110,160,255,.28)", background: "rgba(110,160,255,.07)" }}
          >
            <div className="mb-2 flex items-center gap-2">
              <FlaskConical size={14} style={{ color: "var(--blue)" }} />
              <span className="label" style={{ color: "var(--blue)" }}>
                Режим разработки (Dev Login)
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {devAccounts.map((account) => (
                <button
                  key={account.key}
                  type="button"
                  className="btn w-full flex-col items-start gap-0.5 px-3 py-2 text-left"
                  onClick={() => void handleDevLogin(account.key)}
                  disabled={devBusy !== ""}
                >
                  <span className="flex items-center gap-2 text-[12.5px] font-semibold">
                    {devBusy === account.key ? <Spinner /> : <UserRound size={14} />}
                    {account.label}
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--dim)" }}>
                    {account.callsign} · {account.rank} · {account.unit}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px]" style={{ color: "var(--dim)" }}>
              {devAccounts[0]?.hint}
            </p>
          </div>
        )}

        <div className="mt-6 border-t pt-4 text-center" style={{ borderColor: "var(--stroke-soft)" }}>
          <Link href="/apply" className="text-[13px] font-semibold" style={{ color: "var(--red)" }}>
            Подать рапорт на вступление →
          </Link>
        </div>
      </div>
    </div>
  );
}
