"use client";

import { useState } from "react";
import { inputClass } from "@/components/ui";

/**
 * Single-password login for the opt-in gate (src/middleware.ts). Uses raw
 * fetch — the shared api client redirects to /login on 401, which would loop.
 */
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (res?.ok) {
      location.href = "/wardrobe";
      return;
    }
    const body = await res?.json().catch(() => null);
    setError(body?.error?.message ?? "Login failed");
    setBusy(false);
  };

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-6">
        <div className="text-center text-xs font-semibold uppercase tracking-[0.35em]">
          Stylist&nbsp;OS
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className={inputClass}
        />
        {error ? <div className="text-center text-xs text-danger">{error}</div> : null}
        <button
          type="submit"
          disabled={busy || !password}
          className="bg-fg px-4 py-2 text-xs font-medium uppercase tracking-[0.08em] text-bg transition-colors hover:bg-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
