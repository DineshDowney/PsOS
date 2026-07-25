import { beforeEach, describe, expect, it } from "vitest";
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

  it("prefers the first x-forwarded-for hop, else a shared bucket", () => {
    expect(loginKey(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(loginKey(new Headers())).toBe("shared");
  });
});
