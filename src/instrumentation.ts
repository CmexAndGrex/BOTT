export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 1. Запуск существующих фоновых задач (планировщик)
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();

    // 2. Подгружаем и запускаем нашего слушателя Discord
    const { initBot } = await import("@/lib/bot");
    initBot();
  }
}