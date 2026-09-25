import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "你的学霸同桌 · 学习诊断工作台",
  description: "通过多轮诊断发现薄弱知识点，进行专题强化并跟踪掌握情况。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <div className="local-edition-notice" role="status">
          本地版：档案和账号只保存在这台电脑；模型教学和在线检索仍需联网。
        </div>
        {children}
      </body>
    </html>
  );
}
