#!/usr/bin/env tsx
/**
 * Исправление некорректных Discord ID в базе данных
 * Заменяет строковые "null" на SQL NULL
 */

import { db } from '../src/db';
import { members } from '../src/db/schema';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('🔧 Исправление некорректных Discord ID...\n');

  // Найти все записи с некорректными Discord ID
  const invalidMembers = await db
    .select({ id: members.id, callsign: members.callsign, discordId: members.discordId })
    .from(members)
    .where(sql`${members.discordId} IS NOT NULL`);

  const toFix = invalidMembers.filter(m =>
    m.discordId && !/^\d{17,19}$/.test(m.discordId)
  );

  if (toFix.length === 0) {
    console.log('✅ Некорректных Discord ID не найдено');
    process.exit(0);
  }

  console.log(`⚠️  Найдено ${toFix.length} записей с некорректными Discord ID:`);
  for (const m of toFix) {
    console.log(`  - ${m.callsign} (ID ${m.id}): discordId="${m.discordId}"`);
  }

  console.log('\n🔄 Установка NULL для некорректных записей...');

  for (const m of toFix) {
    await db
      .update(members)
      .set({ discordId: null })
      .where(sql`${members.id} = ${m.id}`);
  }

  console.log(`✅ Исправлено ${toFix.length} записей\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Ошибка:', err);
  process.exit(1);
});
