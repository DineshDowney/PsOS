/**
 * Login for the single-user password gate (see src/middleware.ts). Compares
 * the submitted password against PSOS_PASSWORD and sets the long-lived session
 * cookie the middleware expects. Constant-time comparison via digest equality.
 */
import { NextResponse } from "next/server";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const bodySchema = z.object({ password: z.string().min(1) });

const COOKIE = "psos_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 90 days — single user, own devices

function sessionToken(password: string): string {
  return createHmac("sha256", password).update("psos-session-v1").digest("hex");
}

export async function POST(req: Request) {
  const configured = process.env.PSOS_PASSWORD;
  if (!configured) {
    return NextResponse.json(
      { error: { message: "Login is not enabled on this instance", code: "login_disabled" } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { message: "Password required", code: "bad_request" } },
      { status: 400 },
    );
  }

  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash("sha256").update(parsed.data.password).digest();
  const b = createHash("sha256").update(configured).digest();
  if (!timingSafeEqual(a, b)) {
    return NextResponse.json(
      { error: { message: "Wrong password", code: "unauthorized" } },
      { status: 401 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, sessionToken(configured), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    // NOT `secure`: the deployed instance serves plain HTTP on the VM today.
    // Flip to secure: true when the app moves behind TLS (tunnel/domain).
  });
  return res;
}
