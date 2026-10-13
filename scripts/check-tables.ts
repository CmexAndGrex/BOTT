import 'dotenv/config';
import { db } from '../src/db/index.js';
import { sql } from 'drizzle-orm';

async function checkTables() {
  try {
    const result = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log('Таблицы в базе данных:');
    console.log(result.rows);
  } catch (error) {
    console.error('Ошибка:', error);
  } finally {
    process.exit(0);
  }
}

checkTables();
