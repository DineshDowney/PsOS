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
              "uppercase transition-colors duration-[160ms]",
              orientation === "vertical"
                ? "text-[11px] tracking-[0.25em]"
                : "whitespace-nowrap text-[11px] tracking-[0.2em]",
              // Weight as well as colour: burgundy on white is a smaller
              // contrast step than burgundy on near-black was, so the active
              // item needs a second signal to stay findable at 11px.
              active ? "font-semibold text-accent" : "text-muted hover:text-fg",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
