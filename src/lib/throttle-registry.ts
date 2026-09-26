/**
 * Реестр ограничителей попыток входа.
 *
 * Зачем: `LoginThrottle` хранит счётчики в памяти процесса и создаётся прямо в
 * роуте (`const throttle = new LoginThrottle()`). Из обслуживания системы до
 * такого объекта не дотянуться, поэтому «Очистить устаревшие сессии» не снимала
 * бы истёкшие блокировки входа — а именно они и являются устаревшими записями о
 * сессиях на стороне приложения: сессии бойцов лежат в БД (member_sessions).
 *
 * Модуль держит ссылки на созданные ограничители. Регистрация — одна строка в
 * роуте рядом с созданием, так что расхождение исключено.
 */
import type { LoginThrottle } from "@/lib/recruits";

const registry = new Set<LoginThrottle>();

/** Регистрирует ограничитель; возвращает его же — удобно для `export const` */
export function registerThrottle<T extends LoginThrottle>(throttle: T): T {
  registry.add(throttle);
  return throttle;
}

/** Сколько ограничителей зарегистрировано (для диагностики и тестов) */
export function registeredThrottleCount(): number {
  return registry.size;
}

/** Очищает устаревшие записи во всех известных ограничителях */
export function pruneRegisteredThrottles(now: number = Date.now()): number {
  let removed = 0;
  for (const throttle of registry) {
    try {
      removed += throttle.pruneExpired(now);
    } catch {
      // Один сломанный ограничитель не должен срывать очистку остальных
    }
  }
  return removed;
}