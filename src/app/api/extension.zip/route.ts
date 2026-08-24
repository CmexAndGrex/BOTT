import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { ensureCookieSyncKey } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEMPLATE_FILES = [
  "manifest.json",
  "config.js",
  "background.js",
  "popup.html",
  "popup.js",
  "README.md",
];

/**
 * Персональная сборка расширения «скачал и работает»:
 * адрес панели берётся из самого запроса, ключ синхронизации — из базы.
 * Подстановка заменяет плейсхолдеры __SERVER_URL__ и __SYNC_KEY__ в шаблонах.
 */
export async function GET(req: NextRequest) {
  // Приоритет — Referer: браузер точно передаёт тот origin, на котором открыта панель.
  const referer = req.headers.get("referer");
  let origin = "";
  if (referer) {
    try {
      origin = new URL(referer).origin;
    } catch {
      origin = "";
    }
  }

  if (!origin) {
    const protoHeader = req.headers.get("x-forwarded-proto");
    const hostHeader = req.headers.get("x-forwarded-host");
    const host =
      (hostHeader ? hostHeader.split(",")[0].trim() : "") ||
      req.headers.get("host") ||
      "";
    if (!host) {
      return NextResponse.json(
        { ok: false, error: "Не удалось определить адрес сервера" },
        { status: 500 }
      );
    }
    // e2b-превью умеет только https, хотя proxy иногда передаёт proto=http
    const proto = /(^|\.)e2b\.app$/.test(host)
      ? "https"
      : (protoHeader ? protoHeader.split(",")[0].trim() : "") || "https";
    origin = `${proto}://${host}`;
  }
  const key = await ensureCookieSyncKey();
  const keyMasked = `${key.slice(0, 6)}…`;

  const zip = new JSZip();
  const dir = path.join(process.cwd(), "extension");

  for (const name of TEMPLATE_FILES) {
    let content = readFileSync(path.join(dir, name), "utf8");
    content = content.split("__SERVER_URL__").join(origin);
    content = content.split("__SYNC_KEY__").join(key);
    content = content.split("__SYNC_KEY_MASKED__").join(keyMasked);
    zip.file(name, content);
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX",
  });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="red-ops-cookie-sync.zip"',
      "Cache-Control": "no-store",
    },
  });
}
