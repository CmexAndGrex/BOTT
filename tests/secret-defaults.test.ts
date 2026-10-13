/**
 * Секреты-заглушки: JWT_SECRET и CRON_SECRET из .env.example.
 *
 * Почему это отдельный тест. Оба секрета лежат в открытом файле примера, то
 * есть известны любому, кто видит репозиторий. Заглушка JWT_SECRET позволяет
 * подписать токен с ролью admin (полный доступ к панели и удалению профилей),
 * заглушка CRON_SECRET — дёргать расписание от имени системы (снимки
 * статистики, синхронизация ролей). Поэтому главное утверждение здесь одно:
 * в production значения из примера не принимаются, в разработке — принимаются,
 * иначе локальный запуск превратился бы в возню с .env.
 *
 * Проверяется боевой код (src/lib/auth.ts, src/lib/api-auth.ts), а не копия
 * правил в тесте — иначе правило можно было бы откатить незаметно.
 *
 * Запуск: npm run test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { getJwtSecret } from "@/lib/auth.ts";
import { authorizeCron } from "@/lib/api-auth.ts";

const root = process.cwd();

/** Значения берём из .env.example: тест сторожит именно тот файл, что читают люди */
function exampleValue(key: string): string {
  const source = readFileSync(path.join(root, ".env.example"), "utf8");
  const match = source.match(new RegExp(`^${key}=(.*)$`, "m"));
  assert.ok(match, `.env.example должен содержать ${key}`);
  return match[1].trim();
}

/** Cron-запрос с секретом в заголовке (основной способ внешних расписаний) */
function cronRequest(secret: string): NextRequest {
  const headers = new Headers();
  headers.set("x-cron-secret", secret);
  return new NextRequest(new URL("http://panel.example/api/daily-snapshot"), {
    method: "GET",
    headers,
  });
}

/**
 * Правка окружения на время одного теста.
 *
 * Модуль auth кэширует секрет в памяти (cachedSecret), поэтому менять
 * переменные можно только ДО первого вызова getJwtSecret() — этот файл
 * импортирует модуль, но не вызывает функцию на этапе загрузки, а тесты идут
 * по порядку, поэтому подмена безопасна.
 */
function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/* ------------------------------------------------------------------ */
/* JWT_SECRET                                                          */
/* ------------------------------------------------------------------ */

describe("JWT_SECRET: заглушки не принимаются в production", () => {
  test("заглушка из .env.example не даёт поднять приложение", () => {
    const placeholder = exampleValue("JWT_SECRET");
    assert.equal(placeholder.length >= 32, true, "заглушка из примера длиннее 32 символов");

    // Раньше проверялось только «your_random_jwt_secret_here», и значение из
    // .env.example проходило: длина его не спасает — оно общеизвестно.
    withEnv({ NODE_ENV: "production", JWT_SECRET: placeholder }, () => {
      assert.throws(() => getJwtSecret(), /по умолчанию/);
    });
  });

  test("случайный секрет в production принимается", () => {
    withEnv(
      { NODE_ENV: "production", JWT_SECRET: "s7Fq2Lm9Zx4Tn6Bv1Kd8Rw3Yp5Hg0Jc2" },
      () => {
        assert.equal(getJwtSecret().length > 0, true);
      }
    );
  });

  test("в разработке заглушка допустима: локальный запуск не должен ломаться", () => {
    const placeholder = exampleValue("JWT_SECRET");
    withEnv({ NODE_ENV: "development", JWT_SECRET: placeholder }, () => {
      assert.equal(getJwtSecret().length > 0, true);
    });
  });
});

/* ------------------------------------------------------------------ */
/* CRON_SECRET                                                         */
/* ------------------------------------------------------------------ */

describe("CRON_SECRET: заглушка из .env.example закрывает cron в production", () => {
  test("в production запрос с заглушкой отклоняется 503-ошибкой конфигурации", () => {
    const placeholder = exampleValue("CRON_SECRET");
    withEnv({ NODE_ENV: "production", CRON_SECRET: placeholder }, () => {
      const result = authorizeCron(cronRequest(placeholder));
      assert.equal(result.ok, false, "секрет-заглушка не должен пускать");
      if (!result.ok) {
        // 503, а не 403: это ошибка настройки сервера, а не неверный ключ
        assert.equal(result.response.status, 503);
      }
    });
  });

  test("в production собственный секрет работает как прежде", () => {
    withEnv({ NODE_ENV: "production", CRON_SECRET: "own-secret-9f2c7a4e" }, () => {
      assert.equal(authorizeCron(cronRequest("own-secret-9f2c7a4e")).ok, true);
      // Неверный ключ: заголовки HTTP — только ASCII, поэтому и «чужой» здесь
      // записан латиницей (кириллица в Headers.set падает до самой проверки).
      assert.equal(authorizeCron(cronRequest("wrong-secret-000000")).ok, false);
    });
  });

  test("вне production заглушка проходит: разработке нужен простой вход", () => {
    const placeholder = exampleValue("CRON_SECRET");
    withEnv({ NODE_ENV: "development", CRON_SECRET: placeholder }, () => {
      assert.equal(authorizeCron(cronRequest(placeholder)).ok, true);
    });
  });

  test("пустой CRON_SECRET — ошибка конфигурации в любом режиме", () => {
    withEnv({ CRON_SECRET: "   " }, () => {
      const result = authorizeCron(cronRequest(""));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.response.status, 503);
    });
  });
});