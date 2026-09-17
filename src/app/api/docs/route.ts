import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { getSettings, invalidateSettingsCache, setSettingQuiet } from "@/lib/settings";
import { requireRole } from "@/lib/api-auth";
import { normalizeUrl } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DocTag = { id: string; name: string };
type DocLink = { id: string; title: string; url: string; tagIds: string[] };

/** Максимум тегов на один документ */
export const MAX_DOC_TAGS = 4;

/** Приводим список тегов к безопасному виду: имя 1–40 символов, без дубликатов */
function normalizeTagList(parsed: unknown): DocTag[] {
  if (!Array.isArray(parsed)) return [];
  const out: DocTag[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim().slice(0, 40) : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id:
        typeof obj.id === "string" && obj.id.trim()
          ? obj.id.trim().slice(0, 64)
          : randomBytes(9).toString("hex"),
      name,
    });
  }
  return out;
}

/** Безопасно разбираем сохранённый JSON со списком тегов документации */
function parseTags(raw: string | undefined | null): DocTag[] {
  if (!raw) return [];
  try {
    return normalizeTagList(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Нормализует список ID тегов: строки, дедуп с сохранением порядка, максимум 4 */
function normalizeTagIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const id = typeof item === "string" ? item.trim().slice(0, 64) : "";
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_DOC_TAGS) break;
  }
  return out;
}

/** Безопасно разбираем сохранённый JSON со списком кнопок документации */
function parseLinks(raw: string | undefined | null): DocLink[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: DocLink[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 120) : "";
      const url = typeof obj.url === "string" ? obj.url.trim().slice(0, 2000) : "";
      if (!title || !url) continue;
      out.push({
        id:
          typeof obj.id === "string" && obj.id.trim()
            ? obj.id.trim().slice(0, 64)
            : randomBytes(9).toString("hex"),
        title,
        url,
        // Поддержка нового формата (tagIds) и старого (одиночный tagId) с авто-миграцией
        tagIds: normalizeTagIds(obj.tagIds ?? (obj.tagId ? [obj.tagId] : [])),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Публичный список кнопок и тегов документации — доступен всем без авторизации */
export async function GET() {
  const map = await getSettings();
  return NextResponse.json({
    links: parseLinks(map.get("doc_links")),
    tags: parseTags(map.get("doc_tags")),
  });
}

/** Сохранение списка — только модераторы (officer) и администраторы (admin) */
export async function PUT(req: NextRequest) {
  const auth = await requireRole(req, ["officer"]);
  if (!auth.ok) {
    // Текст ошибки сохраняем прежним, чтобы UI не менял поведение
    return NextResponse.json(
      {
        ok: false,
        error:
          auth.response.status === 401
            ? "Требуется вход в систему"
            : "Недостаточно прав для изменения документации",
      },
      { status: auth.response.status }
    );
  }
  const role = auth.user.role;
  const username = auth.user.username || "";

  let body: { links?: unknown; tags?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.links)) {
    return NextResponse.json({ ok: false, error: "Некорректный формат списка" }, { status: 400 });
  }

  const oldMap = await getSettings(true);
  const beforeLinks = parseLinks(oldMap.get("doc_links"));
  const beforeTags = parseTags(oldMap.get("doc_tags"));

  // Теги: если клиент не прислал массив — оставляем прежние (обратная совместимость)
  const cleanTags = Array.isArray(body.tags) ? normalizeTagList(body.tags) : beforeTags;
  const tagIds = new Set(cleanTags.map((t) => t.id));

  const clean: DocLink[] = [];
  for (const item of body.links) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 120) : "";
    const url = typeof raw.url === "string" ? normalizeUrl(raw.url) : null;
    if (!title || !url) continue;
    const rawTagId = typeof raw.tagId === "string" ? raw.tagId.trim().slice(0, 64) : "";
    clean.push({
      id:
        typeof raw.id === "string" && raw.id.trim()
          ? raw.id.trim().slice(0, 64)
          : randomBytes(9).toString("hex"),
      title,
      url,
      // Засчитываем только существующие теги; дедуп и лимит — в normalizeTagIds
      tagIds: normalizeTagIds(raw.tagIds ?? (rawTagId ? [rawTagId] : [])).filter((id) =>
        tagIds.has(id)
      ),
    });
  }

  await setSettingQuiet("doc_tags", JSON.stringify(cleanTags));
  await setSettingQuiet("doc_links", JSON.stringify(clean));
  invalidateSettingsCache();

  const linksChanged = JSON.stringify(beforeLinks) !== JSON.stringify(clean);
  const tagsChanged = JSON.stringify(beforeTags) !== JSON.stringify(cleanTags);

  // Пишем запись в журнал только если что-то реально изменилось
  if (linksChanged || tagsChanged) {
    const roleRu = role === "admin" ? "Администратор" : "Командир";
    const authorFormatted = username ? `${roleRu} ${username}` : roleRu;

    const oldIds = new Set(beforeLinks.map((x) => x.id));
    const newIds = new Set(clean.map((x) => x.id));
    const added = clean.filter((x) => !oldIds.has(x.id)).map((x) => x.title);
    const removed = beforeLinks.filter((x) => !newIds.has(x.id)).map((x) => x.title);
    const changed = clean
      .filter((x) => {
        const prev = beforeLinks.find((b) => b.id === x.id);
        return (
          !!prev &&
          (prev.title !== x.title ||
            prev.url !== x.url ||
            JSON.stringify(prev.tagIds) !== JSON.stringify(x.tagIds))
        );
      })
      .map((x) => x.title);

    const oldTagIds = new Set(beforeTags.map((t) => t.id));
    const addedTags = cleanTags.filter((t) => !oldTagIds.has(t.id)).map((t) => t.name);
    const actualTagIds = new Set(cleanTags.map((t) => t.id));
    const removedTags = beforeTags.filter((t) => !actualTagIds.has(t.id)).map((t) => t.name);

    const parts: string[] = [];
    if (added.length) parts.push(`добавлено: ${added.length}`);
    if (removed.length) parts.push(`удалено: ${removed.length}`);
    if (changed.length) parts.push(`изменено: ${changed.length}`);
    if (addedTags.length) parts.push(`тегов создано: ${addedTags.length}`);
    if (removedTags.length) parts.push(`тегов удалено: ${removedTags.length}`);

    const action = parts.length
      ? `обновил документацию (${parts.join(", ")})`
      : "обновил документацию (изменил порядок)";

    await db.insert(logs).values({
      category: "edit",
      author: authorFormatted,
      action,
      details: {
        "Кнопок было": String(beforeLinks.length),
        "Кнопок стало": String(clean.length),
        Добавлены: added.join(", ") || "—",
        Удалены: removed.join(", ") || "—",
        Изменены: changed.join(", ") || "—",
        "Новые теги": addedTags.join(", ") || "—",
        "Удалённые теги": removedTags.join(", ") || "—",
      },
      kind: "system",
      title: "Изменение документации",
      detail: "Обновлён список кнопок и тегов на вкладке «Документация»",
      ok: true,
    });
  }

  return NextResponse.json({ ok: true, links: clean, tags: cleanTags });
}
