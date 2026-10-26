"use client";

/**
 * Состав подразделения (табель).
 *
 * Что видит личный состав: позывной, звание с должностью, онлайн, статус. Что
 * видит штаб дополнительно: колонку Discord ID с полем для привязки (по нему
 * бот упоминает человека в Discord) и сводку «без Discord ID».
 *
 * Технические идентификаторы не показываются бойцам намеренно: они не нужны для
 * несения службы, а утечка ID позволяет увести человека в личку или упомянуть
 * его в чужом канале. Права проверяются и на сервере (/api/members обнуляет
 * поле для не-штаба), поэтому скрытие в разметке — не единственный рубеж.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CalendarDays, CheckCircle2, CloudDownload, Ghost, Palmtree,
  Search, Users, X, XCircle,
} from "lucide-react";
import { Avatar, Section, Spinner, fmtDate } from "@/components/ui";
import { DiscordIdCell, type DiscordIdSaveResult } from "@/components/discord-id-cell";
import { MemberDeleteButton, type MemberDeleteResult } from "@/components/member-delete-button";
import {
  MemberActionButtons,
  type MemberActionResult,
} from "@/components/member-action-buttons";
import { isRosterActive as isMemberInRoster } from "@/lib/recruits";
import type { MemberAction } from "@/lib/member-lifecycle";

/**
 * Строка табеля.
 *
 * callsign и unit нужны ячейке Discord ID: роут правки ищет бойца по этим
 * значениям в листе Google Таблицы (позывной — как зовёт его ШДС, подразделение
 * — как называется лист), поэтому в типе они обязательны, хотя в разметке
 * строки не показываются.
 */
type Member = { id: number; name: string; handle: string | null; callsign: string | null; unit: string | null; rankName: string | null; post: string | null; hours: number; vacation: boolean; vacationUntil: string | null; status: string | null; discordId: string | null; active: boolean; updatedAt: string; };
type Notice = { ok: boolean; text: string } | null;

/** Роли, которым доступны приватные поля состава (панель или кабинет) */
const STAFF_ROLES = ["admin", "officer", "commander"];

export default function MembersPage() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [norm, setNorm] = useState(10);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [onlyDebtors, setOnlyDebtors] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  /** Боец, для которого открыто окно управления отпуском */
  const [vacationFor, setVacationFor] = useState<Member | null>(null);
  /** Дата возвращения в черновике окна отпуска (YYYY-MM-DD) */
  const [vacationUntilDraft, setVacationUntilDraft] = useState("");
  /** Создаётся ли отпуск (true) или снимается (false) в открытом окне */
  const [vacationApply, setVacationApply] = useState(true);
  /** Роль сессии панели: guest / officer / admin */
  const [role, setRole] = useState("guest");
  /** Администратор ли текущий пользователь — из /api/me (право считает сервер) */
  const [isAdmin, setIsAdmin] = useState(false);
  /** Роль бойца из кабинета: пусто, если кабинет не открыт */
  const [memberRole, setMemberRole] = useState("");
  /**
   * ID бойца текущей сессии (из /api/me → member.id).
   *
   * Нужен защите от «самострела»: кнопки «В запас»/«Уволить» не рендерятся
   * для самого себя. Право считает сервер, клиент лишь скрывает кнопку.
   */
  const [selfMemberId, setSelfMemberId] = useState<number | null>(null);
  /**
   * Правка Discord ID разрешена этому пользователю.
   *
   * Значение приходит из /api/me флагом isCommander/isAdmin: права считает
   * общее правило (resolvePanelRights) с учётом должности и звания из табеля,
   * а клиент их только отображает. Выводи сам клиент права из роли — и
   * открытое в интерфейсе поле упиралось бы в 403 на сервере (баг из отчёта).
   */
  const [canEditRosterDiscordId, setCanEditRosterDiscordId] = useState(false);
  /** Разрешено ли видеть приватные поля — из /api/me (право считает сервер) */
  const [canViewPrivate, setCanViewPrivate] = useState(false);
  /**
   * Приватные поля состава (Discord ID) видит штаб панели ИЛИ штаб кабинета:
   * командир, вошедший в личный кабинет, тоже ведёт учёт онлайна.
   *
   * Учитывается и флаг /api/me: командир подразделения может иметь роль
   * «member» в табеле и права лишь по должности, и по одной роли колонка
   * Discord ID осталась бы для него скрытой. Тот же признак считает сервер
   * (/api/members возвращает поле или null) — интерфейс и API совпадают.
   */
  const canSeePrivate =
    canViewPrivate || STAFF_ROLES.includes(role) || STAFF_ROLES.includes(memberRole);
  /**
   * Правки состава идут через сессию панели (PATCH /api/members/[id] требует
   * requireAuth): бойцу-командиру поле ввода не показываем, иначе он получил бы
   * интерфейс, который отвечает «Нет доступа».
   */
  const canEditPanel = STAFF_ROLES.includes(role);
  /**
   * Правка Discord ID в табеле.
   *
   * Окно с записью в Google Таблицу ШДС раньше видел только администратор, а
   * командиру оставался ввод старой панели. По требованию поле должны править и
   * командиры (в том числе командир подразделения по должности), поэтому окно
   * показываем всем, кому разрешена правка: право спрашиваем у /api/me флагом
   * canEditRosterDiscordId, а не выводим из роли на клиенте. Сервер проверяет
   * то же самое (requireRosterEditor) — интерфейс и роут не разойдутся.
   *
   * Если флага нет (например, сессия старого образца), остаётся ветка с
   * canEditPanel: возможность правки в базе панели убирать нельзя.
   */
  const canEditDiscordId = canEditRosterDiscordId || canEditPanel;
  /**
   * Полное удаление профиля — СТРОГО администратор.
   *
   * Флаг isAdmin приходит из /api/me (право считает сервер по обеим сессиям и
   * по роли из БД), а не выводится из строки роли на клиенте: иначе кнопка
   * показывалась бы командиру, которому роут отвечает 403. Отдельно от
   * canEditDiscordId намеренно: правка состава — полномочие командира,
   * удаление личного дела — только администратора.
   */
  const canDeleteMembers = Boolean(isAdmin);

  const reload = useCallback(async () => {
    const [m, s, me] = await Promise.all([
      fetch("/api/members", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/stats", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/me", { cache: "no-store" }).then((r) => r.json()), // Кто вошёл: панель или кабинет
    ]);
    setMembers(m.members ?? []);
    setNorm(s.norm ?? 10);
    /**
     * Роли хранятся раздельно: сессия панели и сессия бойца дают разные права
     * (правки состава — только панель), а видеть Discord ID вправе обе.
     */
    setRole(me.role || "guest");
    setIsAdmin(Boolean(me.isAdmin));
    setMemberRole(me.member?.role ?? "");
    setSelfMemberId(typeof me.member?.id === "number" ? me.member.id : null);
    setCanEditRosterDiscordId(Boolean(me.isCommander || me.isAdmin));
    setCanViewPrivate(Boolean(me.canViewPrivate));
  }, []);

  useEffect(() => { reload().catch(() => setMembers([])); }, [reload]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /**
   * Полное удаление профиля бойца.
   *
   * Строка убирается из таблицы без перезагрузки страницы: сводные карточки
   * («Активных бойцов», «В отпуске», «Без Discord ID») считаются из того же
   * массива members, поэтому числа пересчитываются сами. При ошибке список не
   * трогаем — сервер отказал, значит боец на месте.
   */
  const deleteMember = async (id: number, confirmation: string): Promise<MemberDeleteResult> => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/admin/members/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      const data = await res.json();
      if (!data.ok) {
        const error = data.error || "Не удалось удалить профиль";
        setNotice({ ok: false, text: error });
        return { ok: false, error };
      }
      setMembers((prev) => (prev ?? []).filter((m) => m.id !== id));
      setNotice({ ok: true, text: data.message || "Профиль бойца удалён" });
      return { ok: true, message: data.message ?? null };
    } catch {
      const error = "Сбой сети при удалении профиля";
      setNotice({ ok: false, text: error });
      return { ok: false, error };
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  /**
   * Административное действие «В запас» / «Уволить».
   *
   * Запрос уходит в POST /api/members/[id]/action: сервер синхронизирует БД,
   * Google Таблицу и Discord. Строка обновляется из ответа (там актуальный
   * статус и подразделение), сводки пересчитываются сами — они выводятся из
   * того же массива members. Ошибка Discord не отменяет действие: сервер
   * возвращает ok=true с предупреждением, и штаб видит его в notice.
   */
  const runMemberAction = async (
    id: number,
    action: MemberAction,
    reason: string
  ): Promise<MemberActionResult> => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/members/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: reason || undefined }),
      });
      const data = await res.json();
      if (!data.ok) {
        const error = data.error || "Не удалось выполнить действие";
        setNotice({ ok: false, text: error });
        return { ok: false, error };
      }
      if (data.member) {
        setMembers((prev) => (prev ?? []).map((m) => (m.id === id ? data.member : m)));
      }
      setNotice({ ok: true, text: data.message || "Действие выполнено" });
      return { ok: true, message: data.message };
    } catch {
      const error = "Сбой сети при выполнении действия";
      setNotice({ ok: false, text: error });
      return { ok: false, error };
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  /**
   * Правка карточки (отпуск, Discord ID).
   *
   * Ответ содержит итог по роли Discord «Отпуск». Молчать о нём нельзя: если
   * бот не смог выдать или снять роль (нет прав, роль выше роли бота, не
   * привязан Discord), база уже обновлена, и штаб должен знать, что на сервере
   * роль осталась прежней — иначе отпуск считается оформленным только наполовину.
   */
  const patch = async (id: number, body: Record<string, unknown>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/members/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.ok) {
        setMembers((prev) => (prev ?? []).map((m) => (m.id === id ? data.member : m)));
        const role = data.vacationRole as
          | { ok: boolean; message: string; error: string | null }
          | null
          | undefined;
        if (role && !role.ok) {
          // Предупреждение, а не ошибка: сохранение в базе прошло успешно
          setNotice({
            ok: false,
            text: `Отпуск сохранён, но роль Discord не изменена: ${role.error || role.message}`,
          });
        } else if (role?.ok) {
          setNotice({ ok: true, text: `Сохранено. ${role.message}` });
        }
      }
      else { setNotice({ ok: false, text: data.error || "Не удалось сохранить" }); }
    } catch { setNotice({ ok: false, text: "Сбой сети при сохранении" }); }
    finally { setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; }); }
  };

  /** Подтверждение окна отпуска: ставит или снимает отпуск с датой возврата */
  const confirmVacation = async () => {
    if (!vacationFor) return;
    const until = vacationApply ? vacationUntilDraft.trim() : null;
    await patch(vacationFor.id, {
      vacation: vacationApply,
      vacationUntil: until || null,
    });
    setVacationFor(null);
  };

  /**
   * Правка Discord ID администратором: база панели + Google Таблица ШДС.
   *
   * Оптимистичное обновление: значение в строке подставляется сразу, а сводка
   * «Без Discord ID» пересчитывается сама — она выводится из того же массива
   * members, поэтому перезагрузка страницы не нужна. Если сервер отказал,
   * возвращаем прежнее значение и показываем причину; если правка в базе прошла,
   * а таблица не обновилась — предупреждение (не ложный «успех»).
   */
  const saveDiscordId = async (id: number, discordId: string): Promise<DiscordIdSaveResult> => {
    const previous = members ?? [];
    setBusyIds((prev) => new Set(prev).add(id));
    // Оптимистичная подстановка: пустая строка = снятая привязка (null)
    setMembers((prev) =>
      (prev ?? []).map((m) => (m.id === id ? { ...m, discordId: discordId || null } : m))
    );

    try {
      const res = await fetch(`/api/admin/roster/${id}/discord-id`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId }),
      });
      const data = await res.json();
      if (!data.ok) {
        setMembers(previous);
        setNotice({ ok: false, text: data.error || "Не удалось сохранить Discord ID" });
        return { ok: false, error: data.error };
      }
      // Строка берётся из ответа сервера: там и нормализованное значение, и updatedAt
      setMembers((prev) => (prev ?? []).map((m) => (m.id === id ? data.member : m)));
      /**
       * Снежинку могли освободить от выбывшей карточки (дубль после смены
       * ника). Об этом нужно сказать вслух: в табеле у старой записи ID
       * исчез, и без пояснения это выглядело бы случайной потерей данных.
       */
      const released = Array.isArray(data.released) ? (data.released as string[]) : [];
      const releasedNote = released.length
        ? ` Прежняя привязка снята у выбывших: ${released.join(", ")}.`
        : "";
      const base = data.warning || data.sheets?.message || "Discord ID сохранён";
      setNotice({ ok: true, text: `${base}${releasedNote}` });
      return { ok: true, warning: data.warning ?? null };
    } catch {
      setMembers(previous);
      setNotice({ ok: false, text: "Сбой сети при сохранении Discord ID" });
      return { ok: false, error: "Сбой сети" };
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setNotice({ ok: !!data.ok, text: data.ok ? data.detail : data.detail || data.error || "Ошибка синхронизации" });
    } catch { setNotice({ ok: false, text: "Сбой сети" }); } 
    finally { setSyncing(false); await reload(); }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members ?? []).filter((m) => {
      // Действующий боец — по общему правилу (isRosterActive): отпуск остаётся
      // в составе, а исключённый/выбывший скрывается, даже если флаг active
      // забыли снять. То же правило применяет «Учёт онлайна» (/api/control),
      // поэтому число бойцов в двух разделах совпадает.
      if (!showInactive && !isMemberInRoster(m)) return false;
      if (onlyDebtors && !(isMemberInRoster(m) && !m.vacation && Math.floor(m.hours) < norm)) return false;
      if (!q) return true;
      // Discord ID участвует в поиске только у штаба: иначе по перебору цифр
      // можно было бы узнать, привязан ли конкретный человек к Discord
      const haystack = [m.name, m.rankName ?? "", m.post ?? "", canSeePrivate ? m.discordId ?? "" : ""];
      return haystack.join(" ").toLowerCase().includes(q);
    });
  }, [members, query, showInactive, onlyDebtors, norm, canSeePrivate]);

  const all = members ?? [];
  const active = all.filter((m) => isMemberInRoster(m));
  const onVacation = active.filter((m) => m.vacation).length;
  /** Сколько бойцов без Discord — рабочая сводка штаба, бойцам не показывается */
  const withoutDiscord = active.filter((m) => !m.discordId).length;
  const lastSync = all.length ? all.reduce((a, b) => (new Date(a.updatedAt) > new Date(b.updatedAt) ? a : b)).updatedAt : null;

  /**
   * Сводные карточки: «Без Discord ID» — служебный показатель (по нему штаб
   * видит, кого не удастся упомянуть в Discord), поэтому он показывается только
   * тем, у кого есть доступ к самим ID. Остальным — состав и отпуска.
   */
  const summary = [
    { label: "Активных бойцов", value: active.length, icon: Users, tint: "#7c9aff" },
    { label: "В отпуске", value: onVacation, icon: Palmtree, tint: "#ffb020" },
    ...(canSeePrivate
      ? [{ label: "Без Discord ID", value: withoutDiscord, icon: Ghost, tint: "#be123c" }]
      : [{ label: "Выбывших в списке", value: all.length - active.length, icon: Ghost, tint: "#be123c" }]),
  ];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">личный состав // division 05</div>
          <h1 className="display text-[34px] font-black leading-tight sm:text-[40px]">Состав</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            {canSeePrivate
              ? "Отпуск исключает бойца из пингов. Discord ID нужен для персональных упоминаний."
              : "Отпуск исключает бойца из пингов. Часы считает синхронизация с rs-red.com."}
          </p>
        </div>
        {/* Кнопка синхронизации доступна только командирам панели */}
        {canEditPanel && (
          <button className="btn btn-primary" onClick={sync} disabled={syncing}>
            {syncing ? <Spinner /> : <CloudDownload size={15} />}
            Синхронизировать с rs-red.com
          </button>
        )}
      </header>

      <AnimatePresence>
        {notice && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="card flex items-start gap-2.5 px-4 py-3" style={{ borderColor: notice.ok ? "rgba(16,185,129,.4)" : "rgba(190,18,60,.45)" }}>
            {notice.ok ? <CheckCircle2 size={16} className="mt-0.5" style={{ color: "var(--green)", flex: "none" }} /> : <XCircle size={16} className="mt-0.5" style={{ color: "var(--red)", flex: "none" }} />}
            <span className="text-[13px]" style={{ color: "var(--muted)" }}>{notice.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-5 sm:grid-cols-3">
        {summary.map((s) => (
          <div key={s.label} className="card card-hover flex items-center gap-3.5 px-5 py-4">
            <span className="flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 12, background: `${s.tint}1f`, color: s.tint }}><s.icon size={17} /></span>
            <div><div className="display text-[22px] font-black leading-none">{members ? s.value : "—"}</div><div className="label mt-1">{s.label}</div></div>
          </div>
        ))}
      </div>

      <Section title="Бойцы подразделения" eyebrow={lastSync ? `обновлено ${fmtDate(lastSync)}` : "ожидание синхронизации"} action={
          <div className="relative" style={{ width: 240 }}>
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--dim)" }} />
            <input className="input" style={{ paddingLeft: "2.1rem", paddingTop: "0.5rem", paddingBottom: "0.5rem", fontSize: "0.82rem" }} placeholder={canSeePrivate ? "Поиск по имени, званию, ID…" : "Поиск по имени, званию…"} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          <button className={`chip ${onlyDebtors ? "" : ""}`} style={onlyDebtors ? { borderColor: "rgba(190,18,60,.5)", background: "var(--red-soft)", color: "#fff" } : { cursor: "pointer" }} onClick={() => setOnlyDebtors((v) => !v)}><span className={`dot ${onlyDebtors ? "dot-err" : "dot-dim"}`} />Только должники (&lt; {norm} ч)</button>
          <button className="chip" style={showInactive ? { borderColor: "rgba(255,176,32,.5)", background: "var(--amber-soft)", color: "#fff" } : { cursor: "pointer" }} onClick={() => setShowInactive((v) => !v)}><span className={`dot ${showInactive ? "dot-warn" : "dot-dim"}`} />Показать выбывших</button>
        </div>

        <div className="overflow-x-auto px-2 pb-2 pt-2">
          {!members ? (
            <div className="flex flex-col gap-2 p-4">{[0, 1, 2, 3, 4].map((i) => (<div key={i} className="skeleton" style={{ height: 46 }} />))}</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center"><Users size={20} style={{ color: "var(--dim)" }} /><p className="text-sm" style={{ color: "var(--muted)" }}>{all.length === 0 ? "Состав пуст — нажмите «Синхронизировать с rs-red.com»" : "Никого не найдено по фильтрам"}</p></div>
          ) : (
            <table className="tbl" style={{ minWidth: (canSeePrivate ? 900 : 680) + (canDeleteMembers ? 70 : 0) }}>
              <thead><tr>
                <th>Позывной</th>
                <th>Звание / должность</th>
                <th>Онлайн</th>
                {/* Discord ID — рабочая колонка штаба: по ней бот пингует человека */}
                {canSeePrivate && <th>Discord ID</th>}
                <th style={{ textAlign: "center" }}>Статус</th>
                {/* Колонка необратимых действий — только администратору */}
                {canDeleteMembers && <th style={{ textAlign: "center" }}>Действия</th>}
              </tr></thead>
              <tbody>
                {filtered.map((m) => {
                  const okNorm = Math.floor(m.hours) >= norm;
                  const zero = Math.floor(m.hours) === 0;
                  return (
                    <tr key={m.id} className={`${m.vacation ? "row-vacation" : ""} ${m.active ? "" : "row-inactive"}`}>
                      <td><div className="flex items-center gap-2.5"><Avatar name={m.name} discordId={m.discordId} /><div><div className="font-semibold leading-tight">{m.name}{m.handle ? <span className="ml-1.5 text-[11px]" style={{ color: "var(--dim)" }}>@{m.handle}</span> : null}</div>{!m.active && (<span className="badge badge-red mt-0.5">выбыл</span>)}</div></div></td>
                      <td style={{ color: "var(--muted)" }}>{m.rankName ?? "—"}{m.post ? (<span style={{ color: "var(--dim)" }}> · {m.post}</span>) : null}</td>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <div className="hours-track"><div className="hours-fill" style={{ width: `${Math.min(100, (m.hours / norm) * 100)}%`, background: m.vacation ? "var(--amber)" : okNorm ? "var(--green)" : zero ? "var(--red)" : "var(--amber)" }} /></div>
                          <span className="mono text-[13px] font-bold" style={{ color: m.vacation ? "var(--amber)" : okNorm ? "var(--green)" : "var(--red)" }}>{m.hours.toFixed(1)} ч</span>
                        </div>
                      </td>

                      {/* Discord ID: только штабу — остальным колонка не отрисовывается.
                          Администратор правит значение через окно (запись и в панель,
                          и в Google Таблицу ШДС); командиру доступен прежний ввод
                          панели; командиру из кабинета поле показываем только для
                          чтения (без обмана) */}
                      {canSeePrivate && (
                        <td>
                          {canEditDiscordId ? (
                            <DiscordIdCell
                              member={{ id: m.id, name: m.name, callsign: m.callsign, unit: m.unit, discordId: m.discordId }}
                              onSave={saveDiscordId}
                            />
                          ) : (
                            <span className="mono text-[12.5px]" style={{ color: m.discordId ? "var(--text)" : "var(--dim)" }}>
                              {m.discordId || "—"}
                            </span>
                          )}
                        </td>
                      )}

                      <td style={{ textAlign: "center" }}>
                        <div className="inline-flex items-center justify-center gap-2">
                          {m.status === "reserve" || m.status === "dismissed" ? (
                            <span className="badge badge-reserve">
                              {m.status === "reserve" ? "в резерве" : "выбыл"}
                            </span>
                          ) : m.vacation ? (
                            <span className="badge badge-info" title={m.vacationUntil ? `До ${fmtDate(m.vacationUntil)}` : undefined}>
                              <Palmtree size={12} className="mr-1" style={{ display: 'inline-block' }} />
                              в отпуске
                              {m.vacationUntil ? ` · до ${fmtDate(m.vacationUntil)}` : null}
                            </span>
                          ) : (
                            <span className="badge badge-green">в строю</span>
                          )}
                          {/* Управление отпуском — штатная кнопка для офицеров:
                              вместо слепого тумблера открывает окно с датой возврата */}
                          {canEditPanel && (
                            <button
                              type="button"
                              className="btn btn-sm btn-icon"
                              title={m.vacation ? "Снять отпуск" : "В отпуск"}
                              aria-label={m.vacation ? `Снять отпуск бойцу ${m.name}` : `Отправить ${m.name} в отпуск`}
                              disabled={busyIds.has(m.id)}
                              onClick={() => {
                                setVacationFor(m);
                                setVacationApply(!m.vacation);
                                setVacationUntilDraft(m.vacationUntil ? m.vacationUntil.slice(0, 10) : "");
                              }}
                            >
                              {m.vacation ? <X size={13} /> : <Palmtree size={13} />}
                            </button>
                          )}
                          {/* «В запас» / «Уволить»: штабу, с окном подтверждения.
                              Командование корпуса и сам пользователь кнопок не
                              видят — правило isProtectedLifecycleTarget скрывает
                              их в самом компоненте */}
                          {canEditPanel && (
                            <MemberActionButtons
                              member={{
                                id: m.id,
                                name: m.name,
                                rank: m.rankName,
                                unit: m.unit,
                                post: m.post,
                                discordId: m.discordId,
                                status: m.status,
                              }}
                              selfMemberId={selfMemberId}
                              onAction={runMemberAction}
                              disabled={busyIds.has(m.id)}
                              compact
                            />
                          )}
                        </div>
                      </td>

                      {/* Полное удаление профиля: кнопка рендерится только
                          администратору (canDeleteMembers из /api/me), а окно
                          подтверждения требует ввести позывной бойца */}
                      {canDeleteMembers && (
                        <td style={{ textAlign: "center" }}>
                          <MemberDeleteButton
                            member={{ id: m.id, name: m.name, callsign: m.callsign }}
                            onDelete={deleteMember}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      {/* Окно управления отпуском: офицер задаёт дату возврата, а не просто
          щёлкает тумблер. Правка уходит PATCH /api/members/[id] под гвардом
          requireRosterEditor — тем же правилом, что разрешает кнопку в строке. */}
      <AnimatePresence>
        {vacationFor && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
            style={{ background: "var(--overlay)", backdropFilter: "blur(4px)" }}
            onClick={() => setVacationFor(null)}
            role="dialog"
            aria-modal="true"
            aria-label={`Отпуск бойца ${vacationFor.name}`}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 14 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 14 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="card my-10 w-full max-w-[420px]"
              style={{ background: "var(--modal)", backdropFilter: "blur(14px)", borderColor: "rgba(255,176,32,0.3)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <header className="flex items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--stroke-soft)" }}>
                <div>
                  <div className="label mb-0.5">состав // отпуск</div>
                  <h2 className="display text-[14px] font-bold">{vacationFor.name}</h2>
                </div>
                <button type="button" onClick={() => setVacationFor(null)} className="btn btn-sm btn-icon" title="Закрыть" aria-label="Закрыть окно">
                  <X size={14} />
                </button>
              </header>

              <div className="flex flex-col gap-4 px-5 py-4">
                <p className="text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
                  {vacationApply
                    ? "Боец исключается из пингов на время отпуска. Укажите дату возвращения."
                    : "Боец возвращается в строй и снова включается в пинги."}
                </p>

                {vacationApply && (
                  <label className="flex flex-col gap-1.5">
                    <span className="label">Дата возвращения</span>
                    <input
                      className="input"
                      type="date"
                      value={vacationUntilDraft}
                      onChange={(e) => setVacationUntilDraft(e.target.value)}
                      aria-label="Дата возвращения из отпуска"
                    />
                  </label>
                )}

                <div className="flex items-center justify-end gap-2">
                  <button type="button" className="btn" onClick={() => setVacationFor(null)} disabled={busyIds.has(vacationFor.id)}>
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyIds.has(vacationFor.id)}
                    onClick={() => void confirmVacation()}
                  >
                    {busyIds.has(vacationFor.id) ? <Spinner /> : <CalendarDays size={15} />}
                    {vacationApply ? "Отправить в отпуск" : "Вернуть в строй"}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
