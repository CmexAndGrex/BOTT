import type { Metadata, Viewport } from "next";
import "./globals.css";
import Shell from "@/components/shell";

export const metadata: Metadata = {
  title: "RED ATK - Артиллерийско - Танковый Корпус",
  description:
    "Автоматизированный бот подразделения: пинги на операции, контроль онлайна rs-red.com, учёт отпусков и статистика нормы.",
  icons: {
    icon: "/atk-logo.png",
  },
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