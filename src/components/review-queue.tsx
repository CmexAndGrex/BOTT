"use client";

/**
 * Очереди модерации: рапорты состава и заявки на вступление.
 *
 * Вынесены из страницы /admin/reports, чтобы та описывала состояния (фильтры,
 * загрузка, решения), а не разметку строк. Кнопки решения вызывают тот же
 * серверный путь, что и кнопки в Discord, — правило одно, входов два.
 */
import React from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Section, Spinner, fmtDate } from "@/components/ui";
import { reportTypeMeta, type ReviewStatus, type ServiceReportType } from "@/lib/reports";
import {
  APPLICATION_KIND_RESERVE_RETURN,
  APPLICATION_KIND_TITLES,
  type RecruitApplicationKind,
} from "@/lib/recruits";

export type ReportRow = {
  id: number;
  memberId: number | null;
  callsign: string;
  /**
   * ФИО подающего бойца из division_members.
   *
   * Требование модерации: в карточке рапорта должно читаться, КТО подал.
   * Отдельным полем, а не через callsign: у бойцов из синхронизации rs-red.com
   * позывного нет, и карточка без ФИО выглядела обезличенной.
   */
  memberName?: string | null;
  /** Должность бойца: помогает модератору понять, чей это рапорт */
  post?: string | null;
  type: ServiceReportType;
  status: ReviewStatus;
  summary: string;
  moderatorComment: string | null;
  reviewedBy: string | null;
  createdAt: string;
  unit: string | null;
  rank: string | null;
  discordId: string | null;
};

export type RecruitRow = {
  id: number;
  memberId: number | null;
  callsign: string;
  /** ФИО из карточки бойца (если заявка уже связана с ним) */
  memberName?: string | null;
  /** Вид заявки: recruit — новобранец, reserve_return — возврат из запаса */
  kind?: RecruitApplicationKind | null;
  /** ФИО из самой заявки: у возврата из запаса заполняется обязательно */
  fullName?: string | null;
  /** Подразделение и звание из карточки бойца: видны, если он уже заведён */
  unit?: string | null;
  rank?: string | null;
  discordTag: string | null;
  discordId: string | null;
  age: number | null;
  armaExperience: string | null;
  about: string | null;
  status: ReviewStatus;
  reviewedBy: string | null;
  createdAt: string;
};

export type QueueHandlers = {
  busy: string | null;
  comments: Record<string, string>;
  onComment: (key: string, value: string) => void;
  onDecide: (id: number, action: "approve" | "reject") => void;
};

const STATUS_BADGE: Record<ReviewStatus, string> = {
  pending: "badge-amber",
  approved: "badge-green",
  rejected: "badge-red",
};

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "На рассмотрении",
  approved: "Одобрено",
  rejected: "Отклонено",
};

/** Очередь рапортов действующего состава */
export function ReportsQueue({ rows, ...handlers }: QueueHandlers & { rows: ReportRow[] }) {
  if (rows.length === 0) {
    return (
      <Section title="Рапорты состава" eyebrow="очередь пуста">
        <p className="px-5 py-6 text-[13px]" style={{ color: "var(--dim)" }}>
          Рапортов с такими фильтрами нет.
        </p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => {
        const meta = reportTypeMeta(row.type);
        /**
         * Кто подал рапорт: ФИО из табеля — крупно, позывной — рядом.
         *
         * Порядок именно такой: в очереди модерации штаб опознаёт человека по
         * ФИО, а позывной может отсутствовать у бойцов из синхронизации.
         */
        const personName = row.memberName || row.callsign || "боец не указан";
        const callsign = row.memberName && row.callsign ? row.callsign : "";
        return (
          <Section
            key={row.id}
            title={personName}
            eyebrow={`рапорт состава · #${row.id}`}
            action={<span className={`badge ${STATUS_BADGE[row.status]}`}>{STATUS_LABEL[row.status]}</span>}
          >
            <div className="flex flex-col gap-3 p-5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                <span className="display text-[17px] font-bold">{personName}</span>
                {callsign && (
                  <span className="text-[13px]" style={{ color: "var(--muted)" }}>
                    позывной: {callsign}
                  </span>
                )}
                <span className="chip">{meta.label}</span>
                <span className="ml-auto text-[11.5px] mono" style={{ color: "var(--dim)" }}>
                  {fmtDate(row.createdAt)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
                <span className="chip">{row.rank || "звание не указано"}</span>
                <span className="chip">{row.unit || "подразделение не назначено"}</span>
                {row.post && <span className="chip">должность: {row.post}</span>}
                {row.discordId && (
                  <span className="chip mono" style={{ fontSize: "0.68rem" }}>
                    Discord: {row.discordId}
                  </span>
                )}
              </div>

              <p className="text-[13px]" style={{ color: "var(--muted)" }}>
                {row.summary}
              </p>

              {row.moderatorComment && (
                <p className="text-[12px]" style={{ color: "var(--red)" }}>
                  Комментарий модератора: {row.moderatorComment}
                </p>
              )}
              {row.reviewedBy && row.status !== "pending" && (
                <p className="text-[11.5px]" style={{ color: "var(--dim)" }}>
                  Решение принял: {row.reviewedBy}
                </p>
              )}

              <DecisionBar scope="report" id={row.id} status={row.status} {...handlers} />
            </div>
          </Section>
        );
      })}
    </div>
  );
}

/** Кнопки решения с полем причины — общие для обеих очередей */
function DecisionBar({
  scope,
  id,
  status,
  busy,
  comments,
  onComment,
  onDecide,
}: QueueHandlers & {
  scope: "recruit" | "report";
  id: number;
  status: ReviewStatus;
}) {
  // Решённые записи не решаются повторно: кнопки гасятся, остаётся итог
  if (status !== "pending") {
    return (
      <div className="flex items-center gap-2 border-t pt-4" style={{ borderColor: "var(--stroke-soft)" }}>
        <span className={`badge ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>
      </div>
    );
  }

  const key = `${scope}-${id}`;
  const inFlight = busy === key;

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t pt-4"
      style={{ borderColor: "var(--stroke-soft)" }}
    >
      <input
        className="input flex-1"
        style={{ minWidth: 220 }}
        placeholder="Комментарий к решению (причина отказа уйдёт бойцу)"
        value={comments[key] || ""}
        onChange={(e) => onComment(key, e.target.value)}
      />
      <button
        onClick={() => onDecide(id, "reject")}
        className="btn btn-sm"
        disabled={inFlight}
        style={{ color: "var(--red)", borderColor: "transparent", background: "rgba(190,18,60,0.1)" }}
      >
        <ThumbsDown size={14} /> Отклонить
      </button>
      <button onClick={() => onDecide(id, "approve")} className="btn btn-sm btn-primary" disabled={inFlight}>
        {inFlight ? <Spinner /> : <ThumbsUp size={14} />} Одобрить
      </button>
    </div>
  );
}

/** Очередь заявок на вступление */
export function RecruitsQueue({ rows, ...handlers }: QueueHandlers & { rows: RecruitRow[] }) {
  if (rows.length === 0) {
    return (
      <Section title="Заявки на вступление" eyebrow="очередь пуста">
        <p className="px-5 py-6 text-[13px]" style={{ color: "var(--dim)" }}>
          Заявок с такими фильтрами нет.
        </p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => {
        /**
         * Вид заявки показывается явно: возврат из запаса — «Запрос на возврат
         * из запаса». Модератор обязан видеть разницу до нажатия «Одобрить»,
         * потому что решение по возврату переносит строку в Google Таблице,
         * а не зачисляет нового бойца.
         */
        const isReserveReturn = row.kind === APPLICATION_KIND_RESERVE_RETURN;
        /**
         * ФИО кандидата — на видном месте карточки.
         *
         * Источники по приоритету: карточка бойца (заявка уже связана) →
         * поле full_name самой заявки (возврат из запаса) → позывной.
         */
        const personName = row.memberName || row.fullName || row.callsign || "кандидат";
        return (
        <Section
          key={row.id}
          title={personName}
          eyebrow={
            isReserveReturn
              ? `${APPLICATION_KIND_TITLES.reserve_return} · #${row.id}`
              : `заявка на вступление · #${row.id}`
          }
          action={<span className={`badge ${STATUS_BADGE[row.status]}`}>{STATUS_LABEL[row.status]}</span>}
        >
          <div className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
              <span className="display text-[17px] font-bold">{personName}</span>
              {row.callsign && row.callsign !== personName && (
                <span className="text-[13px]" style={{ color: "var(--muted)" }}>
                  позывной: {row.callsign}
                </span>
              )}
              <span className="ml-auto text-[11.5px] mono" style={{ color: "var(--dim)" }}>
                {fmtDate(row.createdAt)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
              {isReserveReturn && (
                <span className="badge badge-amber">{APPLICATION_KIND_TITLES.reserve_return}</span>
              )}
              {row.rank && <span className="chip">{row.rank}</span>}
              {row.unit && <span className="chip">{row.unit}</span>}
              <span className="chip">{row.age ? `${row.age} лет` : "возраст не указан"}</span>
              {row.discordTag && <span className="chip">Discord: {row.discordTag}</span>}
              {row.discordId && (
                <span className="chip mono" style={{ fontSize: "0.68rem" }}>
                  ID: {row.discordId}
                </span>
              )}
            </div>

            {/**
             * ФИО из заявки показывается всегда.
             *
             * Для возврата из запаса по нему ищется строка на листе «Запас»,
             * а для новобранца это второй ключ поиска дубля в составе: если
             * ФИО нет, проверка при одобрении опирается только на Discord ID.
             */}
            <div>
              <div className="label mb-1">
                {isReserveReturn ? "ФИО в табеле / «Запасе»" : "ФИО кандидата"}
              </div>
              <p
                className="text-[12.5px]"
                style={{ color: row.fullName ? "var(--text)" : "var(--red)" }}
              >
                {row.fullName ||
                  (isReserveReturn
                    ? "не указано — строку в «Запасе» найти нечем"
                    : "не указано — дубль в составе проверить нечем")}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <div className="label mb-1">Опыт в Arma</div>
                <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                  {row.armaExperience || "—"}
                </p>
              </div>
              <div>
                <div className="label mb-1">О себе</div>
                <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                  {row.about || "—"}
                </p>
              </div>
            </div>

            {row.reviewedBy && row.status !== "pending" && (
              <p className="text-[11.5px]" style={{ color: "var(--dim)" }}>
                Решение принял: {row.reviewedBy}
              </p>
            )}

            <DecisionBar scope="recruit" id={row.id} status={row.status} {...handlers} />
          </div>
        </Section>
        );
      })}
    </div>
  );
}