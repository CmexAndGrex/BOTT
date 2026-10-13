import 'dotenv/config';
import { db } from '../src/db/index.js';
import { members } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

async function fixDiscordIds() {
  try {
    console.log('Исправление некорректных Discord ID в базе данных...\n');

    // Заменяем строки "null" на SQL NULL
    const result = await db
      .update(members)
      .set({ discordId: null })
      .where(sql`${members.discordId} = 'null' OR ${members.discordId} = '' OR ${members.discordId} !~ '^[0-9]{17,19}$'`);

    console.log('✅ Некорректные Discord ID очищены');
    console.log(`📊 Обработано записей: ${result.rowCount ?? 0}`);

  } catch (error) {
    console.error('❌ Ошибка при исправлении Discord ID:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

fixDiscordIds();
