# ---------- База ----------
FROM node:22-alpine AS base
WORKDIR /app

# ---------- Зависимости ----------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# npm ci строго по lock-файлу; кэш npm чистим сразу, чтобы он не раздувал слой
RUN npm ci --no-audit --no-fund && npm cache clean --force

# ---------- Сборка Next.js ----------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgresql://postgres:postgres@db:5432/app_db"
# Кэш инкрементальной сборки в рантайме не нужен (runner берёт standalone/static) —
# удаляем, чтобы слой builder не раздувался на диске сервера
RUN npm run build && rm -rf .next/cache

# ---------- Разовый сервис миграций ----------
FROM base AS migrator
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
CMD ["sh", "scripts/docker-migrate.sh"]

# ---------- Продакшен (standalone) ----------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/extension ./extension

USER nextjs
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]