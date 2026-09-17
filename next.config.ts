import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Автономный образ для Docker: собирает .next/standalone
  output: "standalone",
  // Говорим сборщику не трогать библиотеку бота
  serverExternalPackages: ["discord.js"],
  // next/image не используется — отключаем пайплайн оптимизации картинок,
  // чтобы sharp и его нативные библиотеки не попадали в standalone (~50 МБ)
  images: { unoptimized: true },
  // Базовые security-хедеры для всех страниц и ответов приложения.
  // CSP добавляется в middleware (с nonce для inline-скриптов Next.js).
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // HSTS: включайте только когда панель реально работает по HTTPS
          // (за обратным прокси). Отключается HSTS_DISABLED=true.
          ...(process.env.HSTS_DISABLED === "true"
            ? []
            : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
