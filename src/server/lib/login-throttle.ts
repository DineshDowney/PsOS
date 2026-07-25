/**
 * Brute-force resistance for the single-user password gate.
 *
 * The app is internet-facing on plain HTTP (2026-07-25), so /api/auth/login is
 * the one endpoint an unauthenticated stranger can reach. It needed a cost per
 * guess.
 *
 * Deliberately a progressive DELAY, not a lockout: a hard block would let anyone
 * who can reach the port lock Dinesh out of his own wardrobe, which trades a
 * remote risk for a guaranteed annoyance. Delay makes guessing infeasible while
 * a legitimate login never fails — worst case it waits a few seconds.
 *
 * Per-IP only when a trusted proxy is actually in front of us (PSOS_BEHIND_TLS),
 * otherwise one shared bucket. This matters: `x-forwarded-for` is just a request
 * header, so when the app serves directly it is attacker-supplied and honouring
 * it would hand every guess a fresh bucket — the throttle would price nothing.
 * The shared bucket is the honest fallback; it still prices every guess.
 *
 * In-memory and per-process, which is fine for one `next start` process. It
 * resets on deploy — acceptable, since an attacker cannot force a restart.
 */

const WINDOW_MS = 10 * 60_000;
/** Failures before any delay applies — normal typos stay instant. */
const FREE_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;

interface Bucket {
  failures: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function bucketFor(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now) return existing;
  const fresh: Bucket = { failures: 0, resetAt: now + WINDOW_MS };
  buckets.set(key, fresh);
  return fresh;
}

/**
 * Client key from request headers — falls back to a shared bucket.
 *
 * Takes the LAST hop, not the first. `x-forwarded-for` accumulates
 * left-to-right, so the rightmost entry is the one our own proxy appended and
 * every earlier entry is client-supplied text. Reading the leftmost hop would
 * let an attacker rotate the key on every request. Correct either way: if the
 * proxy replaces the header instead of appending, last and first are the same.
 */
export function loginKey(headers: Headers): string {
  if (!behindTrustedProxy()) return "shared";
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? "shared";
}

/**
 * Is a reverse proxy we control terminating TLS in front of us?
 *
 * One flag for one deployment fact, used for two things: trusting
 * `x-forwarded-for` here, and setting `secure` on the session cookie in
 * api/auth/login. Set to 1 on the VM (behind Tailscale Funnel), unset for local
 * `npm run dev` over plain HTTP.
 */
export function behindTrustedProxy(): boolean {
  return process.env.PSOS_BEHIND_TLS === "1";
}

/** How long this attempt should be made to wait before it is answered. */
export function loginDelayMs(key: string, now = Date.now()): number {
  const bucket = bucketFor(key, now);
  const over = bucket.failures - FREE_ATTEMPTS;
  if (over < 0) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** over, MAX_DELAY_MS);
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  bucketFor(key, now).failures++;
}

/** A correct password clears the cost — the owner is never punished. */
export function clearLoginFailures(key: string): void {
  buckets.delete(key);
}

/** Tests only. */
export function resetLoginThrottle(): void {
  buckets.clear();
}

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
