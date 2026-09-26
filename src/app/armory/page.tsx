"use client";

/**
 * «Арсенал» (/armory): каталог выкладок для состава.
 *
 * Одна страница на два режима, как в /admin/reports: бойцу — карточки и панель
 * деталей с копированием строк в игру, офицеру — дополнительно форма шаблона.
 * Права приходят из ответа API (`canManage`), а не вычисляются в браузере: то же
 * решение принимает роут, и второй его копии в интерфейсе быть не должно.
 *
 * Копирование идёт через navigator.clipboard с запасным путём (execCommand):
 * панель открывают и по http во внутренней сети, где Clipboard API недоступен, а
 * бойцу нужно именно скопировать строку, а не прочитать её глазами. При полном
 * отказе показывается подсказка — молча ничего не делать нельзя: боец решит, что
 * строка уже в буфере.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Pencil, Plus, RefreshCw, Search, X } from "lucide-react";
import { Section, Spinner } from "@/components/ui";
import {
  LoadoutCard,
  LoadoutDetail,
  divisionColor,
  type ArmoryRow,
  type CopyState,
  type DetailTab,
} from "@/components/armory-loadout";
import { ArmoryAdminForm, draftFrom, type ArmoryDraft } from "@/components/armory-admin";
import { ARMORY_DIVISIONS, type ArmoryDivision } from "@/lib/armory";

/** Вкладки фильтра: «Все комплекты» плюс разделы из домена */
type DivisionTab = ArmoryDivision | "all";

const TABS: { key: DivisionTab; label: string }[] = [
  { key: "all", label: "Все комплекты" },
  ...ARMORY_DIVISIONS.map((division) => ({ key: division, label: division })),
];

export default function ArmoryPage() {
  const [rows, setRows] = useState<ArmoryRow[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [tab, setTab] = useState<DivisionTab>("all");
  const [search, setSearch] = useState("");
  /** Запрос, ушедший на сервер: локальный ввод не должен дёргать API на каждую букву */
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [gate, setGate] = useState("");
  const [copyState, setCopyState] = useState<CopyState>(null);

  const [openId, setOpenId] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("gear");
  const [draft, setDraft] = useState<ArmoryDraft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  /** Архив виден только штабу: включается отдельной кнопкой */
  const [withArchived, setWithArchived] = useState(false);

  const load = useCallback(async (division: DivisionTab, q: string, archived: boolean) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (division !== "all") params.set("division", division);
      if (q) params.set("q", q);
      if (archived) params.set("archived", "1");
      const res = await fetch(`/api/armory?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (res.status === 401) {
        setGate("Войдите в личный кабинет или панель, чтобы открыть «Арсенал»");
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.error || "Не удалось загрузить каталог");
        return;
      }
      setRows(data.loadouts ?? []);
      setCanManage(Boolean(data.canManage));
    } catch {
      setError("Сбой сети");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Отложено на микрозадачу: синхронный setState в теле эффекта вызвал бы
    // каскадный рендер (та же схема в /admin/reports и /reports)
    const timer = window.setTimeout(() => {
      void load(tab, query, withArchived);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tab, query, withArchived, load]);

  /**
   * Поиск уходит на сервер с задержкой: без неё каждый набранный символ — запрос,
   * а сервер ищет по разобранной выкладке (в SQL её не выразить).
   */
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  const opened = useMemo(() => rows.find((row) => row.id === openId) || null, [rows, openId]);
  const total = rows.length;

  const handleCopy = async (key: string, value: string) => {
    setFlash("");
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        // Запасной путь для http-адресов внутренней сети: Clipboard API там
        // недоступен, а копирование — единственное, зачем боец открыл выкладку
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        if (!ok) throw new Error("execCommand вернул false");
      }
      setCopyState({ key, ok: true });
      window.setTimeout(() => setCopyState(null), 1600);
    } catch {
      setCopyState({ key, ok: false });
      setFlash("Буфер обмена недоступен: выделите строку в разделе ниже и скопируйте вручную");
      window.setTimeout(() => setCopyState(null), 1600);
    }
  };

  const openEditor = (row: ArmoryRow | null) => {
    setDraft(draftFrom(row));
    setFormError("");
    setEditorOpen(true);
  };

  /** Сохранение шаблона: POST /api/admin/armory (создание либо правка) */
  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setFormError("");
    try {
      const res = await fetch("/api/admin/armory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id ?? undefined,
          title: draft.title,
          division: draft.division,
          specialty_code: draft.specialtyCode,
          description: draft.description,
          equipment_breakdown: draft.equipment,
          ace_import_string: draft.aceImportString,
          sqf_code: draft.sqfCode,
          is_active: draft.isActive,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFormError(data.error || "Не удалось сохранить шаблон");
        return;
      }
      setEditorOpen(false);
      setDraft(null);
      setFlash(data.created ? "Комплект создан" : "Комплект обновлён");
      await load(tab, query, withArchived);
    } catch {
      setFormError("Сбой сети");
    } finally {
      setBusy(false);
    }
  };

  /** Архив и возврат из архива — один роут, разный параметр */
  const archiveDraft = async () => {
    if (!draft || draft.id === null) return;
    setBusy(true);
    setFormError("");
    const restore = !draft.isActive;
    try {
      const res = await fetch(
        `/api/admin/armory/${draft.id}${restore ? "?restore=1" : ""}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFormError(data.error || "Не удалось изменить состояние комплекта");
        return;
      }
      setDraft({ ...draft, isActive: Boolean(data.isActive) });
      setFlash(restore ? "Комплект возвращён из архива" : "Комплект убран в архив");
      await load(tab, query, withArchived);
    } catch {
      setFormError("Сбой сети");
    } finally {
      setBusy(false);
    }
  };

  if (gate) {
    return (
      <Section title="Арсенал" eyebrow="доступ">
        <p className="px-5 py-6 text-[13px]" style={{ color: "var(--muted)" }}>
          {gate}
        </p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">экипировка и выкладки</div>
          <h1 className="display mt-1 text-[30px] font-bold leading-tight sm:text-[38px]">
            Арсенал
          </h1>
          <p className="mt-2 max-w-3xl text-sm" style={{ color: "var(--muted)" }}>
            Комплекты по специальностям: скопируйте выкладку для ACE Arsenal, массив для Eden или
            текстовый табель. Строки сформированы штабом — вставляйте их дословно.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void load(tab, query, withArchived)}
            className="btn btn-sm"
            disabled={loading}
          >
            <RefreshCw size={14} /> Обновить
          </button>
          {canManage && (
            <>
              <button
                onClick={() => setWithArchived((v) => !v)}
                className="btn btn-sm"
                style={
                  withArchived
                    ? { borderColor: "rgba(255,176,32,.5)", background: "var(--amber-soft)", color: "var(--amber)" }
                    : undefined
                }
              >
                <Archive size={14} /> {withArchived ? "Скрыть архив" : "Показать архив"}
              </button>
              <button onClick={() => openEditor(null)} className="btn btn-sm btn-primary">
                <Plus size={14} /> Новый комплект
              </button>
            </>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div
          className="flex flex-wrap gap-1.5 rounded-xl border p-1"
          style={{ borderColor: "var(--stroke)", background: "rgba(255,255,255,0.02)" }}
        >
          {TABS.map((item) => {
            const active = tab === item.key;
            const accent = item.key === "all" ? "var(--green)" : divisionColor(item.key);
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className="chip"
                style={
                  active ? { background: `${accent}18`, borderColor: `${accent}55`, color: accent } : undefined
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="relative" style={{ minWidth: 240, flex: "1 1 240px", maxWidth: 420 }}>
          <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--dim)" }} />
          <input
            className="input input-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию или предмету (Грач, 6Б45, CAT)"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Очистить поиск"
              style={{
                position: "absolute",
                right: 10,
                top: 10,
                background: "none",
                border: "none",
                color: "var(--dim)",
                cursor: "pointer",
                display: "flex",
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <span className="chip mono" style={{ fontSize: "0.7rem" }}>
          {total} компл.
        </span>
      </div>

      {flash && (
        <div className="card flex items-center gap-2.5 px-4 py-3" style={{ borderColor: "rgba(61,220,132,.4)" }}>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {flash}
          </span>
        </div>
      )}
      {error && (
        <div className="card flex items-center gap-2.5 px-4 py-3" style={{ borderColor: "rgba(255,61,61,.45)" }}>
          <span className="text-[13px]" style={{ color: "var(--red)" }}>
            {error}
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <Section title="Комплектов нет" eyebrow="каталог пуст">
          <p className="px-5 py-6 text-[13px]" style={{ color: "var(--muted)" }}>
            {canManage
              ? "Заведите первый шаблон кнопкой «Новый комплект» и вставьте выкладку, скопированную в ACE Arsenal."
              : "Штаб ещё не завёл комплекты для этого подразделения."}
          </p>
        </Section>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <LoadoutCard
              key={row.id}
              row={row}
              onOpen={() => {
                setOpenId(row.id);
                setDetailTab("gear");
              }}
            />
          ))}
        </div>
      )}

      {opened && (
        <div
          onClick={() => setOpenId(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(3,4,9,.72)",
            backdropFilter: "blur(4px)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{
              width: "min(720px, 100%)",
              maxHeight: "100vh",
              overflowY: "auto",
              borderRadius: 0,
              padding: 22,
            }}
          >
            <LoadoutDetail
              row={opened}
              tab={detailTab}
              onTab={setDetailTab}
              copyState={copyState}
              onCopy={(key, value) => void handleCopy(key, value)}
              onClose={() => setOpenId(null)}
              footer={
                canManage ? (
                  <div
                    className="flex flex-wrap items-center gap-2 border-t pt-4"
                    style={{ borderColor: "var(--stroke-soft)" }}
                  >
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setOpenId(null);
                        openEditor(opened);
                      }}
                    >
                      <Pencil size={14} /> Редактировать шаблон
                    </button>
                    <span className="chip" style={{ fontSize: "0.68rem" }}>
                      изменил: {opened.createdBy || "—"}
                    </span>
                  </div>
                ) : undefined
              }
            />
          </div>
        </div>
      )}

      {editorOpen && draft && (
        <div
          onClick={() => setEditorOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 70,
            background: "rgba(3,4,9,.78)",
            backdropFilter: "blur(4px)",
            display: "flex",
            justifyContent: "center",
            overflowY: "auto",
            padding: "24px 16px",
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(900px, 100%)" }}>
            <Section
              title={draft.id === null ? "Новый комплект" : `Комплект #${draft.id}`}
              eyebrow="управление арсеналом"
              action={
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="btn btn-sm btn-icon"
                  aria-label="Закрыть"
                >
                  <X size={15} />
                </button>
              }
            >
              <div className="p-5">
                <ArmoryAdminForm
                  draft={draft}
                  onChange={setDraft}
                  onSave={() => void saveDraft()}
                  onArchive={() => void archiveDraft()}
                  onReset={() => {
                    // Сброс возвращает форму к состоянию из базы: правки,
                    // не отправленные на сервер, отбрасываются
                    setDraft(draftFrom(draft.id === null ? null : opened));
                    setFormError("");
                  }}
                  busy={busy}
                  error={formError}
                />
              </div>
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}