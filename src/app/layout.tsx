import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Video Studio",
  description:
    "Turn an ordinary idea into a professionally directed, realistic generative-video production.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/* System font stack on purpose: no network fetch at build time. */}
      <body className="antialiased">{children}</body>
    </html>
  );
}
