import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdFor, keepaliveEnabled, readHold } from "./keepalive";

const saved = process.env.RUNTIME_DIRECTORY;
let dir: string;

describe("keepalive flag", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "psos-keepalive-"));
    process.env.RUNTIME_DIRECTORY = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.RUNTIME_DIRECTORY;
    else process.env.RUNTIME_DIRECTORY = saved;
  });

  it("is a no-op when the runtime directory does not exist", () => {
    // How the Windows dev machine sees it: no /run/psos, so nothing to hold.
    process.env.RUNTIME_DIRECTORY = path.join(dir, "nope");
    expect(keepaliveEnabled()).toBe(false);
    expect(holdFor(60_000)).toBeNull();
    expect(readHold()).toBeNull();
  });

  it("reads back the deadline it wrote", () => {
    const now = 1_000_000;
    expect(holdFor(10 * 60_000, now)).toBe(now + 10 * 60_000);
    expect(readHold()).toBe(now + 10 * 60_000);
  });

  it("never moves the deadline earlier", () => {
    const now = 1_000_000;
    holdFor(4 * 60 * 60_000, now); // manual "hold 4h"
    // A 10-minute heartbeat arriving afterwards must not cut the hold short.
    expect(holdFor(10 * 60_000, now)).toBe(now + 4 * 60 * 60_000);
    expect(readHold()).toBe(now + 4 * 60 * 60_000);
  });

  it("extends the deadline when the new request reaches further", () => {
    const now = 1_000_000;
    holdFor(5 * 60_000, now);
    expect(holdFor(15 * 60_000, now)).toBe(now + 15 * 60_000);
  });

  it("treats garbage in the file as no hold rather than throwing", () => {
    fs.writeFileSync(path.join(dir, "keepalive"), "not-a-number", "utf8");
    expect(readHold()).toBeNull();
    // …and a write on top of it still works, so one bad file is self-healing.
    const now = 1_000_000;
    expect(holdFor(60_000, now)).toBe(now + 60_000);
  });
});
