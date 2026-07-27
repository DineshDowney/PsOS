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

/**
 * Nav keeps its tracked uppercase — it is one of the three roles allowed to
 * (see the TYPE SCALE note in globals.css). Tracking drops .25em -> .18em:
 * at 11px the wider setting broke "OUTFIT STUDIO" into loose letters rather
 * than a word.
 *
 * The active item also gets a burgundy bar. Exactly one bar exists in the DOM
 * at a time and it carries `view-transition-name: nav-marker`, so on a client
 * navigation the browser tweens it from the old item to the new one instead of
 * blinking it off and on. Colour alone was carrying this before, and burgundy
 * on white is a smaller contrast step than burgundy on the old near-black.
 */
export function NavLinks({ orientation }: { orientation: "vertical" | "horizontal" }) {
  const pathname = usePathname();
  const vertical = orientation === "vertical";

  return (
    <>
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "relative text-nav uppercase transition-colors duration-[160ms]",
              vertical ? "py-0.5 pl-3" : "shrink-0 whitespace-nowrap py-2",
              active ? "font-semibold text-accent" : "text-muted hover:text-fg",
            )}
          >
            {active ? (
              <span
                className={clsx(
                  "nav-marker absolute bg-accent",
                  vertical ? "left-0 top-0 h-full w-[2px]" : "inset-x-0 bottom-0 h-[2px]",
                )}
              />
            ) : null}
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
