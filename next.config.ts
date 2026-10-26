import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Автономный образ для Docker: собирает .next/standalone
  output: "standalone",
  // Говорим сборщику не трогать библиотеку бота
  serverExternalPackages: ["discord.js"],
  // next/image не используется — отключаем пайплайн оптимизации картинок,
  // чтобы sharp и его нативные библиотеки не попадали в standalone (~50 МБ).
  //
  // remotePatterns при этом обязателен: аватарки бойцов лежат на Discord CDN, и
  // без явного разрешения хостов next/image (а также любые его будущие замены)
  // отказывают в загрузке. Список совпадает с дискрецией img-src в CSP
  // (src/middleware.ts) — расхождение давало бы «в конфиге можно, в браузере
  // нельзя».
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "cdn.discordapp.com" },
      { protocol: "https", hostname: "media.discordapp.net" },
    ],
  },
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
