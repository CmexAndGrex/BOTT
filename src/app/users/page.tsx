"use client";

/**
 * Управление доступами к панели.
 *
 * Кроме создания аккаунта по логину и паролю здесь же привязывается Discord:
 * администратору или командиру достаточно один раз указать Discord ID (или
 * связать аккаунт с бойцом из состава), после чего кнопка «Войти через Discord»
 * на странице входа сразу выдаёт ему панель. Локальный вход сохраняется как
 * резервный способ — на случай недоступности Discord.
 */
import { useState, useEffect, useCallback } from "react";
import { ShieldCheck, UserPlus, Trash2, AlertTriangle, Link2, Unlink, Save } from "lucide-react";
import { Section, Spinner } from "@/components/ui";
import { PASSWORD_POLICY_HINT } from "@/lib/password-policy";

type LinkedMember = {
  id: number;
  callsign: string | null;
  name: string;
  discordId: string | null;
  role: string;
  status: string;
  roleLabel?: string;
};

type Account = {
  id: number;
  username: string;
  role: string;
  discordId: string | null;
  linkedMember?: LinkedMember | null;
};

/** Черновик правок одного аккаунта */
type Draft = { discordId?: string; role?: string; memberId?: string };

export default function UsersPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roster, setRoster] = useState<LinkedMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  
  const [newLogin, setNewLogin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("officer");
  const [creating, setCreating] = useState(false);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      if (!res.ok) {
        setError(res.status === 403 ? "Доступ закрыт. Вы не администратор." : "Ошибка загрузки");
        return;
      }
      const data = await res.json();
      setAccounts(data.users || []);
      setRoster(data.members || []);
      setDrafts({});
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 7000);
    return () => clearTimeout(t);
  }, [flash]);

  const draftOf = (login: string, field: keyof Draft, fallback: string): string => {
    const value = drafts[login]?.[field];
    return value === undefined ? fallback : value;
  };

  const patchDraft = (login: string, field: keyof Draft, value: string) => {
    setDrafts((prev) => ({ ...prev, [login]: { ...prev[login], [field]: value } }));
  };

  /** Сохранение аккаунта: Discord ID, роль и связка с бойцом состава */
  const saveAccount = async (account: Account) => {
    setBusy(account.username);
    setError("");
    setFlash("");
    try {
      const memberId = draftOf(account.username, "memberId", "");
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: account.username,
          discordId: draftOf(account.username, "discordId", account.discordId ?? ""),
          role: draftOf(account.username, "role", account.role),
          ...(memberId ? { linkMemberId: Number(memberId) } : {}),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Не удалось сохранить");
        return;
      }
      setFlash(data.warning || `Аккаунт ${account.username}: ${data.message || "сохранено"}`);
      await fetchUsers();
    } catch {
      setError("Сбой сети");
    } finally {
      setBusy(null);
    }
  };

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
        setFlash(data.message || "Аккаунт создан");
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
    <div className="flex flex-col gap-5 max-w-5xl mx-auto">
      <header className="mb-4">
        <div className="eyebrow mb-2">система // top secret</div>
        <h1 className="display text-[34px] font-black leading-tight flex items-center gap-3">
          <ShieldCheck className="text-red-500" size={36} /> Доступы
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          Панель управления аккаунтами. Привяжите администратору и командиру Discord — и он войдёт
          кнопкой «Войти через Discord», без логина и пароля. Вход по паролю остаётся резервным способом.
        </p>
      </header>

      {error && <div className="p-3 bg-red-500/10 border border-red-500/50 text-red-400 rounded-lg text-sm mb-4">{error}</div>}
      {flash && (
        <div className="p-3 rounded-lg text-sm mb-4" style={{ background: "var(--amber-soft)", border: "1px solid rgba(255,176,32,.45)", color: "var(--amber)" }}>
          {flash}
        </div>
      )}

      <Section title="Список аккаунтов" eyebrow="база данных">
        <div className="p-5 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center p-5"><Spinner /></div>
          ) : (
            <table className="w-full text-left border-collapse" style={{ minWidth: 780 }}>
              <thead>
                <tr className="border-b border-white/5 text-[11.5px] uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                  <th className="pb-3 pl-2">Логин</th>
                  <th className="pb-3">Уровень прав</th>
                  <th className="pb-3">Discord ID</th>
                  <th className="pb-3">Связка с бойцом</th>
                  <th className="pb-3 text-right pr-2">Управление</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.id} className="border-b border-white/5 last:border-0 align-top">
                    <td className="py-3 pl-2 font-mono font-bold text-[14px] text-[#eef1f7]">{acc.username}</td>
                    <td className="py-3">
                      <select
                        className="select"
                        style={{ padding: "0.35rem 0.5rem", fontSize: "0.78rem" }}
                        value={draftOf(acc.username, "role", acc.role)}
                        onChange={(e) => patchDraft(acc.username, "role", e.target.value)}
                      >
                        <option value="officer">Командир</option>
                        <option value="admin">Администратор</option>
                      </select>
                    </td>
                    <td className="py-3">
                      <div className="relative" style={{ width: 170 }}>
                        <input
                          className="input input-mono"
                          style={{ padding: "0.42rem 2rem 0.42rem 0.7rem", fontSize: "0.76rem" }}
                          placeholder="ID Discord"
                          value={draftOf(acc.username, "discordId", acc.discordId ?? "")}
                          onChange={(e) => patchDraft(acc.username, "discordId", e.target.value.replace(/[^\d]/g, ""))}
                        />
                        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                          {draftOf(acc.username, "discordId", acc.discordId ?? "")
                            ? <Link2 size={13} style={{ color: "var(--green)" }} />
                            : <Unlink size={13} style={{ color: "var(--dim)" }} />}
                        </span>
                      </div>
                      {acc.linkedMember && (
                        <div className="mt-1 text-[11px]" style={{ color: "var(--dim)" }}>
                          {acc.linkedMember.callsign || acc.linkedMember.name}
                        </div>
                      )}
                    </td>
                    <td className="py-3">
                      <select
                        className="select"
                        style={{ padding: "0.35rem 0.5rem", fontSize: "0.78rem", width: 190 }}
                        value={draftOf(acc.username, "memberId", "")}
                        onChange={(e) => patchDraft(acc.username, "memberId", e.target.value)}
                      >
                        <option value="">— не связывать —</option>
                        {roster.map((m) => (
                          <option key={m.id} value={String(m.id)}>
                            {m.callsign || m.name} · {m.roleLabel ?? m.role}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 text-right pr-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => saveAccount(acc)}
                          disabled={busy === acc.username}
                          className="p-1.5 rounded transition-colors"
                          style={{ color: "var(--green)" }}
                          title="Сохранить"
                        >
                          {busy === acc.username ? <Spinner /> : <Save size={16} />}
                        </button>
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
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loading && roster.length === 0 && (
            <p className="mt-4 text-[12px] leading-relaxed" style={{ color: "var(--dim)" }}>
              Бойцов с привязанным Discord в составе нет — список связки пуст. Discord ID можно
              вписать вручную в колонке «Discord ID» или добавить его бойцу во вкладке «Состав».
            </p>
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
              <input required minLength={10} type="password" autoComplete="new-password" className="input input-mono w-full" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="НадёжныйПароль123" />
              <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
                {PASSWORD_POLICY_HINT}
              </p>
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
              Передайте логин и пароль лично, либо сразу привяжите Discord в списке выше.
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
