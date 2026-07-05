import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Otto Enterprise",
  description: "AI Office Assistant",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="antialiased h-screen overflow-hidden">{children}</body>
    </html>
  );
}
