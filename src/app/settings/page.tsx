"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { ActivityEntry, PowerState } from "@/shared/types";
import { Button, Field, PageTitle, inputClass } from "@/components/ui";
import { useToast } from "@/components/providers";

/** Models accepted by the Claude Agent SDK (availability depends on your Claude plan). */
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

/**
 * The VM powers itself off to keep the bill near zero, which is invisible and
 * therefore alarming when it happens mid-session. This card makes the countdown
 * visible and gives a way to override it.
 */
function PowerCard() {
  const toast = useToast();
  const qc = useQueryClient();
  // 20s: fine-grained enough for a minute-granularity readout, and it doubles
  // as proof the server is still up.
  const { data } = useQuery({
    queryKey: ["power"],
    queryFn: () => apiGet<PowerState>("/api/system/power"),
    refetchInterval: 20_000,
  });

  const hold = useMutation({
    mutationFn: () => apiSend("/api/system/power", "POST", { minutes: 4 * 60 }),
    onSuccess: () => {
      toast("info", "Holding the VM up for 4 hours");
      qc.invalidateQueries({ queryKey: ["power"] });
    },
  });

  if (!data) return null;
  if (!data.enabled) {
    return (
      <div className="mb-10 max-w-lg border border-line bg-surface p-6">
        <div className="mb-2 text-[10px] uppercase tracking-[0.25em] text-muted">Power</div>
        <p className="text-sm text-muted">
          Running locally — nothing powers off here.
        </p>
      </div>
    );
  }

  const minutesFrom = (t: number | null) =>
    t === null ? null : Math.max(0, Math.round((t - data.now) / 60_000));
  const offIn = minutesFrom(data.poweroffAt);
  const heldFor = minutesFrom(data.holdUntil);

  return (
    <div className="mb-10 max-w-lg border border-line bg-surface p-6">
      <div className="mb-2 text-[10px] uppercase tracking-[0.25em] text-muted">Power</div>
      <p className="mb-1 text-sm text-fg">
        {offIn === null
          ? "No power-off scheduled."
          : `Powers off in about ${offIn} min.`}
      </p>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        {heldFor !== null && heldFor > 0
          ? `Held awake for another ${heldFor} min — imports in progress, or you've been using it.`
          : "Nothing is holding it awake. Using the app or running an import extends this automatically."}
      </p>
      <Button onClick={() => hold.mutate()}>Hold for 4 hours</Button>
    </div>
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

      <div className="mb-10 flex max-w-lg flex-col gap-5 border border-line bg-surface p-6">
        <Field label="Chat model" hint="Claude — used by Stylist Chat">
          <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
            {CHAT_MODELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field
          label="Import extraction model"
          hint="Gemini — reads your photos during import and drafts the item's metadata"
        >
          <select className={inputClass} value={extractionModel} onChange={(e) => setExtractionModel(e.target.value)}>
            {EXTRACTION_MODELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <p className="text-xs leading-relaxed text-muted">
          Chat draws on your Claude Code usage limits, so “Default” is usually right. Extraction
          bills to the Vertex project by the token, and runs once per imported item — Flash is
          accurate enough on garment photos that the heavier tiers are rarely worth it. Either
          “Default” falls back through a list of current models, so a retired model id never
          breaks an import.
        </p>
        <div>
          <Button variant="solid" onClick={() => save.mutate()}>Save</Button>
        </div>
      </div>

      <PowerCard />

      <div className="mb-10 max-w-lg border border-line bg-surface p-6">
        <div className="mb-2 text-[10px] uppercase tracking-[0.25em] text-muted">Backup</div>
        <p className="mb-4 text-sm text-muted">
          Everything lives in the local <code className="text-fg">data/</code> folder. Download a zip of the
          database and all images.
        </p>
        <a href="/api/export" download>
          <Button>Export data</Button>
        </a>
      </div>

      <div className="max-w-3xl border border-line bg-surface p-6">
        <div className="mb-4 text-[10px] uppercase tracking-[0.25em] text-muted">Recent activity</div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          {(activity?.entries ?? []).map((e) => (
            <div key={e.id} className="flex gap-3">
              <span className="w-36 shrink-0 text-faint">{e.ts.slice(0, 19).replace("T", " ")}</span>
              <span className="w-12 shrink-0 uppercase">{e.actor}</span>
              <span>{e.action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
