import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "JobFinder AI · Career intelligence",
  description: "A private workspace for your next career move.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
