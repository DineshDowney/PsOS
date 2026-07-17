/**
 * Single-user password gate. Opt-in: when PSOS_PASSWORD is unset (local dev)
 * nothing is gated; when set (deployed), every page and API route requires the
 * session cookie except the login flow itself. Keeps crawlers/bots away from
 * the Claude Agent SDK endpoints when the app is reachable from the internet.
 */
import { NextRequest, NextResponse } from "next/server";

const COOKIE = "psos_auth";
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);

/** Deterministic session token: HMAC-SHA256 of a fixed label under the password. */
async function sessionToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("psos-session-v1"));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(req: NextRequest) {
  const password = process.env.PSOS_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const presented = req.cookies.get(COOKIE)?.value ?? "";
  const expected = await sessionToken(password);
  // Both strings derive from the server-side secret; a plain compare of the
  // attacker-supplied cookie against an HMAC leaks nothing usable.
  if (presented === expected) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { message: "Authentication required", code: "unauthorized" } },
      { status: 401 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Gate everything except Next static assets and the icon.
  matcher: ["/((?!_next/static|_next/image|icon\\.svg|favicon\\.ico).*)"],
};
