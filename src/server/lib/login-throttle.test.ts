import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearLoginFailures,
  loginDelayMs,
  loginKey,
  recordLoginFailure,
  resetLoginThrottle,
} from "./login-throttle";

describe("login throttle", () => {
  beforeEach(() => resetLoginThrottle());

  it("does not delay the first few attempts", () => {
    for (let i = 0; i < 3; i++) {
      expect(loginDelayMs("ip")).toBe(0);
      recordLoginFailure("ip");
    }
    expect(loginDelayMs("ip")).toBe(250);
  });

  it("grows the delay and caps it", () => {
    for (let i = 0; i < 40; i++) recordLoginFailure("ip");
    expect(loginDelayMs("ip")).toBe(5_000);
  });

  it("never locks out: a correct password clears the cost", () => {
    for (let i = 0; i < 20; i++) recordLoginFailure("ip");
    expect(loginDelayMs("ip")).toBeGreaterThan(0);
    clearLoginFailures("ip");
    expect(loginDelayMs("ip")).toBe(0);
  });

  it("keeps buckets separate per client and forgets old windows", () => {
    for (let i = 0; i < 10; i++) recordLoginFailure("a");
    expect(loginDelayMs("a")).toBeGreaterThan(0);
    expect(loginDelayMs("b")).toBe(0);

    // Same bucket, 11 minutes later — the window has rolled over.
    const later = Date.now() + 11 * 60_000;
    expect(loginDelayMs("a", later)).toBe(0);
  });

  describe("loginKey", () => {
    const saved = process.env.PSOS_BEHIND_TLS;
    afterEach(() => {
      if (saved === undefined) delete process.env.PSOS_BEHIND_TLS;
      else process.env.PSOS_BEHIND_TLS = saved;
    });

    it("ignores x-forwarded-for when nothing trusted is in front of us", () => {
      // Served directly, the header is attacker-supplied — per-IP buckets would
      // let a guesser rotate the key on every request.
      delete process.env.PSOS_BEHIND_TLS;
      expect(loginKey(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("shared");
    });

    it("takes the LAST hop behind a trusted proxy, not the client-supplied first", () => {
      process.env.PSOS_BEHIND_TLS = "1";
      // "9.9.9.9" is whatever the client sent; "5.6.7.8" is what our proxy appended.
      expect(loginKey(new Headers({ "x-forwarded-for": "9.9.9.9, 5.6.7.8" }))).toBe("5.6.7.8");
      // A proxy that replaces rather than appends works too.
      expect(loginKey(new Headers({ "x-forwarded-for": "5.6.7.8" }))).toBe("5.6.7.8");
      expect(loginKey(new Headers())).toBe("shared");
    });
  });
});
