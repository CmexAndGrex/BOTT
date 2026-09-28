/**
 * Учётные записи для локальной разработки («Dev Login»).
 *
 * Зачем отдельный модуль, а не константы в роуте: те же описания нужны
 * странице входа (подписи кнопок), CLI-сиду и тестам, а роут должен остаться
 * тонким. Чистые правила (кто доступен, какие звания/подразделения допустимы)
 * живут здесь и проверяются без базы.
 *
 * Безопасность: набор НИКОГДА не активен в production — это проверяет
 * isDevLoginEnabled(), и её же вызывает роут. Отдельный список, а не «любой
 * боец из базы», потому что иначе кнопка стала бы способом войти под чужим
 * аккаунтом на стенде, где лежит копия боевой базы.
 *
 * Почему звания и подразделения выписаны здесь, а не импортированы из
 * recruits.ts: этот модуль читает и CLI-сид (scripts/dev-seed.ts), который
 * исполняется обычным Node без сборки Next, где алиас «@/lib/...» не
 * резолвится — тот же вынужденный приём, что в scripts/bootstrap-admin.ts.
 * Копия не разойдётся: tests/dev-login.test.ts сверяет оба списка с боевыми
 * RANKS/UNITS (приём уже принят в проекте для политики паролей).
 */
export const DEV_RANKS = [
  "Курсант",
  "Рядовой",
  "Ефрейтор",
  "Мл. Сержант",
  "Сержант",
  "Ст. Сержант",
  "Старшина",
  "Прапорщик",
  "Ст. Прапорщик",
  "Лейтенант",
  "Ст. Лейтенант",
  "Капитан",
  "Майор",
  "Подполковник",
  "Полковник",
] as const;

/** Подразделения: совпадают с UNITS в recruits.ts и именами листов ШДС */
export const DEV_UNITS = ["Танковая рота", "Артиллерийский дивизион"] as const;

export type DevRank = (typeof DEV_RANKS)[number];
export type DevUnit = (typeof DEV_UNITS)[number];
export type DevMemberRole = "recruit" | "member" | "officer" | "admin";

/** Ключ кнопки: он же — значение ?as= в запросе */
export type DevAccountKey = "commander" | "tank" | "artillery";

export type DevAccount = {
  key: DevAccountKey;
  /** Позывной: он же логин бойца и уникальный ключ записи в division_members */
  callsign: string;
  /** ФИО для карточки личного дела */
  name: string;
  rank: DevRank;
  unit: DevUnit;
  post: string;
  /** Роль в пространстве бойца */
  role: DevMemberRole;
  /** Роль в пространстве панели: нужна командиру для доступа к панели */
  panelRole: "admin" | "officer" | null;
  /** Подпись кнопки на форме входа */
  label: string;
  /** Короткое пояснение под кнопкой */
  hint: string;
};

/**
 * Три роли из ТЗ. У командира роль admin сразу в обоих пространствах: он
 * заходит и в панель, и в личный кабинет — это и есть требование «полный
 * доступ к панели и к досье».
 */
export const DEV_ACCOUNTS: readonly DevAccount[] = [
  {
    key: "commander",
    callsign: "Волков",
    name: "Волков Д. В.",
    rank: "Полковник",
    unit: "Танковая рота",
    post: "Командир подразделения",
    role: "admin",
    panelRole: "admin",
    label: "Войти как Волков Д. В. (Командир)",
    hint: "Полный доступ: панель управления и личный кабинет",
  },
  {
    key: "tank",
    callsign: "Сокол",
    name: "Сокол А. В.",
    rank: "Рядовой",
    unit: "Танковая рота",
    post: "Механик-водитель",
    role: "member",
    panelRole: null,
    label: "Войти как боец Танковой роты",
    hint: "Допуск к технике по званию, без прав штаба",
  },
  {
    key: "artillery",
    callsign: "Буря",
    name: "Буря И. С.",
    rank: "Ефрейтор",
    unit: "Артиллерийский дивизион",
    post: "Наводчик",
    role: "member",
    panelRole: null,
    label: "Войти как наводчик Артдивизиона",
    hint: "Артиллерия открывается по нормативам ШДС",
  },
];

/**
 * Доступен ли Dev Login.
 *
 * Только вне production. Проверка по NODE_ENV, а не по «localhost в адресе»:
 * адрес подставляется заголовком Host, и решение по нему открыло бы боевой
 * вход кому угодно, кто подделает заголовок.
 */
export function isDevLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production";
}

/** Учётная запись по ключу кнопки; null — ключа нет в списке */
export function findDevAccount(key: unknown): DevAccount | null {
  if (typeof key !== "string") return null;
  return DEV_ACCOUNTS.find((account) => account.key === key) ?? null;
}

/**
 * Пароль dev-командира в панели.
 *
 * Политика проекта запрещает «admin123» (WEAK_PASSWORDS в password-policy.ts),
 * поэтому по умолчанию берётся значение, проходящее политику. Свой пароль
 * можно задать DEV_ADMIN_PASSWORD — он тоже проверяется политикой вызывающим
 * кодом, чтобы дефолт не «уехал» в стенд с боевыми данными.
 */
export const DEV_ADMIN_PASSWORD_DEFAULT = "DevLocal-2026!x";

/** Логин dev-командира в панели (отдельно от позывного бойца) */
export const DEV_PANEL_USERNAME = "dev-commander";