import type { Metadata } from "next";
import Link from "next/link";
import "@fontsource-variable/instrument-sans";
import "./globals.css";
import { Providers } from "@/components/providers";
import { NavLinks } from "@/components/nav";

export const metadata: Metadata = {
  title: "Personal Stylist OS",
  description: "Local-first wardrobe management and AI stylist",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-fg">
        <Providers>
          {/* phone: sticky top bar with horizontally scrolling nav */}
          <header className="sticky top-0 z-40 flex h-12 items-center gap-6 border-b border-line bg-bg px-4 md:hidden">
            <Link
              href="/wardrobe"
              className="shrink-0 text-xs font-semibold uppercase tracking-[0.35em] text-fg"
            >
              Stylist&nbsp;OS
            </Link>
            <nav className="no-scrollbar flex items-center gap-5 overflow-x-auto">
              <NavLinks orientation="horizontal" />
            </nav>
          </header>

          {/* desktop: fixed sidebar */}
          <aside className="fixed inset-y-0 left-0 hidden w-52 flex-col border-r border-line bg-bg px-6 py-8 md:flex">
            <Link
              href="/wardrobe"
              className="mb-12 text-xs font-semibold uppercase tracking-[0.35em] text-fg"
            >
              Stylist&nbsp;OS
            </Link>
            <nav className="flex flex-col gap-4">
              <NavLinks orientation="vertical" />
            </nav>
            <div className="mt-auto text-[10px] uppercase tracking-[0.2em] text-faint">
              Local · Private
            </div>
          </aside>

          <main className="min-h-screen px-4 py-6 md:ml-52 md:px-14 md:py-14">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
