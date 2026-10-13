#!/usr/bin/env node
/**
 * Оффлайн-проверка модулей с реальной базой данных
 * Не требует запущенного веб-сервера
 */

import 'dotenv/config';
import { db } from '../src/db/index.js';
import { members, recruitApplications, serviceReports, settings } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { isCallsign } from '../src/lib/recruits.js';

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

async function main() {
  console.log('\n========================================================');
  console.log('🔍 ОФФЛАЙН ПРОВЕРКА МОДУЛЕЙ С БАЗОЙ ДАННЫХ');
  console.log('========================================================\n');

  // Модуль 1: Подключение к базе данных
  console.log('--- Модуль 1: Подключение к БД ---');
  try {
    const result = await db.execute(sql`SELECT 1 as test`);
    if (result.rows.length > 0) {
      pass('1. База данных', 'Подключение успешно', 'PostgreSQL доступен');
    } else {
      fail('1. База данных', 'Подключение успешно', 'Пустой результат');
    }
  } catch (error) {
    fail('1. База данных', 'Подключение успешно', String(error));
  }

  // Модуль 2: Таблицы существуют
  console.log('\n--- Модуль 2: Проверка схемы БД ---');
  const tables = ['division_members', 'recruit_applications', 'service_reports', 'bot_settings'];
  for (const table of tables) {
    try {
      const result = await db.execute(sql.raw(`SELECT COUNT(*) FROM ${table}`));
      const count = result.rows[0]?.count || 0;
      pass('2. Схема БД', `Таблица ${table} существует`, `Записей: ${count}`);
    } catch (error) {
      fail('2. Схема БД', `Таблица ${table} существует`, String(error));
    }
  }

  // Модуль 3: Валидация позывных
  console.log('\n--- Модуль 3: Валидация данных ---');
  const validCallsigns = ['Призрак', 'Ghost-1', 'Альфа_01'];
  const invalidCallsigns = ['', '123', 'a', 'ThisCallsignIsWayTooLongAndExceeds32CharacterLimit'];

  let allValid = true;
  for (const cs of validCallsigns) {
    if (!isCallsign(cs)) {
      allValid = false;
      fail('3. Валидация', `Корректный позывной "${cs}"`, 'Отклонён валидатором');
    }
  }

  let allInvalid = true;
  for (const cs of invalidCallsigns) {
    if (isCallsign(cs)) {
      allInvalid = false;
      fail('3. Валидация', `Некорректный позывной "${cs}"`, 'Принят валидатором');
    }
  }

  if (allValid && allInvalid) {
    pass('3. Валидация', 'Валидация позывных (isCallsign)', 'Все тесты пройдены');
  }

  // Модуль 4: Валидация Discord ID
  console.log('\n--- Модуль 4: Проверка Discord ID в БД ---');
  try {
    const membersWithDiscord = await db.select({ discordId: members.discordId })
      .from(members)
      .limit(5);

    if (membersWithDiscord.length > 0) {
      const allValid = membersWithDiscord.every(m =>
        m.discordId && /^\d{17,19}$/.test(m.discordId)
      );
      if (allValid) {
        pass('4. Discord ID', 'Формат Discord ID корректен',
          `Проверено ${membersWithDiscord.length} записей`);
      } else {
        fail('4. Discord ID', 'Формат Discord ID корректен', 'Найдены некорректные ID');
      }
    } else {
      pass('4. Discord ID', 'Формат Discord ID корректен', 'Нет данных для проверки');
    }
  } catch (error) {
    fail('4. Discord ID', 'Формат Discord ID корректен', String(error));
  }

  // Модуль 5: Загрузка настроек
  console.log('\n--- Модуль 5: Настройки системы ---');
  try {
    const allSettings = await db.select().from(settings);
    if (allSettings.length > 0) {
      pass('5. Настройки', 'Таблица settings заполнена', `Настроек: ${allSettings.length}`);
    } else {
      fail('5. Настройки', 'Таблица settings заполнена', 'Нет ни одной настройки');
    }
  } catch (error) {
    fail('5. Настройки', 'Таблица settings заполнена', String(error));
  }

  // Модуль 6: Кандидаты
  console.log('\n--- Модуль 6: Приём и кандидаты ---');
  try {
    const allRecruits = await db.select().from(recruitApplications);
    pass('6. Приём', 'Таблица recruitApplications доступна', `Кандидатов: ${allRecruits.length}`);

    const pendingRecruits = allRecruits.filter(r => r.status === 'pending');
    const approvedRecruits = allRecruits.filter(r => r.status === 'approved');
    const rejectedRecruits = allRecruits.filter(r => r.status === 'rejected');

    pass('6. Приём', 'Статусы кандидатов',
      `pending: ${pendingRecruits.length}, approved: ${approvedRecruits.length}, rejected: ${rejectedRecruits.length}`);
  } catch (error) {
    fail('6. Приём', 'Таблица recruitApplications доступна', String(error));
  }

  // Модуль 7: Рапорты
  console.log('\n--- Модуль 7: Рапорты и экзамены ---');
  try {
    const allReports = await db.select().from(serviceReports);
    pass('7. Рапорты', 'Таблица serviceReports доступна', `Рапортов: ${allReports.length}`);

    const pendingReports = allReports.filter(r => r.status === 'pending');
    const approvedReports = allReports.filter(r => r.status === 'approved');
    const rejectedReports = allReports.filter(r => r.status === 'rejected');

    pass('7. Рапорты', 'Статусы рапортов',
      `pending: ${pendingReports.length}, approved: ${approvedReports.length}, rejected: ${rejectedReports.length}`);
  } catch (error) {
    fail('7. Рапорты', 'Таблица serviceReports доступна', String(error));
  }

  // Модуль 8: Личный состав
  console.log('\n--- Модуль 8: Личный состав ---');
  try {
    const allMembers = await db.select().from(members);
    pass('8. Состав', 'Таблица members доступна', `Бойцов: ${allMembers.length}`);

    // Проверка, что passwordHash присутствует в схеме (для авторизации)
    if (allMembers.length > 0) {
      const sample = allMembers[0];
      if ('passwordHash' in sample && sample.passwordHash !== null) {
        pass('8. Состав', 'Поле passwordHash в БД', 'Хеши сохранены для авторизации');
      } else {
        fail('8. Состав', 'Поле passwordHash в БД', 'Хеши отсутствуют');
      }
    }
  } catch (error) {
    fail('8. Состав', 'Таблица members доступна', String(error));
  }

  // Модуль 9: Проверка структуры данных бойцов
  console.log('\n--- Модуль 9: Структура данных бойцов ---');
  try {
    const testMember = await db.select().from(members).limit(1);
    if (testMember.length > 0) {
      const member = testMember[0];
      const hasRequiredFields = 'callsign' in member && 'discordId' in member && 'rank' in member;
      if (hasRequiredFields) {
        pass('9. Структура', 'Обязательные поля присутствуют',
          `callsign, discordId, rank проверены`);
      } else {
        fail('9. Структура', 'Обязательные поля присутствуют', 'Некоторые поля отсутствуют');
      }
    } else {
      fail('9. Структура', 'Обязательные поля присутствуют', 'Нет бойцов для теста');
    }
  } catch (error) {
    fail('9. Структура', 'Обязательные поля присутствуют', String(error));
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
