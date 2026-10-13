"use client";

/**
 * Ячейка «Discord ID» в табеле «Состав» — быстрая правка для администратора.
 *
 * Раньше ID правился обычным полем ввода прямо в таблице: правка уходила в базу
 * панели, но не в Google Таблицу ШДС, и колонка расходилась с таблицей. Теперь
 * значение проходит проверку общим валидатором (validateRosterDiscordId — те же
 * 17–19 цифр, что требует сервер) и уезжает в PATCH
 * /api/admin/roster/[id]/discord-id, который пишет и в PostgreSQL, и в лист ШДС.
 *
 * Окно сделано модальным, а не инлайн: колонка узкая, и поле без пояснений
 * выглядело бы как случайный ввод. В окне видно, кто именно правится, требование
 * к формату и предупреждение, если таблица не обновилась.
 */
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link2, Pencil, Save, Trash2, X } from "lucide-react";
import { Spinner } from "@/components/ui";
import {
  ROSTER_DISCORD_ID_MAX_LENGTH,
  ROSTER_DISCORD_ID_MIN_LENGTH,
  validateRosterDiscordId,
} from "@/lib/validation";

/** Результат сохранения: warning — правка в базе есть, но таблица не обновилась */
export type DiscordIdSaveResult = {
  ok: boolean;
  error?: string;
  warning?: string | null;
};

/** Боец, чей ID правится: id для запроса, имя и подразделение для окна */
export type DiscordIdTarget = {
  id: number;
  name: string;
  callsign: string | null;
  unit: string | null;
  discordId: string | null;
};

export function DiscordIdCell({
  member,
  onSave,
}: {
  member: DiscordIdTarget;
  /** Сохранение: обновление строки и сводки делает вызывающая сторона */
  onSave: (id: number, discordId: string) => Promise<DiscordIdSaveResult>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const current = member.discordId ?? "";

  /** Открытие окна: черновик заполняется текущим значением, ошибки сбрасываются */
  const start = () => {
    setDraft(current);
    setError("");
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setError("");
  };

  const submit = async (value: string) => {
    // Проверка на клиенте тем же валидатором, что и на сервере: формулировка
    // требования совпадает с ответом API, человек видит её до отправки
    const validated = validateRosterDiscordId(value);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    // Значение не изменилось — окно просто закрывается, запрос не нужен
    if (validated.value === (current || null)) {
      close();
      return;
    }

    setSaving(true);
    setError("");
    try {
      const result = await onSave(member.id, validated.value ?? "");
      if (!result.ok) {
        setError(result.error || "Не удалось сохранить");
        return;
      }
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={start}
        className="group inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-[rgba(255,255,255,0.05)]"
        title={member.discordId ? `Discord ID: ${member.discordId} — нажмите, чтобы изменить` : "Указать Discord ID"}
        aria-label={member.discordId ? `Изменить Discord ID бойца ${member.name}` : `Указать Discord ID бойца ${member.name}`}
      >
        {member.discordId ? (
          <>
            <Link2 size={13} style={{ color: "var(--green)", flex: "none" }} />
            <span className="mono text-[12.5px]">{member.discordId}</span>
          </>
        ) : (
          <span className="mono text-[12.5px]" style={{ color: "var(--dim)" }}>—</span>
        )}
        <Pencil size={12} style={{ color: "var(--dim)", flex: "none" }} />
      </button>

      <AnimatePresence>
        {open && (
          <DiscordIdDialog
            member={member}
            draft={draft}
            error={error}
            saving={saving}
            onDraft={setDraft}
            onClose={close}
            onSubmit={submit}
            hasCurrent={!!current}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * Модальное окно правки.
 *
 * Вынесено отдельной функцией файла (а не объявлено внутри рендера): компонент,
 * созданный в рендере, ESLint справедливо считает ошибкой
 * (react-hooks/static-components) — его состояние сбрасывалось бы на каждом
 * обновлении родителя, и введённый ID пропадал бы при первой же перерисовке.
 */
function DiscordIdDialog({
  member,
  draft,
  error,
  saving,
  hasCurrent,
  onDraft,
  onClose,
  onSubmit,
}: {
  member: DiscordIdTarget;
  draft: string;
  error: string;
  saving: boolean;
  hasCurrent: boolean;
  onDraft: (value: string) => void;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
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
      aria-label={`Discord ID бойца ${member.name}`}
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
          borderColor: "rgba(190,18,60,0.28)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--stroke-soft)" }}
        >
          <div>
            <div className="label mb-0.5">правка состава // Discord ID</div>
            <h2 className="display text-[14px] font-bold">{member.callsign || member.name}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-sm btn-icon"
            title="Закрыть"
            aria-label="Закрыть окно"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            ID сохраняется в панель и в Google Таблицу ШДС
            {member.unit ? ` (лист «${member.unit}»).` : ": подразделение бойцу не назначено."}
          </p>

          <div className="relative">
            <input
              className="input input-mono w-full"
              style={{ paddingRight: "2.2rem" }}
              placeholder="Например, 1085141850966458519"
              value={draft}
              disabled={saving}
              autoFocus
              inputMode="numeric"
              onChange={(e) => onDraft(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSubmit(draft);
                if (e.key === "Escape") onClose();
              }}
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
              {saving ? (
                <Spinner />
              ) : draft ? (
                <Link2 size={13} style={{ color: "var(--green)" }} />
              ) : (
                <Trash2 size={13} style={{ color: "var(--dim)" }} />
              )}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11.5px]" style={{ color: "var(--dim)" }}>
              {draft
                ? `${draft.length} цифр (нужно ${ROSTER_DISCORD_ID_MIN_LENGTH}–${ROSTER_DISCORD_ID_MAX_LENGTH})`
                : "Пустое поле — привязка будет снята"}
            </span>
            {hasCurrent ? (
              <button
                type="button"
                className="btn btn-sm"
                style={{ color: "var(--red)" }}
                disabled={saving}
                onClick={() => void onSubmit("")}
              >
                <Trash2 size={13} /> Снять ID
              </button>
            ) : null}
          </div>

          {error ? (
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--red)" }}>
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" className="btn btn-sm" onClick={onClose} disabled={saving}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={saving}
              onClick={() => void onSubmit(draft)}
            >
              {saving ? <Spinner /> : <Save size={13} />} Сохранить
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}