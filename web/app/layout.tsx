import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Modal AI Chat",
  description: "Self-hosted Qwen chat powered by Modal and vLLM",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
