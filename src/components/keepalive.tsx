"use client";

import { useEffect } from "react";

/**
 * Tells the VM a human is actually looking at the app, so it doesn't power off
 * mid-session.
 *
 * The naive version of this — "any HTTP request counts" — is a trap, and it is
 * the exact reason idle shutdown was rejected the first time round. The Import
 * screen polls every 2–10s (`refetchInterval` in app/import/page.tsx), so a tab
 * left open in a background window would hold the machine up forever and quietly
 * bill for it.
 *
 * So a beat requires BOTH conditions, every time:
 *   - the tab is visible, and
 *   - a pointer/key/scroll event has happened since the last beat.
 *
 * A backgrounded tab, a forgotten tab in the foreground, and a phone in a pocket
 * all send nothing. Walk away and the machine sleeps.
 *
 * Fails silently on purpose: this is a background nicety, and a 401 here must not
 * bounce the user to /login (which is why it uses fetch directly rather than the
 * api helper).
 */

/** At most one beat per this interval, regardless of how much he clicks. */
const BEAT_EVERY_MS = 5 * 60_000;
/** How often we check whether a beat is due. Cheap: no network unless it is. */
const CHECK_EVERY_MS = 30_000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export function useKeepalive(): void {
  useEffect(() => {
    let interacted = false;
    let lastBeat = 0;

    const mark = () => {
      interacted = true;
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, mark, { passive: true });
    }

    const beat = () => {
      if (document.visibilityState !== "visible") return;
      if (!interacted) return;
      if (Date.now() - lastBeat < BEAT_EVERY_MS) return;
      lastBeat = Date.now();
      interacted = false;
      void fetch("/api/system/power", { method: "POST" }).catch(() => {
        /* offline or logged out — the VM will just sleep on schedule */
      });
    };

    const timer = setInterval(beat, CHECK_EVERY_MS);
    return () => {
      clearInterval(timer);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, mark);
    };
  }, []);
}
