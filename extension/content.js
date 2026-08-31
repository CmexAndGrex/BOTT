// Функция ищет скрытый блок с настройками на сайте
function checkConfig() {
    const dataElement = document.getElementById('atk-extension-data');
    if (dataElement) {
        const serverUrl = dataElement.getAttribute('data-url');
        const syncKey = dataElement.getAttribute('data-key');
        
        if (serverUrl && syncKey) {
            // Отправляем данные в фоновый скрипт для сохранения
            chrome.runtime.sendMessage({
                type: 'SAVE_CONFIG',
                serverUrl: serverUrl,
                syncKey: syncKey
            });
        }
    }
}

// Запускаем при загрузке страницы
checkConfig();

// Слушаем изменения на странице (важно для Next.js, так как сайт грузится без перезагрузки страниц)
const observer = new MutationObserver(checkConfig);
observer.observe(document.body, { childList: true, subtree: true });