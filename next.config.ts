import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Автономный образ для Docker: собирает .next/standalone
  output: "standalone",
  // Говорим сборщику не трогать библиотеку бота
  serverExternalPackages: ["discord.js"],
  // next/image не используется — отключаем пайплайн оптимизации картинок,
  // чтобы sharp и его нативные библиотеки не попадали в standalone (~50 МБ)
  images: { unoptimized: true },
  // Базовые security-хедеры для всех страниц и ответов приложения
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
        ],
      },
    ];
  },
};

export default nextConfig;
