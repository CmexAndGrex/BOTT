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
const EXAMPLE_SECRET = "your_random_jwt_secret_here";

export function getJwtSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const secret = process.env.JWT_SECRET || "";

  if (process.env.NODE_ENV === "production") {
    if (!secret || secret === KNOWN_DEFAULT || secret === EXAMPLE_SECRET) {
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