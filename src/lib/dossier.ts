/**
 * Домен личного досье бойца: статус службы, дни отпуска, история рапортов.
 *
 * Модуль не зависит ни от БД, ни от Next.js, ни от Discord — как recruits.ts,
 * reports.ts, vehicles.ts и a2s.ts: правила проверяются тестами напрямую
 * (tests/profile-and-vehicles.test.ts) и одинаково используются в роуте досье и
 * в интерфейсе кабинета. Если правило нужно и серверу, и странице — живёт здесь.
 *
 * Почему даты считаются вручную, а не через Intl: подразделение живёт по Москве,
 * а сервер может стоять в UTC или в любой другой зоне. Расхождение на день в
 * «до 20.11.2026 осталось 3 дня» боец замечает сразу, поэтому все вычисления
 * идут по календарным суткам МСК (UTC+3) — та же схема уже используется при
 * разборе даты окончания отпуска (vacationUntilFromReport в review.ts).
 */
import { STATUS_LABELS, type MemberStatus } from "@/lib/recruits";
import { reviewStatusLabel, type ReviewStatus, type ServiceReportType } from "@/lib/reports";

/* ------------------------------------------------------------------ */
/* Дата по Москве                                                      */
/* ------------------------------------------------------------------ */

/** Смещение Москвы от UTC в минутах (переходов на летнее время нет) */
export const MSK_OFFSET_MINUTES = 180;

/** Сдвиг момента в московское время (Date с тем же «стенным» временем МСК) */
export function toMoscow(date: Date): Date {
  return new Date(date.getTime() + MSK_OFFSET_MINUTES * 60_000);
}

/**
 * Календарный номер суток по МСК (дней от эпохи).
 *
 * Именно номер суток, а не миллисекунды: «осталось 3 дня» — разница календарей,
 * и 21.11 в 00:05 МСК должно давать ровно сутки до 22.11, а не «0,9 суток»,
 * которые округление превратило бы в 0.
 */
export function moscowDayNumber(date: Date): number {
  return Math.floor(toMoscow(date).getTime() / 86_400_000);
}

/** Дата в виде ДД.ММ.ГГГГ по МСК */
export function formatMoscowDate(date: Date): string {
  const msk = toMoscow(date);
  const day = String(msk.getUTCDate()).padStart(2, "0");
  const month = String(msk.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${msk.getUTCFullYear()}`;
}

/**
 * Сколько суток осталось до даты (по МСК).
 *
 * 0 — дата сегодня; отрицательное значение — дата уже прошла. Контракт выбран
 * специально: вызывающий сам решает, считать «0» последним днём отпуска или уже
 * истёкшим, и не угадывает по «полутора суткам».
 */
export function daysUntil(target: Date, now: Date = new Date()): number {
  return moscowDayNumber(target) - moscowDayNumber(now);
}

/* ------------------------------------------------------------------ */
/* Статус службы                                                       */
/* ------------------------------------------------------------------ */

/**
 * Статус службы для пилюли в досье.
 *
 * Отличие от MemberStatus (статус учётной записи) в том, что «В резерве» —
 * состояние бойца, а не рапорта: в базе это `active = false` при статусе
 * dismissed (см. review.ts, перевод в запас). Бойцу важно видеть именно
 * «В резерве», а не «Отклонён».
 */
export type ServiceStatus = "active" | "vacation" | "reserve";

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  active: "В строю",
  vacation: "В отпуске",
  reserve: "В резерве",
};

/**
 * Оформление пилюли.
 *
 * «В строю» — зелёный (класс из globals.css), «В отпуске» — синий,
 * «В резерве» — серо-стальной: запас это не ошибка, а спокойное состояние,
 * и красный цвет здесь читался бы как «боец исключён за нарушение».
 */
export type ServiceStatusTone = "ok" | "info" | "muted";

export const SERVICE_STATUS_TONES: Record<ServiceStatus, ServiceStatusTone> = {
  active: "ok",
  vacation: "info",
  reserve: "muted",
};

export type ServiceStatusView = {
  status: ServiceStatus;
  label: string;
  tone: ServiceStatusTone;
  /** CSS-класс бейджа из globals.css */
  badgeClass: string;
  /** Дата возвращения из отпуска (для «до ДД.ММ.ГГГГ»); иначе null */
  until: Date | null;
  /** «до 20.11.2026» — готовая строка для интерфейса */
  untilLabel: string | null;
  /** Сколько суток осталось; null — не отпуск */
  daysLeft: number | null;
  /** «осталось 3 дня» / «последний день» / «срок истёк» */
  daysLabel: string | null;
  /** Отпуск просрочен: дата возвращения в прошлом, а статус всё ещё «отпуск» */
  overdue: boolean;
};

/**
 * Склонение слова «день»: 1 день, 2 дня, 5 дней.
 *
 * Русский язык здесь не украшение: «осталось 1 дней» в карточке бойца читается
 * как сбой интерфейса, а не как информация.
 */
export function pluralDays(count: number): string {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "дней";
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}

/** Подпись остатка отпуска */
export function daysLeftLabel(days: number): string {
  if (days > 0) return `осталось ${days} ${pluralDays(days)}`;
  if (days === 0) return "последний день";
  return "срок истёк";
}

/**
 * Статус службы бойца для досье.
 *
 * `vacationUntil` читается только при статусе «в отпуске»: если боец уже
 * вернулся (status = active), старая дата в БД — история, и показывать «до
 * 20.11» в строю было бы неверно.
 */
export function serviceStatus(input: {
  status?: MemberStatus | string | null;
  active?: boolean | null;
  vacationUntil?: Date | string | null;
  now?: Date;
}): ServiceStatusView {
  const status = String(input.status ?? "");
  const now = input.now ?? new Date();

  // Перевод в запас: в базе это active = false при статусе dismissed
  if (input.active === false || status === "dismissed") {
    return {
      status: "reserve",
      label: SERVICE_STATUS_LABELS.reserve,
      tone: SERVICE_STATUS_TONES.reserve,
      badgeClass: "badge-reserve",
      until: null,
      untilLabel: null,
      daysLeft: null,
      daysLabel: null,
      overdue: false,
    };
  }

  if (status === "vacation") {
    const parsed = input.vacationUntil ? new Date(input.vacationUntil) : null;
    const until = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    const left = until ? daysUntil(until, now) : null;

    return {
      status: "vacation",
      label: SERVICE_STATUS_LABELS.vacation,
      tone: SERVICE_STATUS_TONES.vacation,
      badgeClass: "badge-info",
      until,
      untilLabel: until ? `до ${formatMoscowDate(until)}` : null,
      daysLeft: left,
      daysLabel: left === null ? null : daysLeftLabel(left),
      // Просроченный отпуск подсвечиваем: боец вернулся, а статус не сняли —
      // это повод штабу поправить карточку, а не молчать
      overdue: left !== null && left < 0,
    };
  }

  return {
    status: "active",
    label: SERVICE_STATUS_LABELS.active,
    tone: SERVICE_STATUS_TONES.active,
    badgeClass: "badge-green",
    until: null,
    untilLabel: null,
    daysLeft: null,
    daysLabel: null,
    overdue: false,
  };
}

/* ------------------------------------------------------------------ */
/* Сданные нормативы и история службы                                  */
/* ------------------------------------------------------------------ */

/** Строка рапорта, как её отдаёт роут кабинета */
export type DossierReportRow = {
  id: number;
  type: ServiceReportType;
  status: ReviewStatus;
  createdAt: Date | string;
  reviewedBy?: string | null;
  moderatorComment?: string | null;
};

/**
 * Пройденные нормативы из одобренных рапортов на экзамены.
 *
 * Почему не читаем заливку ячеек ШДС: роут кабинета не должен тянуть всю
 * таблицу (это медленно и требует прав сервисного аккаунта на лист), а
 * одобренный рапорт — тот самый документ, по которому штаб и закрашивает
 * столбец (scenarioExam в gsheets.ts). Дедупликация по нормализованному
 * названию: один норматив мог быть сдан рапортом дважды (пересдача), а в списке
 * допусков он должен быть один.
 */
export function collectQualifications(
  reports: readonly DossierReportRow[],
  examCodesOf: (report: DossierReportRow) => readonly string[]
): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];

  for (const report of reports) {
    if (report.type !== "exam" || report.status !== "approved") continue;
    for (const code of examCodesOf(report)) {
      const trimmed = String(code ?? "").trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase().replace(/ё/g, "е");
      if (seen.has(key)) continue;
      seen.add(key);
      codes.push(trimmed);
    }
  }

  return codes;
}

/** Итог службы: сколько рапортов и в каком состоянии */
export type ServiceSummary = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  /** Дата первого рапорта */
  firstAt: Date | null;
  /** Дата последнего рапорта */
  lastAt: Date | null;
  /** Сданные нормативы (одобренные рапорты на экзамены) */
  qualifications: string[];
};

/** Сводка по рапортам бойца для шапки истории службы */
export function serviceSummary(
  reports: readonly DossierReportRow[],
  examCodesOf: (report: DossierReportRow) => readonly string[]
): ServiceSummary {
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;

  for (const report of reports) {
    if (report.status === "pending") pending++;
    else if (report.status === "approved") approved++;
    else if (report.status === "rejected") rejected++;

    const at = report.createdAt ? new Date(report.createdAt) : null;
    if (at && !Number.isNaN(at.getTime())) {
      if (!firstAt || at < firstAt) firstAt = at;
      if (!lastAt || at > lastAt) lastAt = at;
    }
  }

  return {
    total: reports.length,
    pending,
    approved,
    rejected,
    firstAt,
    lastAt,
    qualifications: collectQualifications(reports, examCodesOf),
  };
}

/** Статус рапорта для таблицы: подпись и класс бейджа */
export function reportStatusView(status: ReviewStatus): {
  label: string;
  badgeClass: string;
} {
  const badgeClass =
    status === "approved" ? "badge-green" : status === "rejected" ? "badge-red" : "badge-amber";
  return { label: reviewStatusLabel(status), badgeClass };
}

/** Подпись статуса учётной записи (для шапки досье) */
export function memberStatusLabel(status: string | null | undefined): string {
  const key = String(status ?? "") as MemberStatus;
  return STATUS_LABELS[key] ?? STATUS_LABELS.pending;
}

/* ------------------------------------------------------------------ */
/* Титул в шапке досье                                                 */
/* ------------------------------------------------------------------ */

/**
 * Строка «Лейтенант · Танковая рота» для шапки.
 *
 * Пустые части не оставляют «висячих» разделителей: у бойца без подразделения
 * в шапке будет только звание, а не «Лейтенант · не назначено ·».
 */
export function dossierTitle(input: { rank?: string | null; unit?: string | null }): string {
  const parts = [String(input.rank ?? "").trim(), String(input.unit ?? "").trim()].filter(Boolean);
  return parts.join(" · ");
}