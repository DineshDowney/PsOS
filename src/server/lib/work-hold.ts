import { holdFor } from "@/server/lib/keepalive";

/**
 * Keeps the VM awake while background work is in flight.
 *
 * Extracted from imports/pipeline.ts on 2026-07-26 when on-demand image
 * regeneration became a second kind of long-running work. It has to be ONE
 * shared counter, not a copy per caller: two independent counters would each
 * run their own ticker against the same flag file, and the bookkeeping for
 * "is anything still running?" would be split across modules that cannot see
 * each other. One counter, one ticker, any number of work sources.
 *
 * Ticking on a timer rather than writing the flag per step, because a single
 * step can stall for many minutes: image generation is 1-wide process-wide and
 * retries 429s with 20s/45s/90s backoff, so a job 15th in line goes quiet for a
 * long time while being entirely healthy.
 *
 * Self-terminating by construction: the ticker exists only while work is in
 * flight, so a drained queue stops refreshing the flag and the VM sleeps. That
 * is what makes "queue 20 imports and close the laptop" safe.
 */

const HOLD_TICK_MS = 5 * 60_000;
const HOLD_WINDOW_MS = 15 * 60_000;

let inFlight = 0;
let holdTicker: NodeJS.Timeout | null = null;

export function workStarted(): void {
  inFlight++;
  if (holdTicker) return;
  holdFor(HOLD_WINDOW_MS);
  holdTicker = setInterval(() => holdFor(HOLD_WINDOW_MS), HOLD_TICK_MS);
  // Never keep the node process alive on the ticker's account.
  holdTicker.unref?.();
}

export function workFinished(): void {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight > 0 || !holdTicker) return;
  clearInterval(holdTicker);
  holdTicker = null;
}

/** Exposed for tests only. */
export function workInFlight(): number {
  return inFlight;
}
