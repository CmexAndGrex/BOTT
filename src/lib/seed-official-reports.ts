/**
 * Засев эталонных данных из трёх официальных отчётов rs-red.com
 * (05.10—11.10, 12.10—18.10, 19.10—25.10 2026).
 *
 * Идемпотентен: выполняется один раз (флаг 'official_oct_2026_seeded_v2' в
 * bot_settings). При повторном вызове немедленно возвращает { skipped: true }.
 *
 * Логика матчинга имён (жёсткая нормализация):
 *   normalizeFighterName("Добролюбов Е.Д.") === normalizeFighterName("Добролюбов Е Д")
 *   === normalizeFighterName("добролюбов е.д") === "добролюбовед" (без разделителей)
 *
 * Раньше точки лишь удалялись, а пробелы схлопывались, поэтому «Добролюбов Е.Д.»
 * из БД и «Добролюбов Е Д» из отчёта давали разные ключи, и часы заполнялись
 * только у тех 9 бойцов, чьи инициалы в БД были записаны с пробелами.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { members as membersTable, weeklyStats, settings as settingsTable } from "@/db/schema";
import { sql } from "drizzle-orm";
import { isCommanderFighter } from "@/lib/validation";

/**
 * Флаг идемпотентности.
 *
 * Версия поднята до v2: первый засев (v1) сопоставил только 9 бойцов из 37,
 * потому что ключ имён оставлял значимыми пробелы и точки. Флаг v1 уже стоит
 * в bot_settings у развёрнутого стенда, и без смены ключа исправленный матчинг
 * никогда бы не выполнился. Новый ключ запускает засев заново ровно один раз.
 */
const SEED_FLAG = "official_oct_2026_seeded_v2";
/** Прежний ключ — чистится при сбросе, чтобы не оставлять мусор в настройках */
const LEGACY_SEED_FLAGS = ["official_oct_2026_seeded_v1"] as const;

// Эталонные данные из официальных воскресных отчётов (лист «Танковые Войска»)
// [05.10–11.10, 12.10–18.10, 19.10–25.10] — null означает отсутствие в составе на той неделе
//
// Экспортируется для теста: он проверяет, что жёсткая нормализация ФИО не
// склеивает двух разных бойцов в один ключ (однофамильцы «Иванов И.А.» и
// «Иванов К.М.» должны оставаться разными).
export const OFFICIAL_REPORTS: ReadonlyArray<{
  name: string;
  weeks: [number | null, number | null, number | null];
  warnings: number;
  note?: string;
}> = [
  { name: "Акулова Д.В", weeks: [34, 19, 16], warnings: 0 },
  { name: "Брюханов Е Д", weeks: [8, 1, 0], warnings: 0, note: "комсостав" },
  { name: "Вакутагин И И", weeks: [null, 16, 7], warnings: 1 },
  { name: "Вамилов И В", weeks: [null, null, 7], warnings: 1 },
  { name: "Волков Д В", weeks: [9, 3, 13], warnings: 0, note: "комсостав" },
  { name: "Гагарин М А", weeks: [null, 15, 0], warnings: 1 },
  { name: "Гриповский Д А", weeks: [31, 22, 13], warnings: 0, note: "комсостав" },
  { name: "Добролюбов Е Д", weeks: [12, 10, 19], warnings: 0 },
  { name: "Жилин Н Р", weeks: [13, 15, 17], warnings: 0 },
  { name: "Зеленко Я В", weeks: [9, 23, 9], warnings: 0, note: "в отпуске" },
  { name: "Иванов И А", weeks: [32, 17, 21], warnings: 0, note: "комсостав" },
  { name: "Иванов К М", weeks: [6, 13, 19], warnings: 0, note: "комсостав" },
  { name: "Кайзер К И", weeks: [null, null, 15], warnings: 0 },
  { name: "Коренков К А", weeks: [3, 0, 0], warnings: 0, note: "в отпуске" },
  { name: "Кравчук В Ю", weeks: [3, 0, 0], warnings: 2 },
  { name: "Леонидов Г А", weeks: [47, 14, 5], warnings: 1 },
  { name: "Майлазин А С", weeks: [0, 0, 0], warnings: 2 },
  { name: "Макаров Е А", weeks: [4, 15, 2], warnings: 1 },
  { name: "Милорадович М Н", weeks: [4, 0, 0], warnings: 0, note: "комсостав" },
  { name: "Мутагенов И С", weeks: [8, 8, 13], warnings: 0 },
  { name: "Омельченко А А", weeks: [19, 13, 0], warnings: 1 },
  { name: "Осипов Г А", weeks: [20, 20, 13], warnings: 0, note: "комсостав" },
  { name: "Петрович А Е", weeks: [14, 7, 0], warnings: 2 },
  { name: "Пряник В С", weeks: [0, 0, 0], warnings: 2 },
  { name: "Реборн К В", weeks: [30, 11, 11], warnings: 0 },
  { name: "Рожков В А", weeks: [0, 0, 0], warnings: 2 },
  { name: "Розгов А В", weeks: [5, 12, 11], warnings: 0 },
  { name: "Романов А В", weeks: [7, 1, 0], warnings: 2 },
  { name: "Сильвестр К Д", weeks: [16, 14, 15], warnings: 0 },
  { name: "Снежный П С", weeks: [15, 9, 15], warnings: 0 },
  { name: "Соколов Д О", weeks: [null, null, 17], warnings: 0 },
  { name: "Сопрано А Д", weeks: [null, null, 2], warnings: 1 },
  { name: "Союзнов Ю П", weeks: [8, 0, 0], warnings: 2 },
  { name: "Чапаев В И", weeks: [null, null, 24], warnings: 0 },
  { name: "Шевчик В Д", weeks: [null, null, 6], warnings: 1 },
  { name: "Эпов С А", weeks: [8, 0, 5], warnings: 2 },
  { name: "Юсупов М А", weeks: [null, 7, 14], warnings: 0 },
];

// Три недели, данные по которым загружаем
const OFFICIAL_WEEK_STARTS = ["2026-10-05", "2026-10-12", "2026-10-19"] as const;

/**
 * Жёсткий ключ ФИО для сопоставления отчёта и карточки бойца.
 *
 * В БД и в официальных отчётах одно и то же ФИО записано по-разному:
 *   «Волков Д. В.», «Волков Д.В.», «Волков Д В», «волков д в»
 * Мягкая нормализация (убрать точки, сжать пробелы) оставляла пробелы
 * значимыми, поэтому совпадали только те 9 бойцов, у которых и в БД, и в
 * отчёте инициалы были набраны одинаково — с пробелами.
 *
 * Здесь удаляется ВСЁ, кроме букв и цифр: точки, пробелы (включая неразрывные),
 * дефисы, кавычки и прочие спецсимволы. «ё» приводится к «е», регистр вниз.
 * Так «Добролюбов Е.Д.», «Добролюбов Е Д» и «добролюбов е.д» дают один ключ.
 */
export function normalizeFighterName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z0-9]/g, "");
}

export type SeedResult = {
  skipped?: boolean;
  totalFighters: number;
  matched: number;
  unmatched: string[];
  updatedWarnings: number;
};

/**
 * Засевает эталонные данные за 3 недели в weekly_stats и обновляет warnings.
 * Идемпотентен: второй вызов возвращает { skipped: true } без изменения данных.
 */
export async function seedOfficialOnlineReports(): Promise<SeedResult> {
  // Проверка идемпотентного флага
  const flagRows = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, SEED_FLAG));
  if (flagRows.length > 0 && flagRows[0].value === "done") {
    return { skipped: true, totalFighters: 0, matched: 0, unmatched: [], updatedWarnings: 0 };
  }

  // Загружаем всех бойцов из БД
  const allMembers = await db.select().from(membersTable);
  const membersByNormalizedName = new Map<string, typeof allMembers[0]>();
  for (const m of allMembers) {
    const key = normalizeFighterName(m.name);
    if (!membersByNormalizedName.has(key)) {
      membersByNormalizedName.set(key, m);
    }
  }

  const unmatched: string[] = [];
  let matched = 0;
  let updatedWarnings = 0;

  for (const reportEntry of OFFICIAL_REPORTS) {
    const normalizedName = normalizeFighterName(reportEntry.name);
    const member = membersByNormalizedName.get(normalizedName);

    if (!member) {
      unmatched.push(reportEntry.name);
      continue;
    }

    matched++;

    // Обрабатываем каждую неделю
    for (let i = 0; i < OFFICIAL_WEEK_STARTS.length; i++) {
      const weekStart = OFFICIAL_WEEK_STARTS[i];
      const hours = reportEntry.weeks[i];

      if (hours === null) {
        // Удаляем запись, если боец отсутствовал на этой неделе (прочерк)
        await db
          .delete(weeklyStats)
          .where(
            and(
              eq(weeklyStats.memberId, member.id),
              eq(weeklyStats.weekStart, weekStart)
            )
          );
      } else {
        // Вставляем/перезаписываем точными данными из отчёта
        await db
          .insert(weeklyStats)
          .values({
            memberId: member.id,
            weekStart,
            hours,
            vacation: member.vacation,
          })
          .onConflictDoUpdate({
            target: [weeklyStats.memberId, weeklyStats.weekStart],
            set: {
              hours,
              vacation: member.vacation,
            },
          });
      }
    }

    // Обновляем предупреждения в соответствии с официальным отчётом
    await db
      .update(membersTable)
      .set({ warnings: reportEntry.warnings })
      .where(eq(membersTable.id, member.id));
    updatedWarnings++;
  }

  // Ставим идемпотентный флаг
  await db
    .insert(settingsTable)
    .values({ key: SEED_FLAG, value: "done" })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: "done" } });

  // Снимаем устаревшие флаги версий: строка v1 в настройках больше ничего не
  // значит и только путала бы при разборе «почему засев не выполнился».
  for (const legacyKey of LEGACY_SEED_FLAGS) {
    await db.delete(settingsTable).where(eq(settingsTable.key, legacyKey));
  }

  return {
    totalFighters: OFFICIAL_REPORTS.length,
    matched,
    unmatched,
    updatedWarnings,
  };
}

/**
 * Сбрасывает флаги идемпотентности (текущий и устаревшие), чтобы запустить
 * засев повторно. Используется для тестирования и роутом с force=true.
 */
export async function resetSeedFlag(): Promise<void> {
  for (const key of [SEED_FLAG, ...LEGACY_SEED_FLAGS]) {
    await db.delete(settingsTable).where(eq(settingsTable.key, key));
  }
}
