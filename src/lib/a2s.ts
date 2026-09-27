/**
 * Steam A2S Query — «Кто на ВЧ»: живой список бойцов на сервере Arma 3.
 *
 * Зачем свой запрос, а не RCON/бот: у подразделения нет плагина на сервере, а
 * протокол A2S отдаёт список игроков любому, кто знает адрес и порт запроса.
 * Зависимостей не добавляем: пакет — это заголовок и несколько полей, а
 * `node:dgram` есть в стандартной библиотеке.
 *
 * Модуль разделён на две части намеренно:
 *   * ЧИСТЫЕ функции (buildInfoQuery, buildPlayerQuery, parseInfoResponse,
 *     parsePlayerResponse, stripClanTag, matchPlayersToMembers) не трогают сеть —
 *     их проверяют тесты на реальных байтовых ответах, без поднятого сервера;
 *   * queryServer() собирает всё вместе: UDP-обмен с таймаутом и кэш.
 * Так ошибка в разборе буфера (например, сдвиг на байт из-за кириллицы в нике)
 * видна в тесте, а не только «в бою» на живом сервере.
 *
 * Кэш 60 секунд: каждый заход бойца в кабинет — это запрос к серверу, а A2S по
 * UDP легко превратить в флуд, который Valve расценивает как атаку (сервер
 * начинает молча игнорировать запросы). Кэш держит один запрос в минуту.
 */
import dgram from "node:dgram";

/* ------------------------------------------------------------------ */
/* Константы протокола                                                 */
/* ------------------------------------------------------------------ */

/** Порт запроса Arma 3 по умолчанию (игровой 2302 + 1) */
export const DEFAULT_QUERY_PORT = 2303;

/** Таймаут ответа: сервер молчит почти всегда, когда выключен */
export const QUERY_TIMEOUT_MS = 3000;

/** TTL кэша: один UDP-запрос на подразделение в минуту */
export const CACHE_TTL_MS = 60_000;

/** Сигнатуры пакетов (первый байт после заголовка 0xFFFFFFFF) */
const A2S_INFO_REQUEST = 0x54; // 'T'
const A2S_PLAYER_REQUEST = 0x55; // 'U'
const A2S_INFO_RESPONSE = 0x49; // 'I'
const A2S_PLAYER_RESPONSE = 0x44; // 'D'
const A2S_CHALLENGE_RESPONSE = 0x41; // 'A'

/** Тело запроса A2S_INFO: строка движка, завершённая нулём */
const INFO_PAYLOAD = "Source Engine Query\0";

/* ------------------------------------------------------------------ */
/* Конфигурация                                                        */
/* ------------------------------------------------------------------ */

export type A2SConfig = {
  host: string;
  port: number;
};

/**
 * Разбор номера порта из окружения.
 *
 * Возвращает null, если значения нет или оно бессмысленно («abc», 0, -5, 99999):
 * тогда вызывающий сам решает, что подставить. Так «мусор в настройке» не
 * превращается в запрос по случайному адресу.
 */
function parsePort(raw: string | undefined): number | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

/**
 * Адрес сервера из окружения.
 *
 * `ARMA3_SERVER_HOST` — IP или домен, `ARMA3_SERVER_QUERY_PORT` — порт запроса
 * (по умолчанию 2303). Если порт запроса не задан, но указан игровой
 * `ARMA3_SERVER_PORT`, порт запроса выводится из него: в Arma 3 это всегда
 * следующий номер (2302 → 2303), и заставлять администратора писать одно и то
 * же число дважды смысла нет.
 *
 * Если адрес не задан, запрос не выполняется вовсе: молча ходить «в localhost»
 * хуже, чем честно показать «сервер не настроен» — иначе виджет показывал бы
 * чужие данные с чужого сервера.
 */
export function a2sConfig(env: NodeJS.ProcessEnv = process.env): A2SConfig | null {
  const host = (env.ARMA3_SERVER_HOST || "").trim();
  if (!host) return null;

  const explicitQuery = parsePort(env.ARMA3_SERVER_QUERY_PORT);
  if (explicitQuery !== null) return { host, port: explicitQuery };

  // Порт запроса не задан или испорчен: пробуем вывести из игрового порта.
  const gamePort = parsePort(env.ARMA3_SERVER_PORT);
  const derived = gamePort !== null && gamePort < 65535 ? gamePort + 1 : null;

  return { host, port: derived ?? DEFAULT_QUERY_PORT };
}

/* ------------------------------------------------------------------ */
/* Чистая часть: формирование и разбор пакетов                         */
/* ------------------------------------------------------------------ */

/** Запрос A2S_INFO: заголовок 0xFFFFFFFF, тип 'T', строка движка */
export function buildInfoQuery(): Buffer {
  const payload = Buffer.from(INFO_PAYLOAD, "latin1");
  const buffer = Buffer.alloc(4 + 1 + payload.length);
  buffer.writeInt32LE(-1, 0); // 0xFFFFFFFF — «простой» заголовок без разбиения
  buffer.writeUInt8(A2S_INFO_REQUEST, 4);
  payload.copy(buffer, 5);
  return buffer;
}

/**
 * Запрос A2S_PLAYER.
 *
 * После типа идёт 4-байтовый «challenge» — число, которое сервер выдал в ответе
 * на A2S_INFO. Вызывающий передаёт сюда то, что пришло в поле challenge;
 * 0xFFFFFFFF означает «выдай challenge заново», и сервер ответит повторно.
 *
 * По умолчанию передаётся именно 0xFFFFFFFF: 0 — это «challenge не известен»
 * (сервер его не сообщил), а не валидное значение, и запрос с нулём часть
 * движков молча игнорирует.
 */
export function buildPlayerQuery(challenge = -1): Buffer {
  const buffer = Buffer.alloc(9);
  buffer.writeInt32LE(-1, 0);
  buffer.writeUInt8(A2S_PLAYER_REQUEST, 4);
  buffer.writeInt32LE(challenge | 0, 5);
  return buffer;
}

/** Информация о сервере (нужное подмножество для виджета «На ВЧ») */
export type ServerInfo = {
  name: string;
  map: string;
  players: number;
  maxPlayers: number;
  /** «challenge» для следующего запроса списка игроков */
  challenge: number;
};

/**
 * Тип ответа по первому байту после заголовка.
 *
 * Иногда сервер отвечает на A2S_INFO пакетом A2S_INFO (0x49), иногда — вызовом
 * challenge (0x41, 'A'); последний тоже принимаем: именно из него берётся
 * challenge для запроса списка игроков.
 */
export function readResponseKind(buffer: Buffer): "info" | "player" | "challenge" | "unknown" {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return "unknown";
  const kind = buffer.readUInt8(4);
  if (kind === A2S_INFO_RESPONSE) return "info";
  if (kind === A2S_PLAYER_RESPONSE) return "player";
  if (kind === A2S_CHALLENGE_RESPONSE) return "challenge";
  return "unknown";
}

/** Чтение строки с завершающим нулём; возвращает текст и позицию после нуля */
function readCString(buffer: Buffer, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end++;
  // Кириллица в названии сервера, карте и никах: читаем как UTF-8 — моды и
  // миссии Arma 3 почти всегда UTF-8, а latin1 превратил бы «ВЧ» в мусор.
  const value = buffer.toString("utf8", offset, end);
  return { value, next: end + 1 };
}

/**
 * Разбор ответа A2S_INFO.
 *
 * Порядок полей протокола: заголовок(4) тип(1) protocol(1) name map folder game
 * appid(2) players(1) maxPlayers(1) bots(1) serverType(1) environment(1)
 * visibility(1) vac(1). Далее у движков после 2008 года идёт challenge(int32).
 */
export function parseInfoResponse(buffer: Buffer): ServerInfo | null {
  if (readResponseKind(buffer) !== "info") return null;

  try {
    let offset = 5;
    offset += 1; // protocol

    const name = readCString(buffer, offset);
    offset = name.next;
    const map = readCString(buffer, offset);
    offset = map.next;
    const folder = readCString(buffer, offset);
    offset = folder.next;
    const game = readCString(buffer, offset);
    offset = game.next;

    offset += 2; // appid (STEAM_APPID)
    const players = buffer.readUInt8(offset);
    const maxPlayers = buffer.readUInt8(offset + 1);

    // challenge: сразу после аппаратных полей ответа. От players идут
    // players(1) maxPlayers(1) bots(1) serverType(1) environment(1)
    // visibility(1) vac(1) — семь байт, поэтому challenge лежит по offset+7.
    // Прежний сдвиг на 9 отсчитывался от списка из пяти полей и уводил чтение
    // на два байта вперёд: challenge не читался вовсе, и запрос списка игроков
    // уходил без него (движок отвечал вызовом challenge — лишний круг обмена).
    const challengeStart = offset + 7;
    const challenge =
      buffer.length >= challengeStart + 4 ? buffer.readInt32LE(challengeStart) : 0;

    return { name: name.value, map: map.value, players, maxPlayers, challenge };
  } catch {
    // Обрезанный или нестандартный ответ не должен ронять виджет: лучше
    // показать «сервер не ответил», чем 500 в кабинете бойца
    return null;
  }
}

/** Игрок в списке сервера */
export type ServerPlayer = {
  /** Индекс, который выдал сервер (порядковый номер в таблице игроков) */
  index: number;
  /** Ник как он есть на сервере, вместе с тегом клана: «[ATK] Скиф» */
  rawName: string;
  /** Ник без тега клана и служебных пометок */
  name: string;
  score: number;
  duration: number;
};

/**
 * Разбор ответа A2S_PLAYER.
 *
 * Формат: заголовок(4) тип(1) count(1), далее на каждого игрока — index(1),
 * строка имени, score(int32), duration(float32). Строка с завершающим нулём,
 * поэтому читаем последовательно, а не «шагами фиксированной длины»: ники
 * разной длины, и арифметика по среднему размеру дала бы мусор.
 */
export function parsePlayerResponse(buffer: Buffer): ServerPlayer[] {
  if (readResponseKind(buffer) !== "player") return [];

  const players: ServerPlayer[] = [];
  try {
    const count = buffer.readUInt8(5);
    let offset = 6;

    for (let i = 0; i < count; i++) {
      if (offset >= buffer.length) break;
      const index = buffer.readUInt8(offset);
      offset += 1;

      const entry = readCString(buffer, offset);
      offset = entry.next;

      if (offset + 8 > buffer.length) {
        // Имя есть, но запись обрезана — отдаём хотя бы имя: для «кто на ВЧ»
        // важен факт присутствия бойца, а не его счёт.
        players.push({
          index,
          rawName: entry.value,
          name: stripClanTag(entry.value),
          score: 0,
          duration: 0,
        });
        break;
      }

      const score = buffer.readInt32LE(offset);
      const duration = buffer.readFloatLE(offset + 4);
      offset += 8;

      players.push({
        index,
        rawName: entry.value,
        name: stripClanTag(entry.value),
        score,
        duration,
      });
    }
  } catch {
    // Частичный разбор лучше пустого списка: уже прочитанные ники валидны
    return players;
  }

  return players;
}

/* ------------------------------------------------------------------ */
/* Сопоставление ников с составом                                      */
/* ------------------------------------------------------------------ */

/**
 * Теги кланов и служебные пометки, которые снимаются с ника.
 *
 * В Arma 3 ник почти всегда оформлен как «[ATK] Скиф» или «[RED]Гром», а иногда
 * с пометками состояния («Скиф (AFK)», «Скиф | 1 ООВ»). Сопоставление идёт по
 * «чистому» нику — иначе боец на сервере не нашёлся бы в табеле.
 */
export const CLAN_TAG_PATTERN = /\[[^\]]{1,12}\]|\([^)]{1,12}\)|\{[^}]{1,12}\}/g;

/**
 * Пометки состояния, которые снимаются с ника: «Скиф (AFK)», «Скиф {афк}».
 *
 * Источник для обоих шаблонов ниже — один: раньше список был выписан дважды, и
 * у хвостового шаблона потерялся флаг «i», из-за чего «[ATK] Скиф (AFK)» не
 * находился в табеле (пометка в верхнем регистре не снималась).
 *
 * «афк» стоит рядом с «afk» намеренно: в игре пишут и латиницей, и кириллицей,
 * а боец, стоящий в AFK, для виджета «Кто на ВЧ» — присутствующий на сервере.
 * Обе формы покрывает флаг «i»: он регистронезависим и для кириллицы, поэтому
 * «АФК» отдельной записью не нужен.
 */
const STATE_MARKS = "afk|афк|zxc|btr|kk|не в сети";

/** Пометка состояния в начале ника: «(AFK) Скиф» */
const STATE_MARK_HEAD = new RegExp(`^[{[(](?:${STATE_MARKS})[^)\\]}]*[)\\]}]\\s*`, "i");

/** Пометка состояния в конце ника: «Скиф (AFK)» */
const STATE_MARK_TAIL = new RegExp(`\\s*[{[(](?:${STATE_MARKS})[^)\\]}]*[)\\]}]\\s*$`, "i");

/**
 * Снятие тега клана и служебных пометок.
 *
 * Тег — короткая группа в скобках В НАЧАЛЕ или в КОНЦЕ ника: «[ATK] Скиф»,
 * «Скиф [ATK]». Скобки внутри слова не трогаем — иначе позывной «Скиф (БТГ)»
 * потерял бы часть имени, а «Т-72Б3 (2016)» в нике стал бы «Т-72Б3».
 */
export function stripClanTag(rawName: string): string {
  const raw = String(rawName ?? "").replace(/\u00A0/g, " ").trim();
  if (!raw) return "";

  let name = raw;
  // Снимаем до трёх пометок: «[ATK] Скиф (AFK)» → «Скиф»
  for (let i = 0; i < 3; i++) {
    const next = name
      .replace(/^\[[^\]]{1,12}\]\s*/, "")
      .replace(/\s*\[[^\]]{1,12}\]$/, "")
      .trim();
    if (next === name) break;
    name = next;
  }

  // Круглые/фигурные скобки с пометками состояния — только по краям ника
  name = name.replace(STATE_MARK_HEAD, "").replace(STATE_MARK_TAIL, "").trim();

  return (name || raw).replace(/\s+/g, " ");
}

/**
 * Приведение ника к виду, пригодному для сравнения.
 *
 * Регистр и «ё/е» не важны, служебные пометки сняты, знаки препинания сведены к
 * пробелу. Позывные в ШДС пишут по-разному («Скиф», «СКИФ»), а на сервере может
 * стоять «Скиф.», поэтому сравнение должно быть терпимым.
 */
export function normalizePlayerName(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/ё/gi, "е")
    .replace(/[.,|/\\_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Боец состава для сопоставления (минимально необходимое) */
export type RosterEntry = {
  id: number;
  callsign: string;
  rank: string;
  division: string | null;
};

/**
 * Кто из состава сейчас на сервере.
 *
 * Сопоставление — по нормализованному позывному. Порядок результата сохраняется
 * как на сервере (список игроков), потому что подразделение показывает его
 * как есть («кто сейчас в игре»), а не сортирует по званию.
 */
export function matchPlayersToMembers(
  players: readonly ServerPlayer[],
  roster: readonly RosterEntry[]
): RosterEntry[] {
  const byName = new Map<string, RosterEntry>();
  for (const entry of roster) {
    const key = normalizePlayerName(entry.callsign);
    // Первый в табеле важнее: дубликат позывного не должен «перебивать» запись,
    // которую уже нашли (однофамильцы с одинаковым позывным в ШДС встречаются).
    if (key && !byName.has(key)) byName.set(key, entry);
  }

  const found: RosterEntry[] = [];
  const seen = new Set<number>();

  for (const player of players) {
    const key = normalizePlayerName(player.name || stripClanTag(player.rawName));
    if (!key) continue;
    const entry = byName.get(key);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    found.push(entry);
  }

  return found;
}

/* ------------------------------------------------------------------ */
/* Сетевой слой                                                        */
/* ------------------------------------------------------------------ */

/** Один UDP-обмен: отправка пакета и ожидание ответа с таймаутом */
function udpQuery(
  config: A2SConfig,
  packet: Buffer,
  timeoutMs = QUERY_TIMEOUT_MS
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Сокет мог быть уже закрыт при ошибке — это не повод возвращать ошибку
      }
      resolve(value);
    };

    // Таймаут — штатный исход: сервер выключен, порт закрыт или отвечает не он.
    // Виджет покажет «никого нет», и это правильнее, чем ошибка на всю страницу.
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.once("error", () => finish(null));
    socket.once("message", (message) => finish(message));
    socket.send(packet, config.port, config.host, (err) => {
      if (err) finish(null);
    });
  });
}

/** Результат запроса: состояние сервера и список игроков */
export type VchResult = {
  /** Сервер ответил */
  online: boolean;
  /** Всего игроков на сервере (как сообщил сервер) */
  onlineCount: number;
  maxPlayers: number;
  map: string | null;
  serverName: string | null;
  players: ServerPlayer[];
  /** Причина, по которой данных нет: настройка, таймаут, ошибка */
  error?: string;
};

/** Пустой результат с причиной — единый вид «данных нет» */
function emptyResult(error: string): VchResult {
  return {
    online: false,
    onlineCount: 0,
    maxPlayers: 0,
    map: null,
    serverName: null,
    players: [],
    error,
  };
}

/** Кэш последнего ответа: ключ — «host:port» */
type CacheEntry = { at: number; value: VchResult };
const cache = new Map<string, CacheEntry>();

/** Сброс кэша (тесты и ручное обновление виджета) */
export function resetVchCache(): void {
  cache.clear();
}

/** Размер кэша — для тестов TTL */
export function vchCacheSize(): number {
  return cache.size;
}

/**
 * Живой список игроков на сервере.
 *
 * Порядок обмена: A2S_INFO (заодно узнаём challenge) → A2S_PLAYER с challenge.
 * Ответ на A2S_PLAYER может прийти в виде запроса challenge (0x41) — тогда
 * повторяем запрос с полученным значением: так делает сам Steam.
 *
 * Кэш читается и пишется только здесь: TTL 60 секунд защищает сервер от флуда,
 * а `force` нужен кнопке «обновить» в кабинете (осознанное действие бойца).
 */
export async function queryServer(
  options: {
    config?: A2SConfig | null;
    timeoutMs?: number;
    force?: boolean;
    now?: number;
  } = {}
): Promise<VchResult> {
  const config = options.config === undefined ? a2sConfig() : options.config;
  if (!config) {
    return emptyResult(
      "Сервер не настроен: задайте ARMA3_SERVER_HOST и ARMA3_SERVER_QUERY_PORT"
    );
  }

  const key = `${config.host}:${config.port}`;
  const now = options.now ?? Date.now();
  const cached = cache.get(key);
  if (!options.force && cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;

  const infoResponse = await udpQuery(config, buildInfoQuery(), timeoutMs);
  if (!infoResponse) {
    const value = emptyResult("Сервер не ответил на запрос A2S_INFO");
    cache.set(key, { at: now, value });
    return value;
  }

  const parsedInfo = parseInfoResponse(infoResponse);
  // Сервер мог ответить challenge-пакетом вместо полной информации: тогда
  // населения в ответе нет, но challenge для списка игроков уже известен.
  const challenge = parsedInfo
    ? parsedInfo.challenge ?? 0
    : readResponseKind(infoResponse) === "challenge"
      ? infoResponse.readInt32LE(5)
      : 0;

  // challenge = 0 означает «сервер его не сообщил»: в запросе это должно стать
  // 0xFFFFFFFF, иначе движок может молча проигнорировать запрос списка игроков.
  let playersResponse = await udpQuery(config, buildPlayerQuery(challenge || -1), timeoutMs);
  if (playersResponse && readResponseKind(playersResponse) === "challenge") {
    // Второй раунд: движок на первый запрос отдаёт вызов challenge, а не данные
    const retry = await udpQuery(
      config,
      buildPlayerQuery(playersResponse.readInt32LE(5)),
      timeoutMs
    );
    if (retry) playersResponse = retry;
  }

  if (!playersResponse) {
    const value: VchResult = {
      online: true,
      onlineCount: parsedInfo?.players ?? 0,
      maxPlayers: parsedInfo?.maxPlayers ?? 0,
      map: parsedInfo?.map ?? null,
      serverName: parsedInfo?.name ?? null,
      players: [],
      error: "Сервер не ответил на запрос списка игроков",
    };
    cache.set(key, { at: now, value });
    return value;
  }

  const players = parsePlayerResponse(playersResponse);
  const value: VchResult = {
    online: true,
    // Счётчик берём из A2S_INFO: он включает и тех, кого нет в списке (например,
    // наблюдателей на некоторых сборках). Если информации нет — считаем сами.
    onlineCount: parsedInfo?.players ?? players.length,
    maxPlayers: parsedInfo?.maxPlayers ?? 0,
    map: parsedInfo?.map ?? null,
    serverName: parsedInfo?.name ?? null,
    players,
  };
  cache.set(key, { at: now, value });
  return value;
}

/**
 * Сводка «Кто на ВЧ» для кабинета: живые бойцы подразделения.
 *
 * Помимо сопоставления здесь считаются данные для интерфейса: сколько всего
 * людей на сервере и сколько из них — свои.
 */
export type VchSummary = {
  /** Сервер ответил (неважно, есть ли на нём свои) */
  online: boolean;
  /** Всего игроков на сервере */
  onlineCount: number;
  maxPlayers: number;
  map: string | null;
  /** Бойцы подразделения, найденные на сервере */
  clanMembersOnline: RosterEntry[];
  /** Ники, которые не удалось сопоставить с составом */
  unknownPlayers: string[];
  error?: string;
};

export async function garrisonStatus(
  roster: readonly RosterEntry[],
  options: { config?: A2SConfig | null; timeoutMs?: number; force?: boolean; now?: number } = {}
): Promise<VchSummary> {
  const result = await queryServer(options);

  const clanMembersOnline = matchPlayersToMembers(result.players, roster);
  const matched = new Set(clanMembersOnline.map((entry) => normalizePlayerName(entry.callsign)));
  const unknownPlayers = result.players
    .map((player) => player.name || stripClanTag(player.rawName))
    .filter((name) => name && !matched.has(normalizePlayerName(name)));

  return {
    online: result.online,
    onlineCount: result.onlineCount,
    maxPlayers: result.maxPlayers,
    map: result.map,
    clanMembersOnline,
    unknownPlayers,
    ...(result.error ? { error: result.error } : {}),
  };
}