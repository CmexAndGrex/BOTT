"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown, ArrowUp, BookOpen, Check, CheckCircle2, ChevronDown, ExternalLink, FileText,
  Filter, Pencil, Plus, Save, Search, Tag, Trash2, X, XCircle,
} from "lucide-react";
import { Spinner } from "@/components/ui";

type DocTag = { id: string; name: string };
type DocLink = { id: string; title: string; url: string; tagIds: string[] };
type Notice = { ok: boolean; text: string } | null;

const newId = () =>
  `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const newTagId = () =>
  `tag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Максимум тегов на один документ (должно совпадать с MAX_DOC_TAGS в /api/docs)
const MAX_DOC_TAGS = 4;

// Стиль активного чипа фильтра
const activeChipStyle = {
  background: "var(--red-soft)",
  borderColor: "rgba(255,61,61,0.5)",
  color: "#ff7b7b",
} as const;

export default function DocsPage() {
  const [links, setLinks] = useState<DocLink[] | null>(null);
  const [tags, setTags] = useState<DocTag[]>([]);
  const [draft, setDraft] = useState<DocLink[]>([]);
  const [draftTags, setDraftTags] = useState<DocTag[]>([]);
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState("guest");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmTagId, setConfirmTagId] = useState<string | null>(null);
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState("");
  // модальное окно выбора тегов: id кнопки, для которой открыто, + поле создания нового тега
  const [tagModalFor, setTagModalFor] = useState<string | null>(null);
  const [tagModalName, setTagModalName] = useState("");

  const canEdit = role === "admin" || role === "officer";

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [d, me] = await Promise.all([
          fetch("/api/docs", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/me", { cache: "no-store" }).then((r) => r.json()),
        ]);
        if (!alive) return;
        setLinks(Array.isArray(d.links) ? d.links : []);
        setTags(Array.isArray(d.tags) ? d.tags : []);
        setRole(me.role || "guest");
      } catch {
        if (alive) setLinks([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // закрытие окна выбора тегов по Escape
  useEffect(() => {
    if (!tagModalFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTagModalFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tagModalFor]);

  const startEdit = () => {
    const tagList = tags.map((t) => ({ ...t }));
    const known = new Set(tagList.map((t) => t.id));
    setDraft(
      (links ?? []).map((x) => ({
        ...x,
        // вычищаем ссылки на уже несуществующие теги
        tagIds: (x.tagIds ?? []).filter((id) => known.has(id)),
      })),
    );
    setDraftTags(tagList);
    setConfirmId(null);
    setConfirmTagId(null);
    setTagModalFor(null);
    setTagModalName("");
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft([]);
    setDraftTags([]);
    setConfirmId(null);
    setConfirmTagId(null);
    setTagModalFor(null);
    setTagModalName("");
    setFilterTags([]);
    setFilterOpen(false);
  };
  const patchItem = (id: string, patch: Partial<DocLink>) =>
    setDraft((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const moveItem = (id: string, dir: -1 | 1) =>
    setDraft((prev) => {
      const from = prev.findIndex((x) => x.id === id);
      const to = from + dir;
      if (from < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });

  const removeItem = (id: string) => {
    setDraft((prev) => prev.filter((x) => x.id !== id));
    setConfirmId(null);
  };

  const addItem = () =>
    setDraft((prev) => [...prev, { id: newId(), title: "", url: "", tagIds: [] }]);

  // создание нового тега — только добавляет его в общий список, БЕЗ привязки к документу
  // (нужные теги потом отмечаются галочками в списке выше)
  const confirmNewTag = () => {
    const name = tagModalName.trim().slice(0, 40);
    if (!name) return;
    const existing = draftTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!existing) {
      setDraftTags((prev) => [...prev, { id: newTagId(), name }]);
    }
    // поле очищаем в любом случае — можно сразу вводить следующий тег
    setTagModalName("");
  };

  // переключить галочку тега у кнопки (с лимитом на максимум)
  const toggleDocTag = (docId: string, tagId: string) => {
    const doc = draft.find((x) => x.id === docId);
    if (!doc) return;
    if (doc.tagIds.includes(tagId)) {
      setDraft((prev) =>
        prev.map((x) =>
          x.id === docId ? { ...x, tagIds: x.tagIds.filter((t) => t !== tagId) } : x,
        ),
      );
      return;
    }
    if (doc.tagIds.length >= MAX_DOC_TAGS) {
      setNotice({ ok: false, text: `Максимум ${MAX_DOC_TAGS} тега на один документ` });
      return;
    }
    setDraft((prev) =>
      prev.map((x) => (x.id === docId ? { ...x, tagIds: [...x.tagIds, tagId] } : x)),
    );
  };

  // быстрое снятие тега с кнопки по крестику на чипе
  const removeDocTag = (docId: string, tagId: string) => {
    setDraft((prev) =>
      prev.map((x) => (x.id === docId ? { ...x, tagIds: x.tagIds.filter((t) => t !== tagId) } : x)),
    );
  };

  // удаление тега из черновика снимает его со всех кнопок
  const deleteTag = (id: string) => {
    setDraftTags((prev) => prev.filter((t) => t.id !== id));
    setDraft((prev) => prev.map((x) => ({ ...x, tagIds: x.tagIds.filter((t) => t !== id) })));
  };

  const save = async () => {
    // пустые черновики (оба поля пусты) просто отбрасываем
    const filled = draft.filter((x) => x.title.trim() || x.url.trim());
    const bad = filled.find((x) => !x.title.trim() || !x.url.trim());
    if (bad) {
      setNotice({
        ok: false,
        text: !bad.title.trim()
          ? "У одной из кнопок не заполнено название."
          : "У одной из кнопок не заполнена ссылка.",
      });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/docs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links: filled, tags: draftTags }),
      });
      const data = await res.json();

      if (data.ok) {
        setLinks(data.links ?? []);
        setTags(Array.isArray(data.tags) ? data.tags : []);
        cancelEdit();
        setNotice({ ok: true, text: "Изменения сохранены" });
      } else {
        setNotice({ ok: false, text: data.error || "Не удалось сохранить изменения" });
      }
    } catch {
      setNotice({ ok: false, text: "Сбой сети при сохранении" });
    } finally {
      setSaving(false);
    }
  };

  // переключение тега в фильтре (множественный выбор)
  const toggleFilterTag = (id: string) =>
    setFilterTags((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );

  // список карточек с учётом выбранных фильтров по тегам и поиска по названию
  // (документ по тегам подходит, если есть хотя бы один из выбранных)
  const visibleLinks =
    links === null
      ? []
      : links
          .filter((x) => filterTags.length === 0 || x.tagIds.some((id) => filterTags.includes(id)))
          .filter(
            (x) =>
              !search.trim() ||
              x.title.toLowerCase().includes(search.trim().toLowerCase()),
          );

  // теги, которые реально используются в документах
  const usedTagIds = new Set((links ?? []).flatMap((x) => x.tagIds ?? []));
  const filterableTags = tags.filter((t) => usedTagIds.has(t.id));

  // теги, выбранные в открытом окне выбора тегов
  const docModalTagIds = tagModalFor
    ? draft.find((x) => x.id === tagModalFor)?.tagIds ?? []
    : [];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">документация // ссылки и материалы</div>
          <h1 className="display text-[34px] font-black leading-tight sm:text-[40px]">Документация</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            {editing
              ? "Меняйте названия, ссылки и теги, добавляйте новые кнопки и удаляйте ненужные."
              : "Нажмите на кнопку, чтобы открыть соответствующий документ или страницу."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Поиск по названию — доступен всем пользователям */}
          <div className="relative w-full sm:w-[260px]">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--dim)" }}
            />
            <input
              className="input input-search"
              placeholder="Поиск по названию…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                title="Сбросить поиск"
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex"
                style={{ color: "var(--dim)", cursor: "pointer" }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          {canEdit && !editing && (
            <button className="btn btn-primary" onClick={startEdit}>
              <Pencil size={15} />
              Редактировать
            </button>
          )}
        </div>
      </header>

      <AnimatePresence>
        {notice && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="card flex items-start gap-2.5 px-4 py-3" style={{ borderColor: notice.ok ? "rgba(61,220,132,.4)" : "rgba(255,61,61,.45)" }}>
            {notice.ok ? <CheckCircle2 size={16} className="mt-0.5" style={{ color: "var(--green)", flex: "none" }} /> : <XCircle size={16} className="mt-0.5" style={{ color: "var(--red)", flex: "none" }} />}
            <span className="text-[13px]" style={{ color: "var(--muted)" }}>{notice.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* загрузка */}
      {links === null && !editing && (
        <div className="card flex items-center justify-center gap-3 px-6 py-14">
          <Spinner />
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>Загрузка…</span>
        </div>
      )}

      {/* фильтр по тегам — видят все, есть только если есть теги */}
      {!editing && links !== null && filterableTags.length > 0 && (
        <div className="relative flex flex-wrap items-center gap-2">
          <span className="chip" style={{ borderStyle: "dashed", cursor: "default" }}>
            <Filter size={12} />
            Фильтры
          </span>
          <button
            className="chip"
            style={{ cursor: "pointer", ...(filterTags.length === 0 ? activeChipStyle : {}) }}
            onClick={() => { setFilterTags([]); setFilterOpen(false); }}
          >
            Все документы
          </button>
          <button
            className="chip"
            style={{ cursor: "pointer", ...(filterTags.length > 0 ? activeChipStyle : {}) }}
            onClick={() => setFilterOpen((v) => !v)}
          >
            <ChevronDown size={12} />
            {filterTags.length > 0 ? `Выбрано: ${filterTags.length}` : "Выбрать теги"}
          </button>
          {filterOpen && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="card absolute left-0 top-full z-50 mt-2 min-w-[220px] p-2"
              style={{ background: "rgba(10,12,20,0.97)", backdropFilter: "blur(14px)" }}
            >
              {filterableTags.map((t) => (
                <label key={t.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-white/5" style={{ color: "var(--fg)" }}>
                  <input
                    type="checkbox"
                    checked={filterTags.includes(t.id)}
                    onChange={() => toggleFilterTag(t.id)}
                    className="accent-[var(--red)]"
                  />
                  {t.name}
                  <span className="ml-auto text-[11px]" style={{ color: "var(--dim)" }}>
                    {(links ?? []).filter((x) => x.tagIds.includes(t.id)).length}
                  </span>
                </label>
              ))}
              <div className="mt-1 border-t pt-1.5" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                <button
                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[var(--red)]"
                  onClick={() => setFilterTags([])}
                >
                  Сбросить фильтры
                </button>
              </div>
            </motion.div>
          )}
        </div>
      )}
      {/* режим просмотра — видят все */}
      {!editing && links !== null && (
        visibleLinks.length === 0 ? (
          filterTags.length > 0 || search.trim() ? (
            <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
              <span className="flex items-center justify-center" style={{ width: 54, height: 54, borderRadius: 16, background: "var(--red-soft)", color: "var(--red)" }}>
                <Search size={24} />
              </span>
              <div className="display text-[16px] font-bold">Ничего не найдено</div>
              <p className="max-w-md text-[13px]" style={{ color: "var(--muted)" }}>
                Нет документов, соответствующих запросу или выбранным тегам. Сбросьте поиск/фильтры, чтобы увидеть все документы.
              </p>
            </div>
          ) : (
            <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
              <span className="flex items-center justify-center" style={{ width: 54, height: 54, borderRadius: 16, background: "var(--red-soft)", color: "var(--red)" }}>
                <BookOpen size={24} />
              </span>
              <div className="display text-[16px] font-bold">Пока ничего нет</div>
              <p className="max-w-md text-[13px]" style={{ color: "var(--muted)" }}>
                {canEdit
                  ? "Нажмите «Редактировать», чтобы добавить первые кнопки со ссылками на документы."
                  : "Здесь появятся кнопки со ссылками на документы подразделения — загляните позже."}
              </p>
            </div>
          )
        ) : (
          <motion.div
            className="flex flex-col gap-3"
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
          >
            {visibleLinks.map((x) => {
              const docTags = (x.tagIds ?? [])
                .map((tid) => tags.find((t) => t.id === tid))
                .filter((t): t is DocTag => !!t);
              return (
                <motion.a
                  key={x.id}
                  variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } }}
                  href={x.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="card card-hover group relative flex items-center gap-4 px-5 pb-4 pt-9"
                >
                  {/* теги — в правом верхнем углу кнопки (до 4) */}
                  {docTags.length > 0 && (
                    <span className="absolute right-3 top-2 flex max-w-[200px] flex-wrap justify-end gap-1">
                      {docTags.map((tag) => (
                        <span
                          key={tag.id}
                          className="max-w-[120px] truncate rounded-lg px-2 py-0.5 text-[11px] font-bold leading-tight"
                          style={{ background: "var(--red-soft)", color: "#ff7b7b" }}
                          title={`Тег: ${tag.name}`}
                        >
                          {tag.name}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="flex shrink-0 items-center justify-center" style={{ width: 42, height: 42, borderRadius: 13, background: "var(--red-soft)", color: "var(--red)" }}>
                    <FileText size={18} />
                  </span>
                  <span className="min-w-0 flex-1 whitespace-normal break-words text-[15px] font-bold leading-snug">{x.title}</span>
                  <ExternalLink size={16} className="shrink-0 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" style={{ color: "var(--dim)" }} />
                </motion.a>
              );
            })}
          </motion.div>
        )
      )}
{/* режим редактирования — только модераторы и администраторы */}
      {editing && (
        <div className="flex flex-col gap-4">
          {/* управление тегами */}
          <div className="card flex flex-wrap items-center gap-2 px-4 py-3.5" style={{ background: "linear-gradient(180deg, rgba(27,31,46,0.92), rgba(15,18,30,0.88))" }}>
            <span className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--dim)" }}>
              <Tag size={13} />
              Теги
            </span>
            {draftTags.length === 0 ? (
              <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                Теги ещё не созданы — создайте их в окне выбора тегов у любой кнопки («Выбрать тег»).
              </span>
            ) : (
              draftTags.map((t) => (
                <span key={t.id} className="chip" style={{ cursor: "default" }}>
                  {t.name}
                  {confirmTagId === t.id ? (
                    <button
                      title="Точно удалить тег?"
                      onClick={() => { deleteTag(t.id); setConfirmTagId(null); }}
                      className="ml-0.5 inline-flex"
                      style={{ color: "var(--red)", cursor: "pointer" }}
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : (
                    <button
                      title="Удалить тег (снимется со всех кнопок)"
                      onClick={() => setConfirmTagId(t.id)}
                      className="ml-0.5 inline-flex"
                      style={{ color: "var(--dim)", cursor: "pointer" }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))
            )}
          </div>

          <AnimatePresence initial={false}>
            {draft.map((x, i) => (
              <motion.div
                key={x.id}
                layout
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                className="card px-4 py-4"
                style={{ background: "linear-gradient(180deg, rgba(27,31,46,0.92), rgba(15,18,30,0.88))" }}
              >
                <div className="flex flex-wrap items-end gap-3">
                  <span
                    className="mono flex shrink-0 items-center justify-center self-center text-[11px] font-bold"
                    style={{ width: 26, height: 26, borderRadius: 9, background: "rgba(255,255,255,0.06)", color: "var(--dim)" }}
                  >
                    {i + 1}
                  </span>

                  <div className="grid min-w-[240px] flex-1 gap-2.5 lg:grid-cols-3">
                    <div>
                      <div className="label mb-1">Название кнопки</div>
                      <input
                        className="input"
                        placeholder="Например: Устав подразделения"
                        value={x.title}
                        onChange={(e) => patchItem(x.id, { title: e.target.value })}
                      />
                    </div>

                    <div>
                      <div className="label mb-1">Ссылка на документ</div>
                      <input
                        className="input input-mono"
                        placeholder="https://…"
                        value={x.url}
                        onChange={(e) => patchItem(x.id, { url: e.target.value })}
                      />
                    </div>
<div>
                      <div className="label mb-1">Теги (до 4)</div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(x.tagIds ?? [])
                          .map((tid) => draftTags.find((t) => t.id === tid))
                          .filter((t): t is DocTag => !!t)
                          .map((t) => (
                            <span key={t.id} className="chip" style={{ cursor: "default" }}>
                              {t.name}
                              <button
                                title="Снять тег"
                                onClick={() => removeDocTag(x.id, t.id)}
                                className="ml-0.5 inline-flex"
                                style={{ color: "var(--dim)", cursor: "pointer" }}
                              >
                                <X size={12} />
                              </button>
                            </span>
                          ))}
                        {x.tagIds.length < MAX_DOC_TAGS && (
                          <button
                            className="chip"
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setTagModalFor(x.id);
                              setTagModalName("");
                            }}
                          >
                            <Tag size={12} style={{ color: "var(--red)" }} />
                            {x.tagIds.length === 0 ? "Выбрать тег" : "Добавить тег"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 self-center">
                    <button className="btn btn-sm btn-icon" title="Переместить выше" disabled={i === 0} onClick={() => moveItem(x.id, -1)}>
                      <ArrowUp size={14} />
                    </button>
                    <button className="btn btn-sm btn-icon" title="Переместить ниже" disabled={i === draft.length - 1} onClick={() => moveItem(x.id, 1)}>
                      <ArrowDown size={14} />
                    </button>
                    {confirmId === x.id ? (
                      <button
                        className="btn btn-sm"
                        style={{ background: "rgba(255,61,61,0.15)", borderColor: "rgba(255,61,61,0.45)", color: "var(--red)" }}
                        onClick={() => removeItem(x.id)}
                      >
                        <Trash2 size={14} /> Точно удалить
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-icon" title="Удалить" onClick={() => setConfirmId(x.id)}>
                        <Trash2 size={14} style={{ color: "var(--red)" }} />
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          <button
            className="card card-hover flex w-full items-center justify-center gap-2 px-5 py-4"
            style={{ borderStyle: "dashed", background: "rgba(255,255,255,0.015)", color: "var(--muted)" }}
            onClick={addItem}
          >
            <Plus size={16} style={{ color: "var(--red)" }} />
            Добавить кнопку
          </button>
        </div>
      )}
{/* модальное окно выбора тегов документа */}
      <AnimatePresence>
        {tagModalFor !== null && editing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
            onClick={() => setTagModalFor(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="card w-full max-w-[420px] p-5"
              style={{ background: "rgba(10,12,20,0.97)", backdropFilter: "blur(14px)", borderColor: "rgba(255,61,61,0.28)" }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* шапка окна */}
              <div className="mb-4 flex items-center gap-3">
                <span
                  className="flex shrink-0 items-center justify-center"
                  style={{ width: 38, height: 38, borderRadius: 12, background: "var(--red-soft)", color: "var(--red)" }}
                >
                  <Tag size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="display text-[15px] font-bold leading-tight">Теги документа</div>
                  <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted)" }}>
                    {docModalTagIds.length > 0
                      ? `Выбрано: ${docModalTagIds.length} из ${MAX_DOC_TAGS}`
                      : `Отметьте галочками до ${MAX_DOC_TAGS} тегов`}
                  </div>
                </div>
                <button className="btn btn-sm btn-icon" title="Закрыть" onClick={() => setTagModalFor(null)}>
                  <X size={14} />
                </button>
              </div>

              {/* список тегов с галочками */}
              <div className="mb-4 flex max-h-[260px] flex-col gap-0.5 overflow-y-auto">
                {draftTags.length === 0 ? (
                  <div className="rounded-xl px-3 py-6 text-center text-[13px]" style={{ background: "rgba(255,255,255,0.03)", color: "var(--muted)" }}>
                    Теги ещё не созданы — создайте первый в поле ниже.
                  </div>
                ) : (
                  draftTags.map((t) => {
                    const checked = docModalTagIds.includes(t.id);
                    const maxed = !checked && docModalTagIds.length >= MAX_DOC_TAGS;
                    return (
                      <button
                        key={t.id}
                        onClick={() => toggleDocTag(tagModalFor, t.id)}
                        disabled={maxed}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-white/5"
                        style={{ color: "var(--fg)", cursor: maxed ? "not-allowed" : "pointer", opacity: maxed ? 0.35 : 1 }}
                      >
                        {/* кастомный чекбокс */}
                        <span
                          className="flex shrink-0 items-center justify-center transition-all"
                          style={{
                            width: 19,
                            height: 19,
                            borderRadius: 6,
                            border: checked ? "1px solid transparent" : "1px solid rgba(255,255,255,0.22)",
                            background: checked ? "linear-gradient(135deg, #ff3d3d, #b91c1c)" : "rgba(255,255,255,0.05)",
                            color: "#fff",
                          }}
                        >
                          {checked && <Check size={12} strokeWidth={3.5} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      </button>
                    );
                  })
                )}
              </div>

              {/* создание нового тега — только в общий список, без привязки к документу */}
              <div className="border-t pt-3.5" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--dim)" }}>
                  Новый тег
                </div>
                <div className="mb-2 text-[12px]" style={{ color: "var(--muted)" }}>
                  Создаёт тег в общем списке — можно ввести сразу несколько. Чтобы привязать к документу, отметьте его галочкой в списке выше.
                </div>
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    className="input flex-1"
                    placeholder="Название нового тега"
                    value={tagModalName}
                    maxLength={40}
                    onChange={(e) => setTagModalName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmNewTag();
                      if (e.key === "Escape") setTagModalFor(null);
                    }}
                  />
                  <button className="btn btn-primary btn-sm shrink-0" onClick={confirmNewTag}>
                    <Plus size={14} />
                    Создать
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

{/* нижняя панель с сохранением — появляется только в режиме редактирования */}
      <AnimatePresence>
        {editing && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="sticky bottom-4 z-20"
          >
            <div
              className="card flex flex-wrap items-center gap-3 px-5 py-3.5"
              style={{ background: "rgba(10,12,20,0.94)", borderColor: "rgba(255,61,61,0.35)", backdropFilter: "blur(14px)" }}
            >
              <div className="flex min-w-[200px] flex-1 items-center gap-2.5">
                <Pencil size={15} style={{ color: "var(--red)", flex: "none" }} />
                <span className="text-[13px]" style={{ color: "var(--muted)" }}>
                  Режим редактирования · кнопок: {draft.length} · тегов: {draftTags.length} · изменения увидят все после сохранения
                </span>
              </div>
              <button className="btn btn-sm" onClick={cancelEdit} disabled={saving}>
                <X size={14} />
                Отмена
              </button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                {saving ? <Spinner /> : <Save size={14} />}
                Сохранить изменения
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

