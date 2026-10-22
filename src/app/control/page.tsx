"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, UserMinus, XCircle } from "lucide-react";
import { Avatar, Section, Spinner } from "@/components/ui";
import { isCommanderFighter, isDeputyCommander } from "@/lib/validation";

type Stat = { id: number; hours: number; vacation: boolean; createdAt: string };
type Fighter = { id: number; name: string; rankName: string | null; post?: string | null; hours: number; vacation: boolean; discordId: string | null; warnings: number; active: boolean; stats: Stat[] };
type Notice = { ok: boolean; text: string } | null;

// Функция для получения дат недели (0 = текущая, 1 = прошлая, 2 = позапрошлая и т.д.)
function getWeekRange(offsetWeeks: number) {
  const now = new Date();
  now.setHours(0, 0, 0, 0); 
  
  const day = now.getDay();
  // Находим понедельник (если сегодня воскресенье, то отнимаем 6 дней)
  const diffToMonday = now.getDate() - day + (day === 0 ? -6 : 1);
  
  const startOfWeek = new Date(now);
  startOfWeek.setDate(diffToMonday - (offsetWeeks * 7));
  
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);

  const fmt = (d: Date) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return `${fmt(startOfWeek)} — ${fmt(endOfWeek)}`;
}

export default function ControlPage() {
  const [fighters, setFighters] = useState<Fighter[] | null>(null);
  const [norm, setNorm] = useState(10);
  const [notice, setNotice] = useState<Notice>(null);
  /** Права из /api/me: считаются общим правилом (resolvePanelRights) */
  const [isCommander, setIsCommander] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  const reload = useCallback(async () => {
    const [c, s, me] = await Promise.all([
      fetch("/api/control", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/stats", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/me", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setFighters(c.data ?? []);
    setNorm(s.norm ?? 10);
    /**
     * Права берём из флагов /api/me, а не из «role»: роль сессии панели у
     * командира подразделения может быть не выставлена вовсе, и тогда он
     * читался как гость — страница показывала «Доступ запрещен».
     * Тот же расчёт делает сервер (resolvePanelRights), поэтому проверка
     * на клиенте и на сервере больше не расходится.
     */
    setIsCommander(Boolean(me.isCommander));
    setIsAdmin(Boolean(me.isAdmin));
  }, []);

  useEffect(() => { reload().catch(() => setFighters([])); }, [reload]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Функция для выдачи предупреждения и пинга в Discord (type 0 — снятие всех)
  const issueWarning = async (id: number, type: 0 | 1 | 2) => {
    const question =
      type === 0
        ? "Снять все предупреждения с бойца?"
        : `Вы уверены, что хотите выдать ${type}/2 предупреждение? Боец будет пинганут в Discord.`;
    if (!confirm(question)) return;
    
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/warn`, { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ memberId: id, type, norm }) 
      });
      const data = await res.json();
      if (data.ok) {
        setNotice({
          ok: true,
          text: type === 0 ? "Все предупреждения сняты." : `Предупреждение ${type}/2 успешно выдано!`,
        });
        await reload();
      } else {
        setNotice({ ok: false, text: data.error || "Ошибка выдачи" });
      }
    } catch {
      setNotice({ ok: false, text: "Сбой сети" });
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  /**
   * Доступ к разделу «Контроль»: командир (в том числе командир подразделения
   * по должности со званием) или администратор.
   *
   * Проверка по флагам /api/me, а не по «role === guest»: у командира с
   * сессией кабинета роль панели пустая, и по одному ей он читался гостем —
   * страница показывала «Доступ запрещен. Только для командиров». Флаги
   * считает тот же модуль, что и серверный роут /api/control, поэтому клиент
   * и сервер отвечают одинаково.
   */
  if (!isCommander) {
    return <div className="p-10 text-center font-bold" style={{ color: "var(--red)" }}>Доступ запрещен. Только для командиров.</div>;
  }

  // 1. Сортировка бойцов по часам (от большего к меньшему)
  const sortedFighters = fighters ? [...fighters].sort((a, b) => b.hours - a.hours) : null;

  // Вспомогательная функция для рендера ячейки недели
  const renderCell = (isVacation: boolean, hours: number) => {
    if (isVacation) {
      return <span className="badge" style={{ background: "rgba(16,185,129,0.15)", color: "var(--green)", borderColor: "rgba(16,185,129,0.3)" }}>Отпуск</span>;
    }
    const isOk = hours >= norm;
    return <span className="mono font-bold" style={{ color: isOk ? "var(--green)" : "var(--red)" }}>{hours.toFixed(1)} ч</span>;
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">
            командирская панель // контроль{isAdmin ? " // администратор" : ""}
          </div>
          <h1 className="display text-[34px] font-black leading-tight sm:text-[40px]">Учет онлайна</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Сводка активности. Выдавайте предупреждения, бот автоматически пинганет должников в Discord.
          </p>
        </div>
      </header>

      <AnimatePresence>
        {notice && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="card flex items-start gap-2.5 px-4 py-3" style={{ borderColor: notice.ok ? "rgba(16,185,129,.4)" : "rgba(190,18,60,.45)" }}>
            {notice.ok ? <CheckCircle2 size={16} className="mt-0.5" style={{ color: "var(--green)", flex: "none" }} /> : <XCircle size={16} className="mt-0.5" style={{ color: "var(--red)", flex: "none" }} />}
            <span className="text-[13px]" style={{ color: "var(--muted)" }}>{notice.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <Section title="Журнал активности">
        <div className="overflow-x-auto px-2 pb-2 pt-2">
          {!sortedFighters ? (
            <div className="flex flex-col gap-2 p-4">{[0, 1, 2].map((i) => (<div key={i} className="skeleton" style={{ height: 46 }} />))}</div>
          ) : sortedFighters.length === 0 ? (
            <div className="p-10 text-center text-sm" style={{ color: "var(--muted)" }}>Нет активных бойцов</div>
          ) : (
            <table className="tbl" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Боец</th>
                  <th style={{ textAlign: "center" }}>{getWeekRange(3)}</th>
                  <th style={{ textAlign: "center" }}>{getWeekRange(2)}</th>
                  <th style={{ textAlign: "center" }}>{getWeekRange(1)}</th>
                  <th style={{ textAlign: "center", background: "rgba(255,255,255,0.03)" }}>ТЕКУЩАЯ ({getWeekRange(0)})</th>
                  <th style={{ textAlign: "center" }}>Статус</th>
                  <th style={{ textAlign: "right" }}>Управление</th>
                </tr>
              </thead>
              <tbody>
                {sortedFighters.map((f) => {
                  // Подготавливаем историю. f.stats может содержать до 4 записей (0 - самая новая история)
                  // Если история пуста, ставим null
                  const w1 = f.stats.length >= 3 ? f.stats[2] : null; // Самая старая
                  const w2 = f.stats.length >= 2 ? f.stats[1] : null;
                  const w3 = f.stats.length >= 1 ? f.stats[0] : null; // Прошлая неделя

                  return (
                    <tr key={f.id}>
                      {/* ИМЯ */}
                      <td>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={f.name} />
                          <div>
                            <div className="font-semibold leading-tight">{f.name}</div>
                            <div className="text-[12px]" style={{ color: "var(--dim)" }}>{f.rankName || "—"}</div>
                          </div>
                        </div>
                      </td>

                      {/* ИСТОРИЧЕСКИЕ НЕДЕЛИ (1, 2, 3) */}
                      {[w1, w2, w3].map((stat, idx) => (
                        <td key={idx} style={{ textAlign: "center" }}>
                          {stat ? renderCell(stat.vacation, stat.hours) : <span style={{ color: "var(--dim)" }}>—</span>}
                        </td>
                      ))}

                      {/* НЕДЕЛЯ 4 (ТЕКУЩАЯ ЖИВАЯ СТАТИСТИКА) */}
                      <td style={{ textAlign: "center", background: "rgba(255,255,255,0.02)" }}>
                        {renderCell(f.vacation, f.hours)}
                      </td>

                      {/* ПРЕДУПРЕЖДЕНИЯ / СТАТУС КОМСОСТАВА */}
                      <td style={{ textAlign: "center" }}>
                        {isCommanderFighter(f) ? (
                          <span
                            className="badge font-bold"
                            style={{
                              background: "rgba(255,176,32,0.18)",
                              color: "var(--amber)",
                              borderColor: "rgba(255,176,32,0.5)",
                              boxShadow: "0 0 10px rgba(255,176,32,0.2)",
                              letterSpacing: "0.03em"
                            }}
                          >
                            {isDeputyCommander(f) ? "★ ЗАМ. КОМАНДИРА" : "★ КОМАНДИР"}
                          </span>
                        ) : (
                          <span className={`badge ${f.warnings === 0 ? "badge-green" : f.warnings === 1 ? "badge-amber" : "badge-red"}`}>
                            {f.warnings}/2 пред.
                          </span>
                        )}
                      </td>

                      {/* КНОПКИ УПРАВЛЕНИЯ */}
                      <td style={{ textAlign: "right" }}>
                        {isCommanderFighter(f) ? (
                          <span className="text-[12px] mono" style={{ color: "var(--dim)" }}>
                            —
                          </span>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <button 
                              className="btn" 
                              style={{ padding: "0.4rem 0.6rem", fontSize: "0.75rem", background: "var(--amber-soft)", color: "#fff", borderColor: "rgba(255,176,32,.5)" }}
                              disabled={busyIds.has(f.id)}
                              onClick={() => issueWarning(f.id, 1)}
                            >
                              <AlertTriangle size={13} /> 1/2 Пред
                            </button>
                            
                            <button 
                              className="btn" 
                              style={{ padding: "0.4rem 0.6rem", fontSize: "0.75rem", background: "var(--red-soft)", color: "#fff", borderColor: "rgba(190,18,60,.5)" }}
                              disabled={busyIds.has(f.id)}
                              onClick={() => issueWarning(f.id, 2)}
                            >
                              <UserMinus size={13} /> 2/2 Пред
                            </button>

                            {f.warnings > 0 && (
                              <button
                                className="btn"
                                style={{ padding: "0.4rem 0.6rem", fontSize: "0.75rem", background: "var(--green-soft)", color: "#fff", borderColor: "rgba(16,185,129,.5)" }}
                                disabled={busyIds.has(f.id)}
                                onClick={() => issueWarning(f.id, 0)}
                              >
                                <CheckCircle2 size={13} /> Снять пред
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Section>
    </div>
  );
}