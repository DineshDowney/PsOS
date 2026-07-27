"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";
import type { ImageRole, Item, ItemImage } from "@/shared/types";
import Link from "next/link";

/**
 * A section heading inside a page.
 *
 * Was a 12px uppercase tracked whisper, which put it at the same volume as the
 * buttons and field labels around it — so a heading did not read as a heading.
 * Sentence case at 16px, full-strength text: it now outranks its contents.
 */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <h2 className={clsx("text-heading text-fg", className)}>{children}</h2>;
}

/**
 * The page masthead — one of only three places in the app that still uses
 * tracked uppercase (the others are the wordmark and the nav). See the TYPE
 * SCALE note in globals.css for why that restraint is the whole point.
 */
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
      {eyebrow ? (
        <div className="mb-3 text-meta text-accent">{eyebrow}</div>
      ) : null}
      <h1 className="text-display uppercase md:text-[2.625rem]">{children}</h1>
      {sub ? <p className="mt-3 max-w-prose text-meta text-muted">{sub}</p> : null}
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
            "relative -ml-px shrink-0 whitespace-nowrap border border-line px-3.5 py-1.5 text-meta capitalize transition-[color,background-color,border-color,transform] duration-200 first:ml-0 first:rounded-l-[2px] last:rounded-r-[2px] active:scale-95",
            opt.value === value
              ? "z-10 border-fg bg-fg font-medium text-bg"
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
  loading = false,
  type = "button",
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "outline" | "solid" | "ghost" | "danger";
  disabled?: boolean;
  /**
   * In-flight. Shows a spinner and blocks the click.
   *
   * Every caller used to swap its own label instead ("Save changes" ->
   * "Saving…"), which loses the label exactly when you want to confirm what you
   * pressed, and resizes the button by more than the spinner does.
   */
  loading?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        // scale-95 on press is the one motion cue that reaches touch AND mouse
        // for free — :active fires on tap, not just click-and-hold.
        "inline-flex items-center gap-2 rounded-[2px] px-4 py-2 text-meta font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
        variant === "outline" && "border border-line text-fg hover:border-muted",
        variant === "solid" && "bg-fg text-bg hover:bg-accent hover:text-accent-fg",
        variant === "ghost" && "text-muted hover:text-fg",
        variant === "danger" && "border border-danger/60 text-danger hover:border-danger",
        className,
      )}
    >
      {loading ? (
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
      ) : null}
      {children}
    </button>
  );
}

/**
 * Marks a value the AI wrote and you have not touched.
 *
 * Only `ai` renders. Tagging user-owned fields too would put a badge on almost
 * every row and say nothing — the useful signal is "this was guessed, check
 * it", and it disappears the moment you edit, because that edit flips the
 * field's provenance to `user` and AI can never overwrite it again.
 */
export function AiMark({ source }: { source?: "ai" | "user" }) {
  if (source !== "ai") return null;
  return (
    <span
      title="Written by AI — your edit replaces it permanently"
      className="rounded-[2px] bg-surface-2 px-1.5 py-px text-micro font-medium text-faint"
    >
      AI
    </span>
  );
}

export function Field({
  label,
  children,
  hint,
  source,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  /** Provenance of the underlying item field, when this Field edits one. */
  source?: "ai" | "user";
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex flex-wrap items-center gap-x-2 text-meta text-muted">
        {label}
        <AiMark source={source} />
        {hint ? <span className="text-faint">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

/**
 * Modal confirmation. Replaces `window.confirm`, which cannot be styled, blocks
 * the whole tab, and looks like the browser is warning you about the site.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = false,
  busy = false,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  busy?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-fg/25 p-4"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-sm p-6 shadow-[0_18px_50px_rgb(25_24_22/0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-heading text-fg">{title}</h2>
        <p className="mt-2 text-meta text-muted">{body}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "solid"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * `w-full` is deliberate and load-bearing for the ~30 form fields that expect
 * it. Anything that wants a narrower input must constrain the PARENT — appending
 * `w-28` here loses, because Tailwind resolves `w-full` vs `w-28` by the order
 * they appear in the generated stylesheet, not the order in the class attribute.
 */
export const inputClass =
  "w-full rounded-[2px] border border-line bg-bg px-3 py-2 text-body text-fg outline-none placeholder:text-faint hover:border-muted focus:border-fg";

export function StatusBadge({ status }: { status: Item["status"] }) {
  return (
    <span
      className={clsx(
        "rounded-[2px] border px-2 py-0.5 text-micro capitalize",
        status === "available" && "border-ok/40 bg-ok/8 text-ok",
        status === "laundry" && "border-line bg-surface-2 text-muted",
        status === "unavailable" && "border-danger/40 bg-danger/8 text-danger",
      )}
    >
      {status}
    </span>
  );
}

/** A block that holds the shape of content still loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton", className)} aria-hidden="true" />;
}

/**
 * The wardrobe grid's loading shape. Same tile geometry and gaps as the real
 * grid, so content landing does not move the page.
 */
export function SkeletonGrid({ count = 8, className }: { count?: number; className?: string }) {
  return (
    <div className={className} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="aspect-square w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

export function itemThumb(item: Item): string | null {
  const byRole = (role: string) => item.images.find((i) => i.role === role)?.url;
  return byRole("thumbnail") ?? byRole("transparent_front") ?? byRole("front") ?? null;
}

/**
 * The back-side counterpart to `itemThumb`. Returns null for the ~third of
 * the wardrobe imported front-only — there is nothing to rotate to, and the
 * grid tile for those items simply does not flip.
 *
 * `thumbnail_back` is the normalized 640px/88%-occupancy tile (added
 * 2026-07-26, backfilled by `scripts/rekey-images.ts`); until that backfill
 * runs on an older item this falls through to the raw `transparent_back`,
 * which is a different size/position than the front tile — the flip will
 * look slightly off until the backfill catches up, not wrong.
 */
export function itemThumbBack(item: Item): string | null {
  const byRole = (role: string) => item.images.find((i) => i.role === role)?.url;
  return byRole("thumbnail_back") ?? byRole("transparent_back") ?? byRole("back") ?? null;
}

/**
 * What a garment is called on screen. The single definition — no screen builds
 * its own.
 *
 * Names are deliberately not shown anywhere in the UI (Dinesh, 2026-07-26): they
 * are AI-written and he does not want them. The column, the editor field and the
 * AI inference all stay, and search still matches name, so nothing is lost —
 * it just isn't the thing you read.
 *
 * Falls through to the name and then "Untitled" so a bare draft, which has no
 * colour or category yet, never renders as an empty row.
 */
export function itemLabel(item: Item): string {
  const label = [item.primaryColor, item.subcategory ?? item.category].filter(Boolean).join(" · ");
  return label || item.name || "Untitled";
}

/** Transparent cutouts get the silhouette shadow; flattened JPEG fallbacks don't. */
export function garmentShadowClass(url: string | null): string | undefined {
  return url && url.includes(".png") ? "garment-shadow" : undefined;
}

/**
 * Photos for the item page, in display order: the studio regenerations first,
 * then the two originals as they came off the phone.
 *
 * Dinesh, 2026-07-26: "the first two photos should be regen ones, then the
 * og." Each regen slot falls back to a transparent cutout or the tight crop
 * when that side was never (re)generated — degrading the same way the rest of
 * the pipeline does — rather than disappearing outright.
 */
export function orderedPhotos(item: Item): ItemImage[] {
  const bestOf = (roles: ImageRole[]): ItemImage | undefined => {
    for (const role of roles) {
      const found = item.images.find((i) => i.role === role);
      if (found) return found;
    }
    return undefined;
  };
  return [
    bestOf(["generated_front", "transparent_front", "front_cropped"]),
    bestOf(["generated_back", "transparent_back", "back_cropped"]),
    bestOf(["front"]),
    bestOf(["back"]),
  ].filter((img): img is ItemImage => Boolean(img));
}

/** Past this many tiles the entrance stagger stops, so late tiles don't wait. */
const STAGGER_CAP = 12;

/**
 * Cycles a two-sided tile front/back on a timer, but ONLY on a device that
 * cannot hover — hover already does this instantly and for free via CSS
 * (`.flip-back` under `@media (hover: hover)` in globals.css), and a timer
 * fighting a hover transition looks like a glitch. Also stays off entirely
 * under prefers-reduced-motion, matching every other ambient animation here.
 *
 * `index` staggers the start so a grid of these doesn't flip in unison, which
 * reads as one blinking wall rather than a wardrobe.
 */
function useAutoFlip(hasBack: boolean, index: number): boolean {
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    if (!hasBack || typeof window === "undefined") return;
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const PERIOD_MS = 4200;
    const stagger = (index % 6) * 650;
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      setFlipped((f) => !f);
      interval = setInterval(() => setFlipped((f) => !f), PERIOD_MS);
    }, PERIOD_MS + stagger);

    return () => {
      clearTimeout(start);
      if (interval) clearInterval(interval);
    };
  }, [hasBack, index]);
  return flipped;
}

export function ItemCard({
  item,
  footer,
  index = 0,
}: {
  item: Item;
  footer?: React.ReactNode;
  /** Position in the grid — drives the entrance and flip stagger only. */
  index?: number;
}) {
  const front = itemThumb(item);
  const back = itemThumbBack(item);
  const hasBack = Boolean(back && back !== front);
  const label = itemLabel(item);
  const flipped = useAutoFlip(hasBack, index);

  return (
    <div
      className={clsx("tile-in group flex flex-col", flipped && "tile-flipped")}
      style={{ "--i": Math.min(index, STAGGER_CAP) } as React.CSSProperties}
    >
      <Link
        href={`/items/${item.id}`}
        // Paper ground: the thumbnails are transparent cutouts, so a pale garment
        // needs something other than the white page behind it. Square, not the
        // portrait ratio the reference used — the thumbnail pipeline already
        // trims + recenters the garment at 88% of a SQUARE canvas, so a portrait
        // box just adds letterboxing on top of that.
        className="card relative block aspect-square overflow-hidden"
        title={item.name || undefined}
      >
        {front ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={front}
            alt={label}
            className={clsx(
              "flip-front garment-lift absolute inset-0 h-full w-full object-contain",
              garmentShadowClass(front),
            )}
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-meta text-faint">
            No photo
          </div>
        )}
        {hasBack ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={back!}
            alt={`${label} — back`}
            className={clsx(
              "flip-back garment-lift absolute inset-0 h-full w-full object-contain",
              garmentShadowClass(back),
            )}
            loading="lazy"
          />
        ) : null}
        {item.status !== "available" ? (
          <div className="absolute left-2 top-2">
            <StatusBadge status={item.status} />
          </div>
        ) : null}
      </Link>
      <div className="mt-3 text-meta capitalize text-fg">{label}</div>
      {footer}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[2px] border border-dashed border-line px-6 py-12 text-center text-meta text-muted">
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-muted" role="status">
      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border border-muted border-t-transparent" />
      {label ? <span className="text-meta">{label}</span> : null}
    </div>
  );
}
