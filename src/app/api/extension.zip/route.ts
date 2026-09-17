import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { ensureCookieSyncKey } from "@/lib/settings";
import { requireRole } from "@/lib/api-auth";
import { firstSafeOrigin } from "@/lib/validation";

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

// Добавляем отдельный список для бинарных файлов, которые нельзя читать как текст
const BINARY_FILES = [
  "icon.png",
];

/**
 * Персональная сборка расширения «скачал и работает»:
 * адрес панели определяется по PANEL_URL/заголовкам запроса с проверкой,
 * ключ синхронизации — из базы.
 * Подстановка заменяет плейсхолдеры __SERVER_URL__ и __SYNC_KEY__ в шаблонах.
 */
export async function GET(req: NextRequest) {
  // Архив содержит ключ синхронизации — только администратор
  const auth = await requireRole(req, ["admin"]);
  if (!auth.ok) return auth.response;

  // Определяем адрес панели, который будет «зашит» в расширение.
  //
  // Раньше origin брался из заголовков (Referer / X-Forwarded-Host) — их
  // подставляет клиент, поэтому в архив можно было вшить чужой домен и
  // увести cookie rs-red.com на сторону. Теперь:
  //   1) приоритет — настроенный адрес панели (PANEL_URL), только http(s);
  //   2) иначе — собственный Host запроса (после проверки формата);
  //   3) X-Forwarded-* принимаем лишь как вынужденную меру за прокси и
  //      проверяем итоговый хост на разумный формат домена.
  const configured = (process.env.PANEL_URL || "").trim();
  const rawCandidates: string[] = [];
  if (configured) rawCandidates.push(configured);

  const protoHeader = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  const hostCandidates = [
    (req.headers.get("host") || "").split(",")[0].trim(),
    (req.headers.get("x-forwarded-host") || "").split(",")[0].trim(),
  ].filter(Boolean);

  for (const host of hostCandidates) {
    const proto = /(^|\.)e2b\.app$/.test(host)
      ? "https"
      : protoHeader || (req.nextUrl.protocol.replace(":", "") || "https");
    rawCandidates.push(`${proto}://${host}`);
  }

  const origin = firstSafeOrigin(rawCandidates);
  if (!origin) {
    return NextResponse.json(
      { ok: false, error: "Не удалось определить адрес панели (задайте PANEL_URL)" },
      { status: 500 }
    );
  }
  const key = await ensureCookieSyncKey();
  const keyMasked = `${key.slice(0, 6)}…`;

  const zip = new JSZip();
  const dir = path.join(process.cwd(), "extension");

  // 1. Упаковываем текстовые файлы, заменяя плейсхолдеры на реальный домен
  for (const name of TEMPLATE_FILES) {
    try {
      let content = readFileSync(path.join(dir, name), "utf8");
      content = content.split("__SERVER_URL__").join(origin);
      content = content.split("__SYNC_KEY__").join(key);
      content = content.split("__SYNC_KEY_MASKED__").join(keyMasked);
      zip.file(name, content);
    } catch (e) {
      console.error(`Ошибка чтения текстового файла ${name}:`, e);
    }
  }

  // 2. Упаковываем картинки как чистые бинарные данные
  for (const name of BINARY_FILES) {
    try {
      const buffer = readFileSync(path.join(dir, name)); // Читаем без "utf8"
      zip.file(name, buffer);
    } catch (e) {
      console.error(`Не удалось найти или прочитать картинку ${name}:`, e);
    }
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX",
  });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="red-atk-cookie-sync.zip"', // Заодно поменял название самого архива на новое
      "Cache-Control": "no-store",
    },
  });
}
