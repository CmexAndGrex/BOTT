#!/usr/bin/env tsx
/**
 * Исправление некорректных Discord ID в базе данных.
 *
 * Проблема: при импорте из Google Sheets записывались строки "null" вместо SQL NULL.
 * Этот скрипт находит и исправляет такие записи.
 */

import "dotenv/config";
import { db } from "@/db";
import { members } from "@/db/schema";
import { sql } from "drizzle-orm";

async function main() {
  console.log("🔍 Поиск некорректных Discord ID...");

  // Найти все записи со строкой "null" в discordId
  const invalidRecords = await db
    .select({ id: members.id, callsign: members.callsign, discordId: members.discordId })
    .from(members)
    .where(sql`${members.discordId} = 'null'`);

  console.log(`Найдено записей с discordId = "null": ${invalidRecords.length}`);

  if (invalidRecords.length === 0) {
    console.log("✅ Все записи корректны!");
    return;
  }

  console.log("\nНекорректные записи:");
  invalidRecords.forEach(r => {
    console.log(`  - ID: ${r.id}, Позывной: ${r.callsign}, Discord ID: "${r.discordId}"`);
  });

  // Исправить: заменить "null" на SQL NULL
  console.log("\n🔧 Исправление записей...");
  const result = await db
    .update(members)
    .set({ discordId: null })
    .where(sql`${members.discordId} = 'null'`);

  console.log(`✅ Исправлено записей: ${result.rowCount ?? 0}`);

  // Проверка
  const remaining = await db
    .select({ id: members.id })
    .from(members)
    .where(sql`${members.discordId} = 'null'`);

  if (remaining.length === 0) {
    console.log("✅ Все некорректные записи успешно исправлены!");
  } else {
    console.error(`❌ Осталось некорректных записей: ${remaining.length}`);
  }
}

main().catch(console.error);
