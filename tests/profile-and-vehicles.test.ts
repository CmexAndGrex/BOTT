/**
 * Тесты личного досье: матрица техники, сопоставление игроков A2S и гварды
 * приватности.
 *
 * Проверяются боевые модули (src/lib/vehicles.ts, a2s.ts, dossier.ts) и реальные
 * роуты кабинета, а не копии правил в тесте: ошибка в матрице допуска отдаёт
 * рядовому технику офицера, а ослабленный гвард открывает «Кто на ВЧ» гостю —
 * то есть адрес игрового сервера и состав подразделения. И то и другое
 * замечается только по факту, уже в игре.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  allTankVehicles,
  getAvailableVehicles,
  isQualificationPassed,
  nextTankTier,
  normalizeRank,
  rankIndex,
  TANK_RANK_MATRIX,
  vehicleDivision,
} from "@/lib/vehicles.ts";
import {
  a2sConfig,
  buildInfoQuery,
  buildPlayerQuery,
  DEFAULT_QUERY_PORT,
  matchPlayersToMembers,
  normalizePlayerName,
  parseInfoResponse,
  parsePlayerResponse,
  queryServer,
  readResponseKind,
  stripClanTag,
  type ServerPlayer,
} from "@/lib/a2s.ts";
import {
  collectQualifications,
  daysLeftLabel,
  daysUntil,
  dossierTitle,
  formatMoscowDate,
  pluralDays,
  reportStatusView,
  serviceStatus,
  serviceSummary,
} from "@/lib/dossier.ts";
import { GET as vchRoute } from "../src/app/api/member/vch/route.ts";
import { GET as dossierRoute } from "../src/app/api/member/dossier/route.ts";

/* ------------------------------------------------------------------ */
/* Хелперы                                                             */
/* ------------------------------------------------------------------ */

/** Запрос к роуту кабинета: те же заголовки, что шлёт браузер */
function memberRequest(
  path: string,
  options: { cookie?: string; method?: string } = {}
): NextRequest {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  headers.set("host", "panel.example");
  return new NextRequest(new URL(path, "http://panel.example"), {
    method: options.method ?? "GET",
    headers,
  });
}

/**
 * Имена открытой техники — по ним читаются утверждения тестов.
 *
 * Параметр объявлен readonly: RankTier.vehicles и VehicleAccessReport.unlocked
 * публикуются как readonly-списки, и мутабельный массив в сигнатуре не принял бы
 * их без копирования.
 */
function namesOf(cards: readonly { vehicle: { name: string } }[]): string[] {
  return cards.map((card) => card.vehicle.name);
}

/** Проверка «в списке есть машина с таким фрагментом названия» */
function hasVehicle(names: readonly string[], fragment: string): boolean {
  return names.some((name) => name.includes(fragment));
}

/**
 * Окружение для a2sConfig: функция читает только два ключа, поэтому в тестах
 * достаточно подделки из пары значений. Приведение через Record не проходит
 * напрямую: Next.js расширяет NodeJS.ProcessEnv обязательным NODE_ENV, и каст
 * из литерала объектного типа отвергается.
 */
function fakeEnv(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...vars } as unknown as NodeJS.ProcessEnv;
}

/**
 * Имена техники из ступени матрицы.
 *
 * Отдельно от namesOf: RankTier.vehicles — плоский список Vehicle (ступень ещё
 * не разобрана на карточки «открыто/заперто»), а VehicleCard несёт vehicle
 * внутри. Смешивать их в одной сигнатуре значило бы терять проверку типов там,
 * где она полезна.
 */
function tierNames(vehicles: readonly { name: string }[]): string[] {
  return vehicles.map((vehicle) => vehicle.name);
}

/**
 * Пакет ответа A2S_INFO, собранный по протоколу.
 * Строки — UTF-8 с завершающим нулём, как их отдаёт движок.
 */
function infoPacket(
  options: {
    name?: string;
    map?: string;
    players?: number;
    maxPlayers?: number;
    challenge?: number;
    protocol?: number;
  } = {}
): Buffer {
  const {
    name = "ATK RED | Сервер",
    map = "altis",
    players = 3,
    maxPlayers = 64,
    challenge = 1234567,
    protocol = 17,
  } = options;

  const parts: Buffer[] = [];
  const header = Buffer.alloc(4);
  header.writeInt32LE(-1, 0);
  parts.push(header);
  parts.push(Buffer.from([0x49])); // 'I' — ответ A2S_INFO
  parts.push(Buffer.from([protocol]));
  for (const text of [name, map, "arma3", "Arma 3"]) {
    parts.push(Buffer.from(`${text}\0`, "utf8"));
  }
  const appId = Buffer.alloc(2);
  // Поле appid в A2S_INFO — 16 бит, а Steam-appid Arma 3 (107410) в них не
  // влезает: в пакете лежит младшая половина. Разбор это поле пропускает, но
  // запись «как есть» роняла бы сборку пакета (ERR_OUT_OF_RANGE).
  appId.writeUInt16LE(107410 & 0xffff, 0);
  parts.push(appId);
  // players, maxPlayers, bots, serverType, environment, visibility, vac
  parts.push(Buffer.from([players, maxPlayers, 0, 0x64, 0x6c, 0, 1]));
  const tail = Buffer.alloc(4);
  tail.writeInt32LE(challenge, 0);
  parts.push(tail);

  return Buffer.concat(parts);
}

/** Пакет ответа A2S_PLAYER: index + имя + score + duration на каждого игрока */
function playerPacket(
  players: { index: number; name: string; score?: number; duration?: number }[]
): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(4);
  header.writeInt32LE(-1, 0);
  parts.push(header);
  parts.push(Buffer.from([0x44, players.length])); // 'D' + count

  for (const player of players) {
    parts.push(Buffer.from([player.index]));
    parts.push(Buffer.from(`${player.name}\0`, "utf8"));
    const stats = Buffer.alloc(8);
    stats.writeInt32LE(player.score ?? 0, 0);
    stats.writeFloatLE(player.duration ?? 0, 4);
    parts.push(stats);
  }

  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/* Матрица техники: Танковая рота                                      */
/* ------------------------------------------------------------------ */

describe("Матрица техники: Танковая рота — допуск по званию", () => {
  test("рядовому открыт Т-72Б, но не Т-90М", () => {
    const report = getAvailableVehicles({ rank: "Рядовой", unit: "Танковая рота" });

    assert.equal(report.division, "tank");
    const open = namesOf(report.unlocked);
    assert.ok(hasVehicle(open, "Т-72Б (1985)"), "рядовой должен водить Т-72Б (1985)");
    assert.ok(hasVehicle(open, "Т-72Б (1989)"), "рядовой должен водить Т-72Б (1989)");
    assert.ok(hasVehicle(open, "Спрут-СД"), "рядовой должен водить 2С25 (Спрут-СД)");
    assert.equal(hasVehicle(open, "Т-90М"), false, "Т-90М рядовому недоступен");
    assert.equal(hasVehicle(open, "Т-14 Армата"), false, "Т-14 Армата рядовому недоступен");

    // Закрытая техника не теряется: она в списке «требует повышения» с причиной
    const t90m = report.locked.find((card) => card.vehicle.name === "Т-90М (RED)");
    assert.ok(t90m, "Т-90М должен быть в списке закрытой техники");
    assert.deepEqual(t90m?.missing, ["звание Лейтенант"]);
    assert.equal(t90m?.statusLabel, "Требуется повышение");
  });

  test("звание открывает технику своего уровня и всё, что ниже", () => {
    const report = getAvailableVehicles({ rank: "Старшина", unit: "Танковая рота" });
    const open = namesOf(report.unlocked);

    assert.ok(hasVehicle(open, "Т-90СМ"), "старшине положен Т-90СМ");
    assert.ok(hasVehicle(open, "Т-72Б (1985)"), "техника рядового не пропадает");
    assert.ok(hasVehicle(open, "Т-90АМ"), "техника ст. сержанта не пропадает");
    assert.equal(hasVehicle(open, "Т-90М (RED)"), false, "Т-90М открывается только лейтенанту");
  });

  test("лейтенант получает офицерскую технику, ст. лейтенант — Т-14", () => {
    const lieutenant = namesOf(
      getAvailableVehicles({ rank: "Лейтенант", unit: "Танковая рота" }).unlocked
    );
    assert.ok(hasVehicle(lieutenant, "Т-90М (RED)"));
    assert.ok(hasVehicle(lieutenant, "Т-90MS Tagil"));
    assert.ok(hasVehicle(lieutenant, "Чёрный Орёл"), "ивент-техника относится к ступени");
    assert.equal(hasVehicle(lieutenant, "Т-14 Армата"), false);

    const senior = namesOf(
      getAvailableVehicles({ rank: "Ст. Лейтенант", unit: "Танковая рота" }).unlocked
    );
    assert.ok(hasVehicle(senior, "Т-14 Армата"));
  });

  test("предпросмотр следующей ступени: что откроет ближайшее повышение", () => {
    const report = getAvailableVehicles({ rank: "Рядовой", unit: "Танковая рота" });
    assert.equal(report.progress.kind, "rank");
    assert.equal(report.progress.next, "Ефрейтор");
    assert.deepEqual(report.progress.missing, ["звание Ефрейтор"]);

    const nextTier = nextTankTier(normalizeRank("Рядовой"));
    assert.equal(nextTier?.rank, "Ефрейтор");
    assert.ok(hasVehicle(tierNames(nextTier?.vehicles ?? []), "Тунгуска"));
  });

  test("предпросмотр не «перепрыгивает» ступень с одной машиной", () => {
    // У «Прапорщика» в матрице одна машина: следующей ступенью для «Старшины»
    // должен быть именно он, а не лейтенант
    const report = getAvailableVehicles({ rank: "Старшина", unit: "Танковая рота" });
    assert.equal(report.progress.next, "Прапорщик");
  });

  test("Курсант без техники: ничего не открыто, но подразделение известно", () => {
    const report = getAvailableVehicles({ rank: "Курсант", unit: "Танковая рота" });
    assert.equal(report.unlocked.length, 0);
    assert.equal(report.progress.next, "Рядовой");
    assert.ok(report.locked.length > 0);
  });

  test("матрица роты описана полностью: ни одна ступень не пустая", () => {
    for (const tier of TANK_RANK_MATRIX) {
      assert.ok(tier.vehicles.length > 0, `ступень «${tier.rank}» без техники`);
    }
    // Идентификаторы уникальны: иначе ключи React и сравнение карточек сломаются
    const ids = allTankVehicles().map((vehicle) => vehicle.id);
    assert.equal(new Set(ids).size, ids.length, "id единиц техники должны быть уникальны");
  });

  test("звания сопоставляются по написанию из ШДС", () => {
    assert.equal(normalizeRank("младший сержант"), "Мл. Сержант");
    assert.equal(normalizeRank("Мл. Сержант"), "Мл. Сержант");
    assert.equal(normalizeRank("  ст.  лейтенант "), "Ст. Лейтенант");
    assert.equal(normalizeRank("Ефрейтор"), "Ефрейтор");
    assert.equal(normalizeRank("Генерал"), null);
    assert.equal(rankIndex("Рядовой"), 1);
  });
});
/* ------------------------------------------------------------------ */
/* Матрица техники: Артиллерийский дивизион — допуск по квалификации    */
/* ------------------------------------------------------------------ */

describe("Матрица техники: артиллерия — допуск по нормативам ШДС", () => {
  test("без сданных нормативов не открыта ни одна категория", () => {
    const report = getAvailableVehicles({
      rank: "Ефрейтор",
      unit: "Артиллерийский дивизион",
      qualifications: [],
    });

    assert.equal(report.division, "artillery");
    assert.equal(report.unlocked.length, 0);
    assert.equal(report.categories.length, 3);
    for (const category of report.categories) {
      assert.equal(category.unlocked, false);
      assert.equal(category.statusLabel, "Требуется сдача норматива");
      assert.ok(category.missing.length > 0, `у «${category.title}» должна быть причина`);
    }
    // Звание в артиллерии ничего не решает: даже «Лейтенант» без допуска без техники
    const officer = getAvailableVehicles({
      rank: "Лейтенант",
      unit: "Артиллерийский дивизион",
      qualifications: [],
    });
    assert.equal(officer.unlocked.length, 0);
  });

  test("«Миномётное дело (Экзамен)» открывает миномётную батарею", () => {
    const report = getAvailableVehicles({
      rank: "Рядовой",
      unit: "Артиллерийский дивизион",
      qualifications: ["Миномётное дело (Экзамен)"],
    });

    const mortar = report.categories.find((category) => category.key === "mortar");
    assert.equal(mortar?.unlocked, true);
    assert.equal(mortar?.statusLabel, "Допуск получен");
    assert.deepEqual(mortar?.satisfied, ["Миномётное дело (Экзамен)"]);

    const open = namesOf(report.unlocked);
    assert.ok(hasVehicle(open, "Поднос"), "2Б14 «Поднос» должен открыться");
    // Остальные категории остаются закрытыми
    assert.equal(
      report.categories.find((c) => c.key === "spg")?.unlocked,
      false,
      "САУ требует своих нормативов"
    );
  });

  test("САУ требует И «Артиллирийское Дело (Экзамен)», И «Сдача на мехвода»", () => {
    const onlyExam = getAvailableVehicles({
      rank: "Сержант",
      unit: "Артиллерийский дивизион",
      qualifications: ["Артиллирийское Дело (Экзамен)"],
    });
    const spgPartial = onlyExam.categories.find((category) => category.key === "spg");
    assert.equal(spgPartial?.unlocked, false, "одного норматива для САУ мало");
    assert.deepEqual(spgPartial?.missing, ["Сдача на мехвода"]);
    assert.equal(hasVehicle(namesOf(onlyExam.unlocked), "Гвоздика"), false);

    const both = getAvailableVehicles({
      rank: "Сержант",
      unit: "Артиллерийский дивизион",
      qualifications: ["Артиллирийское Дело (Экзамен)", "Сдача на мехвода"],
    });
    const spgFull = both.categories.find((category) => category.key === "spg");
    assert.equal(spgFull?.unlocked, true);
    const open = namesOf(both.unlocked);
    assert.ok(hasVehicle(open, "Гвоздика"));
    assert.ok(hasVehicle(open, "Акация"));
    assert.ok(hasVehicle(open, "Мста-С"));
  });

  test("«РСЗО (Экзамен)» открывает реактивную артиллерию", () => {
    const report = getAvailableVehicles({
      rank: "Ефрейтор",
      unit: "Артиллерийский дивизион",
      qualifications: ["РСЗО (Экзамен)"],
    });
    const mlrs = report.categories.find((category) => category.key === "mlrs");
    assert.equal(mlrs?.unlocked, true);
    const open = namesOf(report.unlocked);
    assert.ok(hasVehicle(open, "Град-К"));
    assert.ok(hasVehicle(open, "Торнадо-Г"));
  });

  test("названия нормативов сравниваются терпимо: «ё/е», регистр, пробелы", () => {
    // Так норматив может быть назван в ШДС или в заявке — допуск должен признаться
    const report = getAvailableVehicles({
      rank: "Рядовой",
      unit: "Артиллерийский дивизион",
      qualifications: ["  минометное   дело (экзамен) "],
    });
    assert.equal(
      report.categories.find((category) => category.key === "mortar")?.unlocked,
      true,
      "«ё/е» и регистр не должны мешать допуску"
    );
  });

  test("опечатка «Артиллирийское» из ТЗ и корректное написание равнозначны", () => {
    const typo = getAvailableVehicles({
      rank: "Сержант",
      unit: "Артиллерийский дивизион",
      qualifications: ["Артиллирийское Дело (Экзамен)", "Сдача на мехвода"],
    });
    const correct = getAvailableVehicles({
      rank: "Сержант",
      unit: "Артиллерийский дивизион",
      qualifications: ["Артиллерийское дело (Экзамен)", "Сдача на Мех. Водителя"],
    });

    for (const report of [typo, correct]) {
      assert.equal(
        report.categories.find((category) => category.key === "spg")?.unlocked,
        true,
        "допуск к САУ должен подтверждаться при любом написании норматива"
      );
    }
  });

  test("прогресс артиллерии: сколько категорий открыто и что нужно для ближайшей", () => {
    const report = getAvailableVehicles({
      rank: "Ефрейтор",
      unit: "Артиллерийский дивизион",
      qualifications: ["РСЗО (Экзамен)"],
    });

    assert.equal(report.progress.kind, "qualification");
    assert.equal(report.progress.satisfied, 1);
    assert.equal(report.progress.total, 3);
    // Ближайшая — миномётная: у неё один несданный норматив против двух у САУ
    assert.equal(report.progress.next, "Миномётная батарея");
    assert.deepEqual(report.progress.missing, ["Миномётное дело (Экзамен)"]);
  });

  test("все три категории открыты — прогресс 100% и без «следующего допуска»", () => {
    const report = getAvailableVehicles({
      rank: "Рядовой",
      unit: "Артиллерийский дивизион",
      qualifications: [
        "Миномётное дело (Экзамен)",
        "Артиллирийское Дело (Экзамен)",
        "Сдача на мехвода",
        "РСЗО (Экзамен)",
      ],
    });
    assert.equal(report.progress.next, null);
    assert.equal(report.progress.percent, 100);
    assert.equal(report.locked.length, 0);
    assert.ok(report.unlocked.length > 0);
  });

  test("isQualificationPassed: прямое сопоставление и отказ по чужому нормативу", () => {
    const exam = { code: "РСЗО (Экзамен)", aliases: ["РСЗО"] };
    assert.equal(isQualificationPassed(exam, ["РСЗО"]), true);
    assert.equal(isQualificationPassed(exam, ["рсзо (экзамен)"]), true);
    assert.equal(isQualificationPassed(exam, ["Миномётное дело (Экзамен)"]), false);
    assert.equal(isQualificationPassed(exam, []), false);
  });
});

describe("Матрица техники: определение подразделения и защита от «наугад»", () => {
  test("подразделение определяется по тем же правилам, что раскладка ШДС", () => {
    assert.equal(vehicleDivision("Танковая рота"), "tank");
    assert.equal(vehicleDivision("танковая рота"), "tank");
    assert.equal(vehicleDivision("Артиллерийский дивизион"), "artillery");
    assert.equal(vehicleDivision("артдивизион"), "artillery");
    assert.equal(vehicleDivision("Морская пехота"), "unknown");
    assert.equal(vehicleDivision(null), "unknown");
  });

  test("неизвестное подразделение не даёт доступа ни к чему", () => {
    const report = getAvailableVehicles({ rank: "Полковник", unit: "Морская пехота" });
    assert.equal(report.division, "unknown");
    assert.equal(report.unlocked.length, 0);
    assert.equal(report.locked.length, 0);
    assert.equal(report.progress.percent, 0);
    assert.match(report.summary, /не определена/);
  });

  test("звание вне списка RANKS не открывает ступени", () => {
    const report = getAvailableVehicles({ rank: "Генералиссимус", unit: "Танковая рота" });
    assert.equal(report.rank, null);
    assert.equal(report.rankIndex, -1);
    assert.equal(report.unlocked.length, 0);
    assert.equal(report.progress.next, "Рядовой");
  });
});

/* ------------------------------------------------------------------ */
/* A2S: формирование запросов                                          */
/* ------------------------------------------------------------------ */

describe("A2S: запросы к серверу", () => {
  test("запрос A2S_INFO собран по протоколу", () => {
    const query = buildInfoQuery();
    assert.equal(query.readInt32LE(0), -1, "заголовок 0xFFFFFFFF");
    assert.equal(query.readUInt8(4), 0x54, "тип 'T'");
    assert.equal(query.toString("latin1", 5), "Source Engine Query\0");
  });

  test("запрос A2S_PLAYER несёт challenge в little-endian", () => {
    const query = buildPlayerQuery(1234567);
    assert.equal(query.readInt32LE(0), -1);
    assert.equal(query.readUInt8(4), 0x55, "тип 'U'");
    assert.equal(query.readInt32LE(5), 1234567);
  });

  test("без challenge отправляется 0xFFFFFFFF: сервер выдаст его сам", () => {
    assert.equal(buildPlayerQuery().readInt32LE(5), -1);
  });

  test("адрес сервера берётся из окружения, порт по умолчанию — 2303", () => {
    const configured = a2sConfig(fakeEnv({ ARMA3_SERVER_HOST: "123.45.67.89" }));
    assert.deepEqual(configured, { host: "123.45.67.89", port: DEFAULT_QUERY_PORT });
    assert.equal(DEFAULT_QUERY_PORT, 2303);

    const withPort = a2sConfig(
      fakeEnv({ ARMA3_SERVER_HOST: " atk.example ", ARMA3_SERVER_QUERY_PORT: "2305" })
    );
    assert.deepEqual(withPort, { host: "atk.example", port: 2305 });
  });

  test("адрес не задан — запрос не выполняется вовсе", () => {
    assert.equal(a2sConfig(fakeEnv({})), null);
    assert.equal(a2sConfig(fakeEnv({ ARMA3_SERVER_HOST: "   " })), null);
  });

  test("порт запроса выводится из игрового, если не задан явно", () => {
    // В Arma 3 порт запроса — следующий за игровым (2302 → 2303)
    const derived = a2sConfig(
      fakeEnv({ ARMA3_SERVER_HOST: "atk.example", ARMA3_SERVER_PORT: "2302" })
    );
    assert.deepEqual(derived, { host: "atk.example", port: 2303 });

    // Явный порт запроса приоритетнее: если заданы оба — берётся ARMA3_SERVER_QUERY_PORT
    const explicit = a2sConfig(
      fakeEnv({
        ARMA3_SERVER_HOST: "atk.example",
        ARMA3_SERVER_PORT: "2302",
        ARMA3_SERVER_QUERY_PORT: "2400",
      })
    );
    assert.deepEqual(explicit, { host: "atk.example", port: 2400 });

    // Испорченный игровой порт не мешает: берётся общий порт по умолчанию
    const broken = a2sConfig(
      fakeEnv({ ARMA3_SERVER_HOST: "atk.example", ARMA3_SERVER_PORT: "не число" })
    );
    assert.deepEqual(broken, { host: "atk.example", port: DEFAULT_QUERY_PORT });

    // 65535 — граница диапазона: следующий порт уже невалиден, берём умолчание
    const edge = a2sConfig(
      fakeEnv({ ARMA3_SERVER_HOST: "atk.example", ARMA3_SERVER_PORT: "65535" })
    );
    assert.deepEqual(edge, { host: "atk.example", port: DEFAULT_QUERY_PORT });
  });

  test("мусор в порту не ломает настройку: берётся порт по умолчанию", () => {
    const cases = ["abc", "0", "-5", "99999", ""];
    for (const raw of cases) {
      const config = a2sConfig(
        fakeEnv({ ARMA3_SERVER_HOST: "atk.example", ARMA3_SERVER_QUERY_PORT: raw })
      );
      assert.equal(config?.port, DEFAULT_QUERY_PORT, `порт «${raw}» должен игнорироваться`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* A2S: разбор пакетов                                                 */
/* ------------------------------------------------------------------ */

describe("A2S: разбор ответа A2S_INFO", () => {
  test("поля сервера читаются: имя, карта, население, challenge", () => {
    const info = parseInfoResponse(infoPacket({ players: 5, maxPlayers: 40 }));
    assert.ok(info);
    assert.equal(info?.name, "ATK RED | Сервер");
    assert.equal(info?.map, "altis");
    assert.equal(info?.players, 5);
    assert.equal(info?.maxPlayers, 40);
    assert.equal(info?.challenge, 1234567);
  });

  test("кириллица в названии сервера не превращается в мусор", () => {
    const info = parseInfoResponse(
      infoPacket({ name: "ВЧ АТК · Операция «Гроза»", map: "СНаП_Карта" })
    );
    assert.equal(info?.name, "ВЧ АТК · Операция «Гроза»");
    assert.equal(info?.map, "СНаП_Карта");
  });

  test("чужой пакет не принимается за информацию о сервере", () => {
    assert.equal(parseInfoResponse(playerPacket([{ index: 0, name: "Скиф" }])), null);
    assert.equal(parseInfoResponse(Buffer.from([1, 2, 3])), null);
  });

  test("обрезанный ответ не роняет разбор", () => {
    const truncated = infoPacket().subarray(0, 12);
    assert.doesNotThrow(() => parseInfoResponse(truncated));
  });

  test("типы ответов различаются по первому байту", () => {
    assert.equal(readResponseKind(infoPacket()), "info");
    assert.equal(readResponseKind(playerPacket([])), "player");

    const challenge = Buffer.alloc(9);
    challenge.writeInt32LE(-1, 0);
    challenge.writeUInt8(0x41, 4);
    challenge.writeInt32LE(777, 5);
    assert.equal(readResponseKind(challenge), "challenge");
  });
});

describe("A2S: разбор ответа A2S_PLAYER", () => {
  test("ники, счёт и время читаются по каждому игроку", () => {
    const players = parsePlayerResponse(
      playerPacket([
        { index: 0, name: "[ATK] Скиф", score: 12, duration: 540.5 },
        { index: 1, name: "[RED] Гром", score: 3, duration: 61 },
      ])
    );

    assert.equal(players.length, 2);
    assert.equal(players[0].rawName, "[ATK] Скиф");
    assert.equal(players[0].name, "Скиф", "тег клана снимается сразу при разборе");
    assert.equal(players[0].score, 12);
    assert.equal(Math.round(players[0].duration), 541);
    assert.equal(players[1].name, "Гром");
  });

  test("ник разной длины не сдвигает разбор следующих записей", () => {
    // Главная ловушка формата: если считать записи «шагами фиксированной длины»,
    // длинный ник сдвинул бы всё дальше и второй игрок прочитался бы мусором.
    const players = parsePlayerResponse(
      playerPacket([
        { index: 0, name: "ОченьДлинныйПозывнойБойцаПодразделения", score: 1, duration: 2 },
        { index: 1, name: "Скиф", score: 9, duration: 10 },
        { index: 2, name: "Т-72Б3 (2016)", score: 4, duration: 5 },
      ])
    );

    assert.deepEqual(
      players.map((player) => player.name),
      ["ОченьДлинныйПозывнойБойцаПодразделения", "Скиф", "Т-72Б3 (2016)"]
    );
    assert.equal(players[2].score, 4);
  });

  test("пустой список игроков — пустой массив, без исключений", () => {
    assert.deepEqual(parsePlayerResponse(playerPacket([])), []);
  });

  test("обрезанная запись не теряет уже прочитанные ники", () => {
    const full = playerPacket([
      { index: 0, name: "Скиф", score: 1, duration: 1 },
      { index: 1, name: "Гром", score: 2, duration: 2 },
    ]);
    const cut = full.subarray(0, full.length - 4);
    const players = parsePlayerResponse(cut);
    assert.equal(players[0].name, "Скиф");
    assert.ok(players.length >= 1);
  });

  test("ответ не того типа игнорируется", () => {
    assert.deepEqual(parsePlayerResponse(infoPacket()), []);
  });
});

/* ------------------------------------------------------------------ */
/* A2S: снятие тегов и сопоставление с составом                        */
/* ------------------------------------------------------------------ */

describe("A2S: снятие тега клана", () => {
  test("теги [ATK] и [RED] снимаются с любой стороны ника", () => {
    assert.equal(stripClanTag("[ATK] Скиф"), "Скиф");
    assert.equal(stripClanTag("Скиф [ATK]"), "Скиф");
    assert.equal(stripClanTag("[RED]Гром"), "Гром");
    assert.equal(stripClanTag("[ATK][RED] Скиф"), "Скиф");
    assert.equal(stripClanTag("Скиф"), "Скиф", "ник без тега не портится");
  });

  test("служебные пометки состояния снимаются по краям", () => {
    assert.equal(stripClanTag("[ATK] Скиф (AFK)"), "Скиф");
    assert.equal(stripClanTag("Скиф {afk}"), "Скиф");
  });

  test("кириллическая пометка «афк» снимается в любом регистре", () => {
    // В игре пишут и латиницей, и кириллицей — обе формы должны давать один ник,
    // иначе боец в отпуске/отлучке не найдётся в табеле виджета «Кто на ВЧ».
    assert.equal(stripClanTag("Скиф (афк)"), "Скиф");
    assert.equal(stripClanTag("[ATK] Скиф (АФК)"), "Скиф");
    assert.equal(stripClanTag("Скиф {Афк}"), "Скиф");
    assert.equal(stripClanTag("(афк) Гром"), "Гром");
    // «ё» в других пометках не ломает соседнюю кириллицу
    assert.equal(stripClanTag("[ATK] Скиф (не в сети)"), "Скиф");
  });

  test("скобки внутри ника не считаются тегом", () => {
    // «Т-72Б3 (2016)» — часть названия: срезать её значило бы потерять бойца
    assert.equal(stripClanTag("Т-72Б3 (2016)"), "Т-72Б3 (2016)");
    assert.equal(stripClanTag("Скиф (БТГ)"), "Скиф (БТГ)");
  });

  test("пустой ник не превращается в мусор", () => {
    assert.equal(stripClanTag(""), "");
    assert.equal(stripClanTag("   "), "");
  });

  test("нормализация ника терпима к регистру, «ё» и знакам", () => {
    assert.equal(normalizePlayerName("[ATK] Скиф"), "[atk] скиф");
    assert.equal(normalizePlayerName("Гром."), "гром");
    assert.equal(normalizePlayerName("Орёл"), "орел");
    assert.equal(normalizePlayerName("  Штурман   1 "), "штурман 1");
  });
});

describe("A2S: сопоставление игроков с табелем", () => {
  const roster = [
    { id: 1, callsign: "Скиф", rank: "Рядовой", division: "Танковая рота" },
    { id: 2, callsign: "Гром", rank: "Сержант", division: "Танковая рота" },
    { id: 3, callsign: "Штурман 1", rank: "Лейтенант", division: "Артиллерийский дивизион" },
  ];

  test("свои находятся по нику с тегом и без", () => {
    const players: ServerPlayer[] = [
      { index: 0, rawName: "[ATK] Скиф", name: "Скиф", score: 0, duration: 0 },
      { index: 1, rawName: "[RED] Гром", name: "Гром", score: 0, duration: 0 },
    ];
    const found = matchPlayersToMembers(players, roster);
    assert.deepEqual(
      found.map((entry) => entry.callsign),
      ["Скиф", "Гром"]
    );
    assert.equal(found[0].division, "Танковая рота");
  });

  test("чужие игроки в результат не попадают", () => {
    const players: ServerPlayer[] = [
      { index: 0, rawName: "[ЧУЖИЕ] Незнакомец", name: "Незнакомец", score: 0, duration: 0 },
      { index: 1, rawName: "[ATK] Скиф", name: "Скиф", score: 0, duration: 0 },
    ];
    const found = matchPlayersToMembers(players, roster);
    assert.equal(found.length, 1);
    assert.equal(found[0].callsign, "Скиф");
  });

  test("регистр, «ё» и знаки препинания не мешают сопоставлению", () => {
    const players: ServerPlayer[] = [
      { index: 0, rawName: "[ATK] ШТУРМАН 1.", name: "ШТУРМАН 1.", score: 0, duration: 0 },
    ];
    const found = matchPlayersToMembers(players, roster);
    assert.equal(found[0].id, 3);
  });

  test("дубликат позывного не даёт двух записей об одном бойце", () => {
    const players: ServerPlayer[] = [
      { index: 0, rawName: "[ATK] Скиф", name: "Скиф", score: 0, duration: 0 },
      { index: 1, rawName: "[ATK] Скиф (AFK)", name: "Скиф (AFK)", score: 0, duration: 0 },
    ];
    const found = matchPlayersToMembers(players, roster);
    assert.equal(found.length, 1);
  });

  test("пустой состав или пустой сервер — пустой результат", () => {
    assert.deepEqual(matchPlayersToMembers([], roster), []);
    const players: ServerPlayer[] = [
      { index: 0, rawName: "[ATK] Скиф", name: "Скиф", score: 0, duration: 0 },
    ];
    assert.deepEqual(matchPlayersToMembers(players, []), []);
  });
});

/* ------------------------------------------------------------------ */
/* A2S: сетевой слой и кэш                                             */
/* ------------------------------------------------------------------ */

describe("A2S: сетевой слой", () => {
  test("адрес не настроен — запрос не идёт в сеть и объясняет причину", async () => {
    const result = await queryServer({ config: null });
    assert.equal(result.online, false);
    assert.equal(result.onlineCount, 0);
    assert.deepEqual(result.players, []);
    assert.match(String(result.error), /не настроен/);
  });

  test("молчащий сервер — это «нет данных», а не исключение", async () => {
    // Порт 1 на localhost никто не слушает: UDP-ответа не будет, сработает таймаут.
    // Ровно так выглядит выключенный игровой сервер — кабинет не должен падать.
    const result = await queryServer({
      config: { host: "127.0.0.1", port: 1 },
      timeoutMs: 120,
    });
    assert.equal(result.online, false);
    assert.match(String(result.error), /не ответил/);
  });

  test("повторный запрос в пределах TTL не выходит в сеть (защита от флуда)", async () => {
    // Первый вызов занимает кэш, второй с тем же адресом обязан вернуть его без
    // нового UDP-обмена: если бы он снова ждал таймаут, тест это заметил бы.
    const config = { host: "127.0.0.1", port: 1 };
    await queryServer({ config, timeoutMs: 100 });
    const startedAt = Date.now();
    const second = await queryServer({ config, timeoutMs: 100 });
    const elapsed = Date.now() - startedAt;

    assert.equal(second.online, false);
    assert.ok(elapsed < 80, `повторный запрос должен брать кэш, а не ждать таймаут (${elapsed} мс)`);
  });

  test("force перебивает кэш и снова опрашивает сервер", async () => {
    const config = { host: "127.0.0.1", port: 1 };
    await queryServer({ config, timeoutMs: 80 });
    const startedAt = Date.now();
    await queryServer({ config, timeoutMs: 80, force: true });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed >= 60, `с force должен пройти реальный опрос (${elapsed} мс)`);
  });
});