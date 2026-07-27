/**
 * VM power state: when it will switch itself off, and asking it not to yet.
 *
 * GET    — { enabled, holdUntil, poweroffAt, now }. `now` is server time so the
 *          client can render a countdown without trusting the device clock.
 * POST   — extend the hold. No body = the interaction heartbeat (10 min); an
 *          explicit `{ minutes }` is the manual "keep it up while I work" button.
 * DELETE — drop the hold. `holdFor` only moves the deadline forward, so without
 *          this a mis-clicked 4-hour hold could not be taken back.
 *
 * A shell script on the VM does the actual cancelling/arming (see
 * server/lib/keepalive.ts for the whole design and why it is a file).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import {
  holdFor,
  keepaliveEnabled,
  readHold,
  releaseHold,
  scheduledPoweroffAt,
} from "@/server/lib/keepalive";

/** One heartbeat covers two missed beats, so a hiccup doesn't drop the hold. */
const HEARTBEAT_MINUTES = 10;
/** Ceiling on a single request so a stuck client cannot pin the VM up forever. */
const MAX_HOLD_MINUTES = 12 * 60;

function state() {
  return {
    enabled: keepaliveEnabled(),
    holdUntil: readHold(),
    poweroffAt: scheduledPoweroffAt(),
    now: Date.now(),
  };
}

export const GET = withErrorHandling(async () => NextResponse.json(state()));

const bodySchema = z.object({
  minutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).optional(),
});

export const POST = withErrorHandling(async (req: Request) => {
  // An empty body is the normal heartbeat, so absent JSON is not an error.
  const raw = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw badRequest(`Hold must be 1–${MAX_HOLD_MINUTES} minutes`, parsed.error.flatten());
  }
  const minutes = parsed.data.minutes ?? HEARTBEAT_MINUTES;
  holdFor(minutes * 60_000);
  return NextResponse.json(state());
});

export const DELETE = withErrorHandling(async () => {
  releaseHold();
  return NextResponse.json(state());
});
