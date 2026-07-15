"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { ActivityEntry } from "@/shared/types";
import { Button, Field, PageTitle, inputClass } from "@/components/ui";
import { useToast } from "@/components/providers";

/** Models accepted by the Claude Agent SDK (availability depends on your Claude plan). */
const MODEL_OPTIONS = [
  { value: "", label: "Default (your Claude Code model)" },
  { value: "claude-fable-5", label: "Claude Fable 5 — most capable" },
  { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5 — fast + smart" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fastest, lightest on limits" },
];

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
      <PageTitle sub="AI runs through your Claude Code login — no API key stored.">Settings</PageTitle>

      <div className="mb-10 flex max-w-lg flex-col gap-5 border border-line bg-surface p-6">
        <Field label="Chat model" hint="used by Stylist Chat">
          <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field
          label="Import extraction model"
          hint="reads your photos during import and drafts the item's metadata"
        >
          <select className={inputClass} value={extractionModel} onChange={(e) => setExtractionModel(e.target.value)}>
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <p className="text-xs leading-relaxed text-muted">
          Both run through your Claude Code login. “Default” uses whatever model your Claude
          Code session uses. Haiku is fastest/cheapest on your usage limits; Opus is the most
          thorough — a reasonable split is a strong model for extraction (accuracy on photos
          matters, runs once per item) and default for chat.
        </p>
        <div>
          <Button variant="solid" onClick={() => save.mutate()}>Save</Button>
        </div>
      </div>

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
