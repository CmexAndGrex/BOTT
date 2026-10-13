import 'dotenv/config';
import { db } from '../src/db/index.js';
import { members } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

async function checkDiscordIds() {
  try {
    const allMembers = await db.select({
      id: members.id,
      callsign: members.callsign,
      discordId: members.discordId,
    }).from(members);

    console.log('Проверка Discord ID в базе:');
    console.log('─'.repeat(80));

    let validCount = 0;
    let invalidCount = 0;

    // Discord ID должен быть строкой из 17-19 цифр (snowflake)
    const discordIdPattern = /^\d{17,19}$/;

    for (const member of allMembers) {
      const isValid = member.discordId && discordIdPattern.test(member.discordId);

      if (isValid) {
        validCount++;
      } else {
        invalidCount++;
        console.log(`❌ [${member.id}] ${member.callsign}: "${member.discordId}" (невалидный)`);
      }
    }

    console.log('─'.repeat(80));
    console.log(`\n✅ Валидных: ${validCount}`);
    console.log(`❌ Невалидных: ${invalidCount}`);
    console.log(`📊 Всего: ${allMembers.length}`);

  } catch (error) {
    console.error('Ошибка:', error);
  } finally {
    process.exit(0);
  }
}

checkDiscordIds();
