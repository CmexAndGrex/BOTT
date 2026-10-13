import type { Metadata, Viewport } from "next";
import "./globals.css";
import Shell from "@/components/shell";

export const metadata: Metadata = {
  title: "ATK RED - Артиллерийско - Танковый Корпус",
  description:
    "Автоматизированный бот подразделения: пинги на операции, контроль онлайна rs-red.com, учёт отпусков и статистика нормы.",
  icons: {
    icon: "/atk-logo.png",
  },
};

export const viewport: Viewport = {
  // Цвет системной панели браузера — в тон глубокой графитовой подложке (#0c0d10)
  themeColor: "#0c0d10",
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
