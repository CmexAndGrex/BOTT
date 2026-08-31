"use client";

import { useState, useEffect, useCallback } from "react";
import { ShieldCheck, UserPlus, Trash2, AlertTriangle } from "lucide-react";
import { Section, Spinner } from "@/components/ui";

type Account = { id: number; username: string; role: string };

export default function UsersPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  
  const [newLogin, setNewLogin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("officer");
  const [creating, setCreating] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      if (!res.ok) {
        setError(res.status === 403 ? "Доступ закрыт. Вы не администратор." : "Ошибка загрузки");
        return;
      }
      const data = await res.json();
      setAccounts(data.users || []);
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/adduser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newLogin, password: newPassword, role: newRole })
      });
      const data = await res.json();
      if (data.ok) {
        setNewLogin("");
        setNewPassword("");
        fetchUsers();
      } else {
        setError(data.error || "Ошибка создания");
      }
    } catch {
      setError("Сбой сети");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (login: string) => {
    if (!confirm(`Точно навсегда удалить доступ для ${login}?`)) return;
    try {
      const res = await fetch(`/api/deluser?login=${encodeURIComponent(login)}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (data.ok) fetchUsers();
      else alert(data.error || "Ошибка удаления");
    } catch {
      alert("Сбой сети");
    }
  };

  if (error && error.includes("закрыт")) {
    return <div className="p-10 text-center text-red-500 font-bold">{error}</div>;
  }

  return (
    <div className="flex flex-col gap-5 max-w-4xl mx-auto">
      <header className="mb-4">
        <div className="eyebrow mb-2">система // top secret</div>
        <h1 className="display text-[34px] font-black leading-tight flex items-center gap-3">
          <ShieldCheck className="text-red-500" size={36} /> Доступы
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          Скрытая панель управления аккаунтами. Добавляйте командиров для помощи в учете онлайна.
        </p>
      </header>

      {error && <div className="p-3 bg-red-500/10 border border-red-500/50 text-red-400 rounded-lg text-sm mb-4">{error}</div>}

      <Section title="Список аккаунтов" eyebrow="база данных">
        <div className="p-5">
          {loading ? (
            <div className="flex justify-center p-5"><Spinner /></div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5 text-[11.5px] uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                  <th className="pb-3 pl-2">Логин</th>
                  <th className="pb-3">Уровень прав</th>
                  <th className="pb-3 text-right pr-2">Управление</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.id} className="border-b border-white/5 last:border-0">
                    <td className="py-3 pl-2 font-mono font-bold text-[14px] text-[#eef1f7]">{acc.username}</td>
                    <td className="py-3">
                      <span className={`px-2 py-1 rounded text-[11px] font-semibold tracking-wide ${acc.role === 'admin' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}`}>
                        {acc.role === 'admin' ? 'АДМИНИСТРАТОР' : 'КОМАНДИР'}
                      </span>
                    </td>
                    <td className="py-3 text-right pr-2">
                      <button 
                        onClick={() => handleDelete(acc.username)}
                        className="p-1.5 rounded transition-colors"
                        style={{ color: "var(--dim)" }}
                        onMouseOver={(e) => e.currentTarget.style.color = "var(--red)"}
                        onMouseOut={(e) => e.currentTarget.style.color = "var(--dim)"}
                        title="Удалить"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      <Section title="Создать новый аккаунт" eyebrow="регистрация">
        <form onSubmit={handleAdd} className="flex flex-col gap-4 p-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-[12px] mb-1.5 block" style={{ color: "var(--dim)" }}>Логин</label>
              <input required minLength={3} className="input input-mono w-full" value={newLogin} onChange={e => setNewLogin(e.target.value)} placeholder="Командир_Ник" />
            </div>
            <div>
              <label className="text-[12px] mb-1.5 block" style={{ color: "var(--dim)" }}>Пароль</label>
              <input required minLength={5} type="text" className="input input-mono w-full" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="НадёжныйПароль123" />
            </div>
            <div>
              <label className="text-[12px] mb-1.5 block" style={{ color: "var(--dim)" }}>Роль</label>
              <select className="select w-full" value={newRole} onChange={e => setNewRole(e.target.value)}>
                <option value="officer">Командир (управление бойцами)</option>
                <option value="admin">Администратор (полный доступ)</option>
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[11.5px] flex items-center gap-1.5" style={{ color: "var(--dim)" }}>
              <AlertTriangle size={13} style={{ color: "var(--amber)" }} /> 
              Передайте логин и пароль лично.
            </p>
            <button type="submit" disabled={creating} className="btn btn-primary px-4 py-2">
              {creating ? <Spinner /> : <UserPlus size={16} />} Добавить
            </button>
          </div>
        </form>
      </Section>
    </div>
  );
}