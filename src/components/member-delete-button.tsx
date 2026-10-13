"use client";

/**
 * Удаление профиля бойца из табеля «Состав» — только администратор.
 *
 * Кнопка рендерится исключительно при роли admin (признак isAdmin приходит из
 * /api/me, то есть право считает сервер). Командиру и офицеру кнопки не
 * показываем: правка состава им доступна, а уничтожение личного дела — нет, и
 * интерфейс не должен предлагать действие, на которое сервер отвечает 403.
 *
 * Защита от случайного клика двойная:
 *   * окно с предупреждением вместо немедленного запроса;
 *   * ввод позывного бойца (или его имени, если позывной не задан) — ровно то
 *     же значение требует сервер (memberDeletionConfirmationMatches). Кнопка
 *     «Удалить безвозвратно» заблокирована, пока ввод не совпал.
 *
 * Формулировки подтверждения и тексты предупреждения берём из общего модуля
 * правил (src/lib/member-deletion.ts): копия правила в компоненте разошлась бы
 * с проверкой на сервере, и админ видел бы «Неверный позывной» при верном вводе.
 */
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Trash2, X } from "lucide-react";
import { Spinner } from "@/components/ui";
import {
  memberDeletionConfirmationMatches,
  memberDeletionConfirmationLabel,
} from "@/lib/member-deletion";

/** Боец, чей профиль удаляется: id для запроса, позывной и имя для окна */
export type MemberDeleteTarget = {
  id: number;
  name: string;
  callsign: string | null;
};

/** Итог удаления: сообщение для уведомления или причина отказа */
export type MemberDeleteResult = { ok: boolean; message?: string; error?: string };

export function MemberDeleteButton({
  member,
  onDelete,
}: {
  member: MemberDeleteTarget;
  /** Удаление: строку из таблицы убирает вызывающая сторона */
  onDelete: (id: number, confirmation: string) => Promise<MemberDeleteResult>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);

  /** Подтверждение в окне: позывной бойца либо имя, если позывного нет */
  const expected = memberDeletionConfirmationLabel(member);
  const confirmed = memberDeletionConfirmationMatches(draft, member);

  const start = () => {
    setDraft("");
    setError("");
    setOpen(true);
  };

  const close = () => {
    if (deleting) return;
    setOpen(false);
    setError("");
  };

  const submit = async () => {
    if (!confirmed || deleting) return;
    setDeleting(true);
    setError("");
    try {
      const result = await onDelete(member.id, draft);
      if (!result.ok) {
        setError(result.error || "Не удалось удалить профиль");
        return;
      }
      setOpen(false);
      setDraft("");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={start}
        className="btn btn-sm btn-icon"
        style={{ color: "var(--red)" }}
        title={`Удалить профиль бойца ${expected}`}
        aria-label={`Удалить профиль бойца ${expected}`}
      >
        <Trash2 size={13} />
      </button>

      <AnimatePresence>
        {open && (
          <MemberDeleteDialog
            member={member}
            expected={expected}
            draft={draft}
            error={error}
            deleting={deleting}
            confirmed={confirmed}
            onDraft={setDraft}
            onClose={close}
            onSubmit={submit}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * Окно подтверждения.
 *
 * Отдельной функцией файла, а не внутри рендера: компонент, созданный в
 * рендере, ESLint справедливо считает ошибкой (react-hooks/static-components) —
 * его состояние сбрасывалось бы при каждой перерисовке родителя, и введённый
 * позывной пропадал бы.
 */
function MemberDeleteDialog({
  member,
  expected,
  draft,
  error,
  deleting,
  confirmed,
  onDraft,
  onClose,
  onSubmit,
}: {
  member: MemberDeleteTarget;
  expected: string;
  draft: string;
  error: string;
  deleting: boolean;
  confirmed: boolean;
  onDraft: (value: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
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
      aria-label={`Удаление профиля бойца ${expected}`}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 14 }}
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        className="card my-10 w-full max-w-[460px]"
        style={{
          background: "var(--modal)",
          backdropFilter: "blur(14px)",
          // Рамка в опасных тонах: окно отличается от обычной правки ещё до чтения
          borderColor: "rgba(190,18,60,0.55)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--stroke-soft)" }}
        >
          <div className="flex items-center gap-2.5">
            <AlertTriangle size={16} style={{ color: "var(--red)", flex: "none" }} />
            <div>
              <div className="label mb-0.5">состав // удаление профиля</div>
              <h2 className="display text-[14px] font-bold">{expected}</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-sm btn-icon"
            disabled={deleting}
            title="Закрыть"
            aria-label="Закрыть окно"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            Вы действительно хотите удалить профиль бойца{" "}
            <strong style={{ color: "var(--text)" }}>{expected}</strong>? Это действие
            необратимо: будут удалены допуски, история и привязка к Discord.
          </p>

          <div className="alert-red rounded px-3 py-2.5 text-[12px] leading-relaxed">
            Учётная запись панели останется рабочей — она лишь потеряет связь с бойцом.
            Рапорты и заявки сохранятся в истории штаба с позывным вместо привязки к карточке.
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="label">Для подтверждения введите «{expected}»</span>
            <input
              className="input w-full"
              value={draft}
              disabled={deleting}
              autoFocus
              placeholder={expected}
              aria-label={`Подтверждение удаления: введите ${expected}`}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && confirmed) void onSubmit();
                if (e.key === "Escape") onClose();
              }}
            />
          </label>

          {error ? (
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--red)" }}>
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" className="btn btn-sm" onClick={onClose} disabled={deleting}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              // Кнопка активна только при совпавшем подтверждении: необратимое
              // действие нельзя совершить одним промахом по клавише
              disabled={!confirmed || deleting}
              onClick={() => void onSubmit()}
            >
              {deleting ? <Spinner /> : <Trash2 size={13} />} Удалить безвозвратно
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}