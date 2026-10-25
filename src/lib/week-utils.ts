/**
 * Утилиты для работы с недельными периодами (понедельник–воскресенье по МСК).
 *
 * Все функции оперируют датой начала недели (понедельником) в формате YYYY-MM-DD.
 * Это ключ для записей в weekly_stats и основа для защиты от сдвига колонок.
 */

/**
 * Возвращает дату понедельника (начало недели) для заданной даты по московскому времени.
 * @param date - Дата (по умолчанию текущий момент UTC)
 * @returns Строка YYYY-MM-DD (понедельник недели)
 */
export function getMondayInMSK(date: Date = new Date()): string {
  // Преобразуем UTC в МСК
  const msk = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));

  const day = msk.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Если воскресенье (0), отнимаем 6 дней

  const monday = new Date(msk);
  monday.setDate(msk.getDate() + diff);
  monday.setHours(0, 0, 0, 0);

  return formatDateYMD(monday);
}

/**
 * Возвращает понедельник N недель назад от текущей недели.
 * @param weeksAgo - Сколько недель назад (0 = текущая неделя, 1 = прошлая и т.д.)
 * @returns Строка YYYY-MM-DD
 */
export function getMondayWeeksAgo(weeksAgo: number): string {
  const currentMonday = getMondayInMSK();
  const date = parseYMD(currentMonday);
  date.setDate(date.getDate() - weeksAgo * 7);
  return formatDateYMD(date);
}

/**
 * Форматирует дату в YYYY-MM-DD.
 */
function formatDateYMD(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Парсит строку YYYY-MM-DD в Date.
 */
function parseYMD(ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Возвращает диапазон недели для отображения в UI (например, "05.10 — 11.10").
 * @param weekStart - Дата начала недели (понедельник) в формате YYYY-MM-DD
 * @returns Строка "ДД.ММ — ДД.ММ"
 */
export function formatWeekRange(weekStart: string): string {
  const monday = parseYMD(weekStart);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmtDD_MM = (d: Date) => {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}`;
  };

  return `${fmtDD_MM(monday)} — ${fmtDD_MM(sunday)}`;
}

/**
 * Возвращает 4 последние недели (текущая + 3 прошлые) для отображения в контроле.
 * @returns Массив из 4 элементов: [3 недели назад, 2 недели назад, прошлая неделя, текущая неделя]
 */
export function getLast4Weeks(): Array<{ weekStart: string; label: string; isCurrent: boolean }> {
  return [
    { weekStart: getMondayWeeksAgo(3), label: formatWeekRange(getMondayWeeksAgo(3)), isCurrent: false },
    { weekStart: getMondayWeeksAgo(2), label: formatWeekRange(getMondayWeeksAgo(2)), isCurrent: false },
    { weekStart: getMondayWeeksAgo(1), label: formatWeekRange(getMondayWeeksAgo(1)), isCurrent: false },
    { weekStart: getMondayWeeksAgo(0), label: formatWeekRange(getMondayWeeksAgo(0)), isCurrent: true },
  ];
}
