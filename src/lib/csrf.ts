/**
 * Проверка источника запроса — защита от CSRF.
 *
 * Раньше правило жило прямо в middleware.ts. Появились роуты обслуживания
 * (/api/admin/maintenance), которые обязаны проверять источник ещё и сами:
 * middleware — не единственный барьер (его matcher может быть сужен, а
 * standalone-сервер Next.js в докере отдаёт статику до проверок). Копия правила
 * в двух местах разошлась бы, и одна из копий начала бы пропускать
 * межсайтовые запросы, поэтому функция живёт в общем модуле.
 */
import type { NextRequest } from "next/server";

/** Методы, меняющие состояние: только для них и нужна проверка источника */
export const UNSAFE_HTTP_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Опасный (меняющий состояние) метод запроса */
export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_HTTP_METHODS.has((method || "").toUpperCase());
}

/**
 * Отсекаем межсайтовые запросы к cookie-авторизованным роутам.
 *
 * Блокируем только при явных признаках чужого источника, чтобы не ломать
 * легитимные same-origin вызовы и не-браузерных клиентов:
 *   - `Sec-Fetch-Site: cross-site` — современные браузеры помечают так сами;
 *   - `Origin` с чужим хостом — подстраховка для старых браузеров.
 */
export function isCrossSiteRequest(req: NextRequest): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site" && fetchSite !== "none") {
    return true;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      // Сравниваем с фактическим Host и с X-Forwarded-Host: за обратным прокси
      // Host может быть переписан на внутренний, а реальный домен придёт в
      // X-Forwarded-Host. Браузер эти заголовки подделать не может.
      const candidates = [
        (req.headers.get("host") || "").split(",")[0].trim(),
        (req.headers.get("x-forwarded-host") || "").split(",")[0].trim(),
        req.nextUrl.host,
      ].filter(Boolean);

      if (originHost && candidates.length > 0 && !candidates.includes(originHost)) {
        return true;
      }
    } catch {
      return true; // нечитаемый Origin — считаем подозрительным
    }
  }
  return false;
}