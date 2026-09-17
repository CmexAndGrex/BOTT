import { randomUUID } from "node:crypto";
import { db } from "@/db";

/**
 * Лидер-лок для фоновых задач (бот + планировщик).
 *
 * Проблема: `instrumentation.ts` выполнялся в каждом инстансе Next.js, поэтому
 * при нескольких репликах бот подключался к Discord многократно, а планировщик
 * дублировал задачи (пинги, снимки, синхронизации). Защита в памяти
 * (globalThis) не работает между процессами.
 *
 * Решение: advisory-lock PostgreSQL. Блокировка живёт в рамках соединения —
 * лидером становится тот инстанс, чьё соединение успешно захватило лок;
 * при падении/закрытии соединения лок освобождается автоматически, и лидером
 * может стать другая реплика.
 */

/** ID лидер-лока: произвольное, но постоянное число для этого приложения */
const LEADER_LOCK_ID = 918_273_645;

/** Соединение, удерживающее лок (пул отдаёт «выделенный» клиент) */
type LockedClient = { release: () => void };

export type LeaderRole = "leader" | "follower" | "single";

declare global {
  var __redopsLeaderAcquired: boolean | undefined;
  var __redopsInstanceId: string | undefined;
}

/** Уникальный ID процесса: помогает отличать инстансы в логах */
export function instanceId(): string {
  if (!globalThis.__redopsInstanceId) {
    globalThis.__redopsInstanceId =
      (process.env.INSTANCE_ID || "").trim() || randomUUID().slice(0, 8);
  }
  return globalThis.__redopsInstanceId;
}

/**
 * Пытается стать лидером. Возвращает:
 *   "leader"   — лок захвачен этим инстансом, фоновые задачи запускаем;
 *   "follower" — лидер уже есть, задачи не запускаем;
 *   "single"   — БД недоступна/лок не поддерживается: работаем как единственный
 *                инстанс (поведение как раньше, чтобы не потерять функциональность).
 */
export async function acquireLeaderLock(): Promise<LeaderRole> {
  if (globalThis.__redopsLeaderAcquired) return "leader";

  try {
    const client = await db.$client.connect();
    try {
      const res = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [LEADER_LOCK_ID]
      );
      const locked = res.rows[0]?.locked === true;

      if (!locked) {
        client.release();
        return "follower";
      }

      // Лок удерживаем на этом соединении до конца жизни процесса
      globalThis.__redopsLeaderAcquired = true;
      const holder: LockedClient = { release: () => client.release() };
      const close = () => holder.release();
      process.once("SIGTERM", close);
      process.once("SIGINT", close);
      process.once("beforeExit", close);
      return "leader";
    } catch (e) {
      client.release();
      throw e;
    }
  } catch (e) {
    console.warn(
      `[leader] Не удалось получить лидер-лок (${e instanceof Error ? e.message : e}). ` +
        `Фоновые задачи запускаются как в одиночном инстансе.`
    );
    return "single";
  }
}