import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Автономный образ для Docker: собирает .next/standalone
  output: "standalone",
};

export default nextConfig;
