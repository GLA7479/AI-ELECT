import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "AI לחשמלאים",
  description: "עוזר מקצועי לחשמלאים עם מאגר מקורות וציטוטים",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "AI לחשמלאים",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b1220",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
