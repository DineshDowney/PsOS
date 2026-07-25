/**
 * "Keep the VM awake" flag.
 *
 * The VM powers itself off on a timer so an idle box costs nothing. That is
 * fine until a 20-garment import batch is halfway through, or Dinesh is sitting
 * reading a screen — so the app needs a way to say "I am busy, don't."
 *
 * The mechanism is deliberately one file holding one number: a UNIX-ms
 * DEADLINE. A deadline in the future means "stay up". A shell script on the VM
 * (`psos-keepalive-check`, run by a systemd timer every 30 min) reads it and
 * cancels or arms the poweroff. A number rather than a bare touch/mtime so that
 * "hold for 4 hours" is the same operation as the 10-minute heartbeat, just
 * with a bigger argument — and so a short beat can never shorten a long hold
 * (`holdFor` only ever moves the deadline forward).
 *
 * The directory comes from systemd's `RuntimeDirectory=psos`, which creates
 * /run/psos owned by the service user. That is why nothing here needs sudo or a
 * setuid helper. It is tmpfs, so the flag can never end up in the data/ backup
 * and never survives a reboot — both correct.
 *
 * Everything degrades to a no-op when the directory is absent, which is how the
 * Windows dev machine and `npm test` see it. Nothing here may throw: a failed
 * keepalive write must never turn into a failed import or a 500.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * systemd sets RUNTIME_DIRECTORY from `RuntimeDirectory=psos`. Read lazily so
 * tests can point it at a temp dir without module-load ordering games.
 */
function runtimeDir(): string {
  return process.env.RUNTIME_DIRECTORY || "/run/psos";
}

function flagPath(): string {
  return path.join(runtimeDir(), "keepalive");
}

/** Where systemd records a pending `shutdown -h`. World-readable. */
const SCHEDULED_PATH = "/run/systemd/shutdown/scheduled";

let warned = false;

function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  console.error(`[psos] keepalive ${what} failed (continuing without it):`, err);
}

/**
 * Is the flag usable? False on the dev machine, and false on the VM if the
 * RuntimeDirectory was never configured — in which case the poweroff behaves
 * exactly as it did before this feature existed.
 */
export function keepaliveEnabled(): boolean {
  try {
    return fs.statSync(runtimeDir()).isDirectory();
  } catch {
    return false;
  }
}

/** The current deadline in UNIX ms, or null if none/unreadable/disabled. */
export function readHold(): number | null {
  try {
    const raw = fs.readFileSync(flagPath(), "utf8").trim();
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null; // Missing file is the normal "nothing is holding it" state.
  }
}

/**
 * Ask to stay up for at least `ms` longer. Returns the resulting deadline, or
 * null when the flag is unavailable. Never moves an existing deadline earlier,
 * so a 5-minute heartbeat cannot cut a 4-hour manual hold short.
 */
export function holdFor(ms: number, now = Date.now()): number | null {
  if (!keepaliveEnabled()) return null;
  const deadline = Math.max(now + ms, readHold() ?? 0);
  try {
    // Single small write; the readers are a shell script and this process, and
    // a torn read just looks like "no hold", which fails safe (VM sleeps).
    fs.writeFileSync(flagPath(), String(deadline), "utf8");
    return deadline;
  } catch (err) {
    warnOnce("write", err);
    return null;
  }
}

/**
 * When systemd will power the machine off, in UNIX ms — or null if nothing is
 * armed. The file holds microseconds since the epoch as `USEC=<n>`.
 */
export function scheduledPoweroffAt(): number | null {
  try {
    const usec = /^USEC=(\d+)/m.exec(fs.readFileSync(SCHEDULED_PATH, "utf8"));
    return usec ? Math.round(Number(usec[1]) / 1000) : null;
  } catch {
    return null;
  }
}
