"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import React, { useEffect, useState } from "react";
import BackgroundSlideshow from "@/components/background";
import {
  Activity, Badge, BookOpen, Bot, ClipboardCheck, Clock3, Globe, LayoutDashboard,
  ScrollText, Settings2, Users, LogIn, LogOut, ShieldAlert, UserRound, Inbox,
  ChevronDown, FilePlus2, Crosshair
} from "lucide-react";
import { REPORT_TYPE_META } from "@/lib/reports";

type StatusResponse = {
  bot: { configured: boolean; ok: boolean; user?: { username: string }; error?: string };
  site: { ok: boolean; error?: string };
  schedulerAlive: boolean;
  timezone: string;
};

function Clock() {
  const [now, setNow] = useState("");
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", day: "numeric", month: "short" });
    const update = () => setNow(fmt.format(new Date()));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="chip mono" style={{ fontSize: "0.72rem" }}>
      <Clock3 size={12} style={{ color: "var(--red)" }} />
      {now || "—"} МСК
    </div>
  );
}

function StatusBlock() {
  const [status, setStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setStatus(data);
      } catch {}
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const Row = ({ icon: Icon, label, state, hint }: { icon: typeof Bot; label: string; state: "ok" | "err" | "dim"; hint: string }) => (
    <div className="flex items-center gap-2.5 px-1 py-1">
      <Icon size={14} style={{ color: "var(--dim)", flex: "none" }} />
      <span className="text-[12px] font-medium" style={{ color: "var(--muted)" }}>{label}</span>
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`dot ${state === "ok" ? "dot-ok" : state === "err" ? "dot-err" : "dot-dim"} ${state === "err" ? "pulse-dot" : ""}`} />
        <span className="text-[11px]" style={{ color: "var(--dim)" }}>{hint}</span>
      </span>
    </div>
  );

  return (
    <div className="card mt-auto" style={{ padding: "12px 12px 8px", background: "rgba(13,15,24,0.85)" }}>
      <div className="label px-1 pb-1.5">Система</div>
      <Row icon={Bot} label="Discord-бот" state={status ? (status.bot.ok ? "ok" : "err") : "dim"} hint={status ? (status.bot.ok ? `@${status.bot.user?.username ?? "онлайн"}` : "ошибка") : "…"} />
      <Row icon={Globe} label="rs-red.com" state={status ? (status.site.ok ? "ok" : "err") : "dim"} hint={status ? (status.site.ok ? "доступен" : "нет доступа") : "…"} />
      <Row icon={Activity} label="Планировщик" state={status ? (status.schedulerAlive ? "ok" : "err") : "dim"} hint={status ? (status.schedulerAlive ? "работает" : "остановлен") : "…"} />
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [role, setRole] = useState("guest");
  const [member, setMember] = useState<{ callsign: string; status: string; statusLabel: string } | null>(null);
  /**
   * Раскрытие подменю «Подать рапорт».
   *
   * Состояние клиентское, но при переходе на страницу рапорта список типов
   * показывается раскрытым (см. reportsOpen) — иначе выбранный пункт «терялся»
   * бы сразу после клика и боец не видел, где он находится.
   */
  const [reportMenuOpen, setReportMenuOpen] = useState(false);

  useEffect(() => {
    fetch("/api/me", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setRole(d.role || "guest");
        setMember(d.member || null);
      })
      .catch(() => {});
  }, [pathname]);

  const handleLogout = async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/";
  };

  /** Выход из личного кабинета бойца (сессия панели не затрагивается) */
  const handleMemberLogout = async () => {
    await fetch("/api/auth/member-logout", { method: "POST" });
    window.location.href = "/login";
  };

  const NAV = [
    // «Личный кабинет» — первым пунктом: это личное дело бойца (статус службы,
    // «Кто на ВЧ», допуск к технике, свои рапорты), и заходит он сюда чаще
    // всего. Пункт появляется только у того, кто реально вошёл как боец:
    // у гостя панели кабинета нет.
    ...(member
      ? [
          {
            href: "/profile",
            label: "Личный кабинет",
            icon: Badge,
            roles: ["guest", "officer", "admin"],
          },
        ]
      : []),
    { href: "/", label: "Обзор", icon: LayoutDashboard, roles: ["guest", "officer", "admin"] },
    { href: "/members", label: "Состав", icon: Users, roles: ["guest", "officer", "admin"] },
    // «Арсенал»: пресеты выкладок для состава. Пункт виден только вошедшему —
    // каталог отдаётся под сессией бойца либо панели, и гостю он был бы тупиком
    { href: "/armory", label: "Арсенал", icon: Crosshair, roles: ["guest", "officer", "admin"] },
    { href: "/admin/recruits", label: "Рапорты", icon: ClipboardCheck, roles: ["officer", "admin"] },
    { href: "/admin/reports", label: "Рапорты и заявки", icon: Inbox, roles: ["officer", "admin"] },
    { href: "/docs", label: "Документация", icon: BookOpen, roles: ["guest", "officer", "admin"] },
    { href: "/control", label: "Контроль", icon: ShieldAlert, roles: ["officer", "admin"] },
    { href: "/logs", label: "Журнал", icon: ScrollText, roles: ["officer", "admin"] },
    { href: "/settings", label: "Настройки", icon: Settings2, roles: ["admin"] },
  ];
  const filteredNav = NAV.filter(item => item.roles.includes(role)).filter(
    (item) => item.href !== "/armory" || Boolean(member) || role !== "guest",
  );

  /**
   * Меню «Подать рапорт» доступно только вошедшему бойцу: рапорт подаётся от
   * своего имени, и без сессии кабинета сервер его отклонит (401). Показывать
   * пункт гостю значило бы вести его в тупик.
   */
  const canSubmitReport = Boolean(member) && member?.status !== "pending";
  const reportsOpen = pathname.startsWith("/reports");

  if (pathname === "/cookie-bridge") {
    return (
      <>
        <div className="fx-bg fx-grid" />
        <div className="fx-bg fx-glow-red" />
        <div className="fx-bg fx-noise" />
        <div className="relative z-10">{children}</div>
      </>
    );
  }

  return (
    <>
      {/* Фоновое слайд-шоу — поддерживает зацикливание и кроссфейд */}
      <BackgroundSlideshow />
      <div className="fx-bg fx-grid" />
      <div className="fx-bg fx-glow-red" />
      <div className="fx-bg fx-glow-blue" />
      <div className="fx-bg fx-noise" />

      <aside className="sidebar">
        <Link href="/" className="flex items-center gap-4 px-2 pb-8 pt-2">
          {/* Идеально круглый логотип (с жесткой обрезкой) */}
          <div
            className="floaty relative flex items-center justify-center shrink-0 ml-1"
            style={{
              width: 68,
              height: 68,
              boxShadow: "0 0 35px 10px rgba(255,61,61,0.18)",
              borderRadius: "50%",
              overflow: "hidden"
            }}
          >
            <img 
              src="/atk-logo.png" 
              alt="АТК" 
              className="w-full h-full object-cover" 
            />
          </div>
          <div className="flex-1 text-center pr-3">
            <div className="display text-[20px] font-bold tracking-widest text-white">ATK&nbsp;RED</div>
          </div>
        </Link>

        <nav className="flex flex-col gap-1">
          {filteredNav.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className={`nav-link ${active ? "nav-active" : ""}`}>
                {active && <motion.span layoutId="nav-glow" className="nav-glow" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                <span style={{ position: "relative", zIndex: 1, display: "flex", gap: "0.7rem", alignItems: "center" }}>
                  <Icon size={16} style={active ? { color: "var(--red)" } : undefined} />
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Меню «Подать рапорт»: аккордеон с типами рапортов */}
        {canSubmitReport && (
          <div className="mt-1 flex flex-col">
            <button
              type="button"
              onClick={() => setReportMenuOpen((v) => !v)}
              className={`nav-link ${pathname.startsWith("/reports") ? "nav-active" : ""}`}
              aria-expanded={reportMenuOpen || reportsOpen}
              style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
            >
              <span style={{ position: "relative", zIndex: 1, display: "flex", gap: "0.7rem", alignItems: "center" }}>
                <FilePlus2 size={16} style={pathname.startsWith("/reports") ? { color: "var(--red)" } : undefined} />
                Подать рапорт
                <motion.span
                  animate={{ rotate: reportMenuOpen || reportsOpen ? 0 : -90 }}
                  transition={{ duration: 0.25, ease: [0.22, 0.8, 0.24, 1] }}
                  style={{ display: "flex", marginLeft: "auto" }}
                >
                  <ChevronDown size={15} />
                </motion.span>
              </span>
            </button>

            <AnimatePresence initial={false}>
              {(reportMenuOpen || reportsOpen) && (
                <motion.div
                  key="report-submenu"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.22, 0.8, 0.24, 1] }}
                  style={{ overflow: "hidden" }}
                >
                  <div className="flex flex-col gap-0.5 pt-1 pl-3">
                    {REPORT_TYPE_META.map((item) => {
                      const href = `/reports/${item.type}`;
                      const active = pathname === href;
                      return (
                        <Link
                          key={item.type}
                          href={href}
                          className="nav-link"
                          style={{
                            fontSize: "0.78rem",
                            paddingLeft: "0.6rem",
                            color: active ? "var(--text)" : undefined,
                          }}
                          title={item.hint}
                        >
                          <span style={{ position: "relative", zIndex: 1, display: "flex", gap: "0.55rem", alignItems: "center" }}>
                            <span aria-hidden style={{ fontSize: "0.85rem" }}>{item.icon}</span>
                            {item.label}
                          </span>
                        </Link>
                      );
                    })}
                    <Link
                      href="/reports"
                      className="nav-link"
                      style={{ fontSize: "0.76rem", paddingLeft: "0.6rem", color: "var(--dim)" }}
                    >
                      <span style={{ position: "relative", zIndex: 1, display: "flex", gap: "0.55rem", alignItems: "center" }}>
                        <ScrollText size={13} /> Мои рапорты
                      </span>
                    </Link>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        <div className="mt-4 px-2 flex flex-col gap-2">
          {member && (
            <div className="chip w-full justify-between" style={{ fontSize: "0.72rem" }}>
              <span className="flex items-center gap-1.5">
                <UserRound size={12} style={{ color: "var(--red)" }} />
                {member.callsign}
              </span>
              <span style={{ color: "var(--dim)" }}>{member.statusLabel}</span>
            </div>
          )}
          {role === "guest" && !member && (
            <Link href="/login" className="btn btn-sm w-full" style={{ background: "rgba(255,255,255,0.05)", borderColor: "transparent", color: "var(--text)" }}>
              <LogIn size={14} /> Вход
            </Link>
          )}
          {member && (
            <button
              onClick={handleMemberLogout}
              className="btn btn-sm w-full"
              style={{ background: "rgba(255,61,61,0.1)", borderColor: "transparent", color: "var(--red)" }}
            >
              <LogOut size={14} /> Выйти из кабинета
            </button>
          )}
          {role !== "guest" && (
            <button onClick={handleLogout} className="btn btn-sm w-full" style={{ background: "rgba(255,255,255,0.05)", borderColor: "transparent", color: "var(--muted)" }}>
              <LogOut size={14} /> Выйти из панели
            </button>
          )}
        </div>

        <StatusBlock />
      </aside>

      <div className="mobile-bar">
        <Link href="/" className="flex items-center gap-2 pr-2">
          {/* Обрезанный мобильный логотип */}
          <div style={{ width: 28, height: 28, borderRadius: "50%", overflow: "hidden" }}>
            <img src="/atk-logo.png" alt="АТК" className="w-full h-full object-cover" />
          </div>
        </Link>
        {filteredNav.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className="btn btn-sm" style={active ? { borderColor: "rgba(255,61,61,.5)", background: "var(--red-soft)", color: "#fff" } : undefined}>
              {item.label}
            </Link>
          );
        })}
        {role === "guest" ? (
          <Link href="/login" className="btn btn-sm"><LogIn size={14}/></Link>
        ) : (
          <button onClick={handleLogout} className="btn btn-sm"><LogOut size={14}/></button>
        )}
        {canSubmitReport && (
          <Link
            href="/reports"
            className="btn btn-sm"
            style={pathname.startsWith("/reports") ? { borderColor: "rgba(255,61,61,.5)", background: "var(--red-soft)", color: "#fff" } : undefined}
          >
            <FilePlus2 size={14}/> Рапорт
          </Link>
        )}
      </div>

      <div className="page-wrap">
        <AnimatePresence mode="wait">
          <motion.main key={pathname} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.35, ease: [0.22, 0.8, 0.24, 1] }} className="page-inner">
            {children}
          </motion.main>
        </AnimatePresence>
      </div>
    </>
  );
}
