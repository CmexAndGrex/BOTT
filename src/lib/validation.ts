/**
 * Чистые проверки и нормализации для L3–L9.
 *
 * Модуль намеренно не зависит ни от Next.js, ни от БД: это позволяет
 * тестировать боевую логику напрямую (tests/*.test.ts) без стенда и моков.
 * Если правило нужно и роуту, и тесту — живёт здесь, а не копией в двух местах.
 */

/** Проверка, что идентификатор Discord — «снежинка» (только цифры) */
export function isDiscordId(value: string | null | undefined): boolean {
  return /^\d{5,25}$/.test((value || "").trim());
}

/**
 * Ужесточённая проверка ID на границе Discord API.
 *
 * ID берутся из настроек панели и подставляются прямо в путь запроса
 * `/channels/{id}/messages`. Значение вида `123/../../users/@me` уехало бы
 * в другой эндпоинт Discord API (path injection).
 */
export function assertDiscordId(value: string, label: string): string {
  const id = (value || "").trim();
  if (!isDiscordId(id)) {
    throw new Error(
      `Некорректный ${label}: ожидается числовой ID (получено «${id.slice(0, 40)}»)`
    );
  }
  return id;
}

/**
 * Счётчик предупреждений бойца.
 *
 * Раньше значение ПЕРЕЗАПИСЫВАЛОСЬ по типу запроса (`type === 1 → 1`), из-за
 * чего повторная выдача «1/2» сбрасывала накопленные предупреждения и боец
 * с 2/2 снова «становился» 1/2. Теперь счётчик только растёт, а явный тип 2
 * сразу доводит до исключения.
 */
export function nextWarningCount(current: number, requested: 1 | 2): number {
  const base = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  return Math.min(Math.max(base + 1, requested), 2);
}

/**
 * Лимит частоты запросов по произвольному ключу.
 *
 * Заменяет прежний глобальный лимит на одну константу: ключ `${кто}:${кому}`
 * означает, что один офицер больше не блокирует выдачу предупреждений
 * остальным, но не может «даблкликать» по одному и тому же бойцу.
 */
export class CooldownLimiter {
  private readonly hits = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly maxKeys: number;
  private readonly staleMs: number;

  constructor(cooldownMs: number, maxKeys = 2000, staleMs = 60_000) {
    this.cooldownMs = cooldownMs;
    this.maxKeys = maxKeys;
    this.staleMs = staleMs;
  }

  /** true — запрос разрешён, false — сработал лимит */
  allow(key: string, now: number = Date.now()): boolean {
    const last = this.hits.get(key);
    // Ключа ещё нет — это первый запрос, он всегда разрешён. Проверять
    // `now - 0 < cooldownMs` нельзя: при малом времени это ложно блокировало
    // бы самый первый запрос.
    if (last !== undefined && now - last < this.cooldownMs) return false;
    this.hits.set(key, now);
    if (this.hits.size > this.maxKeys) this.evict(now);
    return true;
  }

  /**
   * Держим карту в границах: сначала выбрасываем устаревшие ключи, а если
   * жёсткого лимита всё ещё недостаточно — самые старые. Без второго шага
   * при плотном потоке (когда «устаревших» ещё нет) карта росла бы бесконечно,
   * вопреки заявленному ограничению.
   */
  private evict(now: number): void {
    const cutoff = now - this.staleMs;
    for (const [k, at] of this.hits) {
      if (at < cutoff) this.hits.delete(k);
    }
    if (this.hits.size <= this.maxKeys) return;
    // Map сохраняет порядок вставки — удаляем с начала, пока не уложимся
    const excess = this.hits.size - this.maxKeys;
    let removed = 0;
    for (const k of this.hits.keys()) {
      if (removed >= excess) break;
      this.hits.delete(k);
      removed++;
    }
  }

  get size(): number {
    return this.hits.size;
  }

  clear(): void {
    this.hits.clear();
  }
}

/**
 * Выбирает безопасный origin для адреса панели.
 *
 * Раньше адрес брался из клиентских заголовков (Referer / X-Forwarded-Host),
 * поэтому в архив расширения можно было вшить чужой домен и увести cookie
 * rs-red.com на сторону. Возвращаем первый кандидат, похожий на реальный
 * адрес: только http(s) и только правдоподобный хост.
 */
export function firstSafeOrigin(candidates: string[]): string | null {
  for (const raw of candidates) {
    const candidate = (raw || "").trim();
    if (!candidate) continue;
    // Домены/поддомены, допускается порт; без пробелов, кавычек и слэшей
    const host = candidate.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9.-]+(:\d{2,5})?$/i.test(host)) continue;
    const withProto = /^https?:\/\//i.test(candidate) ? candidate : `https://${host}`;
    try {
      const u = new URL(withProto);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      return u.origin;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Приводит ссылку к http(s); null — если она невалидна или небезопасна.
 *
 * Отсекаем ссылки с логином/паролем (`https://user:pass@host` — маскировка
 * реального домена), схемы javascript:/data:/vbscript:/file:/blob:, а также
 * локальные и приватные адреса, чтобы панель нельзя было использовать как
 * «маячок» для внутренней сети.
 */
export function normalizeUrl(input: string): string | null {
  let raw = input.trim().slice(0, 2000);
  if (!raw) return null;

  // Явно отклоняем опасные схемы до автодобавления https://
  if (/^(javascript|data|vbscript|file|blob|about):/i.test(raw)) return null;

  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;

    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return null;
    }
    // Приватные диапазоны IPv4 (10/8, 127/8, 192.168/16, 172.16-31/12, 169.254/16)
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const [a, b] = host.split(".").map(Number);
      const priv =
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 169 && b === 254);
      if (priv) return null;
    }

    return u.toString();
  } catch {
    return null;
  }
}