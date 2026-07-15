"use client";

import clsx from "clsx";
import type { Item } from "@/shared/types";
import Link from "next/link";

export function PageTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <header className="mb-10">
      <h1 className="text-2xl font-light uppercase tracking-[0.3em]">{children}</h1>
      {sub ? <p className="mt-2 text-sm text-muted">{sub}</p> : null}
    </header>
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
        "px-4 py-2 text-[11px] uppercase tracking-[0.2em] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        variant === "outline" && "border border-line text-fg hover:border-accent",
        variant === "solid" && "bg-fg text-bg hover:bg-accent",
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
      <span className="text-[10px] uppercase tracking-[0.2em] text-muted">
        {label}
        {hint ? <span className="ml-2 normal-case tracking-normal text-faint">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full border border-line bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent";

export function StatusBadge({ status }: { status: Item["status"] }) {
  return (
    <span
      className={clsx(
        "border px-2 py-0.5 text-[9px] uppercase tracking-[0.2em]",
        status === "available" && "border-ok/50 text-ok",
        status === "laundry" && "border-accent/50 text-accent",
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
            className="h-full w-full object-contain p-3"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-[0.2em] text-faint">
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
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted">
            {[item.primaryColor, item.subcategory ?? item.category].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      {footer}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-dashed border-line px-8 py-16 text-center text-sm text-muted">
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-muted">
      <span className="inline-block h-3 w-3 animate-spin border border-muted border-t-transparent" />
      {label ? <span className="text-xs uppercase tracking-[0.2em]">{label}</span> : null}
    </div>
  );
}
