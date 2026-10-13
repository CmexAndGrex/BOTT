/**
 * Единая точка получения секрета для JWT-подписей.
 *
 * В продакшене секрет обязан быть задан и отличаться от известных из
 * репозитория значений («temp-secret-key», заглушка из .env.example) — иначе
 * любой сможет подписать токен с ролью admin. Короткий секрет допускается
 * (работа не ломается), но сопровождается предупреждением о необходимости
 * усилить его до 32+ символов.
 */
let cachedSecret: Uint8Array | null = null;

const KNOWN_DEFAULT = "temp-secret-key";

/**
 * Значения-заглушки, встречающиеся в репозитории: они известны всем, кто видит
 * исходники, и подпись таким секретом позволяет выпустить токен с ролью admin.
 * Список ведётся массивом, а не отдельными константами: раньше сюда попадало
 * только «your_random_jwt_secret_here», и заглушка из .env.example проходила
 * проверку продакшена.
 */
const KNOWN_DEFAULTS: readonly string[] = [
  KNOWN_DEFAULT,
  "your_random_jwt_secret_here",
  "replace_me_with_a_random_secret_of_at_least_32_characters",
];

export function getJwtSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const secret = process.env.JWT_SECRET || "";

  if (process.env.NODE_ENV === "production") {
    if (!secret || KNOWN_DEFAULTS.includes(secret)) {
      throw new Error(
        "JWT_SECRET не задан или равен значению по умолчанию. Задайте свой случайный секрет (рекомендуется 32+ символов) в .env / docker-compose и перезапустите приложение."
      );
    }
    if (secret.length < 32) {
      console.warn(
        "[auth] JWT_SECRET короче 32 символов — рекомендуется усилить его до 32+ символов."
      );
    }
  } else if (!secret) {
    // Только для локальной разработки, наружу уходить не должен.
    console.warn(
      "[auth] JWT_SECRET не задан — использую небезопасный dev-секрет. Не разворачивайте так на проде."
    );
    cachedSecret = new TextEncoder().encode(KNOWN_DEFAULT);
    return cachedSecret;
  }

  cachedSecret = new TextEncoder().encode(secret || KNOWN_DEFAULT);
  return cachedSecret;
}