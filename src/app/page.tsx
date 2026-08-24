"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, AlarmClock, ArrowRight, CheckCircle2, Hourglass, Palmtree,
  RefreshCw, ShieldAlert, Target, Users, XCircle, Zap,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Avatar, CountUp, PctBadge, Ring, Section, Spinner, fmtDate } from "@/components/ui";

type Stats = {
  norm: number;
  live: { total: number; zeroHours: number; passed: number; failed: number; onVacation: number; percent: number; };
  color: { name: string; css: string; label: string };
  history: { id: number; createdAt: string; percent: number; passed: number; zeroHours: number; total: number }[];
  latestSnapshot: { id: number; createdAt: string } | null;
};
type Member = { id: number; name: string; rankName: string | null; post: string | null; hours: number; vacation: boolean; discordId: string | null; active: boolean; };
type LogRow = { id: number; createdAt: string; kind: string; title: string; detail: string; ok: boolean; error: string | null; };
type Status = { bot: { configured: boolean; ok: boolean }; site: { ok: boolean }; schedulerAlive: boolean; nextRuns: { operation: string | null; weekly: string | null }; };
type Toast = { id: number; ok: boolean; title: string; detail?: string };

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip-box">
      <div className="label mb-1">{label}</div>
      <div className="mono font-bold" style={{ color: "var(--text)" }}>{payload[0].value.toFixed(1)}% выполнение</div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [role, setRole] = useState("guest");
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 6500);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [s, m, st, me] = await Promise.all([
        fetch("/api/stats", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/members", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/status", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/me", { cache: "no-store" }).then((r) => r.json()),
      ]);
      
      let logsData = { logs: [] };
      if (me.role && me.role !== "guest") {
        logsData = await fetch("/api/logs", { cache: "no-store" }).then(r => r.json()).catch(() => ({ logs: [] }));
      }

      setStats(s);
      setMembers(m.members);
      setStatus(st);
      setRole(me.role || "guest");
      setLogs((logsData.logs ?? []).slice(0, 6));
    } catch (e) {
      pushToast({ ok: false, title: "Не удалось загрузить данные" });
    }
  }, [pushToast]);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 45_000);
    return () => clearInterval(t);
  }, [reload]);

  const runAction = async (key: string, url: string, body?: object) => {
    setBusy(key);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json();
      pushToast({ ok: !!data.ok, title: data.title || (data.ok ? "Готово" : "Ошибка"), detail: data.error || data.detail });
    } catch (e) {
      pushToast({ ok: false, title: "Сбой запроса", detail: e instanceof Error ? e.message : "" });
    } finally {
      setBusy(null);
      reload();
    }
  };

  const norm = stats?.norm ?? 10;
  const debtors = (members ?? []).filter((m) => m.active && !m.vacation && Math.floor(m.hours) < norm).sort((a, b) => a.hours - b.hours);
  const colorCss = stats?.color.css ?? "#ff3d3d";
  const chartData = (stats?.history ?? []).map((h) => ({ date: fmtDate(h.createdAt), percent: h.percent }));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">пульт управления // танковые войска</div>
          <h1 className="display text-[34px] font-black leading-tight sm:text-[40px]">Оперативный свод</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>Автопинги в 14:45 и 19:45 · контроль онлайна пт–вс в 12:00</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip"><AlarmClock size={13} style={{ color: "var(--red)" }} /> Операция: <b style={{ color: "var(--text)" }}>{status?.nextRuns?.operation ?? "—"}</b></span>
          <span className="chip"><Activity size={13} style={{ color: "var(--amber)" }} /> Проверка: <b style={{ color: "var(--text)" }}>{status?.nextRuns?.weekly ?? "—"}</b></span>
        </div>
      </header>

      {/* Показываем панель кнопок только офицерам и админам */}
      {role !== "guest" && (
        <Section glow>
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <div className="mr-auto">
              <div className="display text-[14px] font-bold">Быстрые действия</div>
              <div className="text-[12px]" style={{ color: "var(--dim)" }}>Ручной запуск не отменяет расписание</div>
            </div>
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => runAction("op", "/api/actions", { action: "operation" })}>{busy === "op" ? <Spinner /> : <Zap size={15} />} Пинг на операцию</button>
            <button className="btn" disabled={busy !== null} onClick={() => runAction("weekly", "/api/actions", { action: "weekly" })}>{busy === "weekly" ? <Spinner /> : <Activity size={15} />} Проверка онлайна</button>
            <button className="btn" disabled={busy !== null} onClick={() => runAction("sync", "/api/sync")}>{busy === "sync" ? <Spinner /> : <RefreshCw size={15} />} Синхронизация</button>
          </div>
        </Section>
      )}

      <div className="grid gap-5 lg:grid-cols-12">
        <Section className="lg:col-span-5 card-hover" title="Выполнение нормы" eyebrow="Текущая неделя">
          <div className="px-5 py-6">
            {stats ? (
              <>
                <Ring percent={stats.live.percent} color={colorCss}>
                  <CountUp value={stats.live.percent} decimals={1} className="display text-[34px] font-black" />
                  <span className="text-[10px] uppercase" style={{ color: "var(--dim)", letterSpacing: "0.2em" }}>нормы</span>
                </Ring>
                <div className="mt-4 flex items-center justify-center gap-2">
                  <PctBadge percent={stats.live.percent} />
                  <span className="text-[12px]" style={{ color: "var(--muted)" }}>{stats.live.passed} из {stats.live.total} бойцов · пороги: 50% / 60%</span>
                </div>
              </>
            ) : <div className="skeleton mx-auto" style={{ width: 210, height: 210, borderRadius: 999 }} />}
          </div>
        </Section>

        <div className="grid gap-5 sm:grid-cols-2 lg:col-span-7">
          {[
            { key: "total", label: "Всего бойцов", value: stats?.live.total, icon: Users, tint: "#7c9aff", hint: "в подразделении" },
            { key: "zero", label: "С 0 часов", value: stats?.live.zeroHours, icon: Hourglass, tint: "#ff3d3d", hint: "отображаемый онлайн" },
            { key: "passed", label: `Норма ≥ ${norm} ч`, value: stats?.live.passed, icon: Target, tint: "#3ddc84", hint: "выполнили норму" },
            { key: "vacation", label: "В отпуске", value: stats?.live.onVacation, icon: Palmtree, tint: "#ffb020", hint: "не пингуются" },
          ].map((s, i) => (
            <motion.div key={s.key} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.06, duration: 0.5, ease: [0.22, 0.8, 0.24, 1] }}>
              <div className="card card-hover h-full px-5 py-5">
                <div className="flex items-center justify-between"><span className="label">{s.label}</span><span className="flex items-center justify-center" style={{ width: 34, height: 34, borderRadius: 11, background: `${s.tint}1f`, color: s.tint }}><s.icon size={16} /></span></div>
                <div className="display mt-3 text-[30px] font-black leading-none">{stats ? <CountUp value={s.value ?? 0} /> : <span style={{ color: "var(--dim)" }}>—</span>}</div>
                <div className="mt-1.5 text-[11px]" style={{ color: "var(--dim)" }}>{s.hint}</div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      <Section title="История выполнения нормы" eyebrow="Снимки после каждой проверки" action={stats?.latestSnapshot ? <span className="chip">последний: {fmtDate(stats.latestSnapshot.createdAt)}</span> : undefined}>
        <div className="px-4 py-4">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={chartData} margin={{ top: 10, right: 14, bottom: 0, left: -14 }}>
                <defs>
                  <linearGradient id="pctFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colorCss} stopOpacity={0.35} /><stop offset="100%" stopColor={colorCss} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#5d657a", fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={30} />
                <YAxis domain={[0, 100]} tick={{ fill: "#5d657a", fontSize: 11 }} axisLine={false} tickLine={false} unit="%" />
                <Tooltip content={<ChartTooltip />} />
                <ReferenceLine y={50} stroke="#ffb020" strokeDasharray="5 5" strokeOpacity={0.55} />
                <ReferenceLine y={60} stroke="#3ddc84" strokeDasharray="5 5" strokeOpacity={0.55} />
                <Area type="monotone" dataKey="percent" stroke={colorCss} strokeWidth={2.4} fill="url(#pctFill)" dot={{ r: 2.5, fill: colorCss, strokeWidth: 0 }} activeDot={{ r: 4, fill: "#fff" }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center"><Activity size={20} style={{ color: "var(--dim)" }} /><p className="text-sm" style={{ color: "var(--muted)" }}>Снимки появятся после первой проверки онлайна</p></div>
          )}
        </div>
      </Section>

      {/* Если гость, карточка должников будет на всю ширину. Если офицер - рядом будет журнал */}
      <div className={`grid gap-5 ${role !== "guest" ? "lg:grid-cols-2" : "lg:grid-cols-1"}`}>
        <Section title="Должники по онлайну" eyebrow={`меньше ${norm} ч без отпуска`} action={<Link href="/members" className="btn btn-sm">Состав <ArrowRight size={13} /></Link>}>
          <div className="px-2">
            {debtors.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center"><CheckCircle2 size={20} style={{ color: "var(--green)" }} /><p className="text-sm" style={{ color: "var(--muted)" }}>{members ? "Должников нет — все держат норму" : "Загрузка…"}</p></div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Боец</th><th>Онлайн</th><th>Discord</th></tr></thead>
                <tbody>
                  {debtors.slice(0, 8).map((m) => (
                    <tr key={m.id}>
                      <td><div className="flex items-center gap-2.5"><Avatar name={m.name} /><div><div className="font-semibold leading-tight">{m.name}</div><div className="text-[11px]" style={{ color: "var(--dim)" }}>{[m.rankName, m.post].filter(Boolean).join(" · ") || "—"}</div></div></div></td>
                      <td><span className="mono font-bold" style={{ color: Math.floor(m.hours) === 0 ? "var(--red)" : "var(--amber)" }}>{m.hours.toFixed(1)} ч</span></td>
                      <td>{m.discordId ? <span className="badge badge-green">привязан</span> : <span className="badge badge-red">нет ID</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Section>

        {/* Показываем журнал только офицерам и админам */}
        {role !== "guest" && (
          <Section title="Последние события" eyebrow="Журнал бота" action={<Link href="/logs" className="btn btn-sm">Все записи <ArrowRight size={13} /></Link>}>
            <div className="px-5 py-3">
              {logs.length === 0 && <p className="py-8 text-center text-sm" style={{ color: "var(--muted)" }}>Событий пока нет</p>}
              {logs.map((log) => (
                <div key={log.id} className="log-line">
                  <span className="mt-1.5">{log.ok ? <CheckCircle2 size={15} style={{ color: "var(--green)" }} /> : <XCircle size={15} style={{ color: "var(--red)" }} />}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold">{log.title}</span>
                      {log.kind === "weekly" && <span className="badge badge-amber">онлайн</span>}
                      {log.kind === "operation" && <span className="badge badge-red">операция</span>}
                      {log.kind === "sync" && <span className="badge badge-green">синх</span>}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>{log.error || log.detail}</div>
                    <div className="mono mt-1 text-[10px]" style={{ color: "var(--dim)" }}>{fmtDate(log.createdAt)}</div>
                  </div>
                  {log.kind === "operation" && log.ok && <ShieldAlert size={16} className="ml-auto mt-1" style={{ color: "var(--dim)" }} />}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      <div className="fixed bottom-5 right-5 z-50 flex w-[min(380px,90vw)] flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, x: 40, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 30, scale: 0.96 }} className="card px-4 py-3" style={{ borderColor: t.ok ? "rgba(61,220,132,.4)" : "rgba(255,61,61,.45)" }}>
              <div className="flex items-start gap-2.5">
                {t.ok ? <CheckCircle2 size={16} className="mt-0.5" style={{ color: "var(--green)", flex: "none" }} /> : <XCircle size={16} className="mt-0.5" style={{ color: "var(--red)", flex: "none" }} />}
                <div className="min-w-0"><div className="text-[13px] font-bold">{t.title}</div>{t.detail && <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{t.detail}</div>}</div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}