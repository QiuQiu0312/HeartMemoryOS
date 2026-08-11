import type { Metadata } from "next";
import "./globals.css";
import "./chat.css";

export const metadata: Metadata = {
  title: {
    default: "心忆 · 陪伴式记忆引擎",
    template: "%s · 心忆",
  },
  description: "可迁移、可解释、低成本的长期陪伴记忆基础设施。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
