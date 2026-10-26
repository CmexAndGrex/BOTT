---
name: discord-api
description: Use when working with Discord bot integrations, role assignments, avatar URLs, webhook embeds, or Discord interactions.
---

# Discord API & UI Guidelines

## 1. Аватарки пользователей
- Для всех изображений `<img>` и `<Image>` с Discord CDN ОБЯЗАТЕЛЕН атрибут `referrerPolicy="no-referrer"`. Без него Discord отдаёт 403.
- Формирование URL:
  - С хэшем: `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=128`.
  - Без хэша: дефолтная аватарка `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(discordId) >> 22n) % 6n)}.png`.
  - `BigInt` операции писать через вызов функции `BigInt(22)`, не используя суффикс `22n` (для совместимости с tsconfig target).

## 2. Роли и взаимодействие
- Все вызовы Discord API оборачивать в блок `try/catch` через функцию `safeDiscord`. Сетевой сбой Discord не должен прерывать транзакцию в БД.
- Карточки и пинги: выводить бойца в одну строку без внутренних ID базы (`#55`) и без дублирования ника.