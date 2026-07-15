import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Personal Stylist OS",
  description: "Local-first wardrobe management and AI stylist",
};

const NAV = [
  { href: "/wardrobe", label: "Wardrobe" },
  { href: "/import", label: "Import" },
  { href: "/outfits", label: "Outfit Studio" },
  { href: "/calendar", label: "Calendar" },
  { href: "/laundry", label: "Laundry" },
  { href: "/analytics", label: "Analytics" },
  { href: "/chat", label: "Stylist Chat" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-fg">
        <Providers>
          <div className="flex min-h-screen">
            <aside className="fixed inset-y-0 left-0 flex w-52 flex-col border-r border-line bg-bg px-6 py-8">
              <Link
                href="/wardrobe"
                className="mb-12 text-xs font-semibold uppercase tracking-[0.35em] text-fg"
              >
                Stylist&nbsp;OS
              </Link>
              <nav className="flex flex-col gap-4">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="text-[11px] uppercase tracking-[0.25em] text-muted transition-colors hover:text-fg"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
              <div className="mt-auto text-[10px] uppercase tracking-[0.2em] text-faint">
                Local · Private
              </div>
            </aside>
            <main className="ml-52 min-h-screen flex-1 px-10 py-10">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
