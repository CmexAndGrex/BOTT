/**
 * Адреса аватарок Discord.
 *
 * Модуль чистый (без БД, Next.js и React), поэтому одинаково используется и на
 * сервере, и в компонентах, и проверяется тестами напрямую.
 *
 * Почему это отдельный модуль, а не строка в месте рендера:
 *   * Discord CDN отдаёт 403 Forbidden, если браузер присылает Referer с чужого
 *     сайта. Поэтому КАЖДЫЙ <img> с аватаркой обязан иметь
 *     referrerPolicy="no-referrer" — иначе картинка «ломается» молча;
 *   * формат адреса зависит от того, что известно про бойца (есть ли хеш
 *     аватарки), и собирать его в трёх компонентах по-разному — гарантированный
 *     рассинхрон;
 *   * дефолтная аватарка Discord вычисляется из Discord ID по алгоритму самого
 *     Discord (индекс палитры), и повторить его «на глаз» нельзя.
 */

/** Хосты, с которых разрешено грузить аватарки (см. next.config.ts и CSP) */
export const DISCORD_IMAGE_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"] as const;

/**
 * Сколько дефолтных аватарок у Discord (индексы 0..5).
 *
 * BigInt-литералы (`6n`) в проекте недоступны: tsconfig.target = ES2017, и
 * компилятор запрещает синтаксис новее цели. Конструктор BigInt(6) работает
 * при любой цели и даёт тот же тип.
 */
const DEFAULT_AVATAR_COUNT = BigInt(6);

/** Сдвиг snowflake для индекса дефолтной аватарки Discord (22 бита) */
const SNOWFLAKE_SHIFT = BigInt(22);

/**
 * Discord ID — только цифры. Проверяем строкой, а не через BigInt: BigInt
 * бросает исключение на мусоре, и падение рендера карточки недопустимо.
 */
function digitsOnly(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) ? raw : "";
}

/**
 * Хеш аватарки Discord: hex-строка (в новых аккаунтах встречается префикс
 * `a_` — анимированный аватар). Ничего другого в URL подставлять нельзя:
 * значение уходит в разметку страницы.
 */
function safeAvatarHash(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  return /^(a_)?[0-9a-f]+$/i.test(raw) ? raw : "";
}

/**
 * Адрес аватарки по Discord ID и хешу.
 *
 * Порядок:
 *   1. есть ID и хеш → картинка пользователя;
 *   2. есть только ID → дефолтная аватарка Discord (индекс из старших битов ID);
 *   3. нет ID → null: вызывающий рисует локальную заглушку с инициалами.
 *
 * `size` — степень двойки от 16 до 4096 (ограничение Discord). Неверное
 * значение заменяется на 128, чтобы CDN не ответил 400.
 */
export function getDiscordAvatarUrl(
  discordId?: string | null,
  avatarHash?: string | null,
  size = 128
): string | null {
  const id = digitsOnly(discordId);
  if (!id) return null;

  const pixels = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096].includes(size) ? size : 128;
  const hash = safeAvatarHash(avatarHash);
  if (hash) {
    return `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=${pixels}`;
  }

  /*
   * Дефолтная аватарка Discord: индекс палитры — (id >> 22) % 6.
   * Сдвиг и остаток считаем в BigInt: snowflake не влезает в Number без
   * потери точности, и `Number(id) >> 22` дал бы другую картинку.
   */
  try {
    const index = Number((BigInt(id) >> SNOWFLAKE_SHIFT) % DEFAULT_AVATAR_COUNT);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  } catch {
    // Огромная строка цифр не влезла в BigInt — считаем, что ID некорректен
    return null;
  }
}

/**
 * Хеш аватарки из уже сохранённого адреса Discord CDN.
 *
 * В БД (`division_members.avatar_url`) лежит готовый URL, записанный при входе
 * через Discord. Хеш из него нужен, чтобы пересобрать адрес нужного размера —
 * иначе в шапке досье грузился бы исходный (крупный) файл.
 */
export function avatarHashFromUrl(url: string | null | undefined): string | null {
  /**
   * Хеш берём ИЗ РЕГУЛЯРНОГО ВЫРАЖЕНИЯ, а не из последнего сегмента пути.
   *
   * В БД адрес лежит вместе с параметрами (`...png?size=4096`), и `split("/")`
   * оставлял query в «хеше» — собранный из него новый адрес был битым
   * (`.../abdcef.png?size=4096.png?size=128`). Группа 2 — сам хеш.
   */
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/\/avatars\/\d+\/((?:a_)?[0-9a-f]+)\.(?:png|webp|gif|jpg|jpeg)/i);
  const hash = match?.[1] || "";
  return safeAvatarHash(hash) || null;
}

/**
 * Итоговый адрес для <img>.
 *
 * `storedUrl` — то, что пришло из БД; `discordId` — запасной источник, когда
 * адрес не сохранён (например, боец ни разу не входил после привязки).
 * Приоритет у сохранённого адреса: он указывает на актуальный аватар, тогда как
 * дефолтная картинка по ID — лишь заглушка.
 */
export function resolveAvatarUrl(
  storedUrl: string | null | undefined,
  discordId?: string | null,
  size = 128
): string | null {
  const id = digitsOnly(discordId);
  const hash = avatarHashFromUrl(storedUrl);
  if (id && hash) return getDiscordAvatarUrl(id, hash, size);

  const stored = String(storedUrl ?? "").trim();
  if (stored) return stored;

  return getDiscordAvatarUrl(id, null, size);
}

/** Атрибуты <img> для аватарки: без Referer Discord CDN отвечает 200, а не 403 */
export const DISCORD_IMG_PROPS = {
  referrerPolicy: "no-referrer",
  loading: "lazy",
  decoding: "async",
} as const;

/**
 * Инициалы для локальной заглушки: «Иванов И. А.» → «ИИ».
 * Пустое имя даёт «?», чтобы квадрат не оставался пустым.
 */
export function avatarInitials(name: string | null | undefined): string {
  const initials = String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "?";
}
