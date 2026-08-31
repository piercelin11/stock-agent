import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Stock Agent",
  description: "台股觀察/分析 agent 後端資料層的前端介面",
};

const navLinks = [
  { href: "/", label: "Dashboard" },
  { href: "/screening", label: "Screening" },
  { href: "/watchlist", label: "Watchlist" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant">
      <body>
        <div className="flex min-h-screen">
          <aside className="w-52 shrink-0 border-r border-slate-800 bg-slate-900 px-4 py-6">
            <div className="mb-6 text-sm font-semibold tracking-wide text-slate-500">
              STOCK AGENT
            </div>
            <nav className="flex flex-col gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="rounded px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </aside>
          <main className="flex-1 px-8 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
