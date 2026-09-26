"use client";

/**
 * Панель модерации рапортов (/admin/recruits).
 *
 * Вкладка доступна только командирам и администраторам (проверка на сервере —
 * requireStaff). Модератор просматривает очередь, правит позывной, вписывает
 * пропущенный Discord ID, назначает звание и подразделение, затем одобряет
 * (боец зачисляется и синхронизируется с Google Таблицей ШДС) или отклоняет.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, ShieldAlert, ThumbsUp, ThumbsDown, RefreshCw } from "lucide-react";
import { Section, Spinner } from "@/components/ui";
import {
  MEMBER_ROLES,
  MEMBER_STATUS,
  RANKS,
  ROLE_LABELS,
  statusLabel,
  UNITS,
  type MemberRole,
  type MemberStatus,
} from "@/lib/recruits";

type Recruit = {
  id: number;
  callsign: string | null;
  name: string;
  discordId: string | null;
  avatarUrl: string | null;
  rank: string;
  unit: string | null;
  status: MemberStatus;
  role: MemberRole;
  createdAt: string;
  application: {
    age?: number;
    armaExperience?: string;
    specialization?: string;
    comment?: string;
    decisionReason?: string;
  };
};

/** Фильтры очереди: в первую очередь нужны новые рапорты */
const FILTERS: { key: MemberStatus | "all"; label: string }[] = [
  { key: MEMBER_STATUS.PENDING, label: "На рассмотрении" },
  { key: MEMBER_STATUS.ACTIVE, label: "В строю" },
  { key: MEMBER_STATUS.VACATION, label: "Отпуск" },
  { key: MEMBER_STATUS.DISMISSED, label: "Отклонённые" },
  { key: "all", label: "Все" },
];

export default function AdminRecruitsPage() {
  const [recruits, setRecruits] = useState<Recruit[]>([]);
  const [filter, setFilter] = useState<MemberStatus | "all">(MEMBER_STATUS.PENDING);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  /** Черновики правок по каждому бойцу: id → поля */
  const [drafts, setDrafts] = useState<Record<number, Partial<Recruit>>>({});

  const load = useCallback(async (status: MemberStatus | "all") => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/recruits?status=${status}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Не удалось загрузить список рапортов");
        return;
      }
      setRecruits(data.recruits || []);
      setDrafts({});
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Вызов отложен на микрозадачу: синхронный setState в теле эффекта вызвал бы
    // каскадный рендер, а загрузка и без него меняет состояние после ответа сети
    const timer = window.setTimeout(() => {
      void load(filter);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [filter, load]);

  const patchDraft = (id: number, field: keyof Recruit, value: string) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const valueOf = (recruit: Recruit, field: keyof Recruit): string => {
    const draft = drafts[recruit.id]?.[field];
    if (draft !== undefined && draft !== null) return String(draft);
    const original = recruit[field];
    return original === null || original === undefined ? "" : String(original);
  };

  /** Отправка решения или правок по бойцу */
  const send = async (recruit: Recruit, action: "approve" | "reject" | "save") => {
    setError("");
    setFlash("");
    setBusyId(recruit.id);
    try {
      const body: Record<string, unknown> = {
        id: recruit.id,
        action,
        callsign: valueOf(recruit, "callsign"),
        discordId: valueOf(recruit, "discordId"),
        rank: valueOf(recruit, "rank"),
        unit: valueOf(recruit, "unit"),
        role: valueOf(recruit, "role"),
      };
      if (action === "reject") {
        const reason = window.prompt("Причина отклонения (необязательно):") || "";
        body.reason = reason;
      }

      const res = await fetch(`/api/admin/recruits/${recruit.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!data.ok) {
        setError(data.error || "Не удалось сохранить решение");
        return;
      }

      // Синхронизация с таблицей могла не пройти — это не отменяет зачисления
      if (data.sheets && !data.sheets.ok) {
        setError(
          `Боец зачислен, но запись в Google Таблицу не удалась: ${data.sheets.error}`
        );
      } else if (data.sheets?.message) {
        setFlash(data.sheets.message);
      } else {
        setFlash(
          action === "reject" ? "Рапорт отклонён" : `${recruit.callsign || recruit.name} обновлён`
        );
      }
      load(filter);
    } catch {
      setError("Сбой сети");
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = useMemo(
    () => recruits.filter((r) => r.status === MEMBER_STATUS.PENDING).length,
    [recruits]
  );
return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">штаб // модерация</div>
          <h1 className="display text-[30px] font-black leading-tight flex items-center gap-3">
            <ClipboardCheck className="text-red-500" size={32} /> Рапорты новобранцев
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Проверьте анкету, назначьте звание и подразделение — одобрение сразу дописывает бойца
            в Google Таблицу ШДС.
          </p>
        </div>
        <button onClick={() => load(filter)} className="btn btn-sm" disabled={loading}>
          {loading ? <Spinner /> : <RefreshCw size={14} />} Обновить
        </button>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <ShieldAlert size={16} style={{ flex: "none", marginTop: 2 }} />
          <span>{error}</span>
        </div>
      )}
      {flash && (
        <div
          className="rounded-xl border px-3 py-2 text-sm"
          style={{
            borderColor: "rgba(61,220,132,.3)",
            background: "var(--green-soft)",
            color: "var(--green)",
          }}
        >
          {flash}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            onClick={() => setFilter(item.key)}
            className="btn btn-sm"
            style={
              filter === item.key
                ? { borderColor: "rgba(255,61,61,.5)", background: "var(--red-soft)", color: "#fff" }
                : undefined
            }
          >
            {item.label}
            {item.key === MEMBER_STATUS.PENDING && pendingCount > 0 ? ` (${pendingCount})` : ""}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center p-10">
          <Spinner />
        </div>
      ) : recruits.length === 0 ? (
        <Section title="Очередь пуста" eyebrow="рапорты">
          <div className="p-6 text-sm" style={{ color: "var(--muted)" }}>
            В этом разделе нет рапортов. Новые появятся здесь сразу после подачи формы.
          </div>
        </Section>
      ) : (
        recruits.map((recruit) => (
          <Section
            key={recruit.id}
            title={recruit.callsign || recruit.name}
            eyebrow={`подан ${new Date(recruit.createdAt).toLocaleDateString("ru-RU")}`}
            action={
              <span
                className={`badge ${
                  recruit.status === MEMBER_STATUS.PENDING
                    ? "badge-amber"
                    : recruit.status === MEMBER_STATUS.DISMISSED
                      ? "badge-red"
                      : "badge-green"
                }`}
              >
                {statusLabel(recruit.status)}
              </span>
            }
          >
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap gap-5 text-[12.5px]" style={{ color: "var(--muted)" }}>
                {recruit.avatarUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={recruit.avatarUrl}
                    alt=""
                    width={40}
                    height={40}
                    style={{ borderRadius: "50%", border: "1px solid var(--stroke-soft)" }}
                  />
                )}
                <div>
                  <div className="label">Возраст</div>
                  <div>{recruit.application.age ?? "—"}</div>
                </div>
                <div>
                  <div className="label">Специализация</div>
                  <div>{recruit.application.specialization || "—"}</div>
                </div>
                <div className="min-w-[220px] flex-1">
                  <div className="label">Опыт в Arma 3</div>
                  <div>{recruit.application.armaExperience || "—"}</div>
                </div>
              </div>

              {recruit.application.comment && (
                <div className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                  <div className="label">Комментарий</div>
                  <div>{recruit.application.comment}</div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
                <div>
                  <label className="label mb-1.5 block">Позывной</label>
                  <input
                    className="input input-mono w-full"
                    value={valueOf(recruit, "callsign")}
                    onChange={(e) => patchDraft(recruit.id, "callsign", e.target.value)}
                  />
                </div>
                <div>
                  <label className="label mb-1.5 block">Discord ID</label>
                  <input
                    className="input input-mono w-full"
                    value={valueOf(recruit, "discordId")}
                    placeholder="не привязан"
                    onChange={(e) => patchDraft(recruit.id, "discordId", e.target.value)}
                  />
                </div>
                <div>
                  <label className="label mb-1.5 block">Звание</label>
                  <select
                    className="select w-full"
                    value={valueOf(recruit, "rank")}
                    onChange={(e) => patchDraft(recruit.id, "rank", e.target.value)}
                  >
                    {RANKS.map((rank) => (
                      <option key={rank} value={rank}>
                        {rank}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label mb-1.5 block">Подразделение</label>
                  <select
                    className="select w-full"
                    value={valueOf(recruit, "unit")}
                    onChange={(e) => patchDraft(recruit.id, "unit", e.target.value)}
                  >
                    <option value="">не назначено</option>
                    {UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label mb-1.5 block">Доступ</label>
                  <select
                    className="select w-full"
                    value={valueOf(recruit, "role")}
                    onChange={(e) => patchDraft(recruit.id, "role", e.target.value)}
                  >
                    {MEMBER_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div
                className="flex flex-wrap items-center justify-end gap-2 border-t pt-4"
                style={{ borderColor: "var(--stroke-soft)" }}
              >
                <button
                  onClick={() => send(recruit, "save")}
                  className="btn btn-sm"
                  disabled={busyId === recruit.id}
                >
                  Сохранить правки
                </button>
                <button
                  onClick={() => send(recruit, "reject")}
                  className="btn btn-sm"
                  disabled={busyId === recruit.id}
                  style={{
                    color: "var(--red)",
                    borderColor: "transparent",
                    background: "rgba(255,61,61,0.1)",
                  }}
                >
                  <ThumbsDown size={14} /> Отклонить
                </button>
                <button
                  onClick={() => send(recruit, "approve")}
                  className="btn btn-sm btn-primary"
                  disabled={busyId === recruit.id}
                >
                  {busyId === recruit.id ? <Spinner /> : <ThumbsUp size={14} />} Одобрить
                </button>
              </div>
            </div>
          </Section>
        ))
      )}
    </div>
  );
}