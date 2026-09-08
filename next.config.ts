import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Автономный образ для Docker: собирает .next/standalone
  output: "standalone",
  // Говорим сборщику не трогать библиотеку бота
  serverExternalPackages: ["discord.js"],
  // next/image не используется — отключаем пайплайн оптимизации картинок,
  // чтобы sharp и его нативные библиотеки не попадали в standalone (~50 МБ)
  images: { unoptimized: true },
};

export default nextConfig;
