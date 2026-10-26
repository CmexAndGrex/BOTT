/**
 * Google Таблица (ШДС) — клиент и алгоритмы из ТЗ.
 * Сервисный аккаунт («паспорт») берётся из настроек панели
 * (ключ gsheet_service_account — JSON-текст) либо из файла-паспорта
 * src/lib/google-service-account.json.
 */
import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { getSettings, unitSheetName } from "@/lib/settings";
// Справочник секций и проверка требований ступени живут в домене рапортов
// (reports.ts): там же их читает форма подачи, поэтому «секция рапорта» и
// «блок строк листа» не могут разойтись. Обратной зависимости нет — reports.ts
// не импортирует gsheets.ts, цикла не возникает.
import {
  examColumnTokens,
  missingSectionExams,
  type ShdsSection,
  POSITION_SECTIONS,
  examCatalog,
  normalizeExamCode,
} from "@/lib/reports";
import { isUnit, normalizePersonName } from "@/lib/recruits";
// Проверки по ДОЛЖНОСТИ: боец может быть записан в БД подразделением, но
// занимать должность «Командир Корпуса» / «Зам. Ком. Корпуса». Такие записи
// тоже не должны попадать в «Вакант» листов подразделений — правило одно,
// поэтому берётся общий предикат из validation.ts, а не копия здесь.
import { isCorpsCommander, isDeputyCommander } from "@/lib/validation";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Названия операций поля «Редакция ШДС» */
export const SHDS_ACTIONS = {
  ADD: "Добавление в ШДС",
  RANK: "Изменение звания",
  POST: "Перенос и зачистка (должность)",
  EXAM: "Получение подтверждения об экзаменации",
  REMOVE: "Убрать из таблицы",
  RESERVE_GO: "Уход в запас",
  RESERVE_BACK: "Возврат из запаса",
} as const;

export type ShdsAction = (typeof SHDS_ACTIONS)[keyof typeof SHDS_ACTIONS];

/** Структура разобранной заявки (вебхук → текст) */
export type ParsedRequest = {
  raw: string;
  isVacation: boolean;
  vacationRemove: boolean; // «Снять отпуск» вместо выдачи
  shdsAction: ShdsAction | null;
  unit: string;          // «Подразделение» — имя листа
  userName: string;      // «Имя пользователя»
  rank: string;          // «Звание»
  steamId: string;       // «Steam ID»
  discordId: string;     // «Discord ID»
  отделение: string;     // «Отделение» (Артиллерийский дивизион)
  должность: string;     // «Должность»
  exams: string[];       // «Сданные экзамены»
  grade: string;         // «Оценка» (КМБТ — без оценки)
  /**
   * Оценка КАЖДОГО норматива рапорта: {code, grade} из payload рапорта.
   *
   * Нужно потому, что панель позволяет указать свою оценку каждому нормативу
   * (пакетный рапорт на экзамены), а поле «Оценка» одно. Без этого списка одна
   * оценка уезжала бы во все столбцы блока: закрасили пять нормативов — и все
   * пять получили «Отлично». Пустой список — работаем по полю `grade`.
   */
  examGrades?: { code: string; grade?: string }[];
  examiner: string;      // «Экзаменатор» (Фамилия И.О.)
  rolesGive: string;     // «Роли выдать» (через запятую)
  rolesRemove: string;   // «Роли снять» (через запятую)
  vacationDates: string; // «Даты отпуска»
  reason: string;        // «Причина»
};

/** Разбор текста вебхук-заявки на поля */
export function parseRequestText(text: string): ParsedRequest | null {
  const clean = (s: string) => (s || "").trim();
  const field = (name: string): string => {
    const m = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "im"));
    return m ? clean(m[1]) : "";
  };

  const userName = field("Имя пользователя");
  if (!userName) return null;

  const unit = field("Подразделение");
  const shdsRaw = field("Редакция ШДС");
  const vacationRaw = field("Тип заявки");
  const vacationAll = `${shdsRaw} ${vacationRaw}`;
  const isVacation = /отпуск/i.test(vacationAll) && !/запас/i.test(shdsRaw);
  // «Снять отпуск» / «Окончание отпуска» / «Выход из отпуска» — снятие статуса
  const vacationRemove =
    isVacation && /снять|снятие|отмен|окончан|выход|заверш/i.test(vacationAll);

  let shdsAction: ShdsAction | null = null;
  if (shdsRaw) {
    const low = shdsRaw.toLowerCase();
    if (/возврат|вернуться|вернуть/i.test(low) && /запас/.test(low)) shdsAction = SHDS_ACTIONS.RESERVE_BACK;
    else if (low.includes("запас")) shdsAction = SHDS_ACTIONS.RESERVE_GO;
    else if (low.includes("добавление")) shdsAction = SHDS_ACTIONS.ADD;
    // Стеммы, а не полные слова: в заявках эти операции пишут в родительном
    // падеже («Изменение зван-ия», «Изменение должност-и»), поэтому поиск
    // подстрок «звание»/«должность» не находил совпадения и заявка молча
    // оставалась без действия (shdsAction = null).
    else if (low.includes("звани")) shdsAction = SHDS_ACTIONS.RANK;
    else if (low.includes("должност")) shdsAction = SHDS_ACTIONS.POST;
    else if (low.includes("экзамен")) shdsAction = SHDS_ACTIONS.EXAM;
    else if (low.includes("убрать")) shdsAction = SHDS_ACTIONS.REMOVE;
  }

  // Для операций с таблицей подразделение обязательно (это имя листа)
  if (shdsAction && !unit) return null;

  const examsRaw = field("Сданные экзамены");
  const exams = examsRaw
    ? examsRaw.split(/[,;]/).map((x) => clean(x)).filter(Boolean)
    : [];

  return {
    raw: text,
    isVacation,
    vacationRemove,
    shdsAction,
    unit,
    userName,
    rank: field("Звание"),
    steamId: field("Steam ID"),
    discordId: field("Discord ID").replace(/[^\d]/g, ""),
    отделение: field("Отделение"),
    должность: field("Должность"),
    exams,
    grade: field("Оценка"),
    examiner: field("Экзаменатор"),
    rolesGive: field("Роли выдать"),
    rolesRemove: field("Роли снять"),
    vacationDates: field("Даты отпуска"),
    reason: field("Причина"),
  };
}

/* ------------------------------------------------------------------ */
/* Авторизация и доступ к таблице                                      */
/* ------------------------------------------------------------------ */

/** Читаем «паспорт» сервисного аккаунта из настроек или файла */
async function loadServiceAccount(): Promise<Record<string, unknown>> {
  const map = await getSettings();
  const raw = (map.get("gsheet_service_account") || "").trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Не удалось разобрать JSON сервисного аккаунта из настроек");
    }
  }
  try {
    const p = path.join(process.cwd(), "src", "lib", "google-service-account.json");
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error(
      "Не найден «паспорт» сервисного аккаунта: заполните настройку gsheet_service_account или создайте файл src/lib/google-service-account.json"
    );
  }
}

let cachedDoc: { id: string; doc: GoogleSpreadsheet } | null = null;

/**
 * Области доступа сервисного аккаунта: таблицы (чтение и запись).
 * drive.file нужен только для операций с файлом (метаданные/шаринг) и
 * запрашивается отдельно, чтобы не расширять права без необходимости.
 */
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

/**
 * Собирает авторизацию для Google API из «паспорта» сервисного аккаунта.
 * В google-spreadsheet v5 метод useServiceAccountAuth удалён — вместо него
 * передаётся google-auth-library JWT прямо в конструктор документа.
 */
function buildServiceAccountAuth(creds: Record<string, unknown>): JWT {
  const email =
    typeof creds.client_email === "string" ? creds.client_email.trim() : "";
  const key = typeof creds.private_key === "string" ? creds.private_key : "";
  if (!email || !key) {
    throw new Error(
      "В «паспорте» сервисного аккаунта отсутствует client_email или private_key"
    );
  }
  // В настройках панели и .env переносы строк ключа иногда экранированы как \n
  return new JWT({
    email,
    key: key.replace(/\\n/g, "\n"),
    scopes: GOOGLE_SCOPES,
  });
}

/** Документ Google Таблицы по ID из настроек (с кэшем авторизации) */
export async function getDoc(): Promise<GoogleSpreadsheet> {
  const map = await getSettings();
  const id = (map.get("gsheet_spreadsheet_id") || "").trim();
  if (!id) throw new Error("Не задан ID Google-таблицы (настройка gsheet_spreadsheet_id)");
  if (cachedDoc && cachedDoc.id === id) return cachedDoc.doc;

  const creds = await loadServiceAccount();
  const auth = buildServiceAccountAuth(creds);
  // v5: авторизация передаётся вторым аргументом конструктора
  const doc = new GoogleSpreadsheet(id, auth);
  await doc.loadInfo();
  cachedDoc = { id, doc };
  return doc;
}

/**
 * Лист по названию подразделения.
 *
 * Имя листа берётся из настроек (shds_sheet_tank / shds_sheet_art), а при
 * пустой настройке совпадает с названием подразделения — так листы названы в
 * таблице по умолчанию. Сначала ищется настроенное имя, затем само название
 * подразделения: если администратор переименовал лист и не успел обновить
 * настройку, зачисление всё равно найдёт нужный лист, а не упадёт с
 * «лист не найден».
 *
 * Раскладка (колонки, блоки, оценки) от имени не зависит — она привязана к
 * подразделению через resolveLayout().
 */
export async function getSheet(unit: string): Promise<GoogleSpreadsheetWorksheet> {
  const doc = await getDoc();
  const sheets = Object.values(doc.sheetsById) as GoogleSpreadsheetWorksheet[];
  const normalizedUnit = unit.trim();
  const candidates = [normalizedUnit];

  // Каноническое подразделение → настроенное имя листа
  const map = await getSettings();
  const canonical = normalizedUnit.toLowerCase();
  if (isUnit(normalizedUnit)) {
    candidates.unshift(unitSheetName(normalizedUnit, map));
  } else if (/танк/.test(canonical)) {
    candidates.unshift(unitSheetName("Танковая рота", map));
  } else if (/дивизион|артиллер/.test(canonical)) {
    candidates.unshift(unitSheetName("Артиллерийский дивизион", map));
  }

  for (const name of candidates) {
    const target = name.trim().toLowerCase();
    if (!target) continue;
    const sheet = sheets.find((s) => (s.title || "").trim().toLowerCase() === target);
    if (sheet) return sheet;
  }

  throw new Error(`Лист «${unit}» не найден в таблице`);
}

/* ------------------------------------------------------------------ */
/* Константы раскладки ШДС (по ТЗ)                                     */
/* ------------------------------------------------------------------ */

/**
 * Блок строк листа с одной должностью.
 *
 * `post` — значение, которое обязано стоять в колонке «Должность» (D у роты,
 * E у дивизиона) у строк ЭТОГО блока. Нужно в двух местах: при зачислении
 * (если боец не указал должность, пишется штатная должность секции) и при
 * зачистке освободившейся строки (вместо пустой ячейки возвращается дефолт).
 */
export type PostBlock = {
  /** Границы блока (1-based, включительно) */
  top: number;
  bottom: number;
  /** Должность блока: она же дефолт для освободившихся строк */
  post: string;
};

export type UnitLayout = {
  key: "TR" | "AD";
  nameCol: string;                              // колонка имени / «Вакант»
  overall: { top: number; bottom: number };     // общий диапазон поиска имени
  addRange: { top: number; bottom: number };    // «Добавление в ШДС»
  /**
   * Блок «Запас | долгий отпуск» НА ЭТОМ ЖЕ листе (сейчас есть у дивизиона:
   * строки 44–78). Оценки бойца, вернувшегося из запаса, могут лежать здесь,
   * пока его основная строка пустая — их нужно мержить при чтении ЛК.
   */
  reserveBlock?: { top: number; bottom: number };
  /**
   * Строки ниже этой границы — инфо-блоки и плашки командования, а не состав.
   * При ПОИСКЕ БОЙЦА для мержа оценок они не рассматриваются: иначе зам
   * корпуса Иванов И.А. (плашка в D90/D94) склеивался бы с рядовым
   * однофамильцем из блока запаса (строка 60).
   */
  infoBlockTop?: number;
  /**
   * Дополнительные колонки ФИО, которые нужно проверять при поиске строки.
   * Раскладку листа правят руками: у дивизиона имя встречается и в C, и в D.
   */
  extraNameCols?: readonly string[];
  postRanges: { match: RegExp; top: number; bottom: number }[]; // «Изменение должности»
  /**
   * Должности по блокам строк, включая те, что не назначаются рапортом бойца
   * (командирские). Используются для дефолтной должности при зачислении и при
   * возврате строки в состояние «Вакант».
   */
  defaultPosts: PostBlock[];
  examHeaderRow: number;                        // строка с названиями экзаменов
  /**
   * Первая колонка блока оценок листа.
   *
   * У роты блок экзаменов начинается с «H», у дивизиона — с «I»: служебных
   * столбцов слева у листов разное число, и общая константа на оба листа
   * сдвигала бы оценки на колонку (оценка уезжала бы в чужой столбец, а
   * «сдан» появлялся бы у соседнего норматива).
   */
  examStartCol: string;
  /**
   * Последняя колонка блока оценок — она же конец «строки целиком».
   *
   * У роты это «AE» (24 столбца экзаменов), у дивизиона «AG» (25). Границы
   * нужны и для закраски, и для переноса строки: всё, что правее, в листе
   * относится к служебным пометкам и копированию не подлежит.
   */
  examEndCol: string;
  /**
   * Правая граница ЧТЕНИЯ оценок, если она шире блока записи.
   *
   * Запись нельзя расширять молча: бот закрашивает столбец по заголовку, и
   * сдвинутая граница увела бы оценку в служебную колонку. Чтение же лишних
   * столбцов безопасно — берутся только те, чей заголовок сопоставился с
   * каталогом нормативов, а пустые и служебные пропускаются.
   */
  readExamEndCol?: string;
};

const LAYOUTS: Record<"TR" | "AD", UnitLayout> = {
  // Танковая рота: колонка A узкая (служебная), данные с B.
  // B — звание, C — ФИО, D — должность, E — Steam ID, F — Discord ID.
  TR: {
    key: "TR",
    nameCol: "C",
    /**
     * Поиск идёт до 100-й строки: строки ниже блока логистов тоже относятся
     * к листу, и обрезка по 47-й теряла бойца, добавленного вручную ниже блока
     * (ошибка «Боец … не найден» при существующей строке).
     */
    overall: { top: 10, bottom: 100 },
    /**
     * Диапазон «Добавление в ШДС» — блок логистов-снабженцев (31–47).
     * Зачисление по конкретной должности идёт по секциям VACANT_SECTIONS:
     * боец встаёт в «Вакант» СВОЕЙ секции, а не в первую свободную строку.
     */
    addRange: { top: 31, bottom: 47 },
    /**
     * Плашки командования и инфо-блоки листа роты. Ниже этой строки состав
     * не ищется: там служебные надписи, и совпадение ФИО в них склеило бы
     * двух разных людей.
     */
    infoBlockTop: 80,
    /**
     * Секции строк «Вакант» и должность, которая в них пишется.
     * Границы — по ТЗ: КБМ 10–14, наводчики 16–22, мехводы 24–29,
     * логисты/МТО/курсанты 31–47.
     */
    postRanges: [
      { match: /логист|снабжен|мто|курсант/i, top: 31, bottom: 47 },
      { match: /мех\.?\s*водител|мехвод/i, top: 24, bottom: 29 },
      { match: /наводчик|оператор/i, top: 16, bottom: 22 },
      { match: /кбм|командир/i, top: 10, bottom: 14 },
    ],
    defaultPosts: [
      // Логисты-снабженцы: должность БЕЗ приписки «/резерв» — она осталась от
      // прежней раскладки и у активного бойца читалась как «в резерве»
      { top: 31, bottom: 47, post: "Логист-снабженец" },
      { top: 24, bottom: 30, post: "Специалист Мех.водитель" },
      { top: 16, bottom: 23, post: "Специалист Наводчик-Оператор" },
      { top: 10, bottom: 15, post: "Командир Боевой Машины" },
      { top:  6, bottom:  9, post: "Командование" },
    ],
    examHeaderRow: 6,
    // Блок оценок роты: столбцы H–AE (24 норматива — от КМБТ до «Берет»)
    examStartCol: "H",
    examEndCol: "AE",
  },
  // Артиллерийский дивизион: колонка A пустая, в B — синяя полоса,
  // данные с колонки C: C — звание, D — фамилия и инициалы, E — должность,
  // F — Steam ID, G — Discord ID.
  AD: {
    key: "AD",
    // Колонка имени у дивизиона — D, а не C (в C лежит ЗВАНИЕ).
    // Вся раскладка строки считается отступом от nameCol, поэтому смена
    // одной константы возвращает на место звание (C), должность (E),
    // Steam (F) и Discord (G) — без правки каждой записи отдельно.
    nameCol: "D",
    /**
     * Общий диапазон поиска — до 100-й строки, а не до 42-й.
     *
     * Раньше здесь стоял bottom: 41 (блок снабжения), и всё, что ниже, лист
     * просто не читал: боец, чья строка оказалась дальше (ручная правка,
     * добавленные отделения), не находился — «Боец Розгов А.В. не найден».
     * Блоки для зачисления по-прежнему ограничены postRanges/defaultPosts,
     * поэтому расширение поиска не даёт зачислять в чужие секции.
     */
    overall: { top: 12, bottom: 100 },
    /**
     * Диапазон «Добавление в ШДС» — отделение снабжения (34–42).
     * Строки 43+ — блок «Запас | долгий отпуск»: активных бойцов туда
     * не пишем никогда.
     */
    addRange: { top: 34, bottom: 42 },
    /**
     * Блок «Запас | долгий отпуск» на листе дивизиона (строки 43–78).
     *
     * Оценки бойца, вернувшегося из запаса (Романов А.В., Вакутагин И.И.),
     * остаются здесь, пока основная строка пустая. Блок читается при мерже
     * оценок и при переносе их в основную строку.
     */
    reserveBlock: { top: 43, bottom: 78 },
    /**
     * Ниже 80-й строки у дивизиона идут инфо-блоки и плашки командования
     * (Волков Д.В. — D90, Иванов И.А. — D94, Иванов К.М. — D98). При поиске
     * бойца для мержа оценок они исключены: иначе зам корпуса Иванов И.А.
     * совпал бы с рядовым-однофамильцем из блока запаса (строка 60).
     */
    infoBlockTop: 80,
    /**
     * C — колонка ЗВАНИЯ. В списке дополнительных колонок ФИО она осталась
     * намеренно: `ensureMembersInShds` ищет существующую строку только по
     * nameCol и extraNameCols (без соседней слева), и при ручном сдвиге листа
     * имя может оказаться в C. Ложных совпадений это не даёт: «Рядовой» или
     * «Сержант» не равны ФИО ни по точному, ни по «грубому» ключу.
     */
    extraNameCols: ["C"],
    /**
     * Секции строк «Вакант» по ТЗ: командиры отделений — 12 и 24,
     * 1-е отделение огневого взвода — 13–22 (писать в 18–22),
     * 2-е отделение — 25–32, снабжение — 34–42. Ниже 42 — запас.
     */
    postRanges: [
      { match: /снабжен|логист|мто/i, top: 34, bottom: 42 },
      { match: /2\s*оов|рсзо|миномет|сау/i, top: 25, bottom: 32 },
      // Наводчик 1-го отделения — только СВОБОДНЫЕ строки блока (18–22):
      // строки 13–17 заняты и по ТЗ не трогаются
      { match: /наводчик/i, top: 18, bottom: 22 },
      { match: /1\s*оов/i, top: 13, bottom: 22 },
      { match: /командир/i, top: 12, bottom: 24 },
    ],
    defaultPosts: [
      // Отделение снабжения дивизиона — должность без «/резерв»
      { top: 34, bottom: 42, post: "Логист-снабженец" },
      { top: 25, bottom: 33, post: "Специалист - наводчик" },
      { top: 24, bottom: 24, post: "Командир" },
      { top: 13, bottom: 23, post: "Специалист - наводчик" },
      { top: 12, bottom: 12, post: "Командир" },
    ],
    examHeaderRow: 8,
    // Блок оценок дивизиона: столбцы I–AG (25 нормативов — от КМБТ до «Берет»)
    examStartCol: "I",
    examEndCol: "AG",
    /**
     * Чтение — до «AI»: в шапке дивизиона встречаются столбцы правее «AG»,
     * и без расширения границы их оценки терялись. Запись по-прежнему
     * ограничена «AG» (examEndCol).
     */
    readExamEndCol: "AI",
  },
};

/**
 * Секция строк «Вакант»: блок строк листа с одной должностью.
 *
 * Нужна, чтобы боец вставал в свободную строку СВОЕЙ должности, а не в первую
 * попавшуюся: у роты «Вакант» есть и у командиров машин, и у наводчиков, и у
 * мехводов, и у логистов, у дивизиона — у каждого отделения своё.
 */
export type VacantSection = {
  /** Стабильный ключ секции (для логов и проверок) */
  key: string;
  /** Название секции для сообщений */
  title: string;
  /** Должность, которая обязана стоять в колонке «Должность» строк этой секции */
  post: string;
  /** Границы блока строк (1-based, включительно) */
  rows: { top: number; bottom: number };
  /**
   * С какой строки МОЖНО писать в «Вакант» (по умолчанию rows.top).
   *
   * У наводчиков дивизиона блок идёт с 13-й, но занятые строки 13–17 не
   * трогаются: свободные места по ТЗ — 18–22.
   */
  fillTop?: number;
  /** Признак должности по тексту из БД / заявки */
  match: RegExp;
};

/**
 * Секции «Вакант» по листам.
 *
 * Порядок внутри массива важен: проверяется первое совпадение, поэтому
 * снабжение дивизиона стоит ДО наводчиков (иначе «Логист-снабженец» попал бы
 * в отделение огневого взвода), а у роты мехвод проверяется до наводчика.
 */
export const VACANT_SECTIONS: Record<"TR" | "AD", readonly VacantSection[]> = {
  TR: [
    {
      key: "tr_bcm",
      title: "КБМ / Командир боевой машины",
      post: "Командир Боевой Машины",
      rows: { top: 10, bottom: 14 },
      match: /кбм|командир\s+боевой\s+машины|ком\.?\s*боевой/i,
    },
    {
      key: "tr_gunner",
      title: "Наводчик / Оператор-наводчик",
      post: "Специалист Наводчик-Оператор",
      rows: { top: 16, bottom: 22 },
      match: /наводчик|оператор/i,
    },
    {
      key: "tr_driver",
      title: "Механик-водитель",
      post: "Специалист Мех.водитель",
      rows: { top: 24, bottom: 29 },
      match: /мех\.?\s*водител|мехвод|водител/i,
    },
    {
      key: "tr_logist",
      title: "Логист / Снабженец / МТО / Курсант",
      post: "Логист-снабженец",
      rows: { top: 31, bottom: 47 },
      match: /логист|снабжен|мто|курсант|резерв/i,
    },
  ],
  AD: [
    {
      key: "ad_commander_1",
      title: "Командир 1-го отделения",
      post: "Командир",
      rows: { top: 12, bottom: 12 },
      match: /командир/i,
    },
    {
      key: "ad_gunner_1",
      title: "Наводчик 1-го отделения огневого взвода",
      post: "Специалист - наводчик",
      // Свободные строки блока — 18–22: строки 13–17 заняты по ТЗ
      rows: { top: 13, bottom: 22 },
      fillTop: 18,
      match: /наводчик|1\s*оов|оператор/i,
    },
    {
      key: "ad_commander_2",
      title: "Командир 2-го отделения",
      post: "Командир",
      rows: { top: 24, bottom: 24 },
      match: /командир\s+2|2\s*оов\s*командир/i,
    },
    {
      key: "ad_squad_2",
      title: "2-е отделение огневого взвода",
      post: "Специалист - наводчик",
      rows: { top: 25, bottom: 32 },
      match: /2\s*оов|рсзо|миномет|сау|мех/i,
    },
    {
      key: "ad_supply",
      title: "Отделение снабжения",
      post: "Логист-снабженец",
      rows: { top: 34, bottom: 42 },
      match: /логист|снабжен|мто/i,
    },
  ],
};

/**
 * Последняя строка, в которую разрешено писать активного бойца.
 *
 * У дивизиона с 43-й строки начинается блок «Запас | долгий отпуск»: запись
 * туда активного бойца создала бы второго человека с тем же ФИО и потеряла
 * его настоящую строку.
 */
export const SECTION_FILL_MAX: Record<"TR" | "AD", number> = {
  TR: 47,
  AD: 42,
};

/**
 * Реальная должность бойца для колонки «Должность».
 *
 * Снимает приписку «/резерв» (и её варианты «(резерв)», «- резерв»): она
 * осталась от прежней раскладки учебного отделения и у АКТИВНОГО бойца
 * читалась как «боец в резерве». Пустое значение остаётся пустым — вызывающий
 * подставит штатную должность секции.
 */
export function sanitizeSheetPost(post: unknown): string {
  const value = String(post ?? "")
    .replace(/\u00A0/g, " ")
    .trim();
  if (!value) return "";
  const cleaned = value
    .replace(/\s*[/\\|,;-]\s*(?:в\s+)?резерв[а-яё]*\s*$/i, "")
    .replace(/\s*\(\s*резерв[а-яё]*\s*\)\s*$/i, "")
    .trim();
  return cleaned || value;
}

/** Секция «Вакант» по тексту должности (null — должность вне секций листа) */
export function findVacantSection(
  layout: UnitLayout,
  post: unknown
): VacantSection | null {
  const text = String(post ?? "").trim();
  if (!text) return null;
  return VACANT_SECTIONS[layout.key].find((section) => section.match.test(text)) ?? null;
}

/** Секция строки листа по её номеру (null — строка вне секций) */
export function sectionAtRow(
  layout: UnitLayout,
  row: number
): VacantSection | null {
  return (
    VACANT_SECTIONS[layout.key].find(
      (section) => row >= section.rows.top && row <= section.rows.bottom
    ) ?? null
  );
}

/**
 * Диапазон строк, в которые можно писать бойца этой секции.
 *
 * Верхняя граница — fillTop (у наводчиков дивизиона 18), нижняя — конец блока,
 * но никогда ниже SECTION_FILL_MAX: строки 43+ дивизиона — блок запаса.
 */
export function vacantFillRange(section: VacantSection): { top: number; bottom: number } {
  return { top: section.fillTop ?? section.rows.top, bottom: section.rows.bottom };
}

/**
 * Все секции листа с той же должностью, что у секции, найденной по тексту.
 *
 * Нужно там, где одна должность занимает НЕСКОЛЬКО блоков: у дивизиона
 * «Командир» — это строки 12 (1-е отделение) и 24 (2-е отделение). Без этого
 * боец с должностью «Командир» получал отказ, стоило занять строку 12, хотя
 * свободная строка в блоке 2-го отделения была.
 *
 * Порядок — как в VACANT_SECTIONS (сверху вниз по листу).
 */
export function sectionsForPost(
  layout: UnitLayout,
  post: unknown
): readonly VacantSection[] {
  const found = findVacantSection(layout, post);
  if (!found) return [];
  const wanted = found.post.trim().toLowerCase();
  return VACANT_SECTIONS[layout.key].filter(
    (section) => section.post.trim().toLowerCase() === wanted
  );
}

/**
 * Диапазоны «Вакант» для должности — по одному на каждую её секцию.
 *
 * Пустой список означает «должность вне секций листа»: вызывающий берёт
 * диапазон по умолчанию.
 */
export function vacantFillRangesForPost(
  layout: UnitLayout,
  post: unknown
): { top: number; bottom: number }[] {
  return sectionsForPost(layout, post).map((section) => vacantFillRange(section));
}

/**
 * Штатная должность блока, в котором стоит строка.
 *
 * Пустая строка — блок не описан в раскладке: подставлять «на глаз» чужую
 * должность нельзя, иначе освободившаяся строка получит должность соседнего
 * отделения и следующий зачисленный боец встанет не туда.
 */
export function defaultPostFor(layout: UnitLayout, row: number): string {
  const block = layout.defaultPosts.find((b) => row >= b.top && row <= b.bottom);
  return block?.post ?? "";
}

/**
 * Звание для записи в лист.
 *
 * «Курсант» — звание до принятия присяги: в ШДС его не пишут, вместо него
 * ставится «Рядовой». Пустое звание из формы по той же причине не оставляет
 * ячейку пустой — иначе строка выглядит незаполненной.
 */
export function sheetRank(rank: unknown): string {
  const value = String(rank ?? "").trim();
  if (!value || /^курсант$/i.test(value)) return DEFAULT_SHEET_RANK;
  return value;
}

/** Раскладка подразделения по названию листа */
export function resolveLayout(unit: string): UnitLayout {
  const u = unit.toLowerCase();
  if (/танк/.test(u)) return LAYOUTS.TR;
  if (/дивизион|артиллер/.test(u)) return LAYOUTS.AD;
  throw new Error(
    `Неизвестное подразделение «${unit}»: ожидались «Танковая рота» или «Артиллерийский дивизион»`
  );
}

/** Первая колонка строки ШДС: границы «строки целиком» начинаются с A */
const ROW_START_COL = "A";

/**
 * Последняя колонка ПОЛНОЙ строки ШДС — «AG» (индекс 32, всего 33 колонки A..AG).
 *
 * Почему не конец блока оценок листа: у роты оценки кончаются на «AE», у
 * дивизиона — на «AG», и обрезка снапшота по блоку оценок ТЕРЯЛА хвост строки
 * (у роты это последние нормативы — уставы, ПВО, БПЛА, береты). Снапшот строки
 * бойца при переводе в запас обязан забирать строку целиком, поэтому его
 * правая граница — общая для обоих листов колонка «AG», а не examEndCol.
 *
 * Копирование строки ВНУТРИ листа (copyRow) по-прежнему идёт по examEndCol:
 * правее блока оценок у листа лежат служебные пометки, и переносить их вместе
 * со строкой бойца нельзя.
 */
export const FULL_ROW_END_COL = "AG";

/** Индекс колонки «AG» (0-based): 32 */
export const FULL_ROW_END_INDEX = colIndex(FULL_ROW_END_COL);

/** Длина полной строки ШДС в колонках: A..AG — 33 */
export const FULL_ROW_COL_COUNT = FULL_ROW_END_INDEX + 1;

/**
 * Гарантирует, что у листа есть хотя бы `minColumns` колонок.
 *
 * Зачем: лист «Запас» пишет строку бойца целиком (A..AG) и служебные колонки
 * AH..AJ, а свежесозданный лист Google даёт всего 26 колонок. Без расширения
 * сетки `getCell` падал бы с «Out of bounds», и перевод в запас ломался бы на
 * первом же бойце. Уже существующий лист со старым (узким) снапшотом
 * расширяется здесь же — данные при этом не теряются.
 */
export async function ensureColumnCount(
  sheet: GoogleSpreadsheetWorksheet,
  minColumns: number
): Promise<void> {
  if (sheet.columnCount >= minColumns) return;
  await sheet.resize({ rowCount: sheet.rowCount, columnCount: minColumns });
}

/**
 * Блок оценок листа: с какой колонки начинаются экзамены и на какой кончаются.
 *
 * Границы берутся из РАСКЛАДКИ листа (examStartCol / examEndCol в LAYOUTS), а не
 * из общей константы: у роты блок идёт с «H» по «AE» (24 столбца), у дивизиона —
 * с «I» по «AG» (25). Общая константа сдвигала бы оценки на колонку, и «сдано»
 * появлялось бы у соседнего норматива, а оценка уезжала бы в чужой столбец.
 *
 * Раскладка строки (одинаковая у роты и дивизиона):
 *   * A — служебная;
 *   * B — Звание (строго слева от фамилии);
 *   * C — Фамилия И. О. / позывной;
 *   * D — Должность;
 *   * E — Steam ID;
 *   * F — Discord ID;
 *   * G — «Для пометок» / «Заметки»;
 *   * далее (H/I)..AE/AG — сданные экзамены: оценка в ячейке и зелёная заливка.
 *
 * Отсюда же берётся и колонка имени (nameCol в LAYOUTS = «C») у ОБОИХ листов:
 * у дивизиона она раньше была «D», и всё, что писалось рядом (должность, Steam,
 * Discord), уезжало на колонку вправо — заявка «одобрялась», а в таблице данные
 * вставали не в свои столбцы.
 */
export function examBounds(layout: UnitLayout): { start: number; end: number } {
  return { start: colIndex(layout.examStartCol), end: colIndex(layout.examEndCol) };
}

/**
 * Границы ЧТЕНИЯ блока оценок.
 *
 * Шире границ записи (examBounds), если у листа задан readExamEndCol: у
 * дивизиона шапка уходит правее «AG». Расширять ЗАПИСЬ нельзя — бот закрасил
 * бы служебный столбец, — а чтению лишние столбцы не вредят: берутся только
 * заголовки, сопоставимые с каталогом нормативов.
 */
export function examReadBounds(layout: UnitLayout): { start: number; end: number } {
  return {
    start: colIndex(layout.examStartCol),
    end: colIndex(layout.readExamEndCol ?? layout.examEndCol),
  };
}

/**
 * Цвет имени бойца в строю (колонка C): стандартный зелёный Google Sheets #6aa84f.
 * Эталон — строка 43 «Петров М. С.» листа «Танковая рота».
 */
const NAME_GREEN = { red: 0.4157, green: 0.6588, blue: 0.3098, alpha: 1 };

/**
 * Эталонный шрифт ячеек ШДС: Times New Roman, 12, жирный, чёрный.
 *
 * Google Таблица при перезаписи текста сбрасывает ячейки в Arial 10, поэтому
 * при записи данных бойца и экзаменов шрифт передаётся явно. Константа
 * применяется ТОЛЬКО к ячейкам, в которые модуль пишет значения (строка
 * бойца и оценки экзаменов): заливки по-прежнему идут запросами с fields
 * "userEnteredFormat.backgroundColor" и чужое оформление не трогают.
 */
export const SHDS_TEXT_FORMAT = {
  fontFamily: "Times New Roman",
  fontSize: 12,
  bold: true,
  foregroundColor: { red: 0, green: 0, blue: 0 },
} as const;

/**
 * Цвет сданного экзамена и берета: ярко-зелёный #00ff00.
 * Используется для всех ячеек блока оценок (H..AE / I..AG) и столбца «Берет».
 */
const EXAM_GREEN = { red: 0, green: 1, blue: 0, alpha: 1 };

/** Белая заливка освободившейся строки: фон «Вакант» */
const VACANT_WHITE = { red: 1, green: 1, blue: 1, alpha: 1 };

/** Серая заливка неприменимых/закрытых дисциплин: светло-серый #d9d9d9 */
const DISABLED_GRAY = { red: 0.85, green: 0.85, blue: 0.85, alpha: 1 };

/** Звание по умолчанию для листа: «Курсант» в ШДС не пишется */
const DEFAULT_SHEET_RANK = "Рядовой";

/**
 * Сплошная тонкая чёрная линия.
 *
 * Стиль задан явно, а не «как в соседней строке»: при copyPaste формата рамки
 * переносятся, но стоит одному блоку потерять их (ручная правка, вставка строк
 * из другого файла) — и разделители исчезают по всему диапазону, потому что
 * каждая следующая строка копирует формат предыдущей.
 */
const SOLID_BLACK_BORDER = {
  style: "SOLID" as const,
  color: { red: 0, green: 0, blue: 0 },
  width: 1,
};

/** Цвет заливки в формате Google Sheets */
type CellColor = { red: number; green: number; blue: number; alpha?: number };

/* ------------------------------------------------------------------ */
/* Помощники работы с ячейками                                         */
/* ------------------------------------------------------------------ */

/** Индекс колонки: A=0, B=1, ... */
function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Буква колонки по индексу (0 → A) */
function colLetter(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type Cell = ReturnType<GoogleSpreadsheetWorksheet["getCell"]>;

/** Ячейка по номеру строки (1-based) и букве колонки */
function cellAt(sheet: GoogleSpreadsheetWorksheet, row: number, col: string): Cell {
  return sheet.getCell(row - 1, colIndex(col));
}

/**
 * Steam ID для записи в лист: только сам идентификатор, без подписи.
 *
 * В заявках и старых записях встречается «ID: 7656119…». Префикс — это подпись
 * поля, а не часть идентификатора: в ячейке он ломал поиск по Steam и выглядел
 * как «сбой шрифта» из-за переноса строки в узком столбце. Оставляем только
 * значение: цифры SteamID64 либо формат STEAM_0:1:12345 как есть.
 */
export function cleanSteamIdForSheet(value: unknown): string {
  const raw = String(value ?? "")
    .replace(/\u00A0/g, " ")
    .trim();
  if (!raw) return "";
  // Снимаем подпись «ID:», «ID :», «Steam ID:» (регистр не важен, повторно)
  const stripped = raw
    .replace(/^(?:steam\s*)?id\s*:\s*/i, "")
    .replace(/^(?:steam\s*)?id\s*:\s*/i, "")
    .trim();
  return stripped || raw;
}

/**
 * Индекс колонки по букве (A → 0).
 *
 * Экспортируется для модулей, которым нужно прочитать ячейку известной
 * колонки листа: у них не должно быть своей копии алфавита и своих букв —
 * раскладка ШДС описана здесь (LAYOUTS).
 */
export function columnIndexOf(letter: string): number {
  return colIndex(letter);
}

/** Свободная строка — значение «Вакант» */
function isVacant(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "вакант";
}

/**
 * Первая строка листа: там начинаются объединённые заголовки ШДС.
 *
 * Область поиска расширена до неё намеренно — и заголовки («Фамилия»), и
 * командование листа стоят выше `overall.top`, и обрезка по `overall.top`
 * делала бойца из командования ненаходимым.
 */
const SEARCH_TOP_ROW = 1;

/**
 * Верхняя строка поиска бойца, доступная другим модулям.
 *
 * Раскладка строк листа описана здесь (LAYOUTS), поэтому и граница поиска
 * должна задаваться здесь: синхронизация званий обязана видеть командиров
 * подразделений в строках 7–8 (рота) и 9–10 (дивизион) — они стоят ВЫШЕ
 * `overall.top`, и обрезка по нему делала их ненаходимыми.
 */
export const SHEET_SEARCH_TOP_ROW = SEARCH_TOP_ROW;

/** Последняя строка шапки — строка перед таблицей участников */
function headerScanBottom(layout: UnitLayout): number {
  return Math.max(SEARCH_TOP_ROW, layout.overall.top - 1);
}

/**
 * Загрузить область строк целиком (по границы блока экзаменов этого листа).
 *
 * Читается не только запрошенный диапазон, но и всё, что ВЫШЕ него, до первой
 * строки листа: там лежит шапка (по её заголовкам поиск уточняет колонку ФИО)
 * и командование (у дивизиона строки 1–11 при таблице с 12-й). Один и тот же
 * запрос — отдельного обращения к API это не стоит.
 */
async function loadArea(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  top: number,
  bottom: number
) {
  const from = Math.min(top, SEARCH_TOP_ROW);
  // Правая граница — граница ЧТЕНИЯ: у дивизиона шапка шире блока записи, и
  // обрезка по examEndCol («AG») оставляла столбцы правее не прочитанными, а
  // значит, и оценки в них недоступными для мержа.
  const endCol = layout.readExamEndCol ?? layout.examEndCol;
  await sheet.loadCells(`${ROW_START_COL}${from}:${endCol}${bottom}`);
}

/** Первая строка со значением «Вакант» в диапазоне колонки имени */
export function findVacantRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  top: number,
  bottom: number,
  excludeRow?: number
): number | null {
  for (let row = top; row <= bottom; row++) {
    if (excludeRow && row === excludeRow) continue;
    if (isVacant(cellAt(sheet, row, layout.nameCol).value)) return row;
  }
  return null;
}

/** Текст ячейки строки (1-based) по индексу колонки; "" — пусто или не загружено */
function readRowText(sheet: GoogleSpreadsheetWorksheet, row: number, col: number): string {
  try {
    return String(sheet.getCell(row - 1, col).value ?? "")
      .replace(/\u00A0/g, " ")
      .trim();
  } catch {
    // Ячейка вне загруженного диапазона — для поиска это «нет значения»,
    // а не повод падать с «This cell has not been loaded yet»
    return "";
  }
}

/**
 * «Грубый» ключ ФИО: только буквы и цифры, без точек, дефисов и пробелов.
 *
 * normalizePersonName сводит «А. В.» к «А.В.», но точку в ячейке могли и не
 * поставить — «Розгов А.В» или «Розгов А В». Для поиска это одно и то же ФИО,
 * поэтому дополнительно сравнивается ключ без разделителей.
 * Принимает уже нормализованную строку (normalizePersonName).
 */
function looseNameKey(normalized: string): string {
  return normalized.replace(/[^a-zа-я0-9]+/g, "");
}

/** Заголовок колонки с ФИО в шапке листа */
const NAME_HEADER_RE = /фамили|фио|ф\.?\s*и\.?\s*о/i;

/**
 * Похожа ли колонка на колонку ФИО по её содержимому.
 *
 * Одного слова «Фамилия» в шапке мало: лист начинается с объединённых
 * заголовков («Штатно-должностной список…»), и такое слово может оказаться в
 * колонке A, где данных нет вовсе. Колонка принимается только если в ней
 * реально стоят имена — есть хотя бы одна непустая строка, кроме «Вакант».
 */
function columnLooksLikeNames(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  col: number
): boolean {
  for (let row = layout.overall.top; row <= layout.overall.bottom; row++) {
    const text = readRowText(sheet, row, col);
    if (text && !isVacant(text)) return true;
  }
  return false;
}

/** Колонка ФИО по заголовку шапки (0-based) или null, если шапка её не называет */
function headerNameColumn(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout): number | null {
  const lastCol = Math.min(colIndex(layout.nameCol) + 1, 5);
  for (let row = SEARCH_TOP_ROW; row <= headerScanBottom(layout); row++) {
    // Колонка A служебная (там же объединённые заголовки листа): слово
    // «Фамилия» в них ещё не значит, что имена лежат в A
    for (let col = 1; col <= lastCol; col++) {
      const text = readRowText(sheet, row, col);
      if (!text || !NAME_HEADER_RE.test(text)) continue;
      if (columnLooksLikeNames(sheet, layout, col)) return col;
    }
  }
  return null;
}

/**
 * Колонки, в которых ищется ФИО.
 *
 * Первой идёт колонка, найденная по заголовку шапки (если шапка прочитана),
 * затем C — колонка ФИО по ТЗ, затем B: строку могли сдвинуть вручную, и имя
 * оказывается там, где по раскладке стоит звание. Проверять только C нельзя —
 * именно из-за этого рапорт отвечал «Боец Розгов А.В. не найден», хотя строка
 * на листе есть.
 */
function nameColumnsFor(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout): number[] {
  const base = colIndex(layout.nameCol);
  const columns: number[] = [];
  const byHeader = headerNameColumn(sheet, layout);
  if (byHeader != null) columns.push(byHeader);
  // Дополнительные колонки раскладки: у дивизиона ФИО встречается и в D —
  // раскладку листа правят руками, и поиск только по C отвечал «не найден»
  const extra = (layout.extraNameCols ?? []).map((col) => colIndex(col));
  for (const col of [base, ...extra, base - 1]) {
    if (col >= 0 && !columns.includes(col)) columns.push(col);
  }
  return columns;
}

/**
 * Проход по строкам: сначала точное совпадение ключа ФИО, затем вхождение.
 *
 * Поиск идёт с ПЕРВОЙ строки листа, а не с `overall.top`: командование стоит
 * выше таблицы участников (у дивизиона строки 1–11 при overall.top = 12), и
 * обрезка по overall.top делала такого бойца ненаходимым — рапорт на смену
 * должности отвечал «не найден», хотя строка на листе есть. В строках выше
 * overall.top принимается только СТРОГОЕ совпадение: там лежит шапка, и поиск
 * по вхождению мог бы зацепиться за заголовок.
 *
 * Точное совпадение важнее частичного и в самой таблице: пометка «(отпуск)» в
 * одной строке не должна перебивать чистую запись того же ФИО в другой.
 */
function scanNameRows(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  target: string,
  targetLoose: string,
  columns: readonly number[],
  excludeRow?: number
): number | null {
  let partial: number | null = null;
  for (let row = SEARCH_TOP_ROW; row <= layout.overall.bottom; row++) {
    if (excludeRow && row === excludeRow) continue;
    // Строки шапки/командования выше overall.top: только точное совпадение
    const isAboveTable = row < layout.overall.top;
    for (const col of columns) {
      const raw = readRowText(sheet, row, col);
      // Свободная строка — не боец: «Вакант» не должен совпасть с искомым именем
      if (!raw || isVacant(raw)) continue;
      const key = normalizePersonName(raw);
      if (!key) continue;
      const loose = looseNameKey(key);
      // Пометка в скобках или приписка не должны ломать поиск
      if (key === target || (targetLoose && loose === targetLoose)) return row;
      if (
        !isAboveTable &&
        partial === null &&
        (key.includes(target) || (targetLoose && loose.includes(targetLoose)))
      ) {
        partial = row;
      }
    }
  }
  return partial;
}

/**
 * Строка бойца по имени в общем диапазоне подразделения.
 *
 * Сравнение идёт по ключу normalizePersonName (recruits.ts), а не по сырой
 * строке: в листе ФИО записано как угодно — «Розгов А.В.», «Розгов А. В.»,
 * с неразрывным пробелом из Google Таблиц или с латинской «A» в инициалах.
 * Точное совпадение из-за этого отвечало «Боец не найден», хотя строка есть.
 *
 * Дополнительно:
 *   * ячейки с ФИО проверяются не только в колонке C, но и в B и в колонке,
 *     названной «Фамилия» в шапке — раскладку листа правят руками, и имя
 *     оказывается не там, где стоит по ТЗ;
 *   * сравнивается ещё и «грубый» ключ без точек и пробелов, поэтому
 *     «Розгов А.В» и «Розгов А. В.» находят одну и ту же строку.
 *
 * Сначала ищется точное совпадение ключа, затем — вхождение (на случай
 * «Розгов А.В. (отпуск)» в ячейке): так поиск не теряет бойца из-за пометки,
 * но и не склеивает двух разных людей с похожими ФИО.
 */
export function findNameRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  name: string,
  excludeRow?: number
): number | null {
  const target = normalizePersonName(name);
  if (!target) return null;
  const targetLoose = looseNameKey(target);
  if (!targetLoose) return null;
  return scanNameRows(sheet, layout, target, targetLoose, nameColumnsFor(sheet, layout), excludeRow);
}

/**
 * Диагностика неудачного поиска бойца.
 *
 * В лог попадают первые 10–15 прочитанных ячеек ФИО вместе с их
 * нормализованным ключом: сразу видно, чем запись в листе отличается от
 * искомого имени (опечатка, латиница в инициалах, сдвинутая колонка), и не
 * нужно открывать таблицу, чтобы это выяснить.
 */
function warnMissingSoldier(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  names: readonly string[]
): void {
  const columns = nameColumnsFor(sheet, layout);
  const sample: string[] = [];
  for (let row = SEARCH_TOP_ROW; row <= layout.overall.bottom && sample.length < 15; row++) {
    for (const col of columns) {
      const raw = readRowText(sheet, row, col);
      if (!raw) continue;
      sample.push(`${colLetter(col)}${row}="${raw}"→"${normalizePersonName(raw)}"`);
      break; // одна колонка ФИО на строку
    }
  }
  const byHeader = columns.length > 0 && columns[0] !== colIndex(layout.nameCol);
  const where = columns.map((c) => colLetter(c)).join("/");
  const tail = sample.length ? `: ${sample.join("; ")}` : " — колонки не прочитаны";
  console.warn(
    `[gsheets] Боец не найден на листе «${sheet.title}»` +
      (byHeader ? ` (ФИО по шапке в колонке ${colLetter(columns[0])})` : "") +
      `; ищем ${names.map((n) => `«${n}»→«${normalizePersonName(n)}»`).join(", ")}` +
      `; колонки ${where}, прочитано ${sample.length} ячеек${tail}`
  );
}

/* ------------------------------------------------------------------ */
/* Оформление строки: границы, шрифты, заливки                         */
/* ------------------------------------------------------------------ */

/** Диапазон строки по колонкам (индексы Google: конец диапазона не включается) */
type GridRangeLike = {
  sheetId?: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
};

/** Спецификация одной линии рамки */
type BorderSpec = { style: "SOLID"; color: { red: number; green: number; blue: number }; width: number };

/** Запрос batchUpdate, который умеет собирать этот модуль */
type SheetRequest =
  | {
      updateBorders: {
        range: GridRangeLike;
        top: BorderSpec;
        bottom: BorderSpec;
        left: BorderSpec;
        right: BorderSpec;
        innerHorizontal: BorderSpec;
        innerVertical: BorderSpec;
      };
    }
  | {
      repeatCell: {
        range: GridRangeLike;
        cell: { userEnteredFormat: { backgroundColor: CellColor } };
        fields: string;
      };
    };

/** Диапазон одной строки в указанных колонках */
function rowRange(
  sheetId: number,
  row: number,
  fromCol: string,
  toCol: string
): GridRangeLike {
  return {
    sheetId,
    startRowIndex: row - 1,
    // Конец диапазона не включается: строка занимает ровно одну строку таблицы
    endRowIndex: row,
    startColumnIndex: colIndex(fromCol),
    endColumnIndex: colIndex(toCol) + 1,
  };
}

/**
 * Выполнение набора запросов ОДНИМ batchUpdate.
 *
 * Почему пакетом: «формат + границы + заливка» — одна логическая операция.
 * Разнеси мы её по отдельным вызовам — между ними строка успела бы показаться
 * с полуприменённым оформлением, а часть запросов могла бы не дойти при сбое.
 *
 * `_makeBatchUpdateRequest` в библиотеке помечен внутренним, но именно он
 * отправляет несколько запросов за одно обращение к API (публичные copyPaste и
 * updateBorders шлют по запросу каждый). Если в сборке метода не окажется
 * (обновление зависимости), набор выполняется поштучно публичными методами:
 * медленнее, но результат тот же.
 */
async function runBatch(sheet: GoogleSpreadsheetWorksheet, requests: SheetRequest[]): Promise<void> {
  const batch = (
    sheet as unknown as { _makeBatchUpdateRequest?: (r: unknown[]) => Promise<void> }
  )._makeBatchUpdateRequest;

  if (typeof batch === "function") {
    await batch.call(sheet, requests);
    return;
  }

  for (const request of requests) {
    if ("updateBorders" in request) {
      const { range, ...borders } = request.updateBorders;
      await sheet.updateBorders(range, borders);
    } else {
      const { range, cell, fields } = request.repeatCell;
      await sheet.repeatCell(range, cell, fields);
    }
  }
}

/**
 * Сжатие списка колонок в непрерывные диапазоны.
 *
 * Заливка ставится запросом на диапазон, поэтому 20 подряд идущих колонок
 * выгоднее покрасить одним запросом, чем двадцатью: у Google есть лимит на
 * размер batchUpdate, и «по запросу на ячейку» он упирается в него на больших
 * строках.
 */
function toRanges(columns: readonly number[]): { from: number; to: number }[] {
  const sorted = [...new Set(columns)].sort((a, b) => a - b);
  const ranges: { from: number; to: number }[] = [];
  for (const column of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && column === last.to + 1) last.to = column;
    else ranges.push({ from: column, to: column });
  }
  return ranges;
}

/** Запрос заливки диапазона колонок строки */
function fillRequest(
  sheet: GoogleSpreadsheetWorksheet,
  row: number,
  from: number,
  to: number,
  color: CellColor
): SheetRequest {
  return {
    repeatCell: {
      range: rowRange(sheet.sheetId, row, colLetter(from), colLetter(to)),
      cell: { userEnteredFormat: { backgroundColor: color } },
      // Только цвет: рамки и шрифт ячейки запрос не трогает
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

/**
 * Колонки блока оценок, закрашенные «сдано».
 *
 * Снимается с исходной строки ПЕРЕД переносом: copyPaste формата затирает
 * заливки всего диапазона, и без этого снимка зелёные отметки бойца
 * заменились бы фоном строки-образца (то есть отметками другого человека).
 */
function readExamGreens(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  row: number
): number[] {
  const { start, end } = examBounds(layout);
  const columns: number[] = [];
  for (let c = start; c <= end; c++) {
    if (isExamGreen(sheet.getCell(row - 1, c).backgroundColor)) columns.push(c);
  }
  return columns;
}

/**
 * Определение неприменимых колонок экзаменов для данной должности.
 *
 * Серыми закрашиваются столбцы, которые для этой специальности не нужны:
 * например, у логиста-снабженца (учебное отделение) серыми идут все блоки
 * специализаций (мехвод, наводчик, сержант), а у мехвода — блоки наводчика,
 * сержанта и спецкурсов, кроме самого блока мехвода.
 *
 * Логика: ищем секцию по должности бойца → берём её required → все столбцы,
 * чей group НЕ входит в группы required нормативов, закрашиваем серым.
 */
function disabledExamColumns(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  post: string
): number[] {
  const unit = layout.key === "TR" ? "Танковая рота" : "Артиллерийский дивизион";

  // Находим секцию по должности
  const section = POSITION_SECTIONS.find(
    (s: { unit: string; post: string }) =>
      s.unit === unit && s.post.toLowerCase() === post.toLowerCase()
  );

  if (!section || !section.required || section.required.length === 0) {
    // Нет секции или нет требований: серые не ставятся (либо это командир, либо
    // должность неизвестна — не угадываем, какие столбцы закрыть)
    return [];
  }

  // Группы нормативов, которые НУЖНЫ бойцу этой специальности
  const requiredGroups = new Set<string>();
  for (const req of section.required) {
    const exam = examCatalog(unit).exams.find(
      (e: { code: string }) => e.code === req.code
    );
    if (exam?.group) requiredGroups.add(exam.group);
  }

  const headerRow = layout.examHeaderRow;
  const { start: examFrom, end: examTo } = examBounds(layout);
  const disabled: number[] = [];

  // Читаем шапку и проверяем группу каждого столбца
  for (let c = examFrom; c <= examTo; c++) {
    const title = String(sheet.getCell(headerRow - 1, c).value ?? "").trim();
    if (!title) continue;

    const exam = examCatalog(unit).exams.find(
      (e: { code: string }) => canonicalExamTitle(e.code) === canonicalExamTitle(title)
    );

    // Если норматив найден, но его группы НЕТ в required, закрашиваем серым
    if (exam?.group && !requiredGroups.has(exam.group)) {
      disabled.push(c);
    }
  }

  return disabled;
}

/**
 * Приведение строки к формату ШДС: сплошные границы, заливка колонки имени и
 * восстановление заливок блока оценок.
 *
 * Шрифт строки НЕ задаётся и не переписывается. Это принципиально: раньше
 * каждая записанная ячейка получала «стандартный формат» (Times New Roman,
 * жирный, 12) независимо от оформления листа, и шрифт таблицы сбивался —
 * именно эту жалобу («как у Юсупова») требование запрещает повторять. Теперь
 * единственное, что меняет модуль в оформлении, — `backgroundColor` (заливка
 * «сдано»/«вакант»/«неприменимо»), а `textFormat` остаётся оригинальным.
 *
 * Оформление строки НЕ копируется с образца: требование запрещает менять
 * `textFormat` таблицы (шрифт, размер, начертание). Раньше здесь стоял
 * copyPaste PASTE_FORMAT с соседней строки — именно он и давал «сбитый шрифт»,
 * потому что оформление зависело от случайно выбранной строки-образца.
 * Теперь строка получает только сплошные границы и заливки.
 *
 * Почему заливки блока оценок ставятся ВСЕГДА: строка без явного фона
 * сохраняла бы зелёные отметки прежнего бойца (у нового бойца «сдано» то, чего
 * он не сдавал; на «Вакант» — зачёт несуществующего бойца). Поэтому блок
 * экзаменов (H..AE у роты, I..AG у дивизиона) сначала гасится белым, а затем
 * закрашиваются только сданные нормативы (`examGreenColumns`), а неприменимые
 * дисциплины — серым (`examDisabledColumns`).
 *
 * Каждая заливка отправляется запросом с `fields: "userEnteredFormat.backgroundColor"`:
 * Google меняет РОВНО цвет фона, не трогая текст, шрифт и выравнивание.
 */
async function applyRowFormat(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  targetRow: number,
  options: {
    /** Колонка имени: её заливка выставляется явно */
    nameCol?: string;
    /** Цвет заливки колонки имени (зелёный у бойца, белый у «Вакант») */
    nameFill?: CellColor | null;
    /** Колонки блока оценок, которые нужно закрасить зелёным (сданные) */
    examGreenColumns?: readonly number[];
    /** Колонки блока оценок, которые нужно закрасить серым (неприменимые) */
    examDisabledColumns?: readonly number[];
  } = {}
): Promise<void> {
  const { nameCol, nameFill, examGreenColumns = [], examDisabledColumns = [] } = options;
  const lastCol = layout.examEndCol;
  const target = rowRange(sheet.sheetId, targetRow, ROW_START_COL, lastCol);
  const requests: SheetRequest[] = [];

  /**
   * ВАЖНО: формат строки-образца здесь НЕ копируется.
   *
   * Раньше стоял copyPaste с pasteType PASTE_FORMAT: он переносил шрифт,
   * размер, выравнивание и цвета текста с соседней строки. Это и был источник
   * жалобы «сбился шрифт» — оформление зависело от того, как выглядит строка,
   * случайно выбранная образцом. Требование прямо запрещает менять
   * `textFormat`, поэтому оформление ячеек строки остаётся оригинальным, а
   * модуль ставит только заливки (`backgroundColor`) и границы ниже.
   */
  requests.push({
    updateBorders: {
      range: target,
      top: SOLID_BLACK_BORDER,
      bottom: SOLID_BLACK_BORDER,
      left: SOLID_BLACK_BORDER,
      right: SOLID_BLACK_BORDER,
      // Вертикальные разделители МЕЖДУ ячейками строки: без них столбцы
      // внутри строки сливаются, даже когда внешняя рамка на месте
      innerHorizontal: SOLID_BLACK_BORDER,
      innerVertical: SOLID_BLACK_BORDER,
    },
  });

  // Блок оценок: сначала фон без зачётов, затем — закраска неприменимых
  // дисциплин серым и сданных нормативов зелёным
  const { start: examFrom, end: examTo } = examBounds(layout);
  requests.push(fillRequest(sheet, targetRow, examFrom, examTo, VACANT_WHITE));

  // Серые ячейки (неприменимые дисциплины) ставятся ПЕРЕД зелёными: если
  // столбец попал в оба списка (ошибка логики), зелёный перебивает серый
  for (const range of toRanges(examDisabledColumns)) {
    requests.push(fillRequest(sheet, targetRow, range.from, range.to, DISABLED_GRAY));
  }

  for (const range of toRanges(examGreenColumns)) {
    requests.push(fillRequest(sheet, targetRow, range.from, range.to, EXAM_GREEN));
  }

  if (nameCol && nameFill) {
    requests.push(fillRequest(sheet, targetRow, colIndex(nameCol), colIndex(nameCol), nameFill));
  }

  await runBatch(sheet, requests);
}

/**
 * Возврат строки в состояние «Вакант».
 *
 * Используется при переносе бойца и при «Убрать из таблицы»: освободившаяся
 * строка обязана выглядеть как свободная — «Вакант» с белым фоном в колонке
 * имени, штатная должность секции в колонке «Должность», пустые Steam/Discord,
 * стёртые оценки экзаменов и восстановленные границы.
 *
 * Должность секции возвращается не «пусто», а значением блока: по колонке
 * «Должность» потом ищется блок для зачисления, и пустая ячейка сдвинула бы
 * поиск в чужое отделение.
 *
 * `postOverride` задаёт должность явно (очистка строки командования возвращает
 * «Логист-снабженец/резерв» независимо от блока).
 */
/**
 * Очистка строки бойца до состояния «Вакант».
 *
 * Экспортируется (а не остаётся приватным сценарием REMOVE), потому что
 * увольнение из панели — то же самое приведение строки: должность секции
 * возвращается на место, оценки и заливки сбрасываются, границы
 * восстанавливаются. Копирование строки-шаблона переносило и её значения —
 * в колонке должности оказывалось содержимое чужой строки.
 */
export async function clearRowToVacant(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  row: number,
  /** Должность освободившейся строки вместо штатной должности блока */
  postOverride?: string
): Promise<void> {
  const nameColIdx = colIndex(layout.nameCol);
  const rankCol = colLetter(nameColIdx - 1);
  const steamCol = colLetter(nameColIdx + 2);
  const discordCol = colLetter(nameColIdx + 3);

  cellAt(sheet, row, rankCol).value = DEFAULT_SHEET_RANK;
  cellAt(sheet, row, layout.nameCol).value = "Вакант";
  // Должность пишется в РЕАЛЬНОМ виде: приписка «/резерв» у активного состава
  // снимается (см. sanitizeSheetPost), иначе свободная строка секции читалась
  // бы как «боец в резерве»
  cellAt(sheet, row, colLetter(nameColIdx + 1)).value =
    sanitizeSheetPost(postOverride) || defaultPostFor(layout, row);
  cellAt(sheet, row, steamCol).value = "";
  cellAt(sheet, row, discordCol).value = "";

  // Экзамены и оценки: блок экзаменов листа. Заливки сбрасываются форматом
  // ниже — «зелёный сдан» на свободной строке читался бы как сдавший боец.
  const { start: examFrom, end: examTo } = examBounds(layout);
  for (let c = examFrom; c <= examTo; c++) {
    sheet.getCell(row - 1, c).value = "";
  }

  await sheet.saveUpdatedCells();

  // Блок оценок остаётся пустым: колонки для закраски не передаются, поэтому
  // applyRowFormat гасит его белым и сбрасывает зелёные отметки бойца
  await applyRowFormat(sheet, layout, row, {
    nameCol: layout.nameCol,
    nameFill: VACANT_WHITE,
  });
}

/**
 * Копирование строки: значения + заливки.
 *
 * Конец диапазона — конец блока экзаменов ЭТОГО листа: у роты «AE», у дивизиона
 * «AG». Всё правее в листе относится к служебным пометкам и переносу не
 * подлежит.
 *
 * `textFormat` и выравнивание НЕ переносятся: требование запрещает менять
 * шрифт таблицы. Перенос оформления с одной строки на другую как раз и давал
 * «сбитый шрифт» — у строки-источника мог быть свой размер или начертание.
 * Заливка переносится: она несёт смысл (зелёные отметки экзаменов сданы).
 */
export function copyRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  srcRow: number,
  destRow: number
) {
  const start = colIndex(ROW_START_COL);
  const end = examBounds(layout).end;
  for (let c = start; c <= end; c++) {
    const src = sheet.getCell(srcRow - 1, c);
    const dest = sheet.getCell(destRow - 1, c);
    dest.value = src.value;
    // В google-spreadsheet v5 сеттеры формата не принимают undefined,
    // поэтому заливку переносим только когда она есть у источника.
    if (src.backgroundColor) dest.backgroundColor = { ...src.backgroundColor };
  }
}

/* ------------------------------------------------------------------ */
/* Сценарии А–Д (по ТЗ)                                                */
/* ------------------------------------------------------------------ */

/**
 * Запись бойца в строку листа по раскладке ШДС.
 *
 * Колонки заданы ОТНОСИТЕЛЬНО колонки имени (nameCol), а не выписаны буквами:
 *   B — Звание (строго слева от фамилии), C — Фамилия/позывной, D — Должность,
 *   E — Steam ID, F — Discord ID, G — Для пометок.
 * Раскладка одна у обоих листов, поэтому относительный сдвиг одинаков и не
 * ломается, если у листа когда-нибудь поменяется колонка имени.
 *
 * Должность: если боец её не указал (заявка «Добавление в ШДС» без поля), в
 * колонку пишется штатная должность секции — по ней потом ищется блок строки.
 * Пустая ячейка выглядела бы как незаполненная строка и ломала поиск блока при
 * зачистке.
 *
 * Колонка G (пометок) очищается принудительно: старые записи «Запас», «Отпуск»
 * или технические заметки не должны оставаться при зачислении.
 */
function writeSoldierRow(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  row: number,
  data: { rank: string | null; name: string | null; post: string; steamId: string | null; discordId: string | null }
) {
  const nameCol = colIndex(layout.nameCol);
  const rankCell = cellAt(sheet, row, colLetter(nameCol - 1));
  const nameCell = cellAt(sheet, row, layout.nameCol);
  const postCell = cellAt(sheet, row, colLetter(nameCol + 1));
  const steamCell = cellAt(sheet, row, colLetter(nameCol + 2));
  const discordCell = cellAt(sheet, row, colLetter(nameCol + 3));
  const notesCell = cellAt(sheet, row, colLetter(nameCol + 4));

  rankCell.value = sheetRank(data.rank);
  nameCell.value = data.name || "";
  /**
   * Должность — РЕАЛЬНАЯ должность бойца.
   *
   * `sanitizeSheetPost` снимает приписку «/резерв»: в БД и старых заявках она
   * осталась от прежней раскладки учебного отделения роты, и активный боец
   * выглядел в таблице как «боец в резерве». Пустое поле заменяется штатной
   * должностью секции строки — по ней потом ищется блок при зачистке.
   */
  postCell.value = sanitizeSheetPost(data.post) || defaultPostFor(layout, row);
  // Steam ID пишется БЕЗ подписи «ID:»: только сам идентификатор
  // (7656119… или STEAM_0:1:…). Подпись ломала поиск по Steam и выглядела
  // как «сбой шрифта» в узком столбце.
  steamCell.value = cleanSteamIdForSheet(data.steamId);
  discordCell.value = data.discordId || "";
  notesCell.value = ""; // Очистка колонки «Для пометок»

  /**
   * Эталонный шрифт ШДС: Times New Roman, 12, жирный.
   *
   * Google Таблица при перезаписи текста сбрасывает ячейки в Arial 10 —
   * именно это требование закрывает SHDS_TEXT_FORMAT. Шрифт ставится ТОЛЬКО
   * на ячейки, в которые этот модуль пишет значения бойца; выравнивание и
   * границы не трогаются, а заливки идут отдельными запросами с fields
   * "userEnteredFormat.backgroundColor".
   */
  const font = { ...SHDS_TEXT_FORMAT };
  rankCell.textFormat = font;
  nameCell.textFormat = font;
  postCell.textFormat = font;
  steamCell.textFormat = font;
  discordCell.textFormat = font;
}

/**
 * Жёсткий фильтр: командование не вписывается в строки «Вакант».
 *
 * У командования есть отдельный лист «Командование АТК», а командиры и замы
 * подразделений стоят в самом верху своих листов (ТР — строки 7–8, АД — 9–10).
 * Запись такого бойца в свободную строку создавала дубль: настоящая плашка
 * оставалась выше, а в составе появлялся второй человек с тем же ФИО.
 *
 * @returns текст причины отказа либо null, если записывать можно
 */
function commandVacantRejection(
  layout: UnitLayout,
  names: readonly string[],
  post?: string | null,
  action = "добавления в «Вакант»"
): string | null {
  if (isSheetCommandMember(names, layout.key, post)) {
    return (
      `${names[0] ?? "Боец"}: командование Корпуса и командиры подразделений ` +
      `не вписываются в строки «Вакант» (у командования отдельный лист ` +
      `«Командование АТК», командиры стоят вверху своего листа) — ${action} отменено`
    );
  }
  return null;
}

/** Сценарий А: «Добавление в ШДС» */
async function scenarioAdd(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  // Командование в «Вакант» не пишется ни при каких условиях
  const rejection = commandVacantRejection(layout, [req.userName], req.должность);
  if (rejection) throw new Error(rejection);

  /**
   * Целевая секция — по должности из заявки.
   *
   * Боец встаёт в «Вакант» СВОЕЙ секции, а не в блок добавления: у роты
   * addRange — блок логистов (31–47), и наводчик, зачисленный в него, оказался
   * бы в чужом отделении. Если должность не распознана, работает прежний
   * диапазон добавления листа.
   */
  const reqPost = sanitizeSheetPost(req.должность);
  /**
   * Диапазоны ВСЕХ секций этой должности: у дивизиона «Командир» занимает
   * строку 12 (1-е отделение) и строку 24 (2-е отделение), и свободное место
   * может быть в любом из блоков.
   */
  const ranges = vacantFillRangesForPost(layout, reqPost);
  const fallback = {
    top: layout.addRange.top,
    bottom: Math.min(layout.addRange.bottom, SECTION_FILL_MAX[layout.key]),
  };
  if (!ranges.length) ranges.push(fallback);
  const section = sectionsForPost(layout, reqPost)[0] ?? null;

  const loadTop = Math.min(...ranges.map((r) => r.top), layout.addRange.top);
  const loadBottom = Math.max(...ranges.map((r) => r.bottom), fallback.bottom);
  await loadArea(sheet, layout, loadTop, loadBottom);

  let row: number | null = null;
  for (const range of ranges) {
    row = findVacantRow(sheet, layout, range.top, Math.min(range.bottom, SECTION_FILL_MAX[layout.key]));
    if (row) break;
  }
  if (!row) {
    throw new Error(
      `Нет свободных строк «Вакант» (строки ${ranges
        .map((r) => `${r.top}–${Math.min(r.bottom, SECTION_FILL_MAX[layout.key])}`)
        .join(", ")}` + (section ? `, секция «${section.title}»` : "") + ")"
    );
  }

  // Должность бойца: реальная должность секции, иначе текст из заявки, иначе
  // штатная должность блока. Приписка «/резерв» не пишется (см. writeSoldierRow).
  const finalPost = section?.post || reqPost || defaultPostFor(layout, row);

  writeSoldierRow(sheet, layout, row, {
    rank: req.rank,
    name: req.userName,
    post: finalPost,
    steamId: req.steamId,
    discordId: req.discordId,
  });

  await sheet.saveUpdatedCells();

  // Блок оценок очищается явно: старая строка могла содержать оценки и заливки
  const { start: examFrom, end: examTo } = examBounds(layout);
  for (let c = examFrom; c <= examTo; c++) {
    sheet.getCell(row - 1, c).value = "";
  }
  await sheet.saveUpdatedCells();

  // Оформление: сплошные границы, имя заливается зелёным — как «боец в строю»,
  // неприменимые дисциплины (не входящие в required секции) — серым.
  // Шрифт таблицы НЕ меняется: applyRowFormat ставит только backgroundColor.
  await sheet.loadCells(); // Загружаем шапку для disabledExamColumns
  const disabledColumns = disabledExamColumns(sheet, layout, finalPost);
  await applyRowFormat(sheet, layout, row, {
    nameCol: layout.nameCol,
    nameFill: NAME_GREEN,
    // Новобранец приходит без сданных нормативов: блок оценок остаётся белым
    examGreenColumns: [],
    examDisabledColumns: disabledColumns,
  });

  return `Боец ${req.userName} добавлен в строку ${row} (лист «${sheet.title}», звание «${sheetRank(
    req.rank
  )}», должность «${finalPost}»)`;
}

/** Сценарий Б: «Изменение звания» */
async function scenarioRank(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);
  const row = findNameRow(sheet, layout, req.userName);
  if (!row) {
    warnMissingSoldier(sheet, layout, [req.userName]);
    throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);
  }

  const rankCell = cellAt(sheet, row, colLetter(colIndex(layout.nameCol) - 1));
  // Значение пишется поверх существующего формата: шрифт и выравнивание
  // ячейки остаются такими, какими их задал лист
  rankCell.value = req.rank;

  await sheet.saveUpdatedCells();
  return `Звание бойца ${req.userName} изменено на «${req.rank}» (строка ${row})`;
}

/** Выбор целевого диапазона для «Изменение должности» по ТЗ */
function pickPostRange(layout: UnitLayout, req: ParsedRequest) {
  const haystacks = [req.должность, req.отделение].filter(Boolean);
  for (const r of layout.postRanges) {
    for (const hay of haystacks) {
      if (r.match.test(hay)) return r;
    }
  }
  return null;
}

/** Сценарий В: «Изменение должности» — система «Перенос и зачистка» */
async function scenarioPost(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  /**
   * Командование не переносится в «Вакант».
   *
   * Зам корпуса Иванов И.А. мог попасть в заявку «Изменение должности» и
   * уехать в свободную строку учебного отделения — рядом с настоящей плашкой
   * командования появлялся дубль. Проверка до чтения листа: отказ дешевле и
   * не зависит от того, как сейчас выглядит таблица.
   */
  const rejection = commandVacantRejection(layout, [req.userName], req.должность, "перевода");
  if (rejection) throw new Error(rejection);

  await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);
  const srcRow = findNameRow(sheet, layout, req.userName);
  if (!srcRow) {
    warnMissingSoldier(sheet, layout, [req.userName]);
    throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);
  }

  // 1. Обновляем должность в соседней правой ячейке (формат не трогаем).
  //    Приписка «/резерв» не пишется: у активного бойца это ложный статус.
  const postCell = cellAt(sheet, srcRow, colLetter(colIndex(layout.nameCol) + 1));
  const reqPost = sanitizeSheetPost(req.должность);
  if (reqPost) {
    postCell.value = reqPost;
  }

  // 2. Определяем целевой диапазон по должности/отделению
  const target = pickPostRange(layout, req);
  if (!target) {
    throw new Error(
      `Не удалось определить диапазон по должности «${req.должность}» / отделению «${req.отделение}»`
    );
  }

  // Снимок сданных нормативов: заливки блока оценок копирование формата затирает
  const greenColumns = readExamGreens(sheet, layout, srcRow);

  // 3. Ищем свободную строку «Вакант» в целевом диапазоне
  if (srcRow >= target.top && srcRow <= target.bottom) {
    // Боец остаётся в своём диапазоне — просто обновляем должность.
    // Формат строки всё равно выравнивается: должность могла удлиниться,
    // а границы блока — разойтись при ручной правке листа
    await sheet.saveUpdatedCells();
    await sheet.loadCells(); // Для disabledExamColumns
    const disabledColumns = disabledExamColumns(sheet, layout, req.должность);
    await applyRowFormat(sheet, layout, srcRow, {
      nameCol: layout.nameCol,
      nameFill: NAME_GREEN,
      examGreenColumns: greenColumns,
      examDisabledColumns: disabledColumns,
    });
    return `Должность ${req.userName} обновлена на «${req.должность}» (строка ${srcRow})`;
  }
  const destRow = findVacantRow(sheet, layout, target.top, target.bottom, srcRow);
  if (!destRow) throw new Error("В целевом диапазоне нет свободных строк («Вакант»)");

  // 4. Переносим бойца на новое место вместе с отметками экзаменов
  copyRow(sheet, layout, srcRow, destRow);
  await sheet.saveUpdatedCells();
  await sheet.loadCells(); // Для disabledExamColumns
  const disabledColumns = disabledExamColumns(sheet, layout, req.должность);
  await applyRowFormat(sheet, layout, destRow, {
    nameCol: layout.nameCol,
    nameFill: NAME_GREEN,
    examGreenColumns: greenColumns,
    examDisabledColumns: disabledColumns,
  });

  // 5. Зачищаем старое место: «Вакант», белый фон, штатная должность секции
  await clearRowToVacant(sheet, layout, srcRow);

  return `${req.userName} переведён на «${req.должность}»: строка ${srcRow} → ${destRow} (лист «${sheet.title}»)`;
}

/**
 * Перенос бойца между секциями ШДС по рапорту о должности.
 *
 * Механика (по ТЗ):
 *   1. найти строку бойца на листе;
 *   2. найти первую свободную строку «Вакант» в целевой секции;
 *   3. скопировать в неё Звание (B), Фамилию (C), новую Должность (D),
 *      Steam ID (E), Discord ID (F) и ВСЕ отметки сданных экзаменов
 *      (блок оценок листа: H..AE у роты, I..AG у дивизиона);
 *   4. наложить на новую строку полные границы и формат секции;
 *   5. вернуть прежнюю строку в состояние «Вакант»: «Рядовой» / «Вакант» с
 *      белым фоном / штатная должность секции / очищенные E–F и оценки.
 *
 * Почему шаги идут именно так: строка сначала появляется в новой секции, и
 * только потом зачищается старая. Обратный порядок означал бы, что при сбое на
 * середине боец исчез бы из таблицы совсем — «Вакант» на старом месте уже
 * стоит, а на новом его нет.
 *
 * Требования секции (сданные экзамены) проверяются ЗДЕСЬ, а не в валидаторе
 * payload: тот работает и в браузере, где истории сданных рапортов нет, и
 * «одобренный» перевод без экзаменов всё равно не должен двигать строку.
 */
export async function transferShdsPosition(params: {
  /** Подразделение бойца: оно же название листа */
  unit: string;
  /** Кандидаты имени в таблице (позывной и ФИО: панель и лист зовут по-разному) */
  names: readonly string[];
  /** Целевая секция из справочника reports.ts (POSITION_SECTIONS) */
  section: ShdsSection;
  /** Сданные бойцом нормативы: по ним проверяются требования секции */
  passedExams?: readonly { code: string }[];
}): Promise<ShdsResult> {
  const unit = params.unit.trim();
  if (!unit) {
    return { ok: false, error: "Бойцу не назначено подразделение — неизвестно, в какой лист писать" };
  }
  const names = params.names.map((n) => (n || "").trim()).filter(Boolean);
  if (!names.length) {
    return { ok: false, error: "Неизвестно имя бойца для поиска строки в таблице" };
  }

  /**
   * Командование не переносится в строки «Вакант».
   *
   * Проверка стоит ДО обращения к таблице: у командования Корпуса свой лист
   * «Командование АТК», а командиры и замы подразделений стоят вверху своего
   * листа (ТР — 7–8, АД — 9–10). Раньше рапорт на смену должности мог увести
   * такого бойца в свободную строку блока, оставив дубль в составе.
   */
  const unitKey = /танк/i.test(unit) ? "TR" : /дивизион|артиллер/i.test(unit) ? "AD" : null;
  if (unitKey && isSheetCommandMember(names, unitKey, params.section.post)) {
    return {
      ok: false,
      error:
        `${names[0]}: командование не переносится в строки «Вакант» ` +
        `(у командования Корпуса отдельный лист «Командование АТК»)`,
    };
  }

  // Требования ступени: без обязательных нормативов строка не двигается
  const missing = missingSectionExams(params.section, params.passedExams ?? []);
  if (missing.length) {
    return {
      ok: false,
      error: `Для должности «${params.section.title}» не сданы: ${missing.join(", ")}`,
    };
  }

  try {
    const sheet = await getSheet(unit);
    const layout = resolveLayout(unit);
    await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);

    let srcRow: number | null = null;
    for (const name of names) {
      srcRow = findNameRow(sheet, layout, name);
      if (srcRow) break;
    }
    if (!srcRow) {
      warnMissingSoldier(sheet, layout, names);
      throw new Error(`Боец «${names.join("» / «")}» не найден на листе «${sheet.title}»`);
    }

    const nameColIdx = colIndex(layout.nameCol);
    const read = (row: number, col: number) => {
      const value = sheet.getCell(row - 1, col).value;
      if (value == null) return null;
      const trimmed = String(value).trim();
      return trimmed === "" ? null : trimmed;
    };

    // Звание и персональные данные СНИМАЮТСЯ до перезаписи строк: после
    // зачистки старого места их взять уже негде
    const rank = read(srcRow, nameColIdx - 1);
    const steamId = read(srcRow, nameColIdx + 2);
    const discordId = read(srcRow, nameColIdx + 3);

    // Снимок сданных нормативов: заливки блока оценок копирование формата
    // затирает, и без него боец потерял бы все зелёные отметки
    const greenColumns = readExamGreens(sheet, layout, srcRow);

    /**
     * Границы целевой секции — из раскладки ЛИСТА (VACANT_SECTIONS), а не из
     * справочника рапортов: у листов своя геометрия (у наводчиков роты 16–22,
     * у дивизиона 1-е отделение пишется в 18–22). Справочник reports.ts —
     * резерв на случай, когда должность секции в раскладке не нашлась.
     */
    const vacancy = findVacantSection(layout, params.section.post);
    /**
     * Целевые диапазоны — по ВСЕМ секциям этой должности: у дивизиона
     * «Командир» есть и в 1-м (строка 12), и во 2-м (строка 24) отделении.
     */
    const targetRanges = vacancy
      ? sectionsForPost(layout, params.section.post).map((s) => vacantFillRange(s))
      : [{ top: params.section.rows.top, bottom: params.section.rows.bottom }];
    const limitBottom = (range: { bottom: number }) =>
      Math.min(range.bottom, SECTION_FILL_MAX[layout.key]);
    const targetPost = vacancy?.post || params.section.post;

    // Строка уже в целевой секции: переносить нечего, меняем только должность
    if (targetRanges.some((r) => srcRow >= r.top && srcRow <= limitBottom(r))) {
      cellAt(sheet, srcRow, colLetter(nameColIdx + 1)).value = targetPost;
      await sheet.saveUpdatedCells();
      await sheet.loadCells(); // Для disabledExamColumns
      const disabledColumns = disabledExamColumns(sheet, layout, targetPost);
      await applyRowFormat(sheet, layout, srcRow, {
        nameCol: layout.nameCol,
        nameFill: NAME_GREEN,
        examGreenColumns: greenColumns,
        examDisabledColumns: disabledColumns,
      });
      return {
        ok: true,
        message: `${params.section.title}: боец уже в секции, должность подтверждена (строка ${srcRow})`,
      };
    }

    // 1. Первая свободная строка «Вакант» в целевой секции. Нижняя граница
    //    ограничена 42-й строкой дивизиона: ниже — блок «Запас».
    let destRow: number | null = null;
    for (const range of targetRanges) {
      destRow = findVacantRow(sheet, layout, range.top, limitBottom(range), srcRow);
      if (destRow) break;
    }
    if (!destRow) {
      throw new Error(
        `В секции «${params.section.title}» нет свободных строк («Вакант», строки ${targetRanges
          .map((r) => `${r.top}–${limitBottom(r)}`)
          .join(", ")})`
      );
    }

    // 2. Отметки экзаменов (блок оценок листа): значения оценок и зелёные
    //    заливки. Копируется ДО записи персональных данных: copyRow переносит
    //    строку целиком, и запись «поверх» гарантирует колонки B–F.
    copyRow(sheet, layout, srcRow, destRow);
    writeSoldierRow(sheet, layout, destRow, {
      rank: sheetRank(rank),
      name: read(srcRow, nameColIdx),
      // Реальная должность секции: приписка «/резерв» активному бойцу не нужна
      post: sanitizeSheetPost(targetPost),
      steamId,
      discordId,
    });
    await sheet.saveUpdatedCells();

    // 3. Оформление новой строки: формат секции, сплошные границы, зелёное имя
    //    и ВОССТАНОВЛЕННЫЕ отметки экзаменов бойца (снимок со старой строки).
    //    Неприменимые дисциплины закрашиваются серым.
    await sheet.loadCells(); // Для disabledExamColumns
    const disabledColumns = disabledExamColumns(sheet, layout, targetPost);
    await applyRowFormat(sheet, layout, destRow, {
      nameCol: layout.nameCol,
      nameFill: NAME_GREEN,
      examGreenColumns: greenColumns,
      examDisabledColumns: disabledColumns,
    });

    // 4. Освободившаяся строка возвращается в «Вакант»
    await clearRowToVacant(sheet, layout, srcRow);

    return {
      ok: true,
      message: `${names[0]} переведён на «${params.section.title}»: строка ${srcRow} → ${destRow} (лист «${sheet.title}», отметки экзаменов сохранены)`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Нормализация названия экзамена для сопоставления.
 * Приводим регистр, неразрывные пробелы и «ё» — иначе «Миномётное дело» из
 * формы не найдёт столбец «Минометное дело» в таблице.
 */
function normalizeExamTitle(value: string): string {
  return String(value ?? "")
    .replace(/\u00A0/g, " ") // неразрывный пробел из Google Таблиц
    .replace(/[«»"'']/g, "") // кавычки-ёлочки и лапки на значимость не влияют
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",") // «а , б» → «а,б»
    .trim();
}
/**
 * Прочие внешние кавычки шапок ШДС: типографские («“Топография”») и обратные.
 *
 * Название берета в листе записано именно так, и без снятия этих кавычек столбец
 * «Топография» не находился: рапорт одобрялся, а отметки в таблице не было.
 * Символы заданы escape-последовательностями, чтобы не путать похожие начертания.
 */
const EXTRA_TITLE_QUOTES = /[\u0022\u0027\u0060\u2018\u2019\u201C\u201D\u201E\u201F\u2032]/g;

/**
 * Зарегистрированные алиасы названий: написание → канонический заголовок листа.
 *
 * Ключи и значения — уже в том виде, который даёт нормализация (нижний регистр,
 * «е» вместо «ё»). Соответствие ОДНОЗНАЧНОЕ и направленное: «Миномётное дело» без
 * уточнения — это экзамен, а не обучение. Иначе пара столбцов
 * «(обучение)»/«(Экзамен)» закрашивалась бы одним рапортом, и обучение
 * оказывалось бы «сдано» само по себе.
 */
const EXAM_TITLE_ALIASES: Record<string, string> = {
  // Уставы: в роте слово напечатано с опечаткой («общевоисковые»), в дивизионе —
  // «общевойсковые», а в панели норматив зовут «Уставы общие»
  "уставы общие": "уставы (общевойсковые)",
  "уставы (общевоисковые)": "уставы (общевойсковые)",

  // Миномётное дело: экзамен и обучение — разные столбцы
  "минометное дело": "минометное дело (экзамен)",

  // Артиллерийское дело: то же разделение, плюс сокращение «Арт. дело» из ТЗ
  "арт. дело": "артиллерийское дело (экзамен)",
  "арт дело": "артиллерийское дело (экзамен)",
  "арт. дело (экзамен)": "артиллерийское дело (экзамен)",
  "арт дело (экзамен)": "артиллерийское дело (экзамен)",
  "артиллерийское дело": "артиллерийское дело (экзамен)",
  "арт. дело (обучение)": "артиллерийское дело (обучение)",
  "арт дело (обучение)": "артиллерийское дело (обучение)",
  "арт. дело обучение": "артиллерийское дело (обучение)",
  "арт дело обучение": "артиллерийское дело (обучение)",

  // Сдача на мехвода: в листах роты и дивизиона три написания одного норматива
  "сдача на мех. водителя": "сдача на мехвода",
  "сдача на мехводителя": "сдача на мехвода",

  // Прочие сокращения из ТЗ и форм
  "тест по теории": "прохождение теста по теории",
  "прохождение теста": "прохождение теста по теории",
};

/**
 * Заголовок норматива в каноническом виде — для сопоставления со столбцом листа.
 *
 * Дополнительно к normalizeExamTitle снимаются внешние кавычки шапки (в листе
 * берет записан как «“Топография”»), внешние скобки, а опечатка
 * «Артиллирийское» из ТЗ приводится к корректному написанию: она стоит и в шапке
 * дивизиона, и в написании норматива панелью.
 *
 * Скобки ВНУТРИ названия сохраняются осознанно: иначе «ТТХ (Часть 1)» и
 * «ТТХ (Часть 2)» слились бы в один столбец и один рапорт закрасил бы оба.
 */
function canonicalExamTitle(value: string): string {
  let title = normalizeExamTitle(value)
    .replace(EXTRA_TITLE_QUOTES, "")
    .replace(/\s+/g, " ")
    .trim();

  // Внешние скобки: «(Топография)» → «Топография»
  while (/^\(.*\)$/.test(title)) title = title.slice(1, -1).trim();

  title = title.replace(/артиллирийское/g, "артиллерийское");
  return EXAM_TITLE_ALIASES[title] ?? title;
}

/**
 * Части названия для сопоставления.
 *
 * Google Формы склеивают выбранные флажки через запятую, поэтому название
 * «Снаряжение, обслуживание техники» приходит двумя кусками: сравнение целых
 * строк столбец не находило и заявка падала с «Столбцы экзаменов не найдены».
 */
function canonicalExamParts(value: string): string[] {
  return canonicalExamTitle(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export type ExamMatchResult = {
  /** Индексы столбцов шапки (0-based), которые нужно закрасить */
  columns: number[];
  /** Части ответа, которые не удалось сопоставить ни с одним столбцом */
  unmatched: string[];
};

/**
 * Сопоставление экзаменов из заявки со столбцами шапки листа ШДС.
 *
 * Почему не простое сравнение строк: Google Формы склеивают выбранные флажки
 * через запятую, а название экзамена, которое САМО содержит запятую
 * («Снаряжение, обслуживание техники»), при разборе заявки разъезжается на два
 * куска. Сравнение кусков с заголовком по отдельности столбец не находило, и
 * заявка падала с ошибкой «Столбцы экзаменов не найдены».
 *
 * Поэтому заголовок каждого столбца тоже делится по запятой, и столбец
 * считается найденным, если ВСЕ его части присутствуют среди кусков ответа.
 * Столбцы из нескольких частей проверяются первыми: иначе одиночный кусок
 * «Снаряжение» успел бы «съесть» себя раньше, чем составное название получит
 * свою вторую часть.
 *
 * Имена приводятся к каноническому виду (canonicalExamTitle): снимаются внешние
 * кавычки шапки («“Топография”»), регистр и «ё» не важны, а зарегистрированные
 * алиасы (EXAM_TITLE_ALIASES) сводят написания панели, ТЗ и листа к одному.
 */
export function matchExamColumns(
  headers: string[],
  requested: string[]
): ExamMatchResult {
  const tokens = requested.flatMap((raw) =>
    canonicalExamParts(raw).map((norm) => ({ raw, norm }))
  );
  const used = new Array(tokens.length).fill(false);
  const columns: number[] = [];

  const candidates = headers
    .map((title, index) => ({ index, parts: canonicalExamParts(title) }))
    .filter((h) => h.parts.length > 0)
    // Сначала заголовки из нескольких частей — они самые «жадные»
    .sort((a, b) => b.parts.length - a.parts.length);

  for (const header of candidates) {
    const picked: number[] = [];
    let matched = true;
    for (const part of header.parts) {
      const at = tokens.findIndex(
        (t, i) => !used[i] && !picked.includes(i) && t.norm === part
      );
      if (at === -1) {
        matched = false;
        break;
      }
      picked.push(at);
    }
    if (!matched) continue;
    for (const i of picked) used[i] = true;
    columns.push(header.index);
  }

  // Порядок столбцов — как в шапке, а не как отсортировали кандидатов
  columns.sort((a, b) => a - b);

  return {
    columns,
    // Повтор одного названия не должен выглядеть как несколько несопоставленных
    unmatched: [...new Set(tokens.filter((_, i) => !used[i]).map((t) => t.raw))],
  };
}

/**
 * Конвертация оценки в цифру для записи в ячейку.
 *
 * Оценки в таблице пишутся строго цифрами (5, 4, 3), а не словами. Панель и старые
 * заявки могли присылать «Отлично» / «Хорошо» / «Удовлетворительно», поэтому
 * конвертация обязательна — иначе в ячейке появляется слово вместо цифры.
 */
function gradeToNumber(grade: string): string {
  const normalized = grade.trim().toLowerCase();
  if (/^отл|^5$/i.test(normalized)) return "5";
  if (/^хор|^4$/i.test(normalized)) return "4";
  if (/^уд|^3$/i.test(normalized)) return "3";
  // Неизвестная оценка → по умолчанию 5
  return "5";
}

/** Сценарий Г: «Получение подтверждения об экзаменации» */
async function scenarioExam(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  if (!req.exams.length) throw new Error("В заявке не указаны сданные экзамены");

  await sheet.loadCells();
  const headerRow = layout.examHeaderRow;
  const { start: examFrom, end: examTo } = examBounds(layout);

  /**
   * Заголовки читаются от начала листа до конца БЛОКА ОЦЕНОК этого листа.
   *
   * matchExamColumns возвращает индексы прочитанного массива, и они же
   * используются как индексы колонок — поэтому массив обязан начинаться с
   * колонки A. Границей служит конец блока экзаменов (AE у роты, AG у
   * дивизиона): читать «до 40-й колонки» значило бы заглядывать в служебные
   * столбцы за шапкой, а обрезать по началу блока — сдвинуть оценку на колонку.
   */
  const headers: string[] = [];
  for (let c = 0; c <= examTo; c++) {
    headers.push(String(sheet.getCell(headerRow - 1, c).value ?? "").trim());
  }

  const { columns: matched, unmatched } = matchExamColumns(headers, req.exams);

  // Совпадение вне блока оценок — это не наш столбец: в служебных колонках листа
  // могут стоять слова, совпадающие с названием норматива, и закраска уехала бы
  // в «Заметки» или в чужую служебную ячейку
  const examCols = matched.filter((c) => c >= examFrom && c <= examTo);

  if (!examCols.length) {
    throw new Error(
      `Столбцы экзаменов не найдены в строке ${headerRow}: ${req.exams.join(", ")}`
    );
  }

  const row = findNameRow(sheet, layout, req.userName);
  if (!row) {
    warnMissingSoldier(sheet, layout, [req.userName]);
    throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);
  }

  /**
   * Оценки по столбцам: индекс колонки → оценка рапорта.
   *
   * Каждый норматив с оценкой сопоставляется СО СВОИМ столбцом отдельным
   * вызовом matchExamColumns. Раскладывать оценки по общему результату нельзя:
   * функция возвращает столбцы в порядке ШАПКИ, а рапорт перечисляет нормативы
   * как их выбрал боец, — при обратном порядке оценка встала бы в чужую ячейку
   * (например, «Отлично» за огневую подготовку попало бы в ТТХ).
   */
  const gradesByColumn = new Map<number, string>();
  for (const item of req.examGrades ?? []) {
    const grade = String(item.grade ?? "").trim();
    if (!grade || !item.code) continue;
    const { columns } = matchExamColumns(headers, examColumnTokens([item.code]));
    for (const column of columns) {
      if (column < examFrom || column > examTo) continue;
      // Оценка КМБТ не пишется: базовый экзамен сдаётся без неё
      const title = String(sheet.getCell(headerRow - 1, column).value ?? "").trim();
      if (/кмбт/i.test(title)) continue;
      gradesByColumn.set(column, grade);
    }
  }

  const isKmbtOnly = examCols.every((c) =>
    /кмбт/i.test(String(sheet.getCell(headerRow - 1, c).value ?? ""))
  );

  for (const c of examCols) {
    const cell = sheet.getCell(row - 1, c);
    cell.backgroundColor = { ...EXAM_GREEN };
    // Эталонный шрифт ШДС: перезапись текста сбрасывает ячейку в Arial 10
    cell.textFormat = { ...SHDS_TEXT_FORMAT };
    const title = String(sheet.getCell(headerRow - 1, c).value ?? "").trim();
    // КМБТ и Берет — базовые экзамены: закрашиваются, но оценки не получают
    if (/кмбт|берет/i.test(title)) {
      cell.value = "";
      continue;
    }
    // Своя оценка норматива из пакетного рапорта, иначе — общая «Оценка» заявки
    const grade = gradesByColumn.get(c) || req.grade;
    if (grade) cell.value = gradeToNumber(grade);
  }

  await sheet.saveUpdatedCells();

  // Проверка автоматического получения берета: если после закраски новых экзаменов
  // у бойца оказались сданы все 4 базовых норматива берета, закрашиваем столбец «Берет»
  const beretGranted = await checkAndGrantBeret(sheet, layout, row, headers, examFrom, examTo);
  if (beretGranted) {
    await sheet.saveUpdatedCells();
  }
  const titles = examCols.map((c) => String(sheet.getCell(headerRow - 1, c).value ?? "").trim());
  const graded = examCols
    .map((c) => ({ title: String(sheet.getCell(headerRow - 1, c).value ?? "").trim(), grade: gradesByColumn.get(c) }))
    .filter((item) => item.grade);
  const gradeStr = graded.length
    ? `, оценки: ${graded.map((item) => `${item.title} — ${item.grade}`).join(", ")}`
    : req.grade && !isKmbtOnly
      ? `, оценка «${req.grade}»`
      : "";
  const examinerStr = req.examiner ? `, экзаменатор: ${req.examiner}` : "";
  // Часть названий могла не найтись (опечатка в форме или переименованный
  // столбец) — раньше об этом молчали, и модератор считал заявку полностью
  // выполненной. Теперь несовпавшие перечисляются явным предупреждением.
  const missedStr = unmatched.length
    ? `. ВНИМАНИЕ: не найдены в таблице — ${unmatched.join(", ")}`
    : "";
  return `Отмечены экзамены (${titles.join(", ")}) для ${req.userName} (строка ${row})${gradeStr}${examinerStr}${missedStr}`;
}

/**
 * Проверка и автоматическое присвоение берета.
 *
 * Если у бойца закрашены все 4 базовых норматива берета (Топография, Связь,
 * Строевая подготовка, Должностные лица), автоматически закрашивается столбец
 * «Берет» ярко-зелёным цветом.
 *
 * Возвращает true, если столбец «Берет» был закрашен (требуется saveUpdatedCells).
 */
async function checkAndGrantBeret(
  sheet: GoogleSpreadsheetWorksheet,
  layout: UnitLayout,
  row: number,
  headers: string[],
  examFrom: number,
  examTo: number
): Promise<boolean> {
  // 4 базовых норматива берета (из BERET_EXAM_CODES в reports.ts)
  const beretRequirements = [
    "топография",
    "связь",
    "строевая подготовка",
    "должностные лица",
  ];

  // Проверяем, сданы ли все 4 норматива
  const passedBeretExams: string[] = [];
  for (let c = examFrom; c <= examTo; c++) {
    const title = String(sheet.getCell(layout.examHeaderRow - 1, c).value ?? "").trim();
    const canonical = canonicalExamTitle(title);
    if (beretRequirements.includes(canonical)) {
      if (isExamGreen(sheet.getCell(row - 1, c).backgroundColor)) {
        passedBeretExams.push(canonical);
      }
    }
  }

  // Если сданы все 4, закрашиваем столбец «Берет»
  if (passedBeretExams.length === beretRequirements.length) {
    for (let c = examFrom; c <= examTo; c++) {
      const title = String(sheet.getCell(layout.examHeaderRow - 1, c).value ?? "").trim();
      const canonical = canonicalExamTitle(title);
      if (canonical === "берет") {
        const beretCell = sheet.getCell(row - 1, c);
        beretCell.backgroundColor = { ...EXAM_GREEN };
        beretCell.textFormat = { ...SHDS_TEXT_FORMAT };
        beretCell.value = ""; // Столбец «Берет» закрашивается без текста
        return true;
      }
    }
  }
  return false;
}

/** Сценарий Д: «Убрать из таблицы» */
async function scenarioRemove(sheet: GoogleSpreadsheetWorksheet, layout: UnitLayout, req: ParsedRequest) {
  await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);
  const srcRow = findNameRow(sheet, layout, req.userName);
  if (!srcRow) {
    warnMissingSoldier(sheet, layout, [req.userName]);
    throw new Error(`Боец ${req.userName} не найден на листе «${sheet.title}»`);
  }

  const range =
    layout.postRanges.find((r) => srcRow >= r.top && srcRow <= r.bottom) || layout.overall;

  // Строка сбрасывается в «Вакант» не копированием шаблона, а тем же
  // приведением, что и при переносе: должность секции возвращается на место,
  // оценки и заливки сбрасываются, границы восстанавливаются. Копирование
  // строки-шаблона переносило и её значения — в колонке должности оказывалось
  // содержимое чужой строки, а границы зависели от того, как оформлен шаблон.
  await clearRowToVacant(sheet, layout, srcRow);

  return `${req.userName} убран из таблицы (строка ${srcRow} возвращена в «Вакант»)`;
}

/* ------------------------------------------------------------------ */
/* Диспетчер обработки заявок                                          */
/* ------------------------------------------------------------------ */

export type ShdsResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Выполняет заявку ШДС в Google Таблице.
 * Вызывается из бота при одобрении (зелёный круг / :ATK:).
 */
export async function applyShdsRequest(req: ParsedRequest): Promise<ShdsResult> {
  try {
    if (req.isVacation) {
      return { ok: false, error: "Заявка на отпуск обрабатывается не в таблице" };
    }
    if (!req.shdsAction) {
      return { ok: false, error: "Неизвестный тип «Редакция ШДС»" };
    }
    if (
      req.shdsAction === SHDS_ACTIONS.RESERVE_GO ||
      req.shdsAction === SHDS_ACTIONS.RESERVE_BACK
    ) {
      return {
        ok: false,
        error: "Заявки запаса обрабатываются в модуле reserve.ts (бот вызывает их напрямую)",
      };
    }

    const sheet = await getSheet(req.unit);
    const layout = resolveLayout(req.unit);

    let message: string;
    switch (req.shdsAction) {
      case SHDS_ACTIONS.ADD:
        message = await scenarioAdd(sheet, layout, req);
        break;
      case SHDS_ACTIONS.RANK:
        message = await scenarioRank(sheet, layout, req);
        break;
      case SHDS_ACTIONS.POST:
        message = await scenarioPost(sheet, layout, req);
        break;
      case SHDS_ACTIONS.EXAM:
        message = await scenarioExam(sheet, layout, req);
        break;
      case SHDS_ACTIONS.REMOVE:
        message = await scenarioRemove(sheet, layout, req);
        break;
      default:
        return { ok: false, error: "Сценарий не реализован" };
    }

    await logSheetsEvent(req, message, true, null);
    return { ok: true, message };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await logSheetsEvent(req, "Ошибка обработки заявки", false, error).catch(() => {});
    return { ok: false, error };
  }
}

/** Запись в журнал сайта о работе с Google Таблицей */
async function logSheetsEvent(
  req: ParsedRequest,
  message: string,
  ok: boolean,
  error: string | null
) {
  try {
    const { db } = await import("@/db");
    const { logs } = await import("@/db/schema");
    await db.insert(logs).values({
      category: "edit",
      author: "Discord-бот",
      action: `${req.shdsAction || "Заявка"} · ${req.unit} · ${req.userName}`,
      details: {
        "Подразделение": req.unit,
        "Боец": req.userName,
        "Итог": message,
      },
      kind: "system",
      title: ok ? "Google Таблица: заявка выполнена" : "Google Таблица: ошибка заявки",
      detail: error ? `${message}: ${error}` : message,
      ok,
    });
  } catch (e) {
    console.error("[gsheets] Не удалось записать журнал:", e);
  }
}


/* ------------------------------------------------------------------ */
/* Правка состава панелью: колонка Discord ID                          */
/* ------------------------------------------------------------------ */

/**
 * Обновление ячейки Discord ID на листе подразделения без заявки ШДС.
 *
 * Зачем отдельная функция, а не вызов applyShdsRequest: тот принимает
 * ParsedRequest («Редакция ШДС», звание, экзамены…) и выполняет сценарий
 * целиком — например «Добавление в ШДС» кладёт бойца в свободную строку
 * «Вакант» и заливает имя. Для правки одного столбца это неверно: боец уже
 * стоит в таблице, менять надо ровно одну ячейку.
 *
 * Колонка та же, что у сценария А (три столбца правее колонки имени) —
 * сверено со scripts/verify-sheet.mjs, который читает её так же.
 */
export async function syncDiscordIdToSheet(params: {
  /** Подразделение бойца: оно же название листа («Танковая рота» / «Артиллерийский дивизион») */
  unit: string;
  /**
   * Кандидаты имени бойца в таблице.
   *
   * Список, а не одно имя: в табеле панели боец записан ФИО из rs-red.com, а в
   * ШДС нередко стоит позывной (и наоборот — сценарий «Добавление в ШДС» пишет
   * туда именно callsign). Перебор двух вариантов избавляет штаб от ошибки
   * «боец не найден» там, где панель и таблица зовут человека по-разному.
   */
  names: readonly string[];
  /** Новый Discord ID; пустая строка очищает ячейку */
  discordId: string;
}): Promise<ShdsResult> {
  const unit = params.unit.trim();
  if (!unit) {
    return { ok: false, error: "Бойцу не назначено подразделение — неизвестно, в какой лист писать" };
  }
  const names = params.names.map((n) => (n || "").trim()).filter(Boolean);
  if (!names.length) {
    return { ok: false, error: "Неизвестно имя бойца для поиска строки в таблице" };
  }

  try {
    const sheet = await getSheet(unit);
    const layout = resolveLayout(unit);
    await loadArea(sheet, layout, layout.overall.top, layout.overall.bottom);

    let row: number | null = null;
    for (const name of names) {
      row = findNameRow(sheet, layout, name);
      if (row) break;
    }
    if (!row) {
      warnMissingSoldier(sheet, layout, names);
      throw new Error(`Боец «${names.join("» / «")}» не найден на листе «${sheet.title}»`);
    }

    const discordCell = cellAt(sheet, row, colLetter(colIndex(layout.nameCol) + 3));
    // Только значение: формат ячейки (шрифт, выравнивание, границы) принадлежит
    // таблице и не перезаписывается правкой одного поля
    discordCell.value = params.discordId;
    await sheet.saveUpdatedCells();

    return {
      ok: true,
      message: params.discordId
        ? `Discord ID записан в лист «${sheet.title}» (строка ${row})`
        : `Discord ID очищен в листе «${sheet.title}» (строка ${row})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Оценки с листов: распознавание, чтение и мерж трёх источников       */
/* ------------------------------------------------------------------ */

/**
 * Раскладка листа «Запас».
 *
 * Шапка экзаменов в строке 3 (I..AF — 24 норматива от КМБТ до «Берет»), ФИО в
 * колонке D. Эти координаты НЕ совпадают с листами подразделений: у роты ФИО в
 * C и оценки с H, у дивизиона ФИО в C и оценки с I. Поэтому лист «Запас»
 * читается отдельной раскладкой, а не раскладкой подразделения.
 */
export const RESERVE_LAYOUT = {
  /** Строка шапки экзаменов листа «Запас» */
  headerRow: 3,
  /** Первая колонка блока оценок — «I» (индекс 8) */
  examStartCol: "I",
  /** Последняя колонка блока оценок — «AF» (индекс 31) */
  examEndCol: "AF",
  /** Колонки, в которых ищется ФИО: C (снапшот), D (по шапке), E, B */
  nameCols: [2, 3, 4, 1] as readonly number[],
  /** Первая строка с данными */
  firstDataRow: 4,
  /** Граница сканирования: ниже — служебные пометки, а не состав */
  maxScanRow: 300,
} as const;

/** Оценки, означающие сданный норматив (по ТЗ) */
const PASSED_GRADE_TEXT = new Set([
  "5",
  "4",
  "5-",
  "4-",
  "4+",
  "5+",
  "зач",
  "зачет",
  "зачёт",
]);

/** Подпись «Зачёт»: норматив закрыт заливкой без числовой оценки */
export const PASS_MARK = "Зачёт";

/**
 * Командование Корпуса: в личном кабинете все нормативы показываются сданными.
 *
 * Список задан ФИО, а не должностью: плашки командования стоят на листе ниже
 * таблицы состава (у дивизиона — строки 90/94/98), и «по должности» отличить
 * зама корпуса от рядового однофамильца в блоке запаса нельзя.
 */
export const COMMAND_CORPS_NAMES = ["Волков Д. В.", "Иванов И. А.", "Иванов К. М."] as const;

/**
 * Лист «Командование АТК» — отдельный лист таблицы для высшего командования.
 *
 * Раскладка отличается от листов подразделений: шапка в строке 1, бойцы в
 * строках 2–4, экзамены начинаются с колонки G (у роты и дивизиона — с H и I).
 * Командование НЕ живёт на листах подразделений: его плашки там стоят ниже
 * состава, и запись такого бойца в «Вакант» — дубль и потеря его настоящей
 * строки. Поэтому лист читается отдельно и участвует в жёстком фильтре.
 */
export const COMMAND_SHEET_LAYOUT = {
  /** Строка шапки листа */
  headerRow: 1,
  /** Первая строка с бойцами командования */
  firstRow: 2,
  /** Последняя строка с бойцами командования */
  lastRow: 4,
  rankCol: "B",
  nameCol: "C",
  postCol: "D",
  steamCol: "E",
  discordCol: "F",
  /** Блок экзаменов командования: G..T */
  examStartCol: "G",
  examEndCol: "T",
} as const;

/**
 * Командиры и заместители ПОДРАЗДЕЛЕНИЙ стоят в самом верху своих листов:
 * у роты — строки 7–8, у дивизиона — строки 9–10. Сканер обязан видеть их там
 * и никогда не переносить в «Вакант».
 */
export const UNIT_COMMAND_ROWS: Record<
  "TR" | "AD",
  { top: number; bottom: number; names: readonly string[] }
> = {
  TR: { top: 7, bottom: 8, names: ["Брюханов Е. Д.", "Осипов Г. А."] },
  AD: { top: 9, bottom: 10, names: ["Милорадович М. Н.", "Гриповский Д. А."] },
};

/**
 * Совпадение любого имени с любым именем перечня.
 *
 * Сравнение идёт по ключу normalizePersonName и по «грубому» ключу без
 * разделителей: в таблице ФИО пишут и «Волков Д. В.», и «Волков Д.В.».
 */
export function matchesCommandRoster(
  names: readonly string[],
  roster: readonly string[]
): boolean {
  if (!roster.length) return false;
  const exact = new Set(roster.map((n) => normalizePersonName(n)));
  const loose = new Set(roster.map((n) => looseNameKey(normalizePersonName(n))));
  for (const name of names) {
    const key = normalizePersonName(name);
    if (!key) continue;
    if (exact.has(key) || loose.has(looseNameKey(key))) return true;
  }
  return false;
}

/** Совпадает ли набор имён бойца с командованием Корпуса */
export function isCommandCorps(names: readonly string[]): boolean {
  return matchesCommandRoster(names, COMMAND_CORPS_NAMES);
}

/** Имя принадлежит командованию ПОДРАЗДЕЛЕНИЯ (строки 7–8 ТР / 9–10 АД) */
export function isUnitCommandName(names: readonly string[], key: "TR" | "AD"): boolean {
  return matchesCommandRoster(names, UNIT_COMMAND_ROWS[key].names);
}

/**
 * Боец командования: корпус или командир/зам подразделения.
 *
 * Проверяются и ФИО, и должность: в БД боец может быть закреплён за
 * подразделением, но занимать должность «Командир Корпуса» / «Зам. Ком.
 * Корпуса». Предикаты должности берутся из validation.ts — второго перечня
 * командования в проекте быть не должно.
 */
export function isSheetCommandMember(
  names: readonly string[],
  key: "TR" | "AD",
  post?: string | null
): boolean {
  if (isCommandCorps(names) || isUnitCommandName(names, key)) return true;
  const fighter = { name: names[0] ?? null, post: post ?? null };
  return isCorpsCommander(fighter) || isDeputyCommander(fighter);
}

/** Боец с листа «Командование АТК»: звание, ФИО, должность, ID */
export type CommandSheetMember = {
  /** Строка листа (1-based) */
  row: number;
  rank: string;
  name: string;
  post: string;
  steamId: string;
  discordId: string;
};

/** Имя листа командования: по ТЗ лист один и назван именно так */
export const COMMAND_SHEET_NAME = "Командование АТК";

/** Кэш имён командования: лист читается не на каждого бойца (квота Google) */
let commandSheetCache: { at: number; members: CommandSheetMember[] } | null = null;
const COMMAND_SHEET_CACHE_MS = 10 * 60 * 1000;

/** Лист «Командование АТК» из документа (null — листа в таблице нет) */
async function getCommandSheetIfExists(): Promise<GoogleSpreadsheetWorksheet | null> {
  const doc = await getDoc();
  const target = COMMAND_SHEET_NAME.trim().toLowerCase();
  const sheets = Object.values(doc.sheetsById) as GoogleSpreadsheetWorksheet[];
  return sheets.find((s) => (s.title || "").trim().toLowerCase() === target) ?? null;
}

/**
 * Чтение листа «Командование АТК».
 *
 * Раскладка: шапка в строке 1, бойцы в строках 2–4 (B — звание, C — ФИО,
 * D — должность, E — Steam ID 64, F — Discord, G..T — экзамены). Лист нужен
 * ровно для одного: жёсткий фильтр «кто в нём записан, тот не попадает в
 * «Вакант» листов подразделений». Модуль лист только ЧИТАЕТ — оформление
 * командования не меняется вовсе.
 *
 * Кэш на 10 минут: функция вызывается и при синхронизации, и при чтении
 * оценок, а loadCells на каждого бойца упёрся бы в квоту Google.
 */
export async function readCommandSheet(
  options: { fresh?: boolean } = {}
): Promise<CommandSheetMember[]> {
  if (
    !options.fresh &&
    commandSheetCache &&
    Date.now() - commandSheetCache.at < COMMAND_SHEET_CACHE_MS
  ) {
    return commandSheetCache.members;
  }

  try {
    const sheet = await getCommandSheetIfExists();
    if (!sheet) {
      commandSheetCache = { at: Date.now(), members: [] };
      return [];
    }

    const L = COMMAND_SHEET_LAYOUT;
    const lastCol = colIndex(L.examEndCol);
    await sheet.loadCells(`${L.rankCol}${L.headerRow}:${colLetter(lastCol)}${L.lastRow}`);

    const members: CommandSheetMember[] = [];
    for (let row = L.firstRow; row <= L.lastRow; row++) {
      const name = readRowText(sheet, row, colIndex(L.nameCol));
      // «Вакант» и пустая строка — не боец командования
      if (!name || isVacant(name)) continue;
      members.push({
        row,
        rank: readRowText(sheet, row, colIndex(L.rankCol)),
        name,
        post: readRowText(sheet, row, colIndex(L.postCol)),
        // Подпись «ID:» в значении — не часть идентификатора
        steamId: cleanSteamIdForSheet(readRowText(sheet, row, colIndex(L.steamCol))),
        discordId: readRowText(sheet, row, colIndex(L.discordCol)).replace(/[^\d]/g, ""),
      });
    }

    commandSheetCache = { at: Date.now(), members };
    return members;
  } catch (e) {
    // Недоступный лист не должен ломать фильтр: остаётся жёсткий список ФИО
    console.warn("[gsheets] Не удалось прочитать лист «Командование АТК»:", e);
    return commandSheetCache?.members ?? [];
  }
}

/** Имена бойцов с листа «Командование АТК» */
export async function commandSheetNames(): Promise<string[]> {
  return (await readCommandSheet())
    .map((member) => member.name)
    .filter(Boolean);
}

/**
 * Строки листа, где командования быть не должно.
 *
 * Диапазон накрывает ВСЕ секции «Вакант» листа (рота 10–47, дивизион 12–42):
 * именно в свободные строки секций попадали замы корпуса, и требование прямо
 * называет такие строки листа «Танковая рота». Ниже 42-й строки дивизиона —
 * блок «Запас», его состав чистится отдельным модулем (reserve.ts).
 */
export const COMMAND_CLEANUP_RANGES: Record<"TR" | "AD", { top: number; bottom: number }> = {
  TR: { top: 10, bottom: 47 },
  AD: { top: 12, bottom: 42 },
};

/**
 * Принудительные переносы бойцов, чья должность в листе записана неверно.
 *
 * Зачем список, а не автоматика: система видит только текст должности в
 * ячейке. У бойца, ошибочно записанного в блок логистов, должность в строке
 * тоже логистская — по ней секцию не восстановить. Такое расхождение задаётся
 * явно, по ФИО, и правило идемпотентно: как только боец стоит в своей секции,
 * оно не срабатывает.
 *
 * Чапаев В.И. — строка 38 (логисты), должен стоять в «Вакант» наводчиков
 * (строки 19–22) с должностью «Специалист Наводчик-Оператор»; его прежняя
 * строка возвращается в «Вакант».
 */
export const FORCED_SECTION_MOVES: Record<
  "TR" | "AD",
  readonly { name: string; section: string }[]
> = {
  TR: [{ name: "Чапаев В.И.", section: "tr_gunner" }],
  AD: [],
};

/**
 * Штатная должность освободившейся строки при очистке командования, когда
 * строку нельзя сопоставить ни с одной секцией листа.
 *
 * Приписки «/резерв» в таблице больше нет: должность пишется в реальном виде
 * (см. sanitizeSheetPost). Для строк внутри секции берётся должность СЕКЦИИ
 * (defaultPostFor), этот текст — только резерв для строк вне блоков.
 */
export const COMMAND_CLEANUP_POST = "Логист-снабженец";

/** Итог автоочистки ШДС от записей командования и подписи «ID:» */
export type SheetRepairResult = {
  ok: boolean;
  /** Строки, возвращённые в «Вакант»: «Танковая рота!40» */
  cleared: string[];
  /** Ячейки, из которых снят префикс «ID:»: «Танковая рота!E42» */
  steamFixed: string[];
  /** Ячейки должности, приведённые к реальному виду (снят «/резерв»): «Танковая рота!D39» */
  postsFixed: string[];
  /** Переносы бойцов в «Вакант» своей секции: «Танковая рота: Чапаев В.И. 38 → 19» */
  moved: string[];
  warnings: string[];
};

/**
 * Автоочистка и приведение ШДС к ТЗ.
 *
 * По каждому листу подразделения:
 *   1. снимает подпись «ID: » в колонке Steam ID (у Юсупова М.А. в E42 роты
 *      стояло «ID: 7656119…»): в ячейке остаются чистые цифры;
 *   2. находит строки, где в секциях «Вакант» стоит командование, и возвращает
 *      их в «Вакант»: «Рядовой», «Вакант» с белой заливкой, штатная должность
 *      секции, пустые Steam/Discord, стёртые оценки;
 *   3. приводит должность активного бойца к реальному виду — снимает приписку
 *      «/резерв» (Соколов Д.О.: «Логист-снабженец/резерв» → «Логист-снабженец»);
 *   4. переносит бойца в «Вакант» СВОЕЙ секции, если он стоит в чужой
 *      (Чапаев В.И. — из логистов в наводчики), сохраняя звание, ID и отметки
 *      экзаменов; прежняя строка возвращается в «Вакант».
 *
 * Оформление меняется ТОЛЬКО заливкой: applyRowFormat и fillRequest шлют
 * fields: "userEnteredFormat.backgroundColor", поэтому шрифт, выравнивание и
 * границы таблицы остаются оригинальными.
 *
 * Ошибка на одном листе не отменяет очистку второго — как и в syncShdsRoster.
 */
export async function repairShdsSheets(): Promise<SheetRepairResult> {
  const cleared: string[] = [];
  const steamFixed: string[] = [];
  const postsFixed: string[] = [];
  const moved: string[] = [];
  const warnings: string[] = [];

  // Имена с листа «Командование АТК» — дополняют жёсткий список ФИО: если
  // состав командования поменяют в таблице, фильтр подхватит это сам
  const commandNames = await commandSheetNames();

  for (const unit of ["Танковая рота", "Артиллерийский дивизион"] as const) {
    let layout: UnitLayout;
    try {
      layout = resolveLayout(unit);
    } catch (e) {
      warnings.push(`${unit}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    try {
      const sheet = await getSheet(unit);
      const readBottom = Math.min(
        layout.overall.bottom,
        layout.infoBlockTop ? layout.infoBlockTop - 1 : layout.overall.bottom
      );
      await loadArea(sheet, layout, SEARCH_TOP_ROW, readBottom);

      const nameColumn = colIndex(layout.nameCol);
      const steamColumn = nameColumn + 2;
      const cleanupRange = COMMAND_CLEANUP_RANGES[layout.key];

      // 1. Подпись «ID: » — по всей прочитанной области: она встречается и в
      //    занятых строках, не только в блоке «Вакант»
      let steamDirty = false;
      for (let row = SEARCH_TOP_ROW; row <= readBottom; row++) {
        let raw = "";
        try {
          raw = String(sheet.getCell(row - 1, steamColumn).value ?? "");
        } catch {
          continue;
        }
        if (!/^\s*(?:steam\s*)?id\s*:/i.test(raw)) continue;
        const cleaned = cleanSteamIdForSheet(raw);
        if (cleaned === raw) continue;
        sheet.getCell(row - 1, steamColumn).value = cleaned;
        steamFixed.push(`${sheet.title}!${colLetter(steamColumn)}${row}`);
        steamDirty = true;
      }
      if (steamDirty) await sheet.saveUpdatedCells();

      // 2. Командование в строках «Вакант» — строка возвращается в свободное
      //    состояние той же функцией, что и при переводе бойца
      const rowsToClear: number[] = [];
      /**
       * Принудительные переносы этого листа. Строка назначается ЗАРАНЕЕ:
       * пока боец стоит не там, порядок обхода иначе мог бы затереть только что
       * освобождённую строку повторно.
       */
      const forcedTargets = new Map<string, string>();
      for (const move of FORCED_SECTION_MOVES[layout.key]) {
        forcedTargets.set(normalizePersonName(move.name), move.section);
      }

      for (let row = cleanupRange.top; row <= cleanupRange.bottom; row++) {
        const raw = readRowText(sheet, row, nameColumn);
        if (!raw || isVacant(raw)) continue;
        const names = [raw];
        // Должность бойца из строки — второй признак командования: ФИО могло
        // быть записано иначе, а должность «Зам. Ком. Корпуса» выдаёт его сразу
        const post = readRowText(sheet, row, nameColumn + 1);
        if (
          isSheetCommandMember(names, layout.key, post) ||
          matchesCommandRoster(names, commandNames)
        ) {
          rowsToClear.push(row);
        }
      }

      for (const row of rowsToClear) {
        // Должность секции СТРОКИ, а не общий текст: у роты блок логистов и
        // блок наводчиков возвращаются в «Вакант» со своими должностями
        await clearRowToVacant(
          sheet,
          layout,
          row,
          defaultPostFor(layout, row) || COMMAND_CLEANUP_POST
        );
        cleared.push(`${sheet.title}!${row}`);
      }

      /**
       * 3. Должность активного бойца — в реальном виде.
       *
       * Приписка «/резерв» осталась от прежней раскладки: у бойца в строю
       * (Соколов Д.О., строка 39 роты) она читается как «боец в резерве».
       * Строки «Вакант» не трогаем — там должность уже штатная, и её
       * возвращает clearRowToVacant.
       */
      let postDirty = false;
      for (let row = cleanupRange.top; row <= cleanupRange.bottom; row++) {
        const name = readRowText(sheet, row, nameColumn);
        if (!name || isVacant(name)) continue;
        const post = readRowText(sheet, row, nameColumn + 1);
        if (!post) continue;
        const real = sanitizeSheetPost(post);
        if (!real || real === post) continue;
        sheet.getCell(row - 1, nameColumn + 1).value = real;
        postsFixed.push(`${sheet.title}!${colLetter(nameColumn + 1)}${row}`);
        postDirty = true;
      }
      if (postDirty) await sheet.saveUpdatedCells();

      /**
       * 4. Боец в чужой секции — в «Вакант» СВОЕЙ секции.
       *
       * Порядок как при переводе: сначала строка появляется на новом месте
       * (со званием, ФИО, должностью, ID и отметками экзаменов), и только потом
       * зачищается прежняя. Обратный порядок при сбое посередине потерял бы
       * бойца из таблицы совсем.
       */
      for (const move of FORCED_SECTION_MOVES[layout.key]) {
        const section = VACANT_SECTIONS[layout.key].find((s) => s.key === move.section);
        if (!section) {
          warnings.push(`${unit}: неизвестная секция «${move.section}» для ${move.name}`);
          continue;
        }
        const target = normalizePersonName(move.name);
        let srcRow: number | null = null;
        for (let row = cleanupRange.top; row <= cleanupRange.bottom; row++) {
          const read = readRowText(sheet, row, nameColumn);
          if (!read || isVacant(read)) continue;
          if (normalizePersonName(read) === target) {
            srcRow = row;
            break;
          }
        }
        if (!srcRow) continue;

        const fill = vacantFillRange(section);
        const fillBottom = Math.min(fill.bottom, SECTION_FILL_MAX[layout.key]);
        // Уже в своей секции — двигать нечего, только должность
        if (srcRow >= fill.top && srcRow <= fillBottom) {
          const cell = sheet.getCell(srcRow - 1, nameColumn + 1);
          if (String(cell.value ?? "").trim() !== section.post) {
            cell.value = section.post;
            await sheet.saveUpdatedCells();
            postsFixed.push(`${sheet.title}!${colLetter(nameColumn + 1)}${srcRow}`);
          }
          continue;
        }

        const destRow = findVacantRow(sheet, layout, fill.top, fillBottom, srcRow);
        if (!destRow) {
          warnings.push(
            `${move.name}: нет свободной строки «Вакант» в секции «${section.title}» ` +
              `(${fill.top}–${fillBottom} листа «${sheet.title}») — перенос пропущен`
          );
          continue;
        }

        // Снимок сданных нормативов: копирование строки затирает заливки блока
        const greens = readExamGreens(sheet, layout, srcRow);
        const rank = readRowText(sheet, srcRow, nameColumn - 1);
        const steamId = readRowText(sheet, srcRow, nameColumn + 2);
        const discordId = readRowText(sheet, srcRow, nameColumn + 3);

        copyRow(sheet, layout, srcRow, destRow);
        writeSoldierRow(sheet, layout, destRow, {
          rank: sheetRank(rank),
          name: move.name,
          post: section.post,
          steamId,
          discordId,
        });
        await sheet.saveUpdatedCells();

        await applyRowFormat(sheet, layout, destRow, {
          nameCol: layout.nameCol,
          nameFill: NAME_GREEN,
          examGreenColumns: greens,
        });

        // Прежняя строка возвращается в «Вакант» со СВОЕЙ штатной должностью
        await clearRowToVacant(sheet, layout, srcRow);
        moved.push(`${sheet.title}: ${move.name} ${srcRow} → ${destRow} (${section.post})`);
      }
    } catch (e) {
      warnings.push(`${unit}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ok: warnings.length === 0, cleared, steamFixed, postsFixed, moved, warnings };
}

/** Сданный норматив: код норматива каталога, оценка и признак «сдан» */
export type ExamMark = {
  /** Код норматива каталога (reports.ts) — по нему идёт мерж названий */
  code: string;
  /** Оценка как она записана в листе; null — только заливка или командование */
  grade: string | null;
  /** Норматив сдан */
  passed: boolean;
};

/**
 * Синяя заливка ячейки.
 *
 * Нужна ровно для одного столбца: на листе «Запас» «КБМ Испыт.» отмечают синим
 * (зелёного там нет), и без этой проверки норматив считался бы несданным.
 */
function isExamBlue(color: CellColor | undefined | null): boolean {
  if (!color) return false;
  const { red = 0, green = 0, blue = 0 } = color;
  return blue > 0.6 && blue > red * 1.3 && blue > green * 1.3;
}

/**
 * Разбор ячейки норматива: текст оценки и/или заливка.
 *
 * Порядок важен: текст главнее заливки — «3» в зелёной ячейке остаётся
 * неудовлетворительной оценкой, а не «Зачётом».
 */
export function parseExamMark(params: {
  value: unknown;
  color?: CellColor | null;
  /** Название столбца: для «КБМ Испыт.» зачёт может быть синим */
  title?: string;
}): { grade: string | null; passed: boolean } {
  const text = String(params.value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const key = text.toLowerCase();
  const isKmbtColumn = /кбм\s*испыт/i.test(String(params.title ?? ""));

  if (text) {
    if (PASSED_GRADE_TEXT.has(key)) {
      // «зач» в ячейке — это зачёт, а не оценка: числовой оценки нет
      const grade = /^\d/.test(text) ? text : PASS_MARK;
      return { grade, passed: true };
    }
    // Числовая оценка ниже 4 (например «3») — норматив не сдан
    if (/^\d[+-]?$/.test(text)) return { grade: text, passed: false };
    // Текст без оценки: зачёт, если ячейка закрашена
    if (isExamGreen(params.color) || (isKmbtColumn && isExamBlue(params.color))) {
      return { grade: PASS_MARK, passed: true };
    }
    return { grade: null, passed: false };
  }

  if (isExamGreen(params.color) || (isKmbtColumn && isExamBlue(params.color))) {
    return { grade: PASS_MARK, passed: true };
  }
  return { grade: null, passed: false };
}

/**
 * Сокращения шапки листа «Запас».
 *
 * На этом листе нормативы названы короче, чем в каталоге рапортов («Снаряжение
 * техники» вместо «Снаряжение, обслуживание техники», «Езда в проходимых
 * условиях» вместо «Езда в сложно-проходимых условиях»). Без таблицы
 * соответствий оценка из запаса не находила свой норматив и не попадала ни в
 * ЛК, ни в основную строку.
 *
 * Ключи — уже нормализованные (нижний регистр, «е» вместо «ё»).
 */
const RESERVE_TITLE_ALIASES: Record<string, string> = {
  "снаряжение техники": "Снаряжение, обслуживание техники",
  "снаряжение, обслуживание техники": "Снаряжение, обслуживание техники",
  "снаряжение и обслуживание техники": "Снаряжение, обслуживание техники",
  "езда в проходимых условиях": "Езда в сложно-проходимых условиях",
  "езда в сложнопроходимых условиях": "Езда в сложно-проходимых условиях",
  "уставы общевойсковые": "Уставы (общевойсковые)",
  "кбм испыт": "КБМ Испыт.",
  "кбм испытателя": "КБМ Испыт.",
  "минометное дело экзамен": "Миномётное дело (Экзамен)",
  "артиллерийское дело экзамен": "Артиллерийское Дело (Экзамен)",
  "сдача на мех водителя": "Сдача на Мех. Водителя",
  "сдача на мехводителя": "Сдача на Мех. Водителя",
};

/** Норматив каталога, которому соответствует заголовок столбца листа */
export function resolveExamRubric(title: string): string | null {
  const raw = normalizeExamCode(title);
  if (!raw) return null;
  const canonical = normalizeExamCode(canonicalExamTitle(title));
  const keys = new Set([raw, canonical]);

  // Сокращения листа «Запас» проверяются первыми: они точнее общего каталога
  for (const key of keys) {
    const mapped = RESERVE_TITLE_ALIASES[key];
    if (mapped) return mapped;
  }

  const catalog = examCatalog(null).exams;
  for (const exam of catalog) {
    const own = [exam.code, ...(exam.aliases ?? [])].map((v) => normalizeExamCode(v));
    if (own.some((k) => keys.has(k))) return exam.code;
  }

  // Заголовок без скобок («Снаряжение, обслуживание техники» → «(экзамен)»):
  // сравниваем ещё и с названием без уточнения в скобках
  for (const exam of catalog) {
    const base = normalizeExamCode(String(exam.code).replace(/\(.*?\)/g, ""));
    if (base && keys.has(base)) return exam.code;
  }
  return null;
}

/** Колонка блока оценок с её нормативом: {column, code} */
type ExamColumn = { column: number; code: string; title: string };

/** Колонки блока оценок листа по строке шапки (только известные нормативы) */
function examColumnsFromHeader(
  sheet: GoogleSpreadsheetWorksheet,
  headerRow: number,
  from: number,
  to: number
): ExamColumn[] {
  const columns: ExamColumn[] = [];
  for (let c = from; c <= to; c++) {
    let title = "";
    try {
      title = String(sheet.getCell(headerRow - 1, c).value ?? "").trim();
    } catch {
      // Ячейка шапки вне загруженного диапазона — столбец просто не учитываем
      continue;
    }
    if (!title) continue;
    const code = resolveExamRubric(title);
    if (!code) continue;
    columns.push({ column: c, code, title });
  }
  return columns;
}

/** Нормализованный ключ ФИО для сравнения «как в листе» */
function personKeys(name: string): { exact: string; loose: string } {
  const exact = normalizePersonName(name);
  return { exact, loose: looseNameKey(exact) };
}

/** Строка листа, в которой стоит искомое ФИО, и колонка, где оно найдено */
type NamedRow = { row: number; nameCol: number };

/**
 * Поиск строк по набору имён в указанных колонках и диапазоне строк.
 *
 * В отличие от findNameRow диапазон задаётся вызывающим: при чтении оценок он
 * обрезается по началу инфо-блоков (плашки командования у дивизиона — строки
 * 90/94/98), чтобы зам корпуса Иванов И.А. не склеивался с рядовым
 * однофамильцем из блока запаса.
 */
function findNamedRows(
  sheet: GoogleSpreadsheetWorksheet,
  columns: readonly number[],
  names: readonly string[],
  top: number,
  bottom: number
): NamedRow[] {
  const targets = names
    .map((n) => personKeys(n))
    .filter((k) => k.exact && k.loose);
  if (!targets.length) return [];

  const found: NamedRow[] = [];
  for (let row = top; row <= bottom; row++) {
    for (const col of columns) {
      const raw = readRowText(sheet, row, col);
      if (!raw || isVacant(raw)) continue;
      const key = personKeys(raw);
      if (!key.exact) continue;
      const hit = targets.some(
        (t) => t.exact === key.exact || (t.loose && t.loose === key.loose)
      );
      if (!hit) continue;
      if (!found.some((f) => f.row === row)) found.push({ row, nameCol: col });
      break;
    }
  }
  return found;
}

/** Слияние оценки в накопитель: реальная оценка важнее «Зачёта» */
function mergeMark(into: Map<string, ExamMark>, mark: ExamMark): void {
  const existing = into.get(mark.code);
  if (!existing) {
    into.set(mark.code, { ...mark });
    return;
  }
  if (existing.grade === null && mark.grade !== null) existing.grade = mark.grade;
  existing.passed = existing.passed || mark.passed;
}

/** Чтение всех отмеченных нормативов строки по карте колонок */
function readRowMarks(
  sheet: GoogleSpreadsheetWorksheet,
  row: number,
  columns: readonly ExamColumn[]
): ExamMark[] {
  const marks: ExamMark[] = [];
  for (const column of columns) {
    let cell: Cell;
    try {
      cell = sheet.getCell(row - 1, column.column);
    } catch {
      continue;
    }
    const parsed = parseExamMark({
      value: cell.value,
      color: cell.backgroundColor,
      title: column.title,
    });
    if (!parsed.passed) continue;
    marks.push({ code: column.code, grade: parsed.grade, passed: true });
  }
  return marks;
}

/** Лист «Запас» (по настройке reserve_sheet_name); null — листа нет */
async function getReserveSheetIfExists(): Promise<GoogleSpreadsheetWorksheet | null> {
  const doc = await getDoc();
  const map = await getSettings();
  const name = (map.get("reserve_sheet_name") || "Запас").trim() || "Запас";
  const sheets = Object.values(doc.sheetsById) as GoogleSpreadsheetWorksheet[];
  return (
    sheets.find((s) => (s.title || "").trim().toLowerCase() === name.toLowerCase()) ?? null
  );
}

/**
 * Загрузка листа «Запас» целиком в нужной ширине.
 *
 * Ширина — до «AF» (конец блока оценок). Снапшот строки подразделения занимает
 * и колонки правее (AH..AJ — служебные), но для чтения оценок они не нужны.
 */
async function loadReserveArea(sheet: GoogleSpreadsheetWorksheet): Promise<number> {
  const bottom = Math.min(RESERVE_LAYOUT.maxScanRow, sheet.rowCount);
  // Сетка листа «Запас» может быть уже блока оценок (свежесозданный лист
  // получает 26 колонок): запрос за границу сетки падает с «Out of bounds»,
  // поэтому правая граница ограничивается фактическим числом колонок.
  const lastCol = Math.min(colIndex(RESERVE_LAYOUT.examEndCol), sheet.columnCount - 1);
  await sheet.loadCells(`${ROW_START_COL}1:${colLetter(lastCol)}${bottom}`);
  return bottom;
}

/**
 * Отметки бойца на листе «Запас».
 *
 * Строка запаса может быть двух видов, и оба встречаются в одной таблице:
 *   * ручная запись по раскладке листа (ФИО в D, оценки I..AF) — читается
 *     шапкой листа (строка 3);
 *   * снапшот строки подразделения (ФИО в C, оценки H..AE у роты / I..AG у
 *     дивизиона) — читается шапкой ПОДРАЗДЕЛЕНИЯ.
 *
 * Вид определяется по колонке, где нашлось ФИО: если имя стоит в C (колонка
 * имени подразделения), строка — снапшот, и колонки берутся по раскладке
 * подразделения; если в D — по шапке листа «Запас».
 */
function readReserveMarks(params: {
  reserveSheet: GoogleSpreadsheetWorksheet;
  layout: UnitLayout;
  unitColumns: readonly ExamColumn[];
  names: readonly string[];
  bottom: number;
}): ExamMark[] {
  const { reserveSheet, layout, unitColumns, names, bottom } = params;
  const reserveFrom = colIndex(RESERVE_LAYOUT.examStartCol);
  const reserveTo = colIndex(RESERVE_LAYOUT.examEndCol);
  const reserveColumns = examColumnsFromHeader(
    reserveSheet,
    RESERVE_LAYOUT.headerRow,
    reserveFrom,
    reserveTo
  );

  const rows = findNamedRows(
    reserveSheet,
    RESERVE_LAYOUT.nameCols,
    names,
    RESERVE_LAYOUT.firstDataRow,
    bottom
  );

  const marks: ExamMark[] = [];
  for (const { row, nameCol } of rows) {
    // C — колонка имени подразделения: строка является снапшотом
    const snapshot = nameCol === colIndex(layout.nameCol);
    const columns = snapshot ? unitColumns : reserveColumns;
    marks.push(...readRowMarks(reserveSheet, row, columns));
  }
  return marks;
}

/**
 * Все отметки бойца с трёх листов, объединённые по названию норматива.
 *
 * Источники и порядок приоритета:
 *   1. основная строка на листе подразделения;
 *   2. блок «Запас | долгий отпуск» на ТОМ ЖЕ листе (у дивизиона строки 44–78);
 *   3. лист «Запас» (ручные записи и снапшоты).
 *
 * Мерж нужен для бойцов, вернувшихся из запаса: их строка на листе
 * подразделения пустая, а сданные нормативы остались в запасе. Без мержа ЛК
 * показывал «не сдано» по всем нормативам.
 */
export async function examMarksFromSheets(params: {
  unit: string;
  /** Кандидаты имени: ФИО, позывной. Steam/Discord в листах не ключ поиска */
  names: readonly string[];
  includeReserve?: boolean;
}): Promise<ExamMark[]> {
  const unit = params.unit.trim();
  const names = params.names.map((n) => (n || "").trim()).filter(Boolean);
  if (!unit || !names.length) return [];

  // Командование Корпуса: все нормативы считаются сданными
  if (isCommandCorps(names)) {
    return examCatalog(unit).exams.map((exam) => ({
      code: exam.code,
      grade: PASS_MARK,
      passed: true,
    }));
  }

  try {
    const sheet = await getSheet(unit);
    const layout = resolveLayout(unit);
    const { start: examFrom, end: examTo } = examReadBounds(layout);

    // Нижняя граница чтения: инфо-блоки и плашки командования исключены
    const readBottom = Math.min(
      layout.overall.bottom,
      layout.infoBlockTop ? layout.infoBlockTop - 1 : layout.overall.bottom
    );
    await loadArea(sheet, layout, layout.overall.top, readBottom);

    const unitColumns = examColumnsFromHeader(sheet, layout.examHeaderRow, examFrom, examTo);
    const nameColumns = [
      ...new Set([
        colIndex(layout.nameCol),
        ...(layout.extraNameCols ?? []).map((c) => colIndex(c)),
        colIndex(layout.nameCol) - 1,
      ]),
    ].filter((c) => c >= 0);

    const rows = findNamedRows(sheet, nameColumns, names, SEARCH_TOP_ROW, readBottom);

    const merged = new Map<string, ExamMark>();
    // Основная строка важнее блока запаса: при конфликте остаётся её оценка
    const sorted = [...rows].sort((a, b) => a.row - b.row);
    for (const { row } of sorted) {
      for (const mark of readRowMarks(sheet, row, unitColumns)) mergeMark(merged, mark);
    }

    if (params.includeReserve !== false) {
      const reserveSheet = await getReserveSheetIfExists();
      if (reserveSheet) {
        const bottom = await loadReserveArea(reserveSheet);
        for (const mark of readReserveMarks({
          reserveSheet,
          layout,
          unitColumns,
          names,
          bottom,
        })) {
          mergeMark(merged, mark);
        }
      }
    }

    return [...merged.values()];
  } catch (e) {
    // Ошибка чтения не должна ронять кабинет: отдаём пустой список, и досье
    // покажет нормативы из одобренных рапортов
    console.warn("[gsheets] Не удалось прочитать оценки бойца с листов:", e);
    return [];
  }
}

/** Итог переноса оценок по одному бойцу */
export type GradeCopyResult = { name: string; row: number | null; copied: number };

/**
 * Перенос найденных в запасе оценок в основные строки бойцов подразделения.
 *
 * Вызывается при синхронизации ШДС: оценки, которые есть только на листе
 * «Запас» (или в блоке запаса того же листа), копируются в пустые ячейки
 * основной строки, и таблица тоже актуализируется — не только личный кабинет.
 *
 * Заполняются ТОЛЬКО пустые ячейки: существующая оценка бойца не перезаписывается
 * (пересдачу вносит экзаменатор, а не синхронизация).
 *
 * Пакетный режим не случаен: лист подразделения и лист «Запас» читаются ОДИН
 * раз на всех бойцов. Иначе каждый боец давал бы два запроса loadCells, и на
 * составе в 40 человек синхронизация упиралась бы в квоту Google (60 чтений в
 * минуту) — перенос оценок перестал бы работать вовсе.
 */
export async function copyReserveGradesForUnit(params: {
  unit: string;
  /** Кандидаты имени каждого бойца: ФИО и позывной */
  members: readonly (readonly string[])[];
}): Promise<{ ok: boolean; copied: number; results: GradeCopyResult[]; error?: string }> {
  const unit = params.unit.trim();
  const memberNames = params.members
    .map((names) => names.map((n) => (n || "").trim()).filter(Boolean))
    .filter((names) => names.length > 0);
  if (!unit || !memberNames.length) {
    return { ok: false, copied: 0, results: [], error: "Не указаны бойцы" };
  }

  try {
    const sheet = await getSheet(unit);
    const layout = resolveLayout(unit);
    const { start: examFrom, end: examTo } = examReadBounds(layout);
    const readBottom = Math.min(
      layout.overall.bottom,
      layout.infoBlockTop ? layout.infoBlockTop - 1 : layout.overall.bottom
    );
    await loadArea(sheet, layout, layout.overall.top, readBottom);

    const unitColumns = examColumnsFromHeader(sheet, layout.examHeaderRow, examFrom, examTo);
    const nameColumns = [
      ...new Set([
        colIndex(layout.nameCol),
        ...(layout.extraNameCols ?? []).map((c) => colIndex(c)),
      ]),
    ].filter((c) => c >= 0);

    // Лист «Запас» читается один раз: дальше поиск идёт по загруженным ячейкам
    const reserveSheet = await getReserveSheetIfExists();
    const reserveBottom = reserveSheet ? await loadReserveArea(reserveSheet) : 0;

    const results: GradeCopyResult[] = [];
    let totalCopied = 0;
    let dirty = false;

    for (const names of memberNames) {
      const label = names[0];

      // Основная строка бойца: первая найденная в таблице участников
      const rows = findNamedRows(sheet, nameColumns, names, layout.overall.top, readBottom);
      const main = rows[0];
      if (!main) {
        results.push({ name: label, row: null, copied: 0 });
        continue;
      }

      // Оценки, уже стоящие в основной строке — их не перезаписываем
      const merged = new Map<string, ExamMark>();
      for (const mark of readRowMarks(sheet, main.row, unitColumns)) mergeMark(merged, mark);
      const before = new Set([...merged.keys()].filter((k) => merged.get(k)?.passed));

      // Источники запаса: блок на том же листе + лист «Запас»
      const reserveMarks: ExamMark[] = [];
      const block = layout.reserveBlock;
      if (block) {
        const blockRows = findNamedRows(sheet, nameColumns, names, block.top, block.bottom);
        for (const { row } of blockRows) {
          reserveMarks.push(...readRowMarks(sheet, row, unitColumns));
        }
      }
      if (reserveSheet) {
        reserveMarks.push(
          ...readReserveMarks({
            reserveSheet,
            layout,
            unitColumns,
            names,
            bottom: reserveBottom,
          })
        );
      }

      const byCode = new Map(reserveMarks.map((m) => [m.code, m]));
      let copied = 0;
      for (const column of unitColumns) {
        if (before.has(column.code)) continue;
        const mark = byCode.get(column.code);
        if (!mark?.passed) continue;
        const cell = sheet.getCell(main.row - 1, column.column);
        // Пустая ячейка = нет ни текста, ни заливки «сдано»
        const empty = !String(cell.value ?? "").trim() && !isExamGreen(cell.backgroundColor);
        if (!empty) continue;
        cell.value = mark.grade && mark.grade !== PASS_MARK ? mark.grade : "";
        cell.backgroundColor = { ...EXAM_GREEN };
        cell.textFormat = { ...SHDS_TEXT_FORMAT };
        copied++;
      }

      if (copied > 0) dirty = true;
      totalCopied += copied;
      results.push({ name: label, row: main.row, copied });
    }

    if (dirty) await sheet.saveUpdatedCells();
    return { ok: true, copied: totalCopied, results };
  } catch (e) {
    console.warn("[gsheets] Не удалось перенести оценки из запаса:", e);
    return {
      ok: false,
      copied: 0,
      results: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Одиночный перенос оценок из запаса (обёртка над пакетной версией).
 *
 * Нужен там, где боец один: сценарий бота и проверка из панели. Пакетная
 * функция читает листы один раз, поэтому одиночный вызов не делает лишних
 * запросов к Google — это тот же код, а не копия.
 */
export async function copyReserveGradesToUnitRow(params: {
  unit: string;
  names: readonly string[];
}): Promise<{ ok: boolean; copied: number; row: number | null; error?: string }> {
  const batch = await copyReserveGradesForUnit({
    unit: params.unit,
    members: [params.names],
  });
  const first = batch.results[0];
  return {
    ok: batch.ok,
    copied: batch.copied,
    row: first ? first.row : null,
    ...(batch.error ? { error: batch.error } : {}),
  };
}

/**
 * Блоки «Вакант» для автоматической записи отсутствующих бойцов.
 *
 * Значения — границы блока ЛОГИСТОВ (рота 31–47) и НАВОДЧИКОВ дивизиона
 * (18–22): это последний резерв, если должность бойца из БД не сопоставилась
 * ни с одной секцией VACANT_SECTIONS. Обычно же боец встаёт в «Вакант» СВОЕЙ
 * секции — см. vacantFillRange().
 *
 * Через addRange это делать нельзя: у роты addRange — блок логистов (31–47),
 * и зачисление туда мехвода или наводчика поставило бы его не в своё
 * отделение.
 */
export const VACANT_FILL_RANGES: Record<"TR" | "AD", { top: number; bottom: number }> = {
  TR: { top: 31, bottom: 47 },
  AD: { top: 18, bottom: 22 },
};

/** Боец из БД, которого нужно проверить в таблице */
export type ShdsRosterEntry = {
  name: string;
  unit: string;
  rank?: string | null;
  post?: string | null;
  /** Позывной или ФИО — второй вариант написания имени */
  aliases?: readonly string[];
  steamId?: string | null;
  discordId?: string | null;
};

/**
 * Автозапись отсутствующих бойцов в свободные строки «Вакант».
 *
 * Что делает: для каждого бойца проверяет, есть ли его строка на листе
 * подразделения; если нет — вписывает в первую «Вакант» СВОЕЙ СЕКЦИИ
 * (звание, ФИО, должность, Steam/Discord) и заливает имя зелёным, как «боец в
 * строю». Секция определяется по должности бойца из БД: у роты это КБМ,
 * наводчики, мехводы и логисты, у дивизиона — командиры отделений, 1-е и 2-е
 * отделение огневого взвода и отделение снабжения. Только если должность не
 * распознана, берётся диапазон по умолчанию (VACANT_FILL_RANGES).
 *
 * Уже существующие строки не трогаются, поэтому повторный запуск
 * синхронизации ничего не дублирует.
 */
export async function ensureMembersInShds(
  entries: readonly ShdsRosterEntry[]
): Promise<{ added: string[]; skipped: string[]; warnings: string[]; rows: Record<string, number> }> {
  const added: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const rows: Record<string, number> = {};

  // Бойцы с листа «Командование АТК» — вписываться в «Вакант» не должны даже
  // при несовпадении ФИО со списком: лист читается один раз на весь проход
  const commandNames = await commandSheetNames();

  // Группировка по листу: область читается ОДИН раз на подразделение, а не на
  // бойца. Иначе каждый боец давал бы свой запрос loadCells и состав упирался
  // бы в квоту Google (60 чтений в минуту) — синхронизация падала бы целиком.
  const byUnit = new Map<string, ShdsRosterEntry[]>();
  for (const entry of entries) {
    const unit = String(entry.unit ?? "").trim();
    if (!unit) {
      warnings.push(`${entry.name}: не назначено подразделение`);
      continue;
    }
    const list = byUnit.get(unit) ?? [];
    list.push(entry);
    byUnit.set(unit, list);
  }

  for (const [unit, group] of byUnit) {
    let layout: UnitLayout;
    try {
      layout = resolveLayout(unit);
    } catch (e) {
      for (const entry of group) {
        skipped.push(entry.name);
        warnings.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }

    try {
      const sheet = await getSheet(unit);
      const range = VACANT_FILL_RANGES[layout.key];
      const readBottom = Math.min(
        layout.overall.bottom,
        layout.infoBlockTop ? layout.infoBlockTop - 1 : layout.overall.bottom
      );
      // Читаем с ПЕРВОЙ строки: командиры подразделений стоят в строках 7–8
      // (рота) и 9–10 (дивизион), то есть ВЫШЕ overall.top. Обрезка по
      // range.top делала их «отсутствующими на листе», и автозапись создавала
      // дубль в «Вакант».
      await loadArea(sheet, layout, range.top, readBottom);

      const nameColumn = colIndex(layout.nameCol);
      const nameColumns = [
        ...new Set([nameColumn, ...(layout.extraNameCols ?? []).map((c) => colIndex(c))]),
      ].filter((c) => c >= 0);

      // Занятые строки ведём в памяти: после записи значение в ячейке меняется,
      // но перечитывать лист на каждого бойца нельзя (квота). Без этого учёта
      // все отсутствующие бойцы встали бы в ОДНУ первую строку «Вакант».
      const takenRows = new Set<number>();
      let dirty = false;

      for (const entry of group) {
        const names = [entry.name, ...(entry.aliases ?? [])].filter(Boolean);

        /**
         * ЖЁСТКИЙ ФИЛЬТР КОМАНДОВАНИЯ.
         *
         * Командование Корпуса (Волков Д.В., Иванов И.А., Иванов К.М.) живёт на
         * отдельном листе «Командование АТК», а командиры и замы подразделений
         * стоят в самом верху своих листов (ТР — 7–8, АД — 9–10). Ни один из
         * них не должен попадать на строку «Вакант»: это создало бы второго
         * человека с тем же ФИО, а настоящая плашка осталась бы выше.
         *
         * Проверка стоит ДО поиска существующей строки намеренно: даже если
         * боец почему-то не нашёлся (лист переименован, ФИО записано иначе),
         * запись в «Вакант» всё равно не произойдёт.
         */
        if (
          isSheetCommandMember(names, layout.key, entry.post) ||
          matchesCommandRoster(names, commandNames)
        ) {
          const found = findNamedRows(sheet, nameColumns, names, SEARCH_TOP_ROW, readBottom);
          if (found.length) rows[entry.name] = found[0].row;
          skipped.push(entry.name);
          warnings.push(
            `${entry.name}: командование не вписывается в строки «Вакант» ` +
              `(у командования Корпуса лист «Командование АТК», командиры подразделений ` +
              `стоят вверху листа ${UNIT_COMMAND_ROWS[layout.key].top}–${UNIT_COMMAND_ROWS[layout.key].bottom})`
          );
          continue;
        }

        // Боец уже есть на листе (в любом блоке) — вписывать не нужно
        const existing = findNamedRows(sheet, nameColumns, names, SEARCH_TOP_ROW, readBottom);
        if (existing.length) {
          skipped.push(entry.name);
          rows[entry.name] = existing[0].row;
          continue;
        }

        /**
         * Секция бойца — по его должности из БД. Должность из БД может быть с
         * припиской «/резерв», поэтому сопоставление идёт по «очищенному»
         * тексту, а в колонку пишется РЕАЛЬНАЯ должность секции.
         */
        const entryPost = sanitizeSheetPost(entry.post);
        const section = findVacantSection(layout, entryPost);
        const targetRange = section ? vacantFillRange(section) : range;

        // Первая «Вакант» СВОЕЙ секции, ещё не занятая в этом проходе.
        // Нижняя граница ограничена SECTION_FILL_MAX: строки 43+ дивизиона —
        // блок «Запас | долгий отпуск», активного бойца туда не пишем.
        const fillBottom = Math.min(targetRange.bottom, SECTION_FILL_MAX[layout.key]);
        let target: number | null = null;
        for (let row = targetRange.top; row <= fillBottom; row++) {
          if (takenRows.has(row)) continue;
          if (isVacant(cellAt(sheet, row, layout.nameCol).value)) {
            target = row;
            break;
          }
        }
        if (!target) {
          skipped.push(entry.name);
          warnings.push(
            `${entry.name}: нет свободных строк «Вакант» ` +
              `(${targetRange.top}–${fillBottom} листа «${sheet.title}»` +
              (section ? `, секция «${section.title}»` : "") +
              `)`
          );
          continue;
        }

        writeSoldierRow(sheet, layout, target, {
          rank: entry.rank ?? null,
          name: entry.name,
          // Должность секции важнее текста из БД: у бойца с «/резерв» и у
          // бойца без должности ячейка обязана получить реальную должность
          post: section?.post || entryPost || defaultPostFor(layout, target),
          steamId: entry.steamId ?? null,
          discordId: entry.discordId ?? null,
        });
        takenRows.add(target);
        added.push(entry.name);
        rows[entry.name] = target;
        dirty = true;
      }

      // Значения сохраняются один раз на лист, затем оформляются строки:
      // applyRowFormat шлёт batchUpdate и требует уже сохранённых значений
      if (dirty) {
        await sheet.saveUpdatedCells();
        for (const row of takenRows) {
          await applyRowFormat(sheet, layout, row, {
            nameCol: layout.nameCol,
            nameFill: NAME_GREEN,
            examGreenColumns: [],
          });
        }
      }
    } catch (e) {
      for (const entry of group) {
        if (added.includes(entry.name)) continue;
        skipped.push(entry.name);
        warnings.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { added, skipped, warnings, rows };
}

/* ------------------------------------------------------------------ */
/* Чтение сданных нормативов бойца со листа                            */
/* ------------------------------------------------------------------ */

/**
 * Сданные нормативы бойца по состоянию листа ШДС.
 *
 * Читается закраска колонок блока оценок ЭТОГО листа (H..AE у роты, I..AG у
 * дивизиона): зелёная заливка ячейки — это и есть отметка «сдал». Заголовки
 * берутся из строки шапки (examHeaderRow), а столбец норматива — по позиции
 * заголовка в шапке: список названий и список колонок идут от одной и той же
 * границы, поэтому оценка не может «съехать» на соседний норматив.
 *
 * Зачем это нужно в панели, а не только в боте: требование ступени при переводе
 * по должности проверяется по СДАННЫМ нормативам, а отметка могла появиться
 * правкой таблицы, без рапорта через панель. Смотри мы только рапорты — боец с
 * реально закрашенными экзаменами получал бы отказ «не сданы».
 *
 * Ошибка чтения не считается отказом перевода: возвращается пустой список, и
 * проверка требований идёт по истории рапортов. Иначе недоступный Google API
 * блокировал бы работу штаба целиком.
 */
export async function examsFromSheet(params: {
  unit: string;
  /** Кандидаты имени в таблице (позывной и ФИО) */
  names: readonly string[];
}): Promise<string[]> {
  const unit = params.unit.trim();
  const names = params.names.map((n) => (n || "").trim()).filter(Boolean);
  if (!unit || !names.length) return [];

  try {
    // Читается по ТРЁМ источникам и мержится по названию норматива:
    // основная строка листа, блок «Запас» на том же листе и лист «Запас».
    // Это и есть причина, по которой боец, вернувшийся из запаса, видел свои
    // оценки: на основной строке ячейки пустые, а нормативы лежат в запасе.
    const marks = await examMarksFromSheets({ unit, names });
    return marks.map((mark) => mark.code);
  } catch (e) {
    console.warn("[gsheets] Не удалось прочитать сданные нормативы с листа:", e);
    return [];
  }
}

/**
 * Зелёная заливка ячейки.
 *
 * Сравнивается не «точное равенство цвета», а доминирование зелёного канала:
 * в таблице встречаются оттенки одного и того же зачёта (светло-зелёный от
 * условного форматирования, зелёный EXAM_GREEN), и строгое сравнение пропускало
 * бы половину отметок.
 */
function isExamGreen(color: CellColor | undefined | null): boolean {
  if (!color) return false;
  const { red = 0, green = 0, blue = 0 } = color;
  return green > 0.5 && green - red > 0.15 && green - blue > 0.15;
}