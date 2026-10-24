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
import { RANK_CATALOG, normalizeSteamId64, isSteamId64 } from "@/lib/rank-catalog";
import Link from "next/link";
import {
  ClipboardList,
  ShieldAlert,
  CheckCircle2,
  MessageCircle,
  ChevronDown,
  PlayCircle,
  HelpCircle,
} from "lucide-react";
import { Spinner } from "@/components/ui";
import { PASSWORD_POLICY_HINT } from "@/lib/password-policy";
import {
  AGE_MAX,
  AGE_MIN,
  APPLICATION_KIND_LABELS,
  DEFAULT_APPLICATION_KIND,
  FULL_NAME_FORMAT_HINT,
  FULL_NAME_MAX_LENGTH,
  FULL_NAME_MIN_LENGTH,
  FULL_NAME_PLACEHOLDER,
  isFullNameWithInitials,
  PENDING_NOTICE,
  SPECIALIZATIONS,
  UNITS,
  UNIT_LABELS,
  type RecruitApplicationKind,
  type Unit,
  APPLICATION_KIND_RESERVE_RETURN,
} from "@/lib/recruits";

type Draft = { discord: { id: string; avatarUrl: string | null } | null };

export default function ApplyPage() {
  const [callsign, setCallsign] = useState("");
  const [steamId, setSteamId] = useState("");
  const [rank, setRank] = useState<(typeof RANK_CATALOG)[number]>("Рядовой");
  /**
   * Вид заявки: «Новобранец» (по умолчанию) или «Возврат из запаса».
   *
   * Возвращающийся из запаса подаёт ту же форму, но решение по ней другое:
   * бойца восстанавливают, а не зачисляют заново — его строка в Google Таблице
   * переезжает с листа «Запас» в подразделение. Поэтому вид выбирается явно,
   * а не угадывается по тексту.
   */
  const [kind, setKind] = useState<RecruitApplicationKind>(DEFAULT_APPLICATION_KIND);
  /** ФИО возвращающегося: по нему находят строку на листе «Запас» */
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  /**
   * Подразделение, в которое кандидат просится.
   *
   * Обязательный выбор: от него зависит, в какой лист ШДС попадёт боец при
   * одобрении и какую роль Discord ему выдадут. Пустое значение (не выбрано)
   * отправлять нельзя — иначе штабу пришлось бы угадывать лист, а ошибка
   * увела бы бойца не в то подразделение.
   */
  const [unit, setUnit] = useState<Unit | "">("");
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
  /**
   * Раскрыта ли видео-инструкция «Как узнать свой Discord ID».
   *
   * По умолчанию блок свёрнут: видео занимает много места и отодвигает форму,
   * а нужно оно только тем, кто не знает, где взять ID. Кому Discord ID
   * подставился из OAuth2, инструкция не нужна вовсе.
   */
  const [showIdHelp, setShowIdHelp] = useState(false);
  /**
   * Выбран возврат из запаса.
   *
   * От этого зависит и набор полей (ФИО — только для возврата; анкета у
   * возвращающегося необязательна), и тексты страницы, поэтому признак
   * считается один раз и используется в разметке.
   */
  const isReserveReturn = kind === APPLICATION_KIND_RESERVE_RETURN;

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

    /**
     * Подразделение — обязательный выбор. Проверка на клиенте повторяет
     * серверную (роут /api/apply отвечает 400 на пустое значение): форма
     * показывает подсказку сразу, а не после круга «отправил — ошибка».
     */
    if (!isSteamId64(steamId)) {
      setError("Введите корректный Steam ID64: 17 цифр, начинается с 7656119");
      return;
    }
    if (!unit) {
      setError("Выберите подразделение: Танковая рота или Артиллерийский дивизион");
      return;
    }

    /**
     * Клиентская проверка ФИО идёт до сети: сервер отклонит ту же строку, но
     * здесь кандидат видит подсказку сразу, без круга «отправил — ошибка».
     * Правило одно на оба места — isFullNameWithInitials из lib/recruits.
     */
    if (!isFullNameWithInitials(fullName)) {
      setError(FULL_NAME_FORMAT_HINT);
      return;
    }

    setSending(true);

    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callsign,
          steamId,
          rank,
          password,
          // Подразделение из формы: сохраняется в recruit_applications.unit и
          // определяет лист ШДС и роль Discord при зачислении
          unit,
          age,
          armaExperience,
          specialization,
          comment,
          // Поле уходит как есть: сервер сам решает, доверять cookie или вводу
          discordId: discordLinked ? "" : discordId,
          // Логин/глобальное имя Discord: офицер по нему найдёт кандидата
          discordTag,
          // Вид заявки и ФИО: сервер сам проверит ФИО для возврата из запаса
          kind,
          fullName,
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
        <div className="eyebrow mb-2">
          набор // {kind === APPLICATION_KIND_RESERVE_RETURN ? "возврат из запаса" : "новобранец"}
        </div>
        <h1 className="display text-[30px] font-black leading-tight flex items-center gap-3">
          <ClipboardList style={{ color: "var(--red)" }} size={32} />
          {kind === APPLICATION_KIND_RESERVE_RETURN ? "Рапорт на возврат из запаса" : "Рапорт на вступление"}
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          {kind === APPLICATION_KIND_RESERVE_RETURN
            ? "Укажите ФИО, позывной и пароль: штаб восстановит вашу строку в подразделении, а прежние роли Discord вернутся."
            : "Заполните анкету — штаб рассмотрит её и зачислит вас в подразделение. Позывной и пароль нужны для входа в личный кабинет."}
        </p>
      </header>

      {error && (
        <div className="alert-red mb-4 flex items-center gap-2 rounded-xl px-3 py-2 text-sm">
          <ShieldAlert size={16} />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="card flex flex-col gap-5 p-6">
        {/**
          * Вид заявки выбирается первым: от него зависит и набор полей (ФИО —
          * только для возврата), и решение штаба. Переключатель, а не поле
          * ввода: значения фиксированы доменом (RECRUIT_APPLICATION_KINDS).
          */}
        <div>
          <label className="label mb-1.5 block">Вид заявки</label>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(APPLICATION_KIND_LABELS) as RecruitApplicationKind[]).map((option) => (
              <button
                key={option}
                type="button"
                className="chip"
                onClick={() => setKind(option)}
                style={
                  kind === option
                    ? { borderColor: "rgba(190,18,60,.5)", background: "var(--red-soft)", color: "#fff" }
                    : { cursor: "pointer" }
                }
              >
                <span className={`dot ${kind === option ? "dot-err" : "dot-dim"}`} />
                {APPLICATION_KIND_LABELS[option]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
            {kind === APPLICATION_KIND_RESERVE_RETURN
              ? "Возврат из запаса: штаб восстановит вашу строку в подразделении и вернёт прежние роли Discord"
              : "Новобранец: первичный приём в подразделение"}
          </p>
        </div>

        {/**
         * Подразделение — обязательный выбор.
         *
         * От него зависит лист ШДС (shds_sheet_tank / shds_sheet_art) и роль
         * Discord, поэтому переключатель, а не свободный текст: значения
         * фиксированы доменом (UNITS). Карточки вместо radio — так на телефоне
         * видно и название, и сокращение (ТР/АД), и нажатие по большой
         * площади не требует попадания в кружок.
         */}
        <div>
          <label className="label mb-1.5 block">
            Подразделение <span style={{ color: "var(--red)" }}>*</span>
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Подразделение">
            {UNITS.map((option) => {
              const selected = unit === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className="rounded-xl px-4 py-3 text-left transition"
                  onClick={() => setUnit(option)}
                  style={{
                    border: `1px solid ${selected ? "rgba(190,18,60,.55)" : "var(--stroke-soft)"}`,
                    background: selected ? "var(--red-soft)" : "rgba(255,255,255,.02)",
                    color: selected ? "#fff" : "var(--muted)",
                    cursor: "pointer",
                  }}
                >
                  <span className="flex items-center gap-2 text-[13px] font-bold">
                    <span className={`dot ${selected ? "dot-err" : "dot-dim"}`} />
                    {UNIT_LABELS[option]}
                  </span>
                  <span className="mt-1 block text-[11.5px]" style={{ color: "var(--dim)" }}>
                    {option === "Танковая рота"
                      ? "Экипажи боевых машин, мехводы, наводчики"
                      : "Расчёты орудий, разведка и корректировка"}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
            {isReserveReturn
              ? "Укажите подразделение, в котором вы служили: в него же вернётся ваша строка в ШДС"
              : "Подразделение определяет лист ШДС и роль Discord, которые будут выданы при зачислении"}
          </p>
        </div>

        {/**
         * ФИО спрашивается всегда.
         *
         * Для возврата из запаса оно ищет строку на листе «Запас», а для
         * новобранца — служит вторым ключом поиска бойца в составе при
         * одобрении: без него защита от дублей опиралась бы только на Discord ID,
         * а кандидат без Discord заводил бы вторую карточку.
         */}
        <div>
          <label className="label mb-1.5 block">ФИО (как в табеле)</label>
          <input
            className="input w-full"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={FULL_NAME_PLACEHOLDER}
            minLength={FULL_NAME_MIN_LENGTH}
            maxLength={FULL_NAME_MAX_LENGTH}
            required
          />
          <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
            {FULL_NAME_FORMAT_HINT}
            {kind === APPLICATION_KIND_RESERVE_RETURN
              ? ". Именно по ФИО бот находит вашу строку на листе «Запас»"
              : ". По ФИО штаб сверит вас с составом, чтобы не завести вторую карточку"}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="label mb-1.5 block">Steam ID64 <span style={{ color: "var(--red)" }}>*</span></label>
            <input className="input input-mono w-full" value={steamId} onChange={(e) => setSteamId(normalizeSteamId64(e.target.value))} placeholder="7656119XXXXXXXXXX" inputMode="numeric" maxLength={17} required />
          </div>
          <div>
            <label className="label mb-1.5 block">Звание <span style={{ color: "var(--red)" }}>*</span></label>
            <select className="select w-full" value={rank} onChange={(e) => setRank(e.target.value as (typeof RANK_CATALOG)[number])} required>
              {RANK_CATALOG.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
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
              // Возвращающегося возраст уже не спрашивают: он служил, и данные
              // давно в табеле — обязательность полей зависит от вида заявки
              required={!isReserveReturn}
            />
          </div>
          <div>
            <label className="label mb-1.5 block">
              Специализация{isReserveReturn ? " (необязательно)" : ""}
            </label>
            <input
              className="input w-full"
              list="specializations"
              value={specialization}
              onChange={(e) => setSpecialization(e.target.value)}
              placeholder="Танкист (наводчик)"
              required={!isReserveReturn}
            />
            <datalist id="specializations">
              {SPECIALIZATIONS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
        </div>

        <div>
          <label className="label mb-1.5 block">
            Опыт в Arma 3{isReserveReturn ? " (необязательно)" : ""}
          </label>
          <textarea
            className="input w-full"
            rows={3}
            value={armaExperience}
            onChange={(e) => setArmaExperience(e.target.value)}
            placeholder="600 часов, 3 года, участвовал в операциях на серверах..."
            required={!isReserveReturn}
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

          {/**
           * Шпаргалка с видео: раскрывающийся блок, а не модальное окно.
           * Причина: модальное окно перекрывает форму и на телефоне его легко
           * закрыть случайно, потеряв уже введённые данные. Аккордеон живёт
           * внутри формы и ничего не блокирует.
           */}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowIdHelp((open) => !open)}
              aria-expanded={showIdHelp}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[12.5px]"
              style={{
                border: "1px solid var(--stroke-soft)",
                background: "rgba(255,255,255,.02)",
                color: "var(--muted)",
                cursor: "pointer",
              }}
            >
              <span className="flex items-center gap-2">
                <HelpCircle size={14} style={{ color: "var(--red)" }} />
                Как узнать свой Discord ID (видео-инструкция)
              </span>
              <ChevronDown
                size={15}
                style={{
                  transform: showIdHelp ? "rotate(180deg)" : "none",
                  transition: "transform .15s ease",
                }}
              />
            </button>

            {showIdHelp && (
              <div
                className="mt-2 rounded-lg p-3"
                style={{ border: "1px solid var(--stroke-soft)" }}
              >
                {/**
                 * Файл лежит в public/video/Instr.mov (фактическое расширение
                 * проверено в репозитории). Chrome/Edge играют .mov с H.264,
                 * Safari — тоже; ссылка на скачивание оставлена на случай
                 * экзотического кодека, где плеер покажет пустой кадр.
                 */}
                <video
                  src="/video/Instr.mov"
                  controls
                  preload="metadata"
                  playsInline
                  className="w-full rounded-lg border border-neutral-700"
                >
                  Ваш браузер не поддерживает встроенное видео.
                  <a href="/video/Instr.mov">Скачать инструкцию</a>
                </video>
                <div
                  className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed"
                  style={{ color: "var(--muted)" }}
                >
                  <PlayCircle size={14} className="mt-0.5 flex-none" style={{ color: "var(--red)" }} />
                  <span>
                    Настройки Discord → Расширенные → Включить режим разработчика → Правый клик
                    по своему профилю → Скопировать ID пользователя.
                  </span>
                </div>
                <p className="mt-2 text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Не открывается видео?{" "}
                  <a href="/video/Instr.mov" download className="underline">
                    Скачайте файл
                  </a>{" "}
                  — он откроется любым плеером.
                </p>
              </div>
            )}
          </div>
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