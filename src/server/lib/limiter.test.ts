import { describe, expect, it } from "vitest";
import { createLimiter } from "./limiter";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createLimiter", () => {
  it("never runs more than maxConcurrent tasks at once", async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    const done: number[] = [];

    const task = (id: number) =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        await tick();
        active--;
        done.push(id);
        return id;
      });

    const results = await Promise.all([1, 2, 3, 4, 5].map(task));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(done).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("runs tasks in FIFO order", async () => {
    const run = createLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((id) =>
        run(async () => {
          order.push(id);
          await tick();
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it("a rejected task does not jam the queue", async () => {
    const run = createLimiter(1);
    const boom = run(async () => {
      throw new Error("boom");
    });
    const after = run(async () => "survived");
    await expect(boom).rejects.toThrow("boom");
    await expect(after).resolves.toBe("survived");
  });

  it("rejects a non-positive concurrency up front", () => {
    expect(() => createLimiter(0)).toThrow();
  });
});
