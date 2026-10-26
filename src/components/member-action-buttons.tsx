"use client";

/**
 * Административные действия «В запас» и «Уволить» — кнопки и окно подтверждения.
 *
 * Используется в двух местах: в строке табеля (/members) и в шапке досье
 * (/profile). Кнопки рендерятся только штабу (право считает сервер через
 * /api/me), а защита цели — по общему правилу isProtectedLifecycleTarget из
 * member-lifecycle.ts: командование корпуса и сам пользователь кнопок не
 * видят вовсе, чтобы не предлагать действие, на которое сервер ответит 403.
 *
 * Защита от случайного нажатия: модальное окно подтверждения (ConfirmActionModal)
 * с ФИО, званием, подразделением, предупреждением о последствиях и полем
 * причины (опционально, уходит в аудит-лог). Кнопка подтверждения показывает
 * индикатор загрузки (isPending) и блокируется на время запроса.
 */
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Archive, ShieldAlert, UserX, X } from "lucide-react";
import { Spinner } from "@/components/ui";
import {
  isProtectedLifecycleTarget,
  memberActionLabel,
  type MemberAction,
} from "@/lib/member-lifecycle";

/** Боец, над которым выполняется действие */
export type MemberActionTarget = {
  id: number;
  name: string;
  rank: string | null;
  unit: string | null;
  post: string | null;
  discordId: string | null;
  status: string | null;
};

/** Итог действия: сообщение для уведомления или причина отказа */
export type MemberActionResult = { ok: boolean; message?: string; error?: string };

/**
 * Кнопки действий.
 *
 * `selfMemberId` — ID бойца текущей сессии (нельзя уволить самого себя).
 * Кнопки скрыты (а не disabled) для защищённых целей: disabled-кнопка
 * «Уволить» рядом с командиром корпуса провоцировала бы вопрос «а почему
 * нельзя», а скрытие оставляет интерфейс чистым.
 */
export function MemberActionButtons({
  member,
  selfMemberId,
  onAction,
  disabled = false,
  compact = false,
}: {
  member: MemberActionTarget;
  /** ID бойца сессии (из /api/me → member.id); null — карточки нет */
  selfMemberId: number | null;
  /** Выполнение: запрос уходит в вызывающий компонент (он ведёт notice и reload) */
  onAction: (id: number, action: MemberAction, reason: string) => Promise<MemberActionResult>;
  /** Блокировка на время чужой операции с этим бойцом */
  disabled?: boolean;
  /** Компактный режим для строки табеля: только иконки */
  compact?: boolean;
}) {
  const [pending, setPending] = useState<MemberAction | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Защита цели: командование корпуса и сам пользователь — кнопок нет вовсе
  const isSelf = typeof selfMemberId === "number" && member.id === selfMemberId;
  const isProtected = isProtectedLifecycleTarget(member);
  if (isSelf || isProtected) return null;

  const start = (action: MemberAction) => {
    setPending(action);
    setReason("");
    setError("");
  };

  const close = () => {
    if (busy) return;
    setPending(null);
    setError("");
  };

  const submit = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await onAction(member.id, pending, reason.trim());
      if (!result.ok) {
        setError(result.error || "Не удалось выполнить действие");
        return;
      }
      setPending(null);
      setReason("");
    } finally {
      setBusy(false);
    }
  };

  const reserveStyle = {
    color: "var(--amber)",
    borderColor: "rgba(255,176,32,.45)",
    background: "rgba(255,176,32,.08)",
  };
  const dismissStyle = {
    color: "var(--red)",
    borderColor: "rgba(190,18,60,.45)",
    background: "rgba(190,18,60,.08)",
  };

  return (
    <>
      <div className={compact ? "inline-flex items-center gap-1.5" : "flex flex-wrap items-center gap-2"}>
        <button
          type="button"
          className="btn btn-sm"
          style={reserveStyle}
          disabled={disabled || busy}
          title={`Перевести ${member.name} в запас`}
          aria-label={`Перевести ${member.name} в запас`}
          onClick={() => start("reserve")}
        >
          <Archive size={13} />
          {!compact && "В запас"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          style={dismissStyle}
          disabled={disabled || busy}
          title={`Уволить ${member.name}`}
          aria-label={`Уволить ${member.name}`}
          onClick={() => start("dismiss")}
        >
          <UserX size={13} />
          {!compact && "Уволить"}
        </button>
      </div>

      <AnimatePresence>
        {pending && (
          <ConfirmActionModal
            member={member}
            action={pending}
            reason={reason}
            error={error}
            busy={busy}
            onReason={setReason}
            onClose={close}
            onSubmit={submit}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * Окно подтверждения действия.
 *
 * Отдельной функцией файла, а не внутри рендера: компонент, созданный в
 * рендере, ESLint считает ошибкой (react-hooks/static-components) — его
 * состояние сбрасывалось бы при каждой перерисовке родителя.
 */
function ConfirmActionModal({
  member,
  action,
  reason,
  error,
  busy,
  onReason,
  onClose,
  onSubmit,
}: {
  member: MemberActionTarget;
  action: MemberAction;
  reason: string;
  error: string;
  busy: boolean;
  onReason: (value: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const isReserve = action === "reserve";
  const accent = isReserve ? "var(--amber)" : "var(--red)";
  const accentBorder = isReserve ? "rgba(255,176,32,0.5)" : "rgba(190,18,60,0.55)";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      style={{ background: "var(--overlay)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${memberActionLabel(action)}: ${member.name}`}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 14 }}
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        className="card my-10 w-full max-w-[460px]"
        style={{ background: "var(--modal)", backdropFilter: "blur(14px)", borderColor: accentBorder }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--stroke-soft)" }}
        >
          <div className="flex items-center gap-2.5">
            {isReserve ? (
              <Archive size={16} style={{ color: accent, flex: "none" }} />
            ) : (
              <UserX size={16} style={{ color: accent, flex: "none" }} />
            )}
            <div>
              <div className="label mb-0.5">состав // {isReserve ? "перевод в запас" : "увольнение"}</div>
              <h2 className="display text-[14px] font-bold">{member.name}</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-sm btn-icon"
            disabled={busy}
            title="Закрыть"
            aria-label="Закрыть окно"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Карточка бойца: ФИО, звание, подразделение — то, что сверяет штаб */}
          <div
            className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-[12px]"
            style={{ background: "rgba(255,255,255,.03)", border: "1px solid var(--stroke-soft)" }}
          >
            <span className="font-semibold">{member.name}</span>
            {member.rank && (
              <span className="chip" style={{ fontSize: "0.68rem" }}>
                {member.rank}
              </span>
            )}
            {member.unit && (
              <span className="chip" style={{ fontSize: "0.68rem" }}>
                {member.unit}
              </span>
            )}
            {member.post && (
              <span className="chip" style={{ fontSize: "0.68rem" }}>
                {member.post}
              </span>
            )}
          </div>

          {/* Предупреждение о последствиях: перенос строки ШДС и роли Discord */}
          <div
            className="rounded-xl px-3 py-2.5 text-[12px] leading-relaxed"
            style={{
              background: isReserve ? "rgba(255,176,32,.07)" : "rgba(190,18,60,.08)",
              border: `1px solid ${accentBorder}`,
              color: "var(--muted)",
            }}
          >
            {isReserve ? (
              <>
                Строка бойца в Google Таблице будет перенесена на лист «Запас» (с отметками
                экзаменов), слот на листе подразделения станет «Вакант». В Discord будут сняты
                роли подразделения и боевых допусков, выдана роль «Запас». Звание сохраняется.
              </>
            ) : (
              <>
                Строка бойца в Google Таблице будет очищена («Вакант» или удаление из листа
                «Запас»). В Discord будут сняты все служебные роли: звание, подразделение,
                допуски к технике. Действие обратимо только повторным зачислением.
              </>
            )}
          </div>

          {/* Причина: опциональна, сохраняется в аудит-лог */}
          <label className="flex flex-col gap-1.5">
            <span className="label">Причина (необязательно, для журнала)</span>
            <textarea
              className="input w-full resize-none"
              rows={2}
              maxLength={500}
              value={reason}
              disabled={busy}
              placeholder={isReserve ? "Например: долгий отпуск по личным обстоятельствам" : "Например: неявка на сборы без предупреждения"}
              aria-label="Причина действия"
              onChange={(e) => onReason(e.target.value)}
            />
          </label>

          {error ? (
            <div
              className="flex items-center gap-2 rounded-xl px-3 py-2.5"
              style={{ background: "rgba(190,18,60,.08)", border: "1px solid rgba(190,18,60,.35)" }}
            >
              <ShieldAlert size={15} style={{ color: "var(--red)", flex: "none" }} />
              <span className="text-[12.5px]" style={{ color: "var(--red)" }}>
                {error}
              </span>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void onSubmit()}
              style={{ background: accent, borderColor: accentBorder }}
            >
              {busy ? <Spinner /> : isReserve ? <Archive size={13} /> : <UserX size={13} />}
              {isReserve ? "Перевести в запас" : "Уволить"}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
