"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  CloudDownload,
  Ghost,
  Link2,
  Palmtree,
  RefreshCw,
  Search,
  Unlink,
  Users,
  XCircle,
} from "lucide-react";
import { Avatar, Section, Spinner, Toggle, fmtDate } from "@/components/ui";

type Member = {
  id: number;
  name: string;
  handle: string | null;
  rankName: string | null;
  post: string | null;
  hours: number;
  vacation: boolean;
  discordId: string | null;
  active: boolean;
  updatedAt: string;
};

type Notice = { ok: boolean; text: string } | null;

function DiscordIdInput({
  value,
  onSave,
}: {
  value: string;
  onSave: (v: string) => Promise<void>;
}) {
  const [local, setLocal] = useState(value);
  const [saving, setSaving] = useState(false);
  const initial = useRef(value);

  useEffect(() => {
    setLocal(value);
    initial.current = value;
  }, [value]);

  const commit = async () => {
    if (local === initial.current) return;
    setSaving(true);
    try {
      await onSave(local);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative" style={{ width: 170 }}>
      <input
        className="input input-mono"
        style={{ padding: "0.42rem 2rem 0.42rem 0.7rem", fontSize: "0.76rem" }}
        placeholder="ID Discord"
        value={local}
        disabled={saving}
        onChange={(e) => setLocal(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
        {saving ? (
          <Spinner />
        ) : local ? (
          <Link2 size={13} style={{ color: "var(--green)" }} />
        ) : (
          <Unlink size={13} style={{ color: "var(--dim)" }} />
        )}
      </span>
    </div>
  );
}

export default function MembersPage() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [norm, setNorm] = useState(10);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [onlyDebtors, setOnlyDebtors] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const reload = useCallback(async () => {
    const [m, s] = await Promise.all([
      fetch("/api/members", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/stats", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setMembers(m.members ?? []);
    setNorm(s.norm ?? 10);
  }, []);

  useEffect(() => {
    reload().catch(() => setMembers([]));
  }, [reload]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const patch = async (id: number, body: Record<string, unknown>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/members/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setMembers((prev) => (prev ?? []).map((m) => (m.id === id ? data.member : m)));
      } else {
        setNotice({ ok: false, text: data.error || "Не удалось сохранить" });
      }
    } catch {
      setNotice({ ok: false, text: "Сбой сети при сохранении" });
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setNotice({
        ok: !!data.ok,
        text: data.ok ? data.detail : data.detail || data.error || "Ошибка синхронизации",
      });
    } catch {
      setNotice({ ok: false, text: "Сбой сети" });
    } finally {
      setSyncing(false);
      await reload();
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members ?? []).filter((m) => {
      if (!showInactive && !m.active) return false;
      if (onlyDebtors && !(m.active && !m.vacation && Math.floor(m.hours) < norm)) return false;
      if (q && !`${m.name} ${m.rankName ?? ""} ${m.post ?? ""} ${m.discordId ?? ""}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [members, query, showInactive, onlyDebtors, norm]);

  const all = members ?? [];
  const active = all.filter((m) => m.active);
  const onVacation = active.filter((m) => m.vacation).length;
  const withoutDiscord = active.filter((m) => !m.discordId).length;
  const lastSync = all.length
    ? all.reduce((a, b) => (new Date(a.updatedAt) > new Date(b.updatedAt) ? a : b)).updatedAt
    : null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">личный состав // division 05</div>
          <h1 className="display text-[34px] font-black leading-tight sm:text-[40px]">Состав</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Отпуск исключает бойца из пингов. Discord ID нужен для персональных упоминаний.
          </p>
        </div>
        <button className="btn btn-primary" onClick={sync} disabled={syncing}>
          {syncing ? <Spinner /> : <CloudDownload size={15} />}
          Синхронизировать с rs-red.com
        </button>
      </header>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="card flex items-start gap-2.5 px-4 py-3"
            style={{ borderColor: notice.ok ? "rgba(61,220,132,.4)" : "rgba(255,61,61,.45)" }}
          >
            {notice.ok ? (
              <CheckCircle2 size={16} className="mt-0.5" style={{ color: "var(--green)", flex: "none" }} />
            ) : (
              <XCircle size={16} className="mt-0.5" style={{ color: "var(--red)", flex: "none" }} />
            )}
            <span className="text-[13px]" style={{ color: "var(--muted)" }}>
              {notice.text}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-5 sm:grid-cols-3">
        {[
          { label: "Активных бойцов", value: active.length, icon: Users, tint: "#7c9aff" },
          { label: "В отпуске", value: onVacation, icon: Palmtree, tint: "#ffb020" },
          { label: "Без Discord ID", value: withoutDiscord, icon: Ghost, tint: "#ff3d3d" },
        ].map((s) => (
          <div key={s.label} className="card card-hover flex items-center gap-3.5 px-5 py-4">
            <span
              className="flex items-center justify-center"
              style={{ width: 38, height: 38, borderRadius: 12, background: `${s.tint}1f`, color: s.tint }}
            >
              <s.icon size={17} />
            </span>
            <div>
              <div className="display text-[22px] font-black leading-none">{members ? s.value : "—"}</div>
              <div className="label mt-1">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      <Section
        title="Бойцы подразделения"
        eyebrow={lastSync ? `обновлено ${fmtDate(lastSync)}` : "ожидание синхронизации"}
        action={
          <div className="relative" style={{ width: 240 }}>
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--dim)" }}
            />
            <input
              className="input"
              style={{ paddingLeft: "2.1rem", paddingTop: "0.5rem", paddingBottom: "0.5rem", fontSize: "0.82rem" }}
              placeholder="Поиск по имени, званию, ID…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          <button
            className={`chip ${onlyDebtors ? "" : ""}`}
            style={
              onlyDebtors
                ? { borderColor: "rgba(255,61,61,.5)", background: "var(--red-soft)", color: "#fff" }
                : { cursor: "pointer" }
            }
            onClick={() => setOnlyDebtors((v) => !v)}
          >
            <span className={`dot ${onlyDebtors ? "dot-err" : "dot-dim"}`} />
            Только должники (&lt; {norm} ч)
          </button>
          <button
            className="chip"
            style={
              showInactive
                ? { borderColor: "rgba(255,176,32,.5)", background: "var(--amber-soft)", color: "#fff" }
                : { cursor: "pointer" }
            }
            onClick={() => setShowInactive((v) => !v)}
          >
            <span className={`dot ${showInactive ? "dot-warn" : "dot-dim"}`} />
            Показать выбывших
          </button>
        </div>

        <div className="overflow-x-auto px-2 pb-2 pt-2">
          {!members ? (
            <div className="flex flex-col gap-2 p-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton" style={{ height: 46 }} />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Users size={20} style={{ color: "var(--dim)" }} />
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {all.length === 0
                  ? "Состав пуст — нажмите «Синхронизировать с rs-red.com»"
                  : "Никого не найдено по фильтрам"}
              </p>
            </div>
          ) : (
            <table className="tbl" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Боец</th>
                  <th>Звание / должность</th>
                  <th>Онлайн</th>
                  <th>Discord ID</th>
                  <th style={{ textAlign: "center" }}>Отпуск</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => {
                  const okNorm = Math.floor(m.hours) >= norm;
                  const zero = Math.floor(m.hours) === 0;
                  return (
                    <tr
                      key={m.id}
                      className={`${m.vacation ? "row-vacation" : ""} ${m.active ? "" : "row-inactive"}`}
                    >
                      <td>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={m.name} />
                          <div>
                            <div className="font-semibold leading-tight">{m.name}</div>
                            {!m.active && (
                              <span className="badge badge-red mt-0.5">выбыл</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td style={{ color: "var(--muted)" }}>
                        {m.rankName ?? "—"}
                        {m.post ? (
                          <span style={{ color: "var(--dim)" }}> · {m.post}</span>
                        ) : null}
                      </td>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <div className="hours-track">
                            <div
                              className="hours-fill"
                              style={{
                                width: `${Math.min(100, (m.hours / norm) * 100)}%`,
                                background: m.vacation
                                  ? "var(--amber)"
                                  : okNorm
                                    ? "var(--green)"
                                    : zero
                                      ? "var(--red)"
                                      : "var(--amber)",
                              }}
                            />
                          </div>
                          <span
                            className="mono text-[13px] font-bold"
                            style={{
                              color: m.vacation
                                ? "var(--amber)"
                                : okNorm
                                  ? "var(--green)"
                                  : "var(--red)",
                            }}
                          >
                            {m.hours.toFixed(1)} ч
                          </span>
                        </div>
                      </td>
                      <td>
                        <DiscordIdInput
                          value={m.discordId ?? ""}
                          onSave={(v) => patch(m.id, { discordId: v })}
                        />
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <div className="inline-flex items-center gap-2">
                          <Toggle
                            on={m.vacation}
                            disabled={busyIds.has(m.id)}
                            color="rgba(255,176,32,.9)"
                            onChange={(v) => patch(m.id, { vacation: v })}
                          />
                          {m.vacation && (
                            <Palmtree size={13} style={{ color: "var(--amber)" }} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      <p className="text-[12px] leading-relaxed" style={{ color: "var(--dim)" }}>
        Подсказка: Discord ID копируется правым кликом по пользователю при включённом «Режиме
        разработчика» (Настройки Discord → Дополнительно). Планировщик сам синхронизирует состав
        каждые 30 минут и перед каждой проверкой онлайна.
      </p>
    </div>
  );
}
