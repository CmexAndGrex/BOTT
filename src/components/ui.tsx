"use client";

import { useEffect, useRef, useState } from "react";

export function Section({
  title,
  eyebrow,
  action,
  children,
  className = "",
  style,
  glow = false,
}: {
  title?: string;
  eyebrow?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  glow?: boolean;
}) {
  return (
    <section
      className={`card ${glow ? "card-glow-red" : ""} ${className}`}
      style={style}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--stroke-soft)" }}>
          <div>
            {eyebrow && <div className="label mb-0.5">{eyebrow}</div>}
            {title && <h2 className="display text-[14px] font-bold">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Toggle({
  on,
  onChange,
  color,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="switch"
      data-on={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={color ? ({ "--switch-color": color } as React.CSSProperties) : undefined}
      aria-pressed={on}
    />
  );
}

export function CountUp({
  value,
  decimals = 0,
  suffix = "",
  className = "",
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}) {
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);

  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (from === value) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const dur = 900;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const ease = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * ease);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span className={`mono ${className}`}>
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
}

export function Ring({
  percent,
  color,
  size = 210,
  stroke = 13,
  children,
}: {
  percent: number;
  color: string;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = c - (clamped / 100) * c;
  return (
    <div className="ring-wrap mx-auto" style={{ width: size, height: size, overflow: "visible" }}>
      <svg width={size} height={size} className="ring-svg" style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id="ringFade" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <circle
          className="ring-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          className="ring-val"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          stroke={color}
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ color }}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return <div className="avatar">{initials || "?"}</div>;
}

export function Spinner() {
  return <span className="spinner" />;
}

export function PctBadge({ percent }: { percent: number }) {
  const cls = percent >= 60 ? "badge-green" : percent >= 50 ? "badge-amber" : "badge-red";
  return <span className={`badge ${cls}`}>{percent.toFixed(1)}%</span>;
}

export function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function fmtDateLong(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}