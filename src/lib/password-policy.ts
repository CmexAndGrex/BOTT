/**
 * Политика паролей панели.
 *
 * Раньше требования ограничивались `minLength=5` в форме, то есть сервер
 * принимал пароль «12345». Учитывая, что через панель выдаются роли Discord
 * и меняются настройки бота, здесь — единая проверка для всех точек входа
 * (создание аккаунта, смена пароля, seed-admin).
 */

/** Минимальная длина пароля */
export const PASSWORD_MIN_LENGTH = 10;
/** Разумный верхний предел: bcrypt обрезает вход на 72 байтах */
export const PASSWORD_MAX_LENGTH = 72;

/** Частые пароли/шаблоны, которые нельзя использовать */
const WEAK_PASSWORDS = new Set([
  "password", "password1", "passw0rd", "пароль", "пароль123",
  "qwerty", "qwerty123", "qwertyuiop", "1234567890", "12345678",
  "admin", "admin123", "adminadmin", "administrator", "admin-password",
  "letmein", "welcome", "changeme", "iloveyou", "monkey", "dragon",
  "11111111", "00000000", "87654321", "abc12345", "asdfghjkl",
]);

/**
 * «Основы» слабых паролей. Проверяются отдельно от полного совпадения, чтобы
 * отсекать косметические вариации вида «Пароль12345!» или «Qwerty_2026»:
 * цифры и знаки не делают такое слово надёжнее.
 */
const WEAK_BASES = [
  "password", "passwd", "пароль", "qwerty", "qwert", "admin",
  "letmein", "welcome", "changeme", "iloveyou", "monkey", "dragon",
  "abc123", "asdf", "secret", "root", "test", "guest",
];

export type PasswordCheck = { ok: true } | { ok: false; error: string };

/**
 * Проверяет пароль по политике. Возвращает понятную причину отказа —
 * она показывается администратору в панели.
 */
export function checkPasswordPolicy(password: unknown): PasswordCheck {
  if (typeof password !== "string" || !password) {
    return { ok: false, error: "Пароль не задан" };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `Пароль слишком короткий: минимум ${PASSWORD_MIN_LENGTH} символов`,
    };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      error: `Пароль слишком длинный: максимум ${PASSWORD_MAX_LENGTH} символов`,
    };
  }
  const lower = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) {
    return { ok: false, error: "Такой пароль слишком распространён — выберите другой" };
  }
  // «Основу» проверяем отдельно: «пароль12345» или «qwerty!2026» — это то же
  // самое слабое слово с косметической добавкой цифр/знаков.
  const base = lower.replace(/[^a-zа-яё]/g, "");
  if (base.length >= 4 && WEAK_BASES.some((w) => base.startsWith(w) || base === w)) {
    return {
      ok: false,
      error: "Пароль построен на распространённом слове — выберите другой",
    };
  }
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, error: "Пароль не должен состоять из одного повторяющегося символа" };
  }
  // Требуем смешанный состав: минимум две группы из четырёх
  const groups =
    Number(/[a-zа-яё]/.test(password)) +
    Number(/[A-ZА-ЯЁ]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^\wа-яёА-ЯЁ]/.test(password));
  if (groups < 2) {
    return {
      ok: false,
      error: "Пароль должен содержать минимум два вида символов: строчные, прописные, цифры или знаки",
    };
  }
  if (/^(?:19|20)\d{2}\d{2}\d{2}$/.test(password)) {
    return { ok: false, error: "Пароль не должен быть датой" };
  }
  return { ok: true };
}

/** Требования к паролю — для подсказки в интерфейсе */
export const PASSWORD_POLICY_HINT =
  `Минимум ${PASSWORD_MIN_LENGTH} символов, минимум два вида символов ` +
  `(строчные/прописные/цифры/знаки), без распространённых паролей и дат.`;