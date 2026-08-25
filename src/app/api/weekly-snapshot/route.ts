import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { members, weeklyStats } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  // Защита, чтобы никто случайно не вызвал этот скрипт раньше времени
  const key = req.nextUrl.searchParams.get("key");
  if (key !== "super-cron-key-123") {
    return NextResponse.json({ error: "Неверный ключ" }, { status: 403 });
  }

  try {
    // 1. Получаем всех активных бойцов из базы
    const allMembers = await db.select().from(members).where(eq(members.active, true));
    let processedCount = 0;

    for (const fighter of allMembers) {
      // 2. Сохраняем слепок часов за эту неделю в новую таблицу истории
      await db.insert(weeklyStats).values({
        memberId: fighter.id,
        hours: fighter.hours,
        vacation: fighter.vacation,
      });

      // 3. Умная логика выдачи предупреждений (0, 1 или 2)
      let newWarnings = fighter.warnings;

      // Если боец НЕ в отпуске, проверяем его часы
      if (!fighter.vacation) {
        if (fighter.hours < 10) {
          // Наиграл мало — даем +1 предупреждение
          newWarnings += 1;
        } else {
          // Наиграл больше 10 часов — он молодец, сбрасываем старые наказания до нуля
          newWarnings = 0;
        }
      }

      // Максимальный уровень наказания — 2 (на исключение)
      if (newWarnings > 2) newWarnings = 2;

      // 4. Обновляем статус бойца в основной таблице
      await db.update(members)
        .set({ warnings: newWarnings })
        .where(eq(members.id, fighter.id));
        
      processedCount++;
    }

    return NextResponse.json({ 
      ok: true, 
      message: `Недельный срез успешно выполнен. Обработано бойцов: ${processedCount}` 
    });

  } catch (error) {
    console.error("Ошибка недельного среза:", error);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}