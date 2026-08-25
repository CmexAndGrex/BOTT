"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import React, { useEffect, useState } from "react";
import {
  Activity, Bot, Clock3, Globe, LayoutDashboard,
  ScrollText, Settings2, Users, LogIn, LogOut, ShieldAlert
} from "lucide-react";

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
    <div className="card mt-auto" style={{ padding: "12px 12px 8px", background: "rgba(255,255,255,0.025)" }}>
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

  useEffect(() => {
    fetch("/api/me", { cache: "no-store" })
      .then(r => r.json())
      .then(d => setRole(d.role || "guest"))
      .catch(() => {});
  }, [pathname]);

  const handleLogout = async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/";
  };

  const NAV = [
    { href: "/", label: "Обзор", icon: LayoutDashboard, roles: ["guest", "officer", "admin"] },
    { href: "/members", label: "Состав", icon: Users, roles: ["guest", "officer", "admin"] },
    { href: "/control", label: "Контроль", icon: ShieldAlert, roles: ["officer", "admin"] },
    { href: "/logs", label: "Журнал", icon: ScrollText, roles: ["officer", "admin"] },
    { href: "/settings", label: "Настройки", icon: Settings2, roles: ["admin"] },
  ];
  const filteredNav = NAV.filter(item => item.roles.includes(role));

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
      <div className="fx-bg fx-grid" />
      <div className="fx-bg fx-glow-red" />
      <div className="fx-bg fx-glow-blue" />
      <div className="fx-bg fx-noise" />

      <aside className="sidebar">
        <Link href="/" className="flex items-center gap-4 px-2 pb-8 pt-2">
          {/* Идеально круглый логотип (убраны черные углы квадрата) */}
          <div
            className="floaty relative flex items-center justify-center shrink-0 ml-1 rounded-full"
            style={{
              width: 68,
              height: 68,
              boxShadow: "0 0 35px 10px rgba(255,61,61,0.18)",
            }}
          >
            <img 
              src="/atk-logo.png" 
              alt="АТК" 
              className="w-full h-full object-cover rounded-full" 
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

        <div className="mt-4 px-2">
          {role === "guest" ? (
            <Link href="/login" className="btn btn-sm w-full" style={{ background: "rgba(255,255,255,0.05)", borderColor: "transparent", color: "var(--text)" }}>
              <LogIn size={14} /> Вход
            </Link>
          ) : (
            <button onClick={handleLogout} className="btn btn-sm w-full" style={{ background: "rgba(255,61,61,0.1)", borderColor: "transparent", color: "var(--red)" }}>
              <LogOut size={14} /> Выйти
            </button>
          )}
        </div>

        <StatusBlock />
      </aside>

      <div className="mobile-bar">
        <Link href="/" className="flex items-center gap-2 pr-2">
          {/* Обрезанный мобильный логотип */}
          <img src="/atk-logo.png" alt="АТК" className="w-[28px] h-[28px] object-cover rounded-full" />
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