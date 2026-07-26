import { describe, expect, it } from "vitest";
import {
  queueReducer,
  activeItem,
  nextWaiting,
  pendingCount,
  type QueueState,
  type UploadItem,
} from "./upload-queue";

/** A queue item without needing a real File. */
function item(id: string, over: Partial<UploadItem> = {}): UploadItem {
  return {
    id,
    label: `${id}.jpg`,
    front: {} as File,
    back: null,
    status: "waiting",
    progress: 0,
    error: null,
    ...over,
  };
}

function stateOf(...items: UploadItem[]): QueueState {
  return { items };
}

describe("queueReducer", () => {
  it("appends in the order they were picked", () => {
    let s = stateOf();
    s = queueReducer(s, { type: "enqueue", item: item("a") });
    s = queueReducer(s, { type: "enqueue", item: item("b") });
    expect(s.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(nextWaiting(s)?.id).toBe("a");
  });

  // The whole point of putting sequencing in the reducer: "one at a time" is an
  // invariant a test can hold it to, not just a side effect of the worker's ref.
  it("refuses to start a second upload while one is in flight", () => {
    let s = stateOf(item("a"), item("b"));
    s = queueReducer(s, { type: "preparing", id: "a" });
    expect(activeItem(s)?.id).toBe("a");

    const attempted = queueReducer(s, { type: "preparing", id: "b" });
    expect(attempted).toBe(s); // unchanged, same object
    expect(attempted.items.find((i) => i.id === "b")?.status).toBe("waiting");
  });

  it("starts the next one once the first finishes", () => {
    let s = stateOf(item("a"), item("b"));
    s = queueReducer(s, { type: "preparing", id: "a" });
    s = queueReducer(s, { type: "uploading", id: "a" });
    s = queueReducer(s, { type: "done", id: "a" });
    expect(activeItem(s)).toBeUndefined();

    s = queueReducer(s, { type: "preparing", id: "b" });
    expect(activeItem(s)?.id).toBe("b");
  });

  it("only starts an item that is waiting", () => {
    const s = stateOf(item("a", { status: "failed", error: "boom" }));
    expect(queueReducer(s, { type: "preparing", id: "a" })).toBe(s);
  });

  it("clamps progress into 0..1", () => {
    let s = stateOf(item("a", { status: "uploading" }));
    s = queueReducer(s, { type: "progress", id: "a", fraction: 1.4 });
    expect(s.items[0]!.progress).toBe(1);
    s = queueReducer(s, { type: "progress", id: "a", fraction: -0.2 });
    expect(s.items[0]!.progress).toBe(0);
  });

  it("leaves a failed item retryable, and retry clears the error", () => {
    let s = stateOf(item("a", { status: "uploading", progress: 0.5 }));
    s = queueReducer(s, { type: "failed", id: "a", error: "network died" });
    expect(s.items[0]!.status).toBe("failed");
    expect(s.items[0]!.error).toBe("network died");

    s = queueReducer(s, { type: "retry", id: "a" });
    expect(s.items[0]!.status).toBe("waiting");
    expect(s.items[0]!.error).toBeNull();
    expect(s.items[0]!.progress).toBe(0);
    expect(nextWaiting(s)?.id).toBe("a");
  });

  it("a failed item does not block the queue", () => {
    let s = stateOf(item("a", { status: "failed", error: "boom" }), item("b"));
    expect(activeItem(s)).toBeUndefined();
    s = queueReducer(s, { type: "preparing", id: "b" });
    expect(activeItem(s)?.id).toBe("b");
  });

  it("retry is refused for anything not failed", () => {
    const s = stateOf(item("a", { status: "uploading" }));
    expect(queueReducer(s, { type: "retry", id: "a" })).toBe(s);
  });

  it("clears a stale error when the item starts again", () => {
    let s = stateOf(item("a", { status: "failed", error: "boom" }));
    s = queueReducer(s, { type: "retry", id: "a" });
    s = queueReducer(s, { type: "preparing", id: "a" });
    expect(s.items[0]!.error).toBeNull();
  });

  it("removes an item", () => {
    let s = stateOf(item("a"), item("b"));
    s = queueReducer(s, { type: "remove", id: "a" });
    expect(s.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("ignores actions for an id that is gone", () => {
    const s = stateOf(item("a"));
    expect(queueReducer(s, { type: "progress", id: "ghost", fraction: 0.5 }).items).toHaveLength(1);
    expect(queueReducer(s, { type: "preparing", id: "ghost" })).toBe(s);
  });
});

describe("pendingCount", () => {
  it("counts only what closing the tab would lose", () => {
    const s = stateOf(
      item("a", { status: "waiting" }),
      item("b", { status: "preparing" }),
      item("c", { status: "uploading" }),
      item("d", { status: "done" }),
      item("e", { status: "failed" }),
    );
    // done is already on the server; failed is not going anywhere on its own.
    expect(pendingCount(s)).toBe(3);
  });

  it("is zero for an empty queue", () => {
    expect(pendingCount(stateOf())).toBe(0);
  });
});
