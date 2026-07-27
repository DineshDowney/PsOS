"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { ActivityEntry, PowerState } from "@/shared/types";
import { Button, Field, PageTitle, SectionLabel, Skeleton, inputClass } from "@/components/ui";
import { useToast } from "@/components/providers";

/**
 * Two providers, two lists. Chat runs on the Claude Agent SDK (your Claude Code
 * login); extraction runs on Gemini via Vertex. Offering one shared list was a
 * silent no-op — a Claude id in the extraction setting is filtered out before it
 * can reach Vertex, so the control looked like it worked and did nothing.
 */
const CHAT_MODELS = [
  { value: "", label: "Default (your Claude Code model)" },
  { value: "claude-fable-5", label: "Claude Fable 5 — most capable" },
  { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5 — fast + smart" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest, lightest on limits" },
];

const EXTRACTION_MODELS = [
  { value: "", label: "Default (newest Flash the project can reach)" },
  { value: "gemini-flash-latest", label: "Gemini Flash (latest)" },
  { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite — cheapest" },
];

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`card p-6 ${className ?? ""}`}>{children}</div>;
}

const HOLD_OPTIONS = [
  { minutes: 30, label: "30 min" },
  { minutes: 2 * 60, label: "2 hours" },
  { minutes: 4 * 60, label: "4 hours" },
];

/** mm:ss under an hour, then whole minutes — a seconds readout on a 3-hour hold is noise. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The VM powers itself off to keep the bill near zero, which is invisible and
 * therefore alarming when it happens mid-session. This card makes the countdown
 * visible and gives ways to override it.
 *
 * The countdown ticks locally against a server-time offset rather than
 * re-rendering only on the 20s poll: a number that sits still for twenty
 * seconds and then jumps by twenty reads as broken, and the clock the page can
 * trust is the server's, not the device's.
 */
function PowerCard() {
  const toast = useToast();
  const qc = useQueryClient();
  // 20s: fine-grained enough to catch a change made elsewhere, and it doubles
  // as proof the server is still up.
  const { data, isLoading } = useQuery({
    queryKey: ["power"],
    queryFn: () => apiGet<PowerState>("/api/system/power"),
    refetchInterval: 20_000,
  });

  // Re-render once a second so the countdown actually counts down.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  /*
   * Offset between this device's clock and the server's, sampled each time a
   * poll lands. Every deadline in `data` is server-time, and the device clock
   * can be wrong by minutes — on a countdown to a shutdown, that is the
   * difference between "20 min left" and the machine already being gone.
   */
  const [skew, setSkew] = useState(0);
  useEffect(() => {
    if (data) setSkew(data.now - Date.now());
  }, [data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["power"] });

  const hold = useMutation({
    mutationFn: (minutes: number) => apiSend("/api/system/power", "POST", { minutes }),
    onSuccess: (_r, minutes) => {
      toast("info", `Holding the VM up for ${HOLD_OPTIONS.find((o) => o.minutes === minutes)?.label ?? `${minutes} min`}`);
      invalidate();
    },
  });

  const release = useMutation({
    mutationFn: () => apiSend("/api/system/power", "DELETE"),
    onSuccess: () => {
      toast("info", "Hold released — it can sleep when idle again");
      invalidate();
    },
  });

  // Reserve the space rather than returning null, so the sections below it do
  // not jump down when the first poll lands.
  if (isLoading || !data) {
    return (
      <Card className="mb-8 max-w-lg">
        <Skeleton className="mb-3 h-4 w-16" />
        <Skeleton className="mb-2 h-4 w-52" />
        <Skeleton className="h-8 w-64" />
      </Card>
    );
  }

  if (!data.enabled) {
    return (
      <Card className="mb-8 max-w-lg">
        <SectionLabel className="mb-2">Power</SectionLabel>
        <p className="text-meta text-muted">Running locally — nothing powers off here.</p>
      </Card>
    );
  }

  const serverNow = Date.now() + skew;
  const offIn = data.poweroffAt === null ? null : data.poweroffAt - serverNow;
  const heldFor = data.holdUntil === null ? null : data.holdUntil - serverNow;
  const held = heldFor !== null && heldFor > 0;

  return (
    <Card className="mb-8 max-w-lg">
      <SectionLabel className="mb-3">Power</SectionLabel>

      <p className="text-body text-fg">
        {offIn === null || offIn <= 0
          ? "No power-off scheduled."
          : (
            <>
              Powers off in{" "}
              <span className="font-medium tabular-nums">{formatRemaining(offIn)}</span>.
            </>
          )}
      </p>
      <p className="mt-1 text-meta text-muted">
        {held
          ? `Held awake for another ${formatRemaining(heldFor!)} — an import is running, or you've been using it.`
          : "Nothing is holding it awake. Using the app extends this automatically."}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {HOLD_OPTIONS.map((opt) => (
          <Button
            key={opt.minutes}
            onClick={() => hold.mutate(opt.minutes)}
            loading={hold.isPending && hold.variables === opt.minutes}
          >
            {opt.label}
          </Button>
        ))}
        {held ? (
          <Button variant="ghost" onClick={() => release.mutate()} loading={release.isPending}>
            Release
          </Button>
        ) : null}
      </div>

      <p className="mt-3 text-micro text-faint">
        Holding only postpones sleep. To power it off now, use the Google Cloud app or
        <code className="mx-1 text-muted">scripts/vm-stop.cmd</code> — the app runs unprivileged
        and cannot shut the machine down itself.
      </p>
    </Card>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<{ settings: Record<string, string> }>("/api/settings"),
  });
  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: () => apiGet<{ entries: ActivityEntry[] }>("/api/activity?limit=50"),
  });

  const [model, setModel] = useState("");
  const [extractionModel, setExtractionModel] = useState("");
  useEffect(() => {
    setModel(data?.settings["ai.model"] ?? "");
    setExtractionModel(data?.settings["ai.extractionModel"] ?? "");
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      apiSend("/api/settings", "PATCH", {
        "ai.model": model,
        "ai.extractionModel": extractionModel,
      }),
    onSuccess: () => {
      toast("info", "Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  return (
    <div>
      <PageTitle sub="Chat runs on your Claude Code login. Images and metadata run on Gemini.">
        Settings
      </PageTitle>

      <Card className="mb-8 flex max-w-lg flex-col gap-5">
        <SectionLabel>Models</SectionLabel>
        <Field label="Chat model" hint="Claude — used by Stylist Chat">
          <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
            {CHAT_MODELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field
          label="Import extraction model"
          hint="Gemini — reads your photos and drafts the item's metadata"
        >
          <select
            className={inputClass}
            value={extractionModel}
            onChange={(e) => setExtractionModel(e.target.value)}
          >
            {EXTRACTION_MODELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <p className="text-meta text-muted">
          Chat draws on your Claude Code usage limits, so “Default” is usually right. Extraction
          bills to the Vertex project by the token and runs once per imported item — Flash is
          accurate enough on garment photos that the heavier tiers are rarely worth it. Either
          “Default” falls back through a list of current models, so a retired model id never
          breaks an import.
        </p>
        <div>
          <Button variant="solid" onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </div>
      </Card>

      <PowerCard />

      <Card className="mb-8 max-w-lg">
        <SectionLabel className="mb-2">Backup</SectionLabel>
        <p className="mb-4 text-meta text-muted">
          Everything lives in the local <code className="text-fg">data/</code> folder. Download a
          zip of the database and all images.
        </p>
        <a href="/api/export" download>
          <Button>Export data</Button>
        </a>
      </Card>

      <Card className="max-w-3xl">
        <SectionLabel className="mb-4">Recent activity</SectionLabel>
        <div className="flex flex-col divide-y divide-line/60 text-meta text-muted">
          {(activity?.entries ?? []).map((e) => (
            <div key={e.id} className="flex gap-4 py-1.5">
              <span className="w-36 shrink-0 tabular-nums text-faint">
                {e.ts.slice(0, 19).replace("T", " ")}
              </span>
              <span className="w-12 shrink-0 capitalize text-faint">{e.actor}</span>
              <span className="text-fg">{e.action}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
