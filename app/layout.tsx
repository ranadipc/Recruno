import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recruno Automated Leads",
  description: "Local-first LinkedIn fit and intent sourcing workflow"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
