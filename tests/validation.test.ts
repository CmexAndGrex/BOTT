/**
 * Тесты валидации и логики из src/lib/validation.ts (Этап 3: L3–L7).
 *
 * Запуск: npm run test
 * Тестируется именно боевой модуль (не копия логики), поэтому тест ловит
 * регрессию, если правила изменят в src/.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CooldownLimiter,
  nextWarningCount,
  isDiscordId,
  assertDiscordId,
  firstSafeOrigin,
  normalizeUrl,
} from "../src/lib/validation.ts";

describe("L4 — nextWarningCount (инкремент вместо перезаписи)", () => {
  test("первое предупреждение 0 → 1", () => {
    assert.equal(nextWarningCount(0, 1), 1);
  });

  test("повторная выдача «1/2» увеличивает счётчик, а не сбрасывает", () => {
    // Регрессия: раньше было `type === 1 ? 1 : 2`, и боец с 1 становился 1
    assert.equal(nextWarningCount(1, 1), 2);
  });

  test("счётчик не превышает 2", () => {
    assert.equal(nextWarningCount(2, 1), 2);
    assert.equal(nextWarningCount(2, 2), 2);
    assert.equal(nextWarningCount(5, 2), 2);
  });

  test("явный тип 2 сразу доводит до исключения", () => {
    assert.equal(nextWarningCount(0, 2), 2);
    assert.equal(nextWarningCount(1, 2), 2);
  });

  test("устойчивость к мусорным значениям из БД", () => {
    assert.equal(nextWarningCount(Number.NaN, 1), 1);
    assert.equal(nextWarningCount(-3, 1), 1);
    assert.equal(nextWarningCount(1.7, 1), 2);
  });

describe("L3 — CooldownLimiter (лимит per-user, а не глобальный)", () => {
  test("первый запрос разрешён, повторный в окне — нет", () => {
    const limiter = new CooldownLimiter(3000);
    assert.equal(limiter.allow("officer1:10", 1000), true);
    assert.equal(limiter.allow("officer1:10", 1100), false);
  });

  test("разные офицеры не блокируют друг друга (главная регрессия)", () => {
    const limiter = new CooldownLimiter(3000);
    assert.equal(limiter.allow("officer1:10", 1000), true);
    assert.equal(limiter.allow("officer2:10", 1000), true, "второй офицер не должен быть заблокирован");
  });

  test("один офицер не блокируется разными бойцами", () => {
    const limiter = new CooldownLimiter(3000);
    assert.equal(limiter.allow("officer1:10", 1000), true);
    assert.equal(limiter.allow("officer1:11", 1000), true, "другой боец — другой ключ");
  });

  test("после истечения окна запрос снова разрешён", () => {
    const limiter = new CooldownLimiter(3000);
    assert.equal(limiter.allow("k", 1000), true);
    assert.equal(limiter.allow("k", 3999), false);
    assert.equal(limiter.allow("k", 4000), true);
  });

  test("карта не растёт бесконечно: устаревшие ключи вычищаются", () => {
    const limiter = new CooldownLimiter(10, 50, 1000);
    // Ключи идут с большим шагом по времени — к моменту переполнения
    // предыдущие становятся «устаревшими» и выбрасываются
    for (let i = 0; i < 60; i++) limiter.allow(`key${i}`, i * 1000);
    assert.ok(limiter.size <= 50, `размер карты ${limiter.size} превысил предел`);
  });

  test("жёсткий предел соблюдается и при плотном потоке (без устаревших)", () => {
    const limiter = new CooldownLimiter(1, 50, 10_000_000);
    // Все запросы в одну миллисекунду: «устаревших» нет, вытесняем самые старые
    for (let i = 0; i < 500; i++) limiter.allow(`key${i}`, 1000);
    assert.ok(limiter.size <= 50, `размер карты ${limiter.size} превысил предел`);
  });

  test("лимит не блокирует первого бойца при нулевой метке времени", () => {
    const limiter = new CooldownLimiter(3000);
    // Граничный случай: раньше отсутствие ключа читалось как «время 0»
    assert.equal(limiter.allow("officer1:10", 0), true);
  });
});

describe("L5 — проверка ID Discord (защита от подмены пути API)", () => {
  test("корректная снежинка проходит", () => {
    assert.equal(isDiscordId("1085141850966458519"), true);
    assert.equal(isDiscordId("  1085141850966458519  "), true);
  });

  test("path injection в путь Discord API отклоняется", () => {
    assert.equal(isDiscordId("123/../../users/@me"), false);
    assert.equal(isDiscordId("123/../../channels/1"), false);
  });

  test("query-строка и нецифровые символы отклоняются", () => {
    assert.equal(isDiscordId("123?limit=100"), false);
    assert.equal(isDiscordId("abc123"), false);
    assert.equal(isDiscordId("12 3"), false);
    assert.equal(isDiscordId(""), false);
    assert.equal(isDiscordId(null), false);
    assert.equal(isDiscordId(undefined), false);
  });

describe("L6 — firstSafeOrigin (безопасный адрес панели)", () => {
  test("нормальный домен принимается", () => {
    assert.equal(firstSafeOrigin(["https://panel.example.ru"]), "https://panel.example.ru");
  });

  test("PANEL_URL имеет приоритет над заголовками запроса", () => {
    // Регрессия: раньше приоритет был у клиентского Referer/X-Forwarded-Host
    assert.equal(
      firstSafeOrigin(["https://panel.example.ru", "https://evil.com"]),
      "https://panel.example.ru"
    );
  });

  test("инъекция в путь нормализуется до origin", () => {
    assert.equal(
      firstSafeOrigin(["https://panel.example.ru/../../x"]),
      "https://panel.example.ru"
    );
  });

  test("небезопасная схема отклоняется", () => {
    assert.equal(firstSafeOrigin(["javascript:alert(1)"]), null);
  });

  test("мусор вместо хоста отклоняется, берётся следующий кандидат", () => {
    assert.equal(firstSafeOrigin(["not a host!!"]), null);
    assert.equal(
      firstSafeOrigin(["not a host!!", "https://panel.example.ru"]),
      "https://panel.example.ru"
    );
  });

  test("пробелы обрезаются, порт сохраняется", () => {
    assert.equal(firstSafeOrigin(["  https://panel.example.ru  "]), "https://panel.example.ru");
    assert.equal(
      firstSafeOrigin(["https://panel.example.ru:8443"]),
      "https://panel.example.ru:8443"
    );
  });

  test("пустой список даёт null", () => {
    assert.equal(firstSafeOrigin([]), null);
    assert.equal(firstSafeOrigin(["", ""]), null);
  });
});

describe("L7 — normalizeUrl (усиленная фильтрация ссылок)", () => {
  test("обычные ссылки принимаются", () => {
    assert.ok(normalizeUrl("https://example.com/doc"));
    assert.ok(normalizeUrl("example.com/doc"));
    assert.ok(normalizeUrl("http://8.8.8.8"));
  });

  test("опасные схемы отклоняются", () => {
    assert.equal(normalizeUrl("javascript:alert(1)"), null);
    assert.equal(normalizeUrl("data:text/html,<script>"), null);
    assert.equal(normalizeUrl("vbscript:msgbox"), null);
    assert.equal(normalizeUrl("file:///etc/passwd"), null);
  });

  test("ссылки с логином/паролем отклоняются (маскировка домена)", () => {
    assert.equal(normalizeUrl("https://user:pass@evil.com"), null);
    assert.equal(normalizeUrl("https://user@evil.com"), null);
  });

  test("локальные адреса отклоняются", () => {
    assert.equal(normalizeUrl("http://localhost:3000"), null);
    assert.equal(normalizeUrl("http://svc.internal"), null);
    assert.equal(normalizeUrl("http://host.local"), null);
    assert.equal(normalizeUrl("http://0.0.0.0"), null);
  });

  test("приватные диапазоны IPv4 отклоняются", () => {
    assert.equal(normalizeUrl("http://127.0.0.1"), null);
    assert.equal(normalizeUrl("http://10.0.0.1"), null);
    assert.equal(normalizeUrl("http://192.168.1.5/admin"), null);
    assert.equal(normalizeUrl("http://172.16.0.1"), null);
    assert.equal(normalizeUrl("http://172.31.255.255"), null);
    assert.equal(normalizeUrl("http://169.254.169.254"), null);
  });

  test("публичный IP и соседние диапазоны принимаются", () => {
    assert.ok(normalizeUrl("http://172.32.0.1"));
    assert.ok(normalizeUrl("http://192.169.0.1"));
  });

  test("пустая строка даёт null", () => {
    assert.equal(normalizeUrl("   "), null);
  });
});
  test("слишком короткое и слишком длинное значение отклоняются", () => {
    assert.equal(isDiscordId("123"), false);
    assert.equal(isDiscordId("1".repeat(26)), false);
  });

  test("assertDiscordId возвращает нормализованный ID", () => {
    assert.equal(assertDiscordId(" 1085141850966458519 ", "ID канала"), "1085141850966458519");
  });

  test("assertDiscordId бросает на подмене пути", () => {
    assert.throws(() => assertDiscordId("123/../x", "ID канала"), /Некорректный ID канала/);
  });
});
  test("счётчик монотонно не убывает", () => {
    let cur = 0;
    for (const type of [1, 1, 1, 2, 1] as const) {
      const next = nextWarningCount(cur, type);
      assert.ok(next >= cur, `счётчик убыл: ${cur} → ${next}`);
      cur = next;
    }
    assert.equal(cur, 2);
  });
});