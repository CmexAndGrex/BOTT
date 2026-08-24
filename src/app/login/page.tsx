"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Radar, ShieldAlert } from "lucide-react";
import { Spinner } from "@/components/ui";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (data.ok) {
        router.push("/"); // При успехе перекидываем на главную
        router.refresh();
      } else {
        setError(data.error || "Ошибка авторизации");
      }
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      {/* Фоновые эффекты из вашего дизайна */}
      <div className="fx-bg fx-grid" />
      <div className="fx-bg fx-glow-red" />
      <div className="fx-bg fx-noise" />

      <div className="card relative z-10 w-full max-w-sm px-6 py-8 shadow-2xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div
            className="mb-4 flex items-center justify-center"
            style={{ width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg, #ff5148, #b41d1d 70%)" }}
          >
            <Radar size={24} color="#fff" />
          </div>
          <h1 className="display text-2xl font-bold">RED OPS</h1>
          <p className="text-sm mt-1 text-[var(--muted)]">Авторизация в системе</p>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            <ShieldAlert size={16} />
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          <div>
            <label className="label mb-1.5 block">Логин</label>
            <input
              type="text"
              className="input"
              placeholder="admin"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label mb-1.5 block">Пароль</label>
            <input
              type="password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn btn-primary mt-2 w-full" disabled={loading}>
            {loading ? <Spinner /> : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}