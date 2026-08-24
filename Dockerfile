# ---------- База ----------
FROM node:22-alpine AS base
WORKDIR /app

# ---------- Зависимости ----------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Устанавливаем зависимости внутри контейнера
RUN npm install --no-audit --no-fund

# ---------- Сборка Next.js ----------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgresql://postgres:postgres@db:5432/app_db"
RUN npm run build

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