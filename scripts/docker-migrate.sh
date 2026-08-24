#!/bin/sh
# Применяет схему БД (drizzle-kit push) с конфигом, собранным из env.
# Запускается одноразовым сервисом `migrate` из docker-compose до старта app.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[migrate] DATABASE_URL не задан" >&2
  exit 1
fi

echo "[migrate] Генерирую конфиг drizzle для Docker..."
node -e "
  const fs = require('fs');
  const config = {
    dialect: 'postgresql',
    schema: './src/db/schema.ts',
    dbCredentials: { url: process.env.DATABASE_URL },
  };
  fs.writeFileSync('drizzle.docker.config.json', JSON.stringify(config));
"

echo "[migrate] Применяю схему базы данных..."
npx drizzle-kit push --force --config drizzle.docker.config.json
echo "[migrate] Схема применена."
