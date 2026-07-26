"use client";

/**
 * Client-side upload queue, so picking photos and hitting Start returns the form
 * immediately instead of holding the user for the 10-15s the bytes take.
 *
 * Lives under Providers, which wraps every screen and does not unmount on
 * client-side navigation — so an upload keeps going while he moves around the
 * app. It does NOT survive a tab close or a hard reload: anything still queued
 * is lost and anything in flight dies. `beforeunload` warns; real durability
 * would need a Service Worker with Background Fetch, which is far more machinery
 * than one person uploading garments needs.
 *
 * Strictly one upload at a time — Dinesh's call, and the right one: the server
 * already runs two pipelines concurrently with image calls serialized 1-wide, and
 * parallel uploads over a single relay just split the same bandwidth while making
 * every progress bar meaningless.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiUpload } from "@/lib/api";
import { downscale } from "@/lib/downscale";
import type { ImportJob } from "@/shared/types";

export type UploadStatus = "waiting" | "preparing" | "uploading" | "done" | "failed";

export interface UploadItem {
  id: string;
  label: string;
  front: File;
  back: File | null;
  status: UploadStatus;
  /** 0..1, meaningful while uploading. */
  progress: number;
  error: string | null;
}

export interface QueueState {
  items: UploadItem[];
}

export type QueueAction =
  | { type: "enqueue"; item: UploadItem }
  | { type: "preparing"; id: string }
  | { type: "uploading"; id: string }
  | { type: "progress"; id: string; fraction: number }
  | { type: "done"; id: string }
  | { type: "failed"; id: string; error: string }
  | { type: "retry"; id: string }
  | { type: "remove"; id: string };

/** In-flight means the worker owns it; nothing else may start. */
export function activeItem(state: QueueState): UploadItem | undefined {
  return state.items.find((i) => i.status === "preparing" || i.status === "uploading");
}

export function nextWaiting(state: QueueState): UploadItem | undefined {
  return state.items.find((i) => i.status === "waiting");
}

/** Anything the user would lose by closing the tab. */
export function pendingCount(state: QueueState): number {
  return state.items.filter(
    (i) => i.status === "waiting" || i.status === "preparing" || i.status === "uploading",
  ).length;
}

function patch(state: QueueState, id: string, fields: Partial<UploadItem>): QueueState {
  return { items: state.items.map((i) => (i.id === id ? { ...i, ...fields } : i)) };
}

/**
 * The concurrency rule lives HERE rather than only in the worker effect, so
 * "one at a time" is a property of the state machine that a test can assert. A
 * transition into `preparing` is refused while another item is in flight.
 */
export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "enqueue":
      return { items: [...state.items, action.item] };

    case "preparing": {
      const item = state.items.find((i) => i.id === action.id);
      if (!item || item.status !== "waiting") return state;
      if (activeItem(state)) return state; // refuse a second concurrent upload
      return patch(state, action.id, { status: "preparing", error: null, progress: 0 });
    }

    case "uploading":
      return patch(state, action.id, { status: "uploading", progress: 0 });

    case "progress":
      return patch(state, action.id, {
        progress: Math.min(1, Math.max(0, action.fraction)),
      });

    case "done":
      return patch(state, action.id, { status: "done", progress: 1, error: null });

    case "failed":
      return patch(state, action.id, { status: "failed", error: action.error });

    case "retry": {
      const item = state.items.find((i) => i.id === action.id);
      if (!item || item.status !== "failed") return state;
      return patch(state, action.id, { status: "waiting", error: null, progress: 0 });
    }

    case "remove":
      return { items: state.items.filter((i) => i.id !== action.id) };

    default:
      return state;
  }
}

export interface UploadQueueApi {
  items: UploadItem[];
  enqueue: (input: { front: File; back: File | null }) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
}

const UploadQueueContext = createContext<UploadQueueApi>({
  items: [],
  enqueue: () => {},
  retry: () => {},
  dismiss: () => {},
});

export function useUploadQueue(): UploadQueueApi {
  return useContext(UploadQueueContext);
}

/** How long a finished row lingers before the job list takes over. */
const DONE_LINGER_MS = 4000;

/**
 * `onError` rather than useToast(): providers.tsx mounts this component, so
 * importing its toast hook here would make the two modules import each other.
 * Reporting through a callback keeps the queue ignorant of how errors get shown.
 */
export function UploadQueueProvider({
  children,
  onError,
}: {
  children: React.ReactNode;
  onError: (message: string) => void;
}) {
  const [state, dispatch] = useReducer(queueReducer, { items: [] });
  const qc = useQueryClient();
  // Guards against a second worker being spawned by an effect re-run (progress
  // dispatches change `items`, and React may invoke effects twice in dev).
  const runningRef = useRef<string | null>(null);
  // Re-runs the worker after one finishes. Without this the queue advances only
  // because the terminal dispatch happens to re-render AFTER the ref is cleared,
  // which is true today but would silently stall the queue the moment anyone
  // added an `await` near the end of the worker. Cheap insurance.
  const [tick, wake] = useReducer((n: number) => n + 1, 0);

  const enqueue = useCallback((input: { front: File; back: File | null }) => {
    dispatch({
      type: "enqueue",
      item: {
        id: crypto.randomUUID(),
        label: input.front.name || "photo",
        front: input.front,
        back: input.back,
        status: "waiting",
        progress: 0,
        error: null,
      },
    });
  }, []);

  const retry = useCallback((id: string) => dispatch({ type: "retry", id }), []);
  const dismiss = useCallback((id: string) => dispatch({ type: "remove", id }), []);

  // The worker: pick up the next waiting item whenever nothing is in flight.
  useEffect(() => {
    if (runningRef.current) return;
    const next = nextWaiting(state);
    if (!next || activeItem(state)) return;

    runningRef.current = next.id;
    const id = next.id;

    void (async () => {
      try {
        dispatch({ type: "preparing", id });
        const front = await downscale(next.front);
        const back = next.back ? await downscale(next.back) : null;

        const form = new FormData();
        form.set("front", front);
        if (back) form.set("back", back);

        dispatch({ type: "uploading", id });
        // Only dispatch on a whole-percent change: the progress event fires per
        // chunk, and every dispatch re-runs this effect.
        let lastPercent = -1;
        await apiUpload<{ job: ImportJob }>("/api/imports", form, (fraction) => {
          const percent = Math.round(fraction * 100);
          if (percent === lastPercent) return;
          lastPercent = percent;
          dispatch({ type: "progress", id, fraction });
        });

        dispatch({ type: "done", id });
        void qc.invalidateQueries({ queryKey: ["imports"] });
        setTimeout(() => dispatch({ type: "remove", id }), DONE_LINGER_MS);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dispatch({ type: "failed", id, error: message });
        onError(message);
      } finally {
        runningRef.current = null;
        wake();
      }
    })();
  }, [state, qc, onError, tick]);

  // Closing the tab abandons queued work, so say so.
  const pending = pendingCount(state);
  useEffect(() => {
    if (pending === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const api = useMemo<UploadQueueApi>(
    () => ({ items: state.items, enqueue, retry, dismiss }),
    [state.items, enqueue, retry, dismiss],
  );

  return <UploadQueueContext.Provider value={api}>{children}</UploadQueueContext.Provider>;
}
