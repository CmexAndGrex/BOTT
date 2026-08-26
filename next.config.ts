import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Автономный образ для Docker: собирает .next/standalone
  output: "standalone",
  // Говорим сборщику не трогать библиотеку бота
  serverExternalPackages: ["discord.js"],
};

export default nextConfig;