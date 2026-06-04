import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recruno",
  description: "Local-first LinkedIn fit scoring sourcing workflow"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
