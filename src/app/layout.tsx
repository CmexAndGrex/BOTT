import type { Metadata, Viewport } from "next";
import "./globals.css";
import Shell from "@/components/shell";

export const metadata: Metadata = {
  title: "RED OPS — Пульт Танковых Войск",
  description:
    "Автоматизированный бот подразделения: пинги на операции, контроль онлайна rs-red.com, учёт отпусков и статистика нормы.",
};

export const viewport: Viewport = {
  themeColor: "#05060b",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}