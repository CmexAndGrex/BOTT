/**
 * Фоновые задачи обслуживания: синхронизация ШДС, резервные копии, очистка.
 *
 * Отличие от src/lib/scheduler.ts: там живут задачи бота по расписанию (пинги,
 * проверки онлайна), здесь — обслуживание самой системы. Разделение не
 * косметическое: расписание бота настраивается администратором в панели (время,
 * дни недели), а сроки обслуживания задаёт тот, кто разворачивает контейнер
 * (BACKUP_RETENTION_DAYS, интервалы). Смешав их, пришлось бы выводить в
 * интерфейс поля, которые меняются только вместе с окружением.
 *
 * Ключевое требование: сбой синхронизации с Google не должен ронять процесс.
 * Планировщик живёт в том же процессе, что и веб-сервер, поэтому необработанный
 * reject в фоновой задаче уронил бы всю панель.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cronRuns, logs, members } from "@/db/schema";
import { createDatabaseBackup, type BackupResult } from "@/lib/backup";
import {
  MAINTENANCE_KEYS,
  pruneExpiredSessionsAndLogs,
  syncStatusLabel,
  type PruneResult,
  type SyncStatus,
} from "@/lib/maintenance";
import { getSettings, resolveCookie, setSettingQuiet } from "@/lib/settings";
import { isCommandUnit, normalizePersonName, UNITS } from "@/lib/recruits";
import { isDefaultPost, isDefaultRank, resolveRankAndUnit } from "@/lib/protected-profiles";

/** Ключ сравнения ФИО: та же нормализация, что при поиске дубля в составе */
function normalizeNameKey(value: unknown): string {
  return normalizePersonName(value).replace(/[^a-zа-я0-9]/g, "");
}

declare global {
  var __atkMaintenanceStarted: boolean | undefined;
}

/** Интервал между проверками расписания обслуживания, мс */
export const MAINTENANCE_TICK_MS = 5 * 60 * 1000;

/** Раз в час синхронизируем ростер ШДС */
export const SHEET_SYNC_INTERVAL_MS = 60 * 60 * 1000;

/** Раз в сутки снимаем резервную копию */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Раз в сутки чистим сессии и журнал */
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Отмечает слот, чтобы при нескольких репликах задача не выполнилась дважды */
async function claim(key: string): Promise<boolean> {
  try {
    const rows = await db
      .insert(cronRuns)
      .values({ key })
      .onConflictDoNothing()
      .returning({ key: cronRuns.key });
    return rows.length > 0;
  } catch {
    // БД недоступна — считаем слот свободным: задача сама сообщит об ошибке
    return true;
  }
}

/** Сколько прошло с момента (мс). Работает и для незаданного момента */
export function elapsedSince(iso: string | null | undefined, now: number = Date.now()): number {
  const parsed = Date.parse(iso || "");
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : 0;
}

/** Читаемая отметка времени: null — значения нет или оно нечитаемо */
export function parseTimestamp(iso: string | null | undefined): number | null {
  const parsed = Date.parse(iso || "");
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Пора ли выполнять задачу.
 *
 * Отсутствие отметки означает «ещё не выполнялась», и тогда задача нужна
 * немедленно: если бы пустое значение считалось «только что запускали»,
 * первая копия и первая синхронизация не создались бы никогда — а это ровно
 * тот случай, когда защита от потери данных нужна больше всего.
 */
export function isDue(
  iso: string | null | undefined,
  intervalMs: number,
  now: number = Date.now()
): boolean {
  const last = parseTimestamp(iso);
  if (last === null) return true;
  return now - last >= intervalMs;
}

/** Итог синхронизации ШДС: результат задачи плюс состояние для панели */
export type SheetSyncResult = {
  ok: boolean;
  /** Сколько бойцов обновлено в табеле панели */
  updated: number;
  /** Сколько листов прочитано */
  sheets: number;
  detail: string;
  error?: string;
  /** Итог для бейджа в карточке обслуживания */
  status: SyncStatus;
};

/** Индекс колонки по букве (A → 0): та же арифметика, что в gsheets.ts */
function columnIndexOf(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Подразделение бойца для записи в ШДС.
 *
 * Берётся из карточки (`division_members.unit` — он совпадает с именем листа),
 * а при пустом значении выводится из должности: в табеле rs-red.com
 * подразделение пишут как «ТР» / «АД» или названием дивизиона. Без этого
 * боец с заполненной должностью и пустым unit не попадал бы в таблицу.
 */
function memberUnit(member: { unit?: string | null; post?: string | null }): string {
  const unit = String(member.unit ?? "").trim();
  if (unit) return unit;
  const post = String(member.post ?? "");
  if (/танк|\bтр\b/i.test(post)) return UNITS[0];
  if (/дивизион|артиллер|\bад\b/i.test(post)) return UNITS[1];
  return "";
}

/** Ячейка листа — минимум, нужный для поиска строки (упрощает тесты) */
type CellSource = { getCell: (row: number, col: number) => { value?: unknown } };

/** Строка бойца по имени в диапазоне листа (1-based). null — не найден */
export function findRowByName(
  sheet: CellSource,
  column: number,
  top: number,
  bottom: number,
  name: string
): number | null {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  for (let row = top; row <= bottom; row++) {
    const value = String(sheet.getCell(row - 1, column).value ?? "").trim().toLowerCase();
    if (value && value === target) return row;
  }
  return null;
}

/**
 * Читает живую таблицу ШДС и обновляет звания и подразделения бойцов.
 *
 * Зачем это нужно, если состав приходит с rs-red.com: таблица — источник истины
 * по званиям (правки в неё вносит штаб), а сайт обновляет только онлайн. Без
 * этой сверки расхождение замечали глазами, и в панели звание могло отличаться
 * от таблицы неделю.
 *
 * Ошибка на одном листе не отменяет остальные: состав роты и дивизиона ведут
 * разные люди, и недоступный лист не должен блокировать синхронизацию второго.
 * Именно поэтому функция не пробрасывает исключения наружу — она возвращает
 * отчёт с предупреждениями.
 */
export async function syncShdsRoster(): Promise<{
  ok: boolean;
  updated: number;
  sheets: number;
  detail: string;
  error?: string;
}> {
  const {
    getDoc,
    resolveLayout,
    ensureMembersInShds,
    copyReserveGradesForUnit,
    repairShdsSheets,
    SHEET_SEARCH_TOP_ROW,
  } = await import("@/lib/gsheets");

  const doc = await getDoc();
  const allSheets = Object.values(doc.sheetsById);
  const warnings: string[] = [];
  let updated = 0;
  let readSheets = 0;

  const sheetMembers = await db
    .select({
      id: members.id,
      name: members.name,
      rank: members.rank,
      unit: members.unit,
      post: members.post,
      callsign: members.callsign,
      discordId: members.discordId,
      active: members.active,
      status: members.status,
    })
    .from(members);

  for (const unit of UNITS) {
    const sheet = allSheets.find(
      (s) => (s.title || "").trim().toLowerCase() === unit.trim().toLowerCase()
    );
    if (!sheet) {
      warnings.push(`лист «${unit}» не найден`);
      continue;
    }

    try {
      const layout = resolveLayout(unit);
      // Читаем колонку имён с ПЕРВОЙ строки листа, а не с overall.top: командир
      // и зам подразделения стоят в самом верху (рота — строки 7–8, дивизион —
      // 9–10), то есть ВЫШЕ overall.top. Обрезка по overall.top делала их
      // ненаходимыми, и синхронизация считала их отсутствующими в таблице.
      const nameColumn = columnIndexOf(layout.nameCol);
      await sheet.loadCells(
        `${layout.nameCol}${SHEET_SEARCH_TOP_ROW}:${layout.nameCol}${layout.overall.bottom}`
      );

      for (const fighter of sheetMembers) {
        const row = findRowByName(
          sheet,
          nameColumn,
          SHEET_SEARCH_TOP_ROW,
          layout.overall.bottom,
          fighter.name
        );
        if (!row) continue;

        const rank = String(sheet.getCell(row - 1, nameColumn - 1).value ?? "").trim();
        if (!rank) continue;

        /**
         * Боец закреплён за «Командованием корпуса»: его звание и должность
         * ведёт лист «Командование АТК» (шаг 1b выше). Лист подразделения для
         * него — не источник (там лишь плашка внизу состава), и брать оттуда
         * звание и подразделение нельзя: офицер уехал бы в роту/дивизион.
         */
        if (isCommandUnit(fighter.unit)) continue;

        /**
         * Защищённые карточки командования (Иванов И. А.) не должны терять
         * звание и подразделение из-за строки «Вакант» на листе подразделения:
         * там может стоять «Рядовой» и чужой лист.
         *
         * НО: фильтр отсекает только дефолты. Если штаб правит звание или
         * должность офицера, изменение проходит — см. resolveRankAndUnit.
         * Явная правка должности и звания — из панели и с листа
         * «Командование АТК» (шаг 1b ниже).
         */
        const resolved = resolveRankAndUnit(
          fighter,
          { rank, unit },
          { rank: fighter.rank, unit: fighter.unit, post: fighter.post }
        );

        // Пишем только реальные изменения: иначе каждый проход трогал бы весь
        // состав и забивал журнал записями «обновлено 40 бойцов».
        if (fighter.rank === resolved.rank && fighter.unit === resolved.unit) continue;

        await db
          .update(members)
          .set({ rank: resolved.rank, unit: resolved.unit })
          .where(eq(members.id, fighter.id));
        updated++;
      }
      readSheets++;
    } catch (e) {
      warnings.push(`лист «${unit}»: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 1b. Звание и должность командования корпуса — с листа «Командование АТК».
   *
   * Лист читается отдельно от листов подразделений: у него своя раскладка
   * (B — звание, C — ФИО, D — должность, E/F — Steam/Discord). Именно здесь
   * командир корпуса ведёт звания и должности офицеров, поэтому значения
   * колонок B и D применяются НАПРЯМУЮ — это явная правка, а не дефолт
   * автоматики. Пустая ячейка или дефолт («Рядовой», «—») не затирает
   * сохранённое значение: штаб мог не заполнить строку.
   *
   * Ошибка чтения листа не отменяет сверку подразделений: попадает в warnings.
   */
  let commandUpdated = 0;
  try {
    const { readCommandSheet } = await import("@/lib/gsheets");
    const commandRows = await readCommandSheet({ fresh: true });

    for (const row of commandRows) {
      const nameKey = normalizeNameKey(row.name);
      if (!nameKey) continue;

      const target = sheetMembers.find(
        (member) =>
          normalizeNameKey(member.name) === nameKey ||
          (row.discordId && String(member.discordId ?? "").trim() === row.discordId)
      );
      if (!target) continue;

      const nextRank = row.rank.trim();
      const nextPost = row.post.trim();

      const set: { rank?: string; post?: string; updatedAt?: Date } = {};
      if (nextRank && !isDefaultRank(nextRank) && nextRank !== (target.rank ?? "")) {
        set.rank = nextRank;
      }
      if (nextPost && !isDefaultPost(nextPost) && nextPost !== (target.post ?? "")) {
        set.post = nextPost;
      }
      if (!set.rank && !set.post) continue;

      await db
        .update(members)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(members.id, target.id));
      commandUpdated++;
    }
    readSheets++;
  } catch (e) {
    warnings.push(
      `лист «Командование АТК»: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  /**
   * 2. Автозапись отсутствующих бойцов и перенос оценок из запаса.
   *
   * Почему это здесь, а не в отдельной задаче: обе операции меняют ШДС, и
   * запускать их надо ровно тогда, когда таблица уже прочитана. Порядок важен:
   * сначала боец появляется в строке «Вакант», и только потом в его строку
   * можно перенести оценки из запаса — иначе переносить некуда.
   *
   * Ошибка любого шага не отменяет синхронизацию званий: она попадает в
   * предупреждения, а состав и звания остаются обновлёнными.
   */
  let added = 0;
  let gradesCopied = 0;
  let clearedRows = 0;
  let steamFixed = 0;
  let postsFixed = 0;
  let sectionsMoved = 0;

  try {
    /**
     * 1a. Автоочистка ШДС ПЕРЕД автозаписью.
     *
     * Порядок принципиален: командование (Волков Д.В., Иванов И.А., Иванов К.М.)
     * не должно ни секунды соседствовать с записями «Вакант» — если очищать
     * после автозаписи, их строки успели бы стать «занятыми» и попасть в отчёт
     * как действующий состав. Здесь же снимается подпись «ID: » в колонке
     * Steam ID (у Юсупова М.А. в E42 роты): требование прямо это предписывает.
     */
    const repair = await repairShdsSheets();
    clearedRows = repair.cleared.length;
    steamFixed = repair.steamFixed.length;
    postsFixed = repair.postsFixed.length;
    sectionsMoved = repair.moved.length;
    if (repair.cleared.length) {
      warnings.push(`командование убрано из «Вакант»: ${repair.cleared.join(", ")}`);
    }
    if (repair.steamFixed.length) {
      warnings.push(`снят префикс «ID:»: ${repair.steamFixed.join(", ")}`);
    }
    // Должности активных бойцов приведены к реальному виду (снят «/резерв»)
    if (repair.postsFixed.length) {
      warnings.push(`должность приведена к реальной: ${repair.postsFixed.join(", ")}`);
    }
    // Бойцы, перенесённые в «Вакант» своей секции
    if (repair.moved.length) {
      warnings.push(`перенесены в свою секцию: ${repair.moved.join(", ")}`);
    }
    warnings.push(...repair.warnings);
    // Боец считается действующим, если не исключён и не в запасе
    const activeMembers = sheetMembers.filter(
      (member) => member.active !== false && member.status !== "dismissed" && member.unit
    );

    const entries = activeMembers
      .map((member) => {
        const unit = memberUnit(member);
        if (!unit) return null;
        /**
         * Бойцы «Командования корпуса» не вписываются в листы подразделений:
         * их строки живут на отдельном листе «Командование АТК», и запись в
         * «Вакант» роты/дивизиона была бы дублем. Без этой проверки каждый
         * проход давал бы предупреждение «неизвестное подразделение».
         */
        if (isCommandUnit(unit)) return null;
        return {
          name: String(member.name ?? "").trim(),
          unit,
          rank: member.rank,
          post: member.post,
          aliases: member.callsign ? [member.callsign] : [],
          discordId: member.discordId,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry?.name));

    const result = await ensureMembersInShds(entries);
    added = result.added.length;
    warnings.push(...result.warnings);

    // Оценки из запаса — в основные строки. Перенос ПАКЕТНЫЙ, по подразделению:
    // листы читаются один раз на всех бойцов. Вызов на каждого бойца давал бы
    // два запроса loadCells на человека и упирался в квоту Google.
    const units = [...new Set(entries.map((entry) => entry.unit))];
    for (const unit of units) {
      const copy = await copyReserveGradesForUnit({
        unit,
        members: entries
          .filter((entry) => entry.unit === unit)
          .map((entry) => [entry.name, ...entry.aliases]),
      });
      gradesCopied += copy.copied;
      if (copy.error) warnings.push(`перенос оценок (${unit}): ${copy.error}`);
    }
  } catch (e) {
    warnings.push(
      `автозапись в ШДС: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Успех — если прочитан хотя бы один лист: второй лист может отсутствовать
  // вовсе (подразделение ещё не заведено), и это не повод показывать «Ошибка».
  const ok = readSheets > 0;
  const detail =
    `Прочитано листов: ${readSheets}, обновлено бойцов: ${updated}, ` +
    `командование (лист АТК): ${commandUpdated}, ` +
    `дописано в «Вакант»: ${added}, перенесено оценок из запаса: ${gradesCopied}, ` +
    `очищено строк командования: ${clearedRows}, исправлено Steam ID: ${steamFixed}, ` +
    `приведено должностей: ${postsFixed}, перенесено в свою секцию: ${sectionsMoved}` +
    (warnings.length ? `. Предупреждения: ${warnings.join("; ")}` : "");

  return {
    ok,
    updated,
    sheets: readSheets,
    detail,
    ...(ok ? {} : { error: warnings.join("; ") || "ни один лист не прочитан" }),
  };
}

/**
 * Синхронизация ШДС с изоляцией ошибок и записью состояния.
 *
 * Возвращает результат всегда и никогда не бросает: Google может быть
 * недоступен, сервисный аккаунт — отозван, квота — исчерпана. Каждый из этих
 * случаев должен попасть в журнал предупреждением, а приложение продолжить
 * работу (этого прямо требует ТЗ, и это же защищает процесс от падения).
 */
export async function runSheetSync(source = "schedule"): Promise<SheetSyncResult> {
  const startedAt = Date.now();
  let outcome: { ok: boolean; updated: number; sheets: number; detail: string; error?: string };

  try {
    outcome = await syncShdsRoster();
  } catch (e) {
    // Страховка: ошибка вылетела до внутреннего перехвата (например, не удалось
    // прочитать настройки сервисного аккаунта).
    const message = e instanceof Error ? e.message : String(e);
    outcome = { ok: false, updated: 0, sheets: 0, detail: message, error: message };
  }

  const status: SyncStatus = outcome.ok ? "ok" : "error";
  const finishedAt = new Date().toISOString();

  try {
    await setSettingQuiet(MAINTENANCE_KEYS.lastSheetSyncAt, finishedAt);
    await setSettingQuiet(MAINTENANCE_KEYS.lastSyncStatus, status);
    // Совместимость с автосинком состава в scheduler.ts: он ориентируется на
    // эту настройку, чтобы не запускать синхронизацию дважды подряд.
    await setSettingQuiet("_last_auto_sync", finishedAt);
  } catch {
    // Настройки недоступны — статус вернём в ответе, панель перечитает позже
  }

  try {
    await db.insert(logs).values({
      kind: "sync",
      title: outcome.ok ? "Синхронизация ШДС выполнена" : "Синхронизация ШДС не удалась",
      detail: `${outcome.detail} (${syncStatusLabel(status)}, ${Date.now() - startedAt} мс, источник: ${source})`,
      ok: outcome.ok,
      error: outcome.error ?? null,
    });
  } catch {
    // Журнал не должен срывать синхронизацию
  }

  return { ...outcome, status };
}

/** Итог цикла обслуживания: что реально запустилось в этот тик */
export type MaintenanceCycle = {
  sheetSync: boolean;
  backup: BackupResult | null;
  prune: PruneResult | null;
  errors: string[];
};

/**
 * Один цикл обслуживания: что пора — то и выполняем.
 *
 * Возвращает отчёт, но никогда не бросает: цикл вызывается из таймера, и
 * необработанная ошибка уронила бы процесс вместе с веб-сервером.
 */
export async function runMaintenanceCycle(
  options: {
    now?: Date;
    force?: { sheetSync?: boolean; backup?: boolean; prune?: boolean };
  } = {}
): Promise<MaintenanceCycle> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const report: MaintenanceCycle = { sheetSync: false, backup: null, prune: null, errors: [] };

  let map: Map<string, string>;
  try {
    map = await getSettings(true);
  } catch (e) {
    report.errors.push(`настройки недоступны: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }

  // 1. Синхронизация ШДС. Без cookie сайта она ничего не даст: состав ведёт
  //    rs-red.com, и пустая конфигурация — не ошибка цикла, а «ещё не настроено».
  const sheetDue =
    options.force?.sheetSync ||
    isDue(map.get(MAINTENANCE_KEYS.lastSheetSyncAt), SHEET_SYNC_INTERVAL_MS, nowMs);

  if (sheetDue && resolveCookie(map)) {
    const slot = `maintenance:sheet:${Math.floor(nowMs / SHEET_SYNC_INTERVAL_MS)}`;
    if (await claim(slot)) {
      const sync = await runSheetSync("schedule");
      report.sheetSync = true;
      if (!sync.ok && sync.error) report.errors.push(`синхронизация ШДС: ${sync.error}`);
    }
  }

  // 2. Резервная копия — раз в сутки
  const backupDue =
    options.force?.backup ||
    isDue(map.get(MAINTENANCE_KEYS.lastBackupAt), BACKUP_INTERVAL_MS, nowMs);

  if (backupDue) {
    const slot = `maintenance:backup:${Math.floor(nowMs / BACKUP_INTERVAL_MS)}`;
    if (await claim(slot)) {
      report.backup = await createDatabaseBackup({ now });
      if (!report.backup.ok && report.backup.error) {
        report.errors.push(`резервная копия: ${report.backup.error}`);
      }
    }
  }

  // 3. Очистка сессий и журнала — раз в сутки
  const pruneDue =
    options.force?.prune ||
    isDue(map.get(MAINTENANCE_KEYS.lastPruneAt), PRUNE_INTERVAL_MS, nowMs);

  if (pruneDue) {
    const slot = `maintenance:prune:${Math.floor(nowMs / PRUNE_INTERVAL_MS)}`;
    if (await claim(slot)) {
      report.prune = await pruneExpiredSessionsAndLogs({ now });
      if (report.prune.error) report.errors.push(`очистка: ${report.prune.error}`);
    }
  }

  return report;
}

/**
 * Запускает фоновое обслуживание.
 *
 * Вызывается из src/instrumentation.ts уже после проверки лидер-лока: при
 * нескольких репликах задачи должен вести один инстанс, иначе дампы и
 * синхронизации пойдут дублирующимися пачками, а ротация начнёт удалять свежие
 * файлы, приняв их за дубли.
 */
export function startMaintenanceScheduler(): void {
  if (globalThis.__atkMaintenanceStarted) return;
  globalThis.__atkMaintenanceStarted = true;

  console.log(
    `[maintenance] Фоновое обслуживание запущено: синхронизация ШДС раз в ${
      SHEET_SYNC_INTERVAL_MS / 60000
    } мин, копия и очистка — раз в сутки`
  );

  const safeCycle = () => {
    runMaintenanceCycle().catch((e) => {
      // Сюда попадаем только при сбое самого цикла: отдельные задачи ошибки не
      // пробрасывают. Логируем и продолжаем — падать процесс не должен.
      console.error("[maintenance] ошибка цикла обслуживания:", e);
    });
  };

  // Первый запуск отложен: при старте контейнера сервис migrate ещё применяет
  // миграции, и запрос к отсутствующей таблице дал бы ложную ошибку в журнале.
  //
  // unref() у обоих таймеров: фоновое обслуживание не должно удерживать процесс
  // живым. Веб-сервер держит event loop сам, а скрипты и тесты, случайно
  // импортировавшие этот модуль, иначе не смогли бы завершиться.
  setTimeout(safeCycle, 30_000).unref?.();
  setInterval(safeCycle, MAINTENANCE_TICK_MS).unref?.();
}

/** Когда запустится каждое обслуживание, если ничего не менять (мс от сейчас) */
export function maintenanceSchedule(
  map: Map<string, string>,
  now: number = Date.now()
): { sheetSyncIn: number; backupIn: number; pruneIn: number } {
  const remaining = (key: string, intervalMs: number): number => {
    const last = parseTimestamp(map.get(key));
    // Отметки нет — задача нужна немедленно (см. isDue)
    if (last === null) return 0;
    return Math.max(0, intervalMs - (now - last));
  };

  return {
    sheetSyncIn: remaining(MAINTENANCE_KEYS.lastSheetSyncAt, SHEET_SYNC_INTERVAL_MS),
    backupIn: remaining(MAINTENANCE_KEYS.lastBackupAt, BACKUP_INTERVAL_MS),
    pruneIn: remaining(MAINTENANCE_KEYS.lastPruneAt, PRUNE_INTERVAL_MS),
  };
}