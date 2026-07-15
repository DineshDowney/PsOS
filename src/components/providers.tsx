"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Toasts — small, self-contained; every mutation error lands here.

interface Toast {
  id: number;
  kind: "error" | "info";
  text: string;
}

const ToastContext = createContext<(kind: Toast["kind"], text: string) => void>(
  () => {},
);

export function useToast() {
  return useContext(ToastContext);
}

let toastSeq = 0;

export function Providers({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
          mutations: {
            onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
          },
        },
      }),
    [push],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastContext.Provider value={push}>
        {children}
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`max-w-sm border px-4 py-3 text-sm ${
                t.kind === "error"
                  ? "border-danger bg-surface text-danger"
                  : "border-line bg-surface text-fg"
              }`}
            >
              {t.text}
            </div>
          ))}
        </div>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}
