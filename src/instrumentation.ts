export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Фоновые задачи (бот + планировщик) должны работать ровно в одном
    // инстансе: иначе при нескольких репликах бот подключается к Discord
    // многократно, а задачи дублируются. Лидер определяется через
    // advisory-lock PostgreSQL.
    const { acquireLeaderLock, instanceId } = await import("@/lib/leader");
    const role = await acquireLeaderLock();

    if (role === "follower") {
      console.log(
        `[init] Инстанс ${instanceId()}: фоновые задачи уже ведёт другой инстанс — этот работает только как веб-сервер`
      );
      return;
    }

    console.log(
      `[init] Инстанс ${instanceId()}: роль=${role}, запускаю фоновые задачи`
    );

    // 1. Запуск существующих фоновых задач (планировщик)
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();

    // 2. Обслуживание системы: синхронизация ШДС, резервные копии, очистка.
    //    Только здесь — после проверки лидер-лока: при нескольких репликах
    //    дампы и синхронизации пошли бы дублирующимися пачками, а ротация
    //    начала бы удалять файлы соседнего инстанса как «лишние».
    const { startMaintenanceScheduler } = await import("@/lib/sync-scheduler");
    startMaintenanceScheduler();

    // 3. Подгружаем и запускаем нашего слушателя Discord
    const { initBot } = await import("@/lib/bot");
    initBot();
  }
}
