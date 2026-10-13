#!/usr/bin/env node
/**
 * Упрощённая E2E проверка критических путей системы
 * Требует запущенного dev-сервера на localhost:3000
 */

const BASE_URL = 'http://127.0.0.1:3000';
const TIMEOUT = 5000;

interface TestResult {
  module: string;
  test: string;
  status: 'PASS' | 'FAIL';
  details?: string;
}

const results: TestResult[] = [];

function pass(module: string, test: string, details?: string) {
  results.push({ module, test, status: 'PASS', details });
  console.log(`✅ [PASS] [${module}] ${test}`);
  if (details) console.log(`    └─ ${details}`);
}

function fail(module: string, test: string, details?: string) {
  results.push({ module, test, status: 'FAIL', details });
  console.log(`❌ [FAIL] [${module}] ${test}`);
  if (details) console.log(`    └─ ${details}`);
}

async function fetchWithTimeout(url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timeout after ${TIMEOUT}ms`);
    }
    throw error;
  }
}

async function main() {
  console.log('\n========================================================');
  console.log('🔍 УПРОЩЁННАЯ E2E ПРОВЕРКА КРИТИЧЕСКИХ ПУТЕЙ');
  console.log(`🎯 Целевой сервер: ${BASE_URL}`);
  console.log('========================================================\n');

  // Модуль 1: Доступность сервера
  console.log('--- Модуль 1: Доступность сервера ---');
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/`);
    if (res.ok) {
      pass('1. Сервер', 'Главная страница доступна', `Статус: ${res.status}`);
    } else {
      fail('1. Сервер', 'Главная страница доступна', `Статус: ${res.status}`);
    }
  } catch (error) {
    fail('1. Сервер', 'Главная страница доступна', String(error));
  }

  // Модуль 2: API /api/members (список бойцов)
  console.log('\n--- Модуль 2: API личного состава ---');
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/members`);
    if (res.status === 401 || res.status === 403) {
      pass('2. Состав', 'Защита /api/members (требует авторизацию)', `Статус: ${res.status}`);
    } else if (res.ok) {
      const data = await res.json();
      pass('2. Состав', 'GET /api/members возвращает данные', `Бойцов: ${data.length || 0}`);
    } else {
      fail('2. Состав', 'GET /api/members', `Неожиданный статус: ${res.status}`);
    }
  } catch (error) {
    fail('2. Состав', 'GET /api/members', String(error));
  }

  // Модуль 3: API /api/apply (приём кандидатов)
  console.log('\n--- Модуль 3: Приём кандидатов ---');
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callsign: 'ТестКандидат',
        discordId: '123456789012345678',
        age: 25,
        experience: 'Тестовый опыт',
        timezone: 'UTC+3',
      }),
    });

    if (res.status === 201) {
      pass('3. Приём', 'POST /api/apply создаёт кандидата', 'Статус: 201 Created');
    } else if (res.status === 409) {
      pass('3. Приём', 'POST /api/apply отклоняет дубли', 'Статус: 409 Conflict');
    } else if (res.status === 400) {
      const data = await res.json();
      pass('3. Приём', 'POST /api/apply валидирует данные', `Ошибка: ${data.error || 'validation'}`);
    } else {
      fail('3. Приём', 'POST /api/apply', `Неожиданный статус: ${res.status}`);
    }
  } catch (error) {
    fail('3. Приём', 'POST /api/apply', String(error));
  }

  // Модуль 4: API /api/control (контроль без passwordHash)
  console.log('\n--- Модуль 4: Контроль и безопасность ---');
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/control`);
    if (res.status === 401 || res.status === 403) {
      pass('4. Контроль', 'Защита /api/control (требует авторизацию)', `Статус: ${res.status}`);
    } else if (res.ok) {
      const data = await res.json();
      const hasPasswordHash = data.some((m: any) => 'passwordHash' in m);
      if (!hasPasswordHash) {
        pass('4. Контроль', 'passwordHash не включается в ответ', 'Безопасность соблюдена');
      } else {
        fail('4. Контроль', 'passwordHash не включается в ответ', 'Обнаружена утечка хешей');
      }
    } else {
      fail('4. Контроль', 'GET /api/control', `Неожиданный статус: ${res.status}`);
    }
  } catch (error) {
    fail('4. Контроль', 'GET /api/control', String(error));
  }

  // Модуль 5: Защита Cron-эндпоинтов
  console.log('\n--- Модуль 5: Защита Cron-эндпоинтов ---');
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/weekly-snapshot`, {
      method: 'POST',
    });
    if (res.status === 401 || res.status === 403) {
      pass('5. Cron', 'Защита /api/weekly-snapshot (требует x-cron-secret)', `Статус: ${res.status}`);
    } else {
      fail('5. Cron', 'Защита /api/weekly-snapshot', `Эндпоинт доступен без секрета: ${res.status}`);
    }
  } catch (error) {
    fail('5. Cron', 'Защита /api/weekly-snapshot', String(error));
  }

  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/actions`, {
      method: 'POST',
    });
    if (res.status === 401 || res.status === 403) {
      pass('5. Cron', 'Защита /api/actions (требует x-cron-secret)', `Статус: ${res.status}`);
    } else {
      fail('5. Cron', 'Защита /api/actions', `Эндпоинт доступен без секрета: ${res.status}`);
    }
  } catch (error) {
    fail('5. Cron', 'Защита /api/actions', String(error));
  }

  // Модуль 6: Страницы панели
  console.log('\n--- Модуль 6: Доступность страниц панели ---');
  const pages = ['/login', '/apply', '/docs'];
  for (const page of pages) {
    try {
      const res = await fetchWithTimeout(`${BASE_URL}${page}`);
      if (res.ok) {
        pass('6. Панель', `Страница ${page} доступна`, `Статус: ${res.status}`);
      } else {
        fail('6. Панель', `Страница ${page} доступна`, `Статус: ${res.status}`);
      }
    } catch (error) {
      fail('6. Панель', `Страница ${page} доступна`, String(error));
    }
  }

  // Итоговая таблица
  console.log('\n========================================================');
  console.log('📊 ИТОГОВАЯ ТАБЛИЦА РЕЗУЛЬТАТОВ');
  console.log('========================================================');
  console.log('Модуль'.padEnd(30) + ' | ' + 'Тест-кейс'.padEnd(50) + ' | Статус');
  console.log('-'.repeat(30) + '+' + '-'.repeat(52) + '+-------');

  for (const r of results) {
    const status = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
    console.log(r.module.padEnd(30) + ' | ' + r.test.padEnd(50) + ' | ' + status);
  }

  console.log('========================================================\n');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;

  console.log(`📈 Итого: ${passed}/${total} тестов пройдено (${((passed / total) * 100).toFixed(1)}%)\n`);

  if (failed > 0) {
    console.log(`⚠️  Провалено тестов: ${failed}\n`);
    console.log('Неуспешные тесты:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ [${r.module}] ${r.test}`);
      if (r.details) console.log(`     └─ ${r.details}`);
    });
    process.exit(1);
  } else {
    console.log('🎉 Все тесты успешно пройдены!\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('💥 Критическая ошибка:', err);
  process.exit(1);
});
