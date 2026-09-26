"use client";

/**
 * Компоненты подачи рапортов: форма по типу рапорта и список своих рапортов.
 *
 * Вынесены из страницы /reports, чтобы та читалась как последовательность
 * состояний (загрузка → вход → форма), а не как «простыня» разметки. Логика
 * проверки не дублируется: используется validateReportPayload() из
 * src/lib/reports.ts — тот же валидатор, что и в API.
 */
import React, { useMemo, useState } from "react";
import { Send } from "lucide-react";
import { Section, Spinner, fmtDate } from "@/components/ui";
import {
  EXAM_GRADES,
  REPORT_TYPE_META,
  REPORT_TEXT_MAX,
  SHDS_ENTRY_RANKS,
  SHDS_ENTRY_UNITS,
  examCatalog,
  findExam,
  formatIsoDate,
  reportTypeMeta,
  reviewStatusLabel,
  summarizeReport,
  type ExamItem,
  type ReportPayload,
  type ServiceReportType,
} from "@/lib/reports";
import type { MemberRole } from "@/lib/recruits";

export type SessionMember = {
  id: number;
  callsign: string;
  rank: string;
  unit: string | null;
  status: string;
  statusLabel: string;
  role: MemberRole;
  roleLabel: string;
  discordId: string | null;
};

export type ReportRow = {
  id: number;
  type: ServiceReportType;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  moderatorComment: string | null;
  reviewedBy: string | null;
  typeLabel: string;
  typeIcon: string;
  payload: ReportPayload;
};

/** Статус рапорта → оформление бейджа (как в разделе модерации) */
const STATUS_BADGE: Record<ReportRow["status"], string> = {
  pending: "badge-amber",
  approved: "badge-green",
  rejected: "badge-red",
};

/** Сегодняшняя дата в формате input[type=date] — для значений по умолчанию */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ReportForm({
  member,
  type,
  sending,
  onPickType,
  onSubmit,
}: {
  member: SessionMember | null;
  type: ServiceReportType | null;
  sending: boolean;
  onPickType: (type: ServiceReportType) => void;
  onSubmit: (
    type: ServiceReportType,
    payload: unknown,
    reset: () => void
  ) => Promise<void> | void;
}) {
  if (!type) {
    return <TypePicker onPick={onPickType} />;
  }

  const meta = reportTypeMeta(type);

  return (
    <Section
      title={`${meta.icon} ${meta.label}`}
      eyebrow="подача рапорта"
      action={
        <button type="button" className="btn btn-sm" onClick={() => onPickType(type)}>
          Другой тип
        </button>
      }
    >
      <div className="p-5">
        {type === "exam" && <ExamForm member={member} sending={sending} onSubmit={onSubmit} />}
        {type === "role" && <RoleForm sending={sending} onSubmit={onSubmit} />}
        {type === "vacation" && <VacationForm sending={sending} onSubmit={onSubmit} />}
        {type === "reserve" && <ReserveForm sending={sending} onSubmit={onSubmit} />}
        {type === "shds_entry" && <ShdsEntryForm member={member} sending={sending} onSubmit={onSubmit} />}
      </div>
    </Section>
  );
}

/**
 * Запрос на специальность / роль.
 *
 * Свободный текст: специальностей в подразделении много, а фиксированный
 * список мешал бы писать «наводчик орудия 2-го расчёта». В панели штаб видит
 * запрос и подтверждает должность; звания автоматически не меняются.
 */
function RoleForm({
  sending,
  onSubmit,
}: {
  sending: boolean;
  onSubmit: (type: ServiceReportType, payload: unknown, reset: () => void) => Promise<void> | void;
}) {
  const [role, setRole] = useState("");
  const [post, setPost] = useState("");
  const [comment, setComment] = useState("");
  const reset = () => {
    setRole("");
    setPost("");
    setComment("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit("role", { role, post, comment }, reset);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className="label mb-1.5 block">Желаемая специальность / роль</label>
          <input
            className="input w-full"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Наводчик орудия, разведчик-корректировщик"
            required
          />
        </div>
        <div>
          <label className="label mb-1.5 block">Должность (необязательно)</label>
          <input
            className="input w-full"
            value={post}
            onChange={(e) => setPost(e.target.value)}
            placeholder="Командир отделения"
          />
        </div>
      </div>
      <div>
        <label className="label mb-1.5 block">Комментарий</label>
        <textarea
          className="input w-full"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Опыт, обоснование, рекомендации командира"
          maxLength={REPORT_TEXT_MAX}
        />
      </div>
      <FormFooter sending={sending} hint="Штаб подтвердит роль и выдаст её в Discord отдельно" />
    </form>
  );
}

/** Рапорт на отпуск: диапазон дат и причина */
function VacationForm({
  sending,
  onSubmit,
}: {
  sending: boolean;
  onSubmit: (type: ServiceReportType, payload: unknown, reset: () => void) => Promise<void> | void;
}) {
  const today = todayIso();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState("");
  const reset = () => {
    setFrom(today);
    setTo(today);
    setReason("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit("vacation", { from, to, reason }, reset);
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className="label mb-1.5 block">С даты</label>
          <input
            type="date"
            className="input input-mono w-full"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label mb-1.5 block">По дату (день возвращения)</label>
          <input
            type="date"
            className="input input-mono w-full"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            required
          />
        </div>
      </div>
      <div>
        <label className="label mb-1.5 block">Причина</label>
        <textarea
          className="input w-full"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Отпуск на работе, сессия, семейные обстоятельства"
          maxLength={REPORT_TEXT_MAX}
          required
        />
      </div>
      <FormFooter
        sending={sending}
        hint="При одобрении вы получите роль «Отпуск», а дата возвращения попадёт в кабинет"
      />
    </form>
  );
}
function TypePicker({ onPick }: { onPick: (type: ServiceReportType) => void }) {
  return (
    <Section title="Подать рапорт" eyebrow="выберите тип">
      <div className="grid grid-cols-1 gap-3 p-5 md:grid-cols-2">
        {REPORT_TYPE_META.map((item) => (
          <button
            key={item.type}
            type="button"
            onClick={() => onPick(item.type)}
            className="card card-hover text-left px-4 py-3.5"
            style={{ background: "rgba(255,255,255,0.02)", cursor: "pointer" }}
          >
            <div className="flex items-center gap-2.5">
              <span aria-hidden style={{ fontSize: "1.1rem" }}>
                {item.icon}
              </span>
              <span className="text-[13.5px] font-semibold">{item.label}</span>
            </div>
            <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--dim)" }}>
              {item.hint}
            </p>
          </button>
        ))}
      </div>
    </Section>
  );
}

/**
 * Рапорт на экзамены: пакетный выбор нормативов чекбоксами.
 *
 * Список нормативов берётся из examCatalog() по подразделению бойца, а поле
 * оценки раскрывается только для нормативов, где она предусмотрена (КМБТ —
 * базовый экзамен и сдаётся без оценки: то же правило в gsheets.ts).
 */
function ExamForm({
  member,
  sending,
  onSubmit,
}: {
  member: SessionMember | null;
  sending: boolean;
  onSubmit: (type: ServiceReportType, payload: unknown, reset: () => void) => Promise<void> | void;
}) {
  const catalog = useMemo(() => examCatalog(member?.unit ?? null), [member?.unit]);
  /** Выбранные нормативы: код → оценка (пустая строка = без оценки) */
  const [selected, setSelected] = useState<Record<string, string>>({});

  const chosen = Object.keys(selected);
  const reset = () => setSelected({});

  const toggle = (code: string) => {
    setSelected((prev) => {
      if (code in prev) {
        const next = { ...prev };
        delete next[code];
        return next;
      }
      return { ...prev, [code]: "" };
    });
  };

  const payload: { exams: ExamItem[] } = {
    exams: chosen.map((code) => {
      const grade = selected[code] ?? "";
      return grade ? { exam_code: code, grade } : { exam_code: code };
    }),
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit("exam", payload, reset);
      }}
      className="flex flex-col gap-4"
    >
      {catalog.assumed && (
        <p
          className="text-[12px] leading-relaxed rounded-xl px-3 py-2.5"
          style={{ background: "rgba(255,176,32,.08)", color: "var(--amber)" }}
        >
          Подразделение ещё не назначено — показан общий перечень нормативов. Выберите те, что
          относятся к вашему направлению: лист ШДС определит штаб при зачислении.
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {catalog.exams.map((exam) => {
          const active = exam.code in selected;
          return (
            <div
              key={exam.code}
              className="rounded-xl px-3 py-2.5"
              style={{
                border: `1px solid ${active ? "rgba(255,61,61,.45)" : "var(--stroke-soft)"}`,
                background: active ? "rgba(255,61,61,.06)" : "transparent",
              }}
            >
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggle(exam.code)}
                  style={{ width: 15, height: 15, accentColor: "var(--red)" }}
                />
                <span className="text-[12.5px]">{exam.code}</span>
                {!exam.graded && (
                  <span className="chip ml-auto" style={{ fontSize: "0.62rem" }}>
                    без оценки
                  </span>
                )}
              </label>

              {/* Поле оценки появляется только у выбранного норматива с оценкой */}
              {active && exam.graded && (
                <select
                  className="select mt-2 w-full"
                  value={selected[exam.code]}
                  onChange={(e) => setSelected((prev) => ({ ...prev, [exam.code]: e.target.value }))}
                >
                  <option value="">оценка не указана</option>
                  {EXAM_GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      {grade}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: "var(--stroke-soft)" }}>
        <span className="text-[11.5px]" style={{ color: "var(--dim)" }}>
          Выбрано нормативов: {chosen.length}. Оценку можно оставить пустой — её впишет экзаменатор.
        </span>
        <button type="submit" className="btn btn-primary px-4 py-2" disabled={sending || chosen.length === 0}>
          {sending ? <Spinner /> : <Send size={15} />} Отправить рапорт
        </button>
      </div>
    </form>
  );
}

/** Рапорт о переводе в резерв (запас): причина обязательна */
function ReserveForm({
  sending,
  onSubmit,
}: {
  sending: boolean;
  onSubmit: (type: ServiceReportType, payload: unknown, reset: () => void) => Promise<void> | void;
}) {
  const [reason, setReason] = useState("");
  const reset = () => setReason("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit("reserve", { reason }, reset);
      }}
      className="flex flex-col gap-4"
    >
      <div>
        <label className="label mb-1.5 block">Причина перевода в резерв</label>
        <textarea
          className="input w-full"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Служба в ВС РФ, переезд, длительный перерыв без возможности играть"
          maxLength={REPORT_TEXT_MAX}
          required
        />
      </div>
      <FormFooter
        sending={sending}
        hint="При одобрении строка в ШДС переносится на лист «Запас» — отметки экзаменов сохраняются, возврат возможен"
      />
    </form>
  );
}

/**
 * Запись в ШДС: первичная анкета бойца для ведомости.
 *
 * Подразделение и звание выбираются из списков, совпадающих с листами Google
 * Таблицы и ролями Discord: произвольный текст привёл бы к ошибке «лист не
 * найден» при записи, поэтому поля — select, а не input.
 */
function ShdsEntryForm({
  member,
  sending,
  onSubmit,
}: {
  member: SessionMember | null;
  sending: boolean;
  onSubmit: (type: ServiceReportType, payload: unknown, reset: () => void) => Promise<void> | void;
}) {
  const [unit, setUnit] = useState(member?.unit ?? SHDS_ENTRY_UNITS[0]);
  const [rank, setRank] = useState(member?.rank ?? SHDS_ENTRY_RANKS[0]);
  const [steamId, setSteamId] = useState("");
  const [discordId, setDiscordId] = useState(member?.discordId ?? "");
  const [otdelenie, setOtdelenie] = useState("");
  const [post, setPost] = useState("");
  const reset = () => {
    setSteamId("");
    setOtdelenie("");
    setPost("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(
          "shds_entry",
          { unit, rank, steamId, discordId, отделение: otdelenie, должность: post },
          reset
        );
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className="label mb-1.5 block">Подразделение (лист ШДС)</label>
          <select className="select w-full" value={unit} onChange={(e) => setUnit(e.target.value)}>
            {SHDS_ENTRY_UNITS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label mb-1.5 block">Звание</label>
          <select className="select w-full" value={rank} onChange={(e) => setRank(e.target.value)}>
            {SHDS_ENTRY_RANKS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className="label mb-1.5 block">Steam ID</label>
          <input
            className="input input-mono w-full"
            value={steamId}
            onChange={(e) => setSteamId(e.target.value)}
            placeholder="7656119XXXXXXXXXX"
          />
        </div>
        <div>
          <label className="label mb-1.5 block">Discord ID</label>
          <input
            className="input input-mono w-full"
            value={discordId}
            onChange={(e) => setDiscordId(e.target.value)}
            placeholder="только цифры"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className="label mb-1.5 block">Отделение (для артдивизиона)</label>
          <input
            className="input w-full"
            value={otdelenie}
            onChange={(e) => setOtdelenie(e.target.value)}
            placeholder="1 ООВ, 2 ООВ"
          />
        </div>
        <div>
          <label className="label mb-1.5 block">Должность</label>
          <input
            className="input w-full"
            value={post}
            onChange={(e) => setPost(e.target.value)}
            placeholder="Наводчик, механик-водитель"
          />
        </div>
      </div>

      <FormFooter
        sending={sending}
        hint="После одобрения боец будет внесён в ведомость ШДС, а подразделение и звание обновятся в карточке"
      />
    </form>
  );
}

/** Список своих рапортов: статус, суть и комментарий модератора */
export function MyReports({ reports }: { reports: ReportRow[] }) {
  return (
    <Section title="Мои рапорты" eyebrow={`подано: ${reports.length}`}>
      {reports.length === 0 ? (
        <p className="px-5 py-6 text-[13px]" style={{ color: "var(--dim)" }}>
          Рапортов пока нет. Выберите тип выше, чтобы подать первый.
        </p>
      ) : (
        <div className="flex flex-col divide-y" style={{ borderColor: "var(--stroke-soft)" }}>
          {reports.map((row) => (
            <div key={row.id} className="flex flex-col gap-1.5 px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <span aria-hidden>{row.typeIcon || reportTypeMeta(row.type).icon}</span>
                <span className="text-[13px] font-semibold">{reportTypeMeta(row.type).label}</span>
                <span className={`badge ${STATUS_BADGE[row.status]}`}>{reviewStatusLabel(row.status)}</span>
                <span className="ml-auto text-[11.5px] mono" style={{ color: "var(--dim)" }}>
                  #{row.id} · {fmtDate(row.createdAt)}
                </span>
              </div>
              <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                {summarizeReport(row.type, row.payload)}
              </p>
              {row.status === "rejected" && row.moderatorComment && (
                <p className="text-[12px]" style={{ color: "var(--red)" }}>
                  Причина: {row.moderatorComment}
                </p>
              )}
              {row.reviewedBy && row.status !== "pending" && (
                <p className="text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Решение: {row.reviewedBy}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
function FormFooter({ sending, hint }: { sending: boolean; hint: string }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"
      style={{ borderColor: "var(--stroke-soft)" }}
    >
      <span className="text-[11.5px] max-w-[60%]" style={{ color: "var(--dim)" }}>
        {hint}
      </span>
      <button type="submit" className="btn btn-primary px-4 py-2" disabled={sending}>
        {sending ? <Spinner /> : <Send size={15} />} Отправить рапорт
      </button>
    </div>
  );
}