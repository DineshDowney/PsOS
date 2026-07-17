"use client";

import clsx from "clsx";
import type { Item } from "@/shared/types";
import Link from "next/link";

/** Tracked uppercase micro-label — the one normalization point for section headers. */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("text-xs font-medium uppercase tracking-[0.08em] text-muted", className)}>
      {children}
    </div>
  );
}

export function PageTitle({
  children,
  sub,
  eyebrow,
}: {
  children: React.ReactNode;
  sub?: string;
  eyebrow?: string;
}) {
  return (
    <header className="mb-10">
      {eyebrow ? <SectionLabel className="mb-3">{eyebrow}</SectionLabel> : null}
      <h1 className="text-3xl font-light uppercase tracking-[0.18em] md:text-4xl">{children}</h1>
      {sub ? <p className="mt-2 text-sm text-muted">{sub}</p> : null}
    </header>
  );
}

/**
 * Joined-border segmented tab group; active segment inverts to a solid block.
 * Scrolls horizontally when it overflows (scrollbar hidden).
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={clsx("no-scrollbar flex overflow-x-auto", className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={clsx(
            "relative -ml-px shrink-0 whitespace-nowrap border border-line px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] transition-colors first:ml-0",
            opt.value === value
              ? "z-10 border-fg bg-fg text-bg"
              : "text-muted hover:text-fg",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "outline",
  disabled,
  type = "button",
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "outline" | "solid" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "px-4 py-2 text-xs font-medium uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        variant === "outline" && "border border-line text-fg hover:border-muted",
        variant === "solid" && "bg-fg text-bg hover:bg-accent hover:text-fg",
        variant === "ghost" && "text-muted hover:text-fg",
        variant === "danger" && "border border-danger/60 text-danger hover:border-danger",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.08em] text-muted">
        {label}
        {hint ? <span className="ml-2 normal-case tracking-normal text-faint">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full border border-line bg-transparent px-3 py-2 text-sm text-fg outline-none placeholder:text-faint hover:border-muted focus:border-fg";

export function StatusBadge({ status }: { status: Item["status"] }) {
  return (
    <span
      className={clsx(
        "border px-2 py-0.5 text-[9px] uppercase tracking-[0.08em]",
        status === "available" && "border-ok/50 text-ok",
        status === "laundry" && "border-line text-muted",
        status === "unavailable" && "border-danger/50 text-danger",
      )}
    >
      {status}
    </span>
  );
}

export function itemThumb(item: Item): string | null {
  const byRole = (role: string) => item.images.find((i) => i.role === role)?.url;
  return byRole("thumbnail") ?? byRole("transparent_front") ?? byRole("front") ?? null;
}

/** Transparent cutouts get the silhouette glow; flattened JPEG fallbacks don't. */
export function garmentGlowClass(url: string | null): string | undefined {
  return url && url.includes(".png") ? "garment-glow" : undefined;
}

export function ItemCard({ item, footer }: { item: Item; footer?: React.ReactNode }) {
  const thumb = itemThumb(item);
  return (
    <div className="group flex flex-col">
      <Link
        href={`/items/${item.id}`}
        className="relative block aspect-square overflow-hidden transition-opacity group-hover:opacity-80"
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt={item.name}
            className={clsx("h-full w-full object-contain p-3", garmentGlowClass(thumb))}
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-[0.08em] text-faint">
            no photo
          </div>
        )}
        {item.status !== "available" ? (
          <div className="absolute left-2 top-2">
            <StatusBadge status={item.status} />
          </div>
        ) : null}
      </Link>
      <div className="mt-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm">{item.name || "Untitled"}</div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted">
            {[item.primaryColor, item.subcategory ?? item.category].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      {footer}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-16 text-center text-sm text-muted">{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-muted">
      <span className="inline-block h-3 w-3 animate-spin border border-muted border-t-transparent" />
      {label ? <span className="text-xs uppercase tracking-[0.08em]">{label}</span> : null}
    </div>
  );
}
