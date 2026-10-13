#!/usr/bin/env bash
# clean-history.sh — помощник удаления файла из истории git.
#
# ПОЧЕМУ ОТДЕЛЬНЫЙ СКРИПТ. Переписывание истории — деструктивная и необратимая
# операция: сдвигаются все хеши коммитов, чужие клоны перестают совпадать с
# origin. Запускать её «одной командой из терминала» опасно, поэтому скрипт:
#   1. ПО УМОЛЧАНИЮ НИЧЕГО НЕ МЕНЯЕТ — печатает план и требуемые команды
#      (dry-run). Реальные изменения только с флагом --run;
#   2. работает в ОТДЕЛЬНОМ зеркале (../<repo>-clean), а не в рабочем каталоге,
#      чтобы оригинал остался нетронутым и была точка отката;
#   3. требует явно указать файл через --file.
#
# Запуск:
#   bash scripts/clean-history.sh --file backup-before-staging.sql
#   bash scripts/clean-history.sh --file backup-before-staging.sql --run
#
# После выполнения (см. SECURITY.md, раздел 4) обязательно:
#   * ротировать засветившиеся секреты;
#   * предупредить всех разработчиков: локальные клоны нужно переклонировать;
#   * запушить переписанную историю: git push --force --all && git push --force --tags
set -euo pipefail

TARGET_FILE=""
DO_RUN="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --file) TARGET_FILE="${2:-}"; shift 2 ;;
    --run) DO_RUN="true"; shift ;;
    -h|--help)
      echo "Использование: bash scripts/clean-history.sh --file <путь> [--run]"
      exit 0 ;;
    *)
      echo "Неизвестный аргумент: $1" >&2
      exit 2 ;;
  esac
done

if [ -z "$TARGET_FILE" ]; then
  echo "ОШИБКА: укажите файл через --file <путь>" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "ОШИБКА: запускать из git-репозитория" >&2
  exit 2
fi

echo "Файл для удаления из истории: $TARGET_FILE"
echo "Репозиторий: $REPO_ROOT"
echo ""

# Проверяем, есть ли файл в истории вообще — если нет, чистить нечего.
IN_HISTORY="$(git -C "$REPO_ROOT" log --all --oneline -- "$TARGET_FILE" | head -n 1 || true)"
if [ -z "$IN_HISTORY" ]; then
  echo "Файл '$TARGET_FILE' в истории НЕ найден."
  echo "Если он не отслеживался (например, локальный дамп backup-*.sql),"
  echo "чистка истории не нужна: достаточно убедиться, что он не попадёт в коммит"
  echo "(см. .gitignore) и удалить файл с диска."
  exit 0
fi

echo "ВНИМАНИЕ: файл присутствует в истории, например в коммите:"
echo "  $IN_HISTORY"
echo ""

if [ "$DO_RUN" != "true" ]; then
  echo "=== РЕЖИМ ПРОВЕРКИ (dry-run). Ничего не изменено. ==="
  echo ""
  echo "Будут выполнены шаги (после запуска с --run):"
  echo "  1. git clone --mirror <repo> ../$(basename "$REPO_ROOT")-clean"
  echo "  2. git filter-repo --path '$TARGET_FILE' --invert-paths --force"
  echo "  3. проверка: git log --all --oneline -- '$TARGET_FILE' (должно быть пусто)"
  echo "  4. ручной push переписанной истории (скрипт его НЕ делает)"
  echo ""
  echo "Запустите с --run, прочитав SECURITY.md, раздел «Очистка git-истории»."
  exit 0
fi

# --- Реальное выполнение (только с --run), в отдельном зеркале ---
if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "ОШИБКА: не найден git-filter-repo." >&2
  echo "Установите: pip install git-filter-repo" >&2
  echo "Либо используйте BFG (см. SECURITY.md, раздел 4)." >&2
  exit 3
fi

MIRROR_DIR="$(dirname "$REPO_ROOT")/$(basename "$REPO_ROOT")-clean"
REMOTE_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")"

if [ -z "$REMOTE_URL" ]; then
  echo "ОШИБКА: у репозитория не настроен remote 'origin'." >&2
  echo "Склонируйте зеркало вручную и запустите git filter-repo, см. SECURITY.md." >&2
  exit 3
fi

if [ -e "$MIRROR_DIR" ]; then
  echo "ОШИБКА: каталог '$MIRROR_DIR' уже существует. Удалите его или выберите другое имя." >&2
  exit 3
fi

echo "Клонирую зеркало в $MIRROR_DIR …"
git clone --mirror "$REMOTE_URL" "$MIRROR_DIR"

echo "Удаляю '$TARGET_FILE' из всей истории…"
git -C "$MIRROR_DIR" filter-repo --path "$TARGET_FILE" --invert-paths --force

echo ""
echo "Проверка (должно быть пусто):"
git -C "$MIRROR_DIR" log --all --oneline -- "$TARGET_FILE" || true
echo ""

echo "=== ГОТОВО в зеркале $MIRROR_DIR ==="
echo "Переписанная история НЕ отправлена. Проверьте результат и выполните вручную:"
echo "  cd \"$MIRROR_DIR\""
echo "  git push --force --all"
echo "  git push --force --tags"
echo ""
echo "НЕ ЗАБУДЬТЕ: ротировать секреты (SECURITY.md, раздел 3) и предупредить"
echo "разработчиков о необходимости переклонировать репозиторий."
