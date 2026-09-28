/**
 * Очередь запросов к Discord API: лимиты, задержки и повторные попытки.
 *
 * Зачем отдельный модуль, если у discord.js есть свой REST-планировщик: он
 * обслуживает только гейтвейный клиент. Часть запросов идёт мимо него — из
 * веб-панели (там гейтвейного клиента нет вовсе) и из фоновых задач, которые
 * не делят с ботом ни один экземпляр REST. Массовая сверка состава — это
 * сотни запросов подряд, и без общего тормоза панель и бот вдвоём упираются в
 * 429: Discord отвечает «retry after N», а мы продолжаем долбить лимит и
 * получаем отказ на весь сервер.
 *
 * Здесь один механизм на всех:
 *   1. ограничение параллелизма — не больше N одновременных запросов;
 *   2. минимальный интервал между запусками — ровный поток вместо залпа;
 *   3. экспоненциальная задержка с джиттером — на 429 и 5xx;
 *   4. приоритет Retry-After: если Discord назвал время, ждём именно его, причём
 *      ждёт вся очередь (cooldown), потому что лимит общий для всех запросов,
 *      а не «на один запрос».
 *
 * Модуль намеренно не зависит ни от discord.js, ни от БД: правила задержек —
 * самая ошибкоопасная часть (слишком короткая пауза даёт 429 по кругу, слишком
 * длинная — «зависшая» на часы синхронизация), и они проверяются тестами
 * напрямую.
 */

/** Ошибка Discord API с признаками, по которым очередь решает о повторе */
export class DiscordApiError extends Error {
  /** HTTP-код ответа; 0 — сеть не ответила вовсе */
  readonly status: number;
  /** Код ошибки Discord (например 50035 — неверный запрос) */
  readonly code: number | null;
  /** Сколько просил подождать Discord (мс), если он это указал */
  readonly retryAfterMs: number | null;
  /** Путь запроса: в логе он обезличен, но различает маршруты */
  readonly path: string;

  constructor(
    message: string,
    init: { status?: number; code?: number | null; retryAfterMs?: number | null; path?: string } = {}
  ) {
    super(message);
    this.name = "DiscordApiError";
    this.status = Number.isFinite(init.status) ? Number(init.status) : 0;
    this.code = init.code ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.path = init.path ?? "";
  }
}

/** Статус ошибки: 0 — сбой сети (запрос не дошёл до Discord) */
export function statusOfError(error: unknown): number {
  if (error instanceof DiscordApiError) return error.status;
  if (error && typeof error === "object" && "status" in error) {
    const value = (error as { status?: unknown }).status;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Стоит ли повторять запрос.
 *
 * 429 — прямое указание «подожди и повтори». 5xx — сбой на стороне Discord.
 * Сетевой сбой (нет статуса) тоже повторяем: обычно это таймаут или обрыв, и
 * вторая попытка проходит. А вот остальные 4xx — наша ошибка: путь, права,
 * ID. Повторять её бессмысленно и вредно: Discord ответит тем же, но лимит
 * будет сожжён.
 */
export function isRetryableDiscordError(error: unknown): boolean {
  const status = statusOfError(error);
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status === 0) return true;
  return false;
}

/**
 * Разбор Retry-After: заголовок ответа или поле retry_after в теле.
 *
 * Discord отдаёт секунды (в заголовке — целое, в теле — дробное), но по
 * стандарту HTTP в заголовке может прийти и дата, поэтому поддерживаем оба
 * вида. Приоритет у заголовка: он описывает весь бакет, а retry_after в теле
 * относится к конкретному запросу.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  bodySeconds: unknown,
  now: number = Date.now()
): number | null {
  const header = (headerValue || "").trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  if (typeof bodySeconds === "number" && Number.isFinite(bodySeconds) && bodySeconds >= 0) {
    return Math.ceil(bodySeconds * 1000);
  }
  // Тело может прийти строкой: «1.5» вместо 1.5
  if (typeof bodySeconds === "string" && bodySeconds.trim()) {
    const parsed = Number(bodySeconds.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed * 1000);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Расчёт задержки                                                     */
/* ------------------------------------------------------------------ */

export type BackoffConfig = {
  /** Задержка первой повторной попытки, мс */
  baseMs: number;
  /** Предел роста собственной задержки, мс */
  maxMs: number;
  /** Разброс (0..1): без него все повторы бьют в одну и ту же миллисекунду */
  jitterRatio: number;
};

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 750,
  maxMs: 60_000,
  jitterRatio: 0.25,
};

/**
 * Задержка перед повторной попыткой, мс.
 *
 * Retry-After от Discord важнее собственной экспоненты, и он НЕ обрезается
 * потолком: если сервер сказал «жди 90 секунд», а мы подождём 60 — следующая
 * попытка снова получит 429 и лимит сбросится ещё раз. Потолок maxMs относится
 * только к нашей собственной задержке, чтобы растущее ожидание не превратилось
 * в «сутки на одну задачу».
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs: number | null = null,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random
): number {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.ceil(retryAfterMs);
  }

  const safeAttempt = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const base = Math.max(1, config.baseMs);
  const cap = Math.max(base, config.maxMs);
  // 2^(attempt-1): 750 → 1500 → 3000 → … — классическая экспонента
  const grown = base * 2 ** (safeAttempt - 1);
  const bounded = Math.min(cap, grown);
  const jitter = Math.max(0, Math.min(1, config.jitterRatio));
  // Разброс только ВВЕРХ (от bounded до bounded*(1+jitter)). Симметричный
  // джиттер иногда укорачивал бы паузу — и повтор уходил бы раньше, чем Discord
  // отпустит лимит, то есть ровно тот случай, ради которого пауза и нужна.
  const factor = 1 + Math.max(0, Math.min(1, random())) * jitter;
  return Math.max(1, Math.ceil(bounded * factor));
}

/* ------------------------------------------------------------------ */
/* Очередь запросов                                                    */
/* ------------------------------------------------------------------ */

export type DiscordQueueOptions = {
  /** Сколько запросов выполняем одновременно */
  concurrency: number;
  /** Минимальная пауза между запусками запросов, мс */
  minIntervalMs: number;
  /** Сколько всего попыток на один запрос (1 = без повторов) */
  maxAttempts: number;
  /** Параметры экспоненциальной задержки */
  backoff: BackoffConfig;
};

export const DEFAULT_QUEUE_OPTIONS: DiscordQueueOptions = {
  concurrency: 2,
  minIntervalMs: 120,
  maxAttempts: 4,
  backoff: DEFAULT_BACKOFF,
};

/** Запись в очереди: попытка, момент готовности и сама операция */
type PendingTask = {
  label: string;
  attempt: number;
  /** Раньше этого момента задачу запускать нельзя (индивидуальная пауза) */
  notBefore: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export type DiscordQueueRetryInfo = {
  label: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  status: number;
  /** true — пауза общая для всей очереди (сработал лимит 429) */
  globalCooldown: boolean;
};

export type DiscordQueueStats = {
  pending: number;
  running: number;
  /** Сколько миллисекунд очередь ещё ждёт из-за лимита Discord */
  cooldownMs: number;
  /** Сколько раз запросы уходили на повтор за время работы очереди */
  retries: number;
  /** Сколько заданий в итоге не удалось выполнить */
  failed: number;
};

/**
 * Внедряемые зависимости.
 *
 * `now` и `sleep` подменяются только в тестах: вместе они образуют ручные часы,
 * поэтому проверка задержек не занимает реального времени. В тесте часы должны
 * идти вперёд ровно на время сна — иначе очередь будет крутиться вхолостую,
 * ожидая момент, который никогда не наступит.
 */
export type DiscordQueueDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Колбэк на каждую повторную попытку: для журнала и диагностики */
  onRetry?: (info: DiscordQueueRetryInfo) => void;
  /** Колбэк на окончательный отказ задания */
  onFailure?: (label: string, error: unknown) => void;
};

/**
 * Очередь запросов к Discord API.
 *
 * Ключевое решение: на время паузы задание ВОЗВРАЩАЕТСЯ в очередь, а слот
 * освобождается. Если бы ожидание удерживало слот (как в наивном «while + sleep
 * внутри задачи»), один пойманный 429 остановил бы всю обработку: слоты заняты
 * спящими задачами, остальные стоят, а Discord тем временем ждёт, пока мы
 * перестанем шуметь. Здесь спит таймер, а не слот.
 */
export class DiscordRequestQueue {
  private options: DiscordQueueOptions;
  private deps: DiscordQueueDeps;
  private readonly pending: PendingTask[] = [];
  private running = 0;
  /** До этого момента очередь не запускает НИЧЕГО: глобальный лимит Discord */
  private cooldownUntil = 0;
  /** Когда последний раз стартовал запрос — для соблюдения minIntervalMs */
  private lastStartedAt = 0;
  /** Таймер уже взведён: второй не нужен, иначе цикл «дёргается» лишний раз */
  private scheduled = false;
  /** Очередь остановлена: тесты и выгрузка процесса не должны ждать таймеров */
  private stopped = false;
  private retries = 0;
  private failed = 0;

  constructor(options: Partial<DiscordQueueOptions> = {}, deps: DiscordQueueDeps = {}) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };
    this.deps = deps;
  }

  /** Меняет параметры на ходу: администратор правит настройки в панели */
  configure(options: Partial<DiscordQueueOptions> = {}): void {
    this.options = { ...this.options, ...options };
    this.schedule();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private random(): number {
    return this.deps.random ? this.deps.random() : Math.random();
  }

  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Ставит запрос в очередь и возвращает его результат.
   *
   * `label` — короткая метка маршрута (без ID): в логе не должно быть видно,
   * кого именно правит бот, но должно быть видно, что это за операция.
   */
  run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        label,
        attempt: 1,
        notBefore: 0,
        run: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.schedule();
    });
  }

  /** Диагностика для панели и тестов */
  stats(): DiscordQueueStats {
    return {
      pending: this.pending.length,
      running: this.running,
      cooldownMs: Math.max(0, this.cooldownUntil - this.now()),
      retries: this.retries,
      failed: this.failed,
    };
  }

  /** Останавливает очередь: взведённый таймер не должен удерживать процесс */
  stop(): void {
    this.stopped = true;
    this.scheduled = false;
  }
/**
   * Планирует ближайший запуск.
   *
   * Таймер в бою ещё и unref(): очередь не должна держать процесс живым сама по
   * себе, иначе скрипт или тест, случайно импортировавшие модуль, не смогли бы
   * завершиться. В тестах время идёт через внедрённый sleep — там unref не нужен.
   */
  private schedule(): void {
    if (this.stopped || this.scheduled) return;

    const wait = this.msUntilNextRun(this.now());
    if (wait < 0) return; // запускать нечего или некуда

    this.scheduled = true;
    const fire = () => {
      this.scheduled = false;
      if (this.stopped) return;
      this.pump();
    };

    if (this.deps.sleep) {
      void this.wait(wait).then(fire);
      return;
    }
    const timer = setTimeout(fire, wait);
    timer.unref?.();
  }

  /** Через сколько можно запустить следующий запрос; -1 — прямо сейчас нельзя */
  private msUntilNextRun(now: number): number {
    if (this.running >= this.options.concurrency) return -1;
    if (!this.pending.length) return -1;

    const earliestTask = Math.min(...this.pending.map((t) => t.notBefore));
    const cooldown = now < this.cooldownUntil ? this.cooldownUntil - now : 0;
    const taskDelay = now < earliestTask ? earliestTask - now : 0;
    const pacing = this.lastStartedAt
      ? Math.max(0, this.lastStartedAt + this.options.minIntervalMs - now)
      : 0;
    return Math.max(cooldown, taskDelay, pacing);
  }

  /** Запускает столько заданий, сколько позволяют слоты и паузы */
  private pump(): void {
    for (;;) {
      const now = this.now();

      // Общая пауза (429): лимит общий для сервера, поэтому ждём все вместе
      if (now < this.cooldownUntil) {
        this.schedule();
        return;
      }
      if (this.running >= this.options.concurrency) return;

      // Задание с индивидуальной паузой ждёт, но следующее за ним может быть
      // готово уже сейчас — поэтому ищем первое подходящее, а не берём голову
      const index = this.pending.findIndex((t) => t.notBefore <= now);
      if (index < 0) {
        this.schedule();
        return;
      }
      if (this.lastStartedAt && now - this.lastStartedAt < this.options.minIntervalMs) {
        this.schedule();
        return;
      }

      const [task] = this.pending.splice(index, 1);
      this.running++;
      this.lastStartedAt = now;
      void this.execute(task);
    }
  }

  /** Выполняет попытку: либо завершает задание, либо возвращает его в очередь */
  private async execute(task: PendingTask): Promise<void> {
    try {
      const result = await task.run();
      this.running--;
      task.resolve(result);
      this.pump();
    } catch (error) {
      this.running--;

      if (!isRetryableDiscordError(error) || task.attempt >= this.options.maxAttempts) {
        this.failed++;
        this.deps.onFailure?.(task.label, error);
        task.reject(error);
        this.pump();
        return;
      }

      const status = statusOfError(error);
      const retryAfter = error instanceof DiscordApiError ? error.retryAfterMs : null;
      const delayMs = backoffDelayMs(task.attempt, retryAfter, this.options.backoff, () =>
        this.random()
      );

      // 429 — пауза для ВСЕЙ очереди: «продолжим остальными запросами, пока
      // этот ждёт» только продлевает блокировку, ведь лимит общий.
      const globalCooldown = status === 429;
      if (globalCooldown) {
        this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delayMs);
      }

      this.retries++;
      this.deps.onRetry?.({
        label: task.label,
        attempt: task.attempt,
        maxAttempts: this.options.maxAttempts,
        delayMs,
        status,
        globalCooldown,
      });

      this.pending.push({
        ...task,
        attempt: task.attempt + 1,
        notBefore: this.now() + delayMs,
      });

      this.pump();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Общая очередь процесса                                              */
/* ------------------------------------------------------------------ */

declare global {
  var __atkDiscordQueue: DiscordRequestQueue | undefined;
}

/**
 * Общая очередь процесса.
 *
 * Одна на приложение: если бы каждый вызов создавал свою, ограничение
 * параллелизма ничего бы не значило — десять «кирпичиков бота» по 2 запроса
 * дают те же 20 одновременных обращений, что и без тормоза. Глобальная ссылка
 * нужна ещё и потому, что в Next.js модули в dev-режиме перезагружаются, и
 * новая очередь каждый раз означала бы сброс общего cooldown после 429.
 */
export function discordQueue(): DiscordRequestQueue {
  if (!globalThis.__atkDiscordQueue) {
    globalThis.__atkDiscordQueue = new DiscordRequestQueue();
  }
  return globalThis.__atkDiscordQueue;
}

/** Параметры очереди из настроек панели: значения приводятся к разумным границам */
export function queueOptionsFromSettings(
  values: { concurrency?: string | null; intervalMs?: string | null; attempts?: string | null }
): Partial<DiscordQueueOptions> {
  const clamp = (raw: string | null | undefined, min: number, max: number, fallback: number): number => {
    const parsed = Number.parseInt((raw || "").trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  return {
    concurrency: clamp(values.concurrency, 1, 8, DEFAULT_QUEUE_OPTIONS.concurrency),
    minIntervalMs: clamp(values.intervalMs, 0, 5_000, DEFAULT_QUEUE_OPTIONS.minIntervalMs),
    maxAttempts: clamp(values.attempts, 1, 8, DEFAULT_QUEUE_OPTIONS.maxAttempts),
  };
}