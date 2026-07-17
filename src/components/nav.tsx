"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

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

export function NavLinks({ orientation }: { orientation: "vertical" | "horizontal" }) {
  const pathname = usePathname();
  return (
    <>
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "uppercase transition-colors",
              orientation === "vertical"
                ? "text-[11px] tracking-[0.25em]"
                : "whitespace-nowrap text-[11px] tracking-[0.2em]",
              active ? "text-accent" : "text-muted hover:text-fg",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
