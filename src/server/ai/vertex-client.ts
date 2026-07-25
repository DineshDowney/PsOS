/**
 * Gemini via the Google AI (Gemini Developer) API, API-key auth.
 *
 * Endpoint note: an AI Studio key authenticates against
 * `generativelanguage.googleapis.com`. The full Vertex REST surface
 * (`aiplatform.googleapis.com/v1/projects/...`) rejects API keys outright
 * ("Expected OAuth2 access token") — verified live 2026-07-25 — so that path is
 * only an option if we ever switch to service-account/ADC auth.
 *
 * Auth: VERTEX_API_KEY from the environment only — never from `settings` (that
 * table is served publicly by /api/settings) and never committed. On the VM it
 * lives in ~/psos/.env.local.
 *
 * Model IDs move faster than this code; every caller passes a CANDIDATE LIST and
 * we use the first model the API accepts, remembering it for the rest of the
 * process. A 404/400 on one candidate is expected, not an error. `listModels()`
 * enumerates what this key can actually reach.
 */

const HOST = process.env.GEMINI_API_HOST?.trim() || "https://generativelanguage.googleapis.com/v1beta";

export interface InlinePart {
  inlineData: { mimeType: string; data: string };
}
export interface TextPart {
  text: string;
}
export type Part = TextPart | InlinePart;

export interface GenerateOptions {
  /** Tried in order; first one that responds wins. */
  models: string[];
  parts: Part[];
  responseMimeType?: string;
  responseModalities?: string[];
  temperature?: number;
  maxOutputTokens?: number;
}

interface Candidate {
  content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> };
  finishReason?: string;
}
export interface GenerateResult {
  model: string;
  candidates?: Candidate[];
  promptFeedback?: unknown;
}

export function vertexApiKey(): string | null {
  const key = process.env.VERTEX_API_KEY?.trim();
  return key ? key : null;
}

/**
 * True when a call can be made at all: either an API key is present, or we are
 * meant to use the VM's own service-account identity.
 */
export function hasVertexKey(): boolean {
  return vertexApiKey() !== null || useAdc();
}

function useAdc(): boolean {
  return process.env.VERTEX_USE_ADC === "1";
}

/**
 * Vertex AI via the VM's service account — no key exists anywhere. The token
 * comes from the GCE metadata server, which is only reachable from inside the
 * VM; that is a feature, not a limitation (the laptop physically cannot spend
 * money this way).
 */
let cachedToken: { token: string; expiresAt: number } | null = null;

async function metadataToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) {
    throw new Error(
      `metadata token failed: HTTP ${res.status} — is this running on the VM with cloud-platform scope?`,
    );
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

function vertexLocation(): string {
  return process.env.VERTEX_LOCATION?.trim() || "us-central1";
}

function vertexUrl(model: string): string {
  const project = process.env.VERTEX_PROJECT_ID?.trim();
  if (!project) throw new Error("VERTEX_PROJECT_ID is required for Vertex (ADC) calls");
  const loc = vertexLocation();
  const host =
    loc === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${loc}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`;
}

/** Where a request should go and how it should authenticate. */
async function requestTarget(model: string): Promise<{ url: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useAdc()) {
    headers.Authorization = `Bearer ${await metadataToken()}`;
    return { url: vertexUrl(model), headers };
  }
  const key = vertexApiKey();
  if (!key) throw new Error("VERTEX_API_KEY is not set");
  return { url: `${HOST}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, headers };
}

/** Model that worked last, per process — avoids re-probing dead candidates. */
const resolved = new Map<string, string>();

function cacheKey(models: string[]): string {
  return models.join("|");
}

export async function generateContent(opts: GenerateOptions): Promise<GenerateResult> {
  if (!hasVertexKey()) throw new Error("No Gemini credentials: set VERTEX_API_KEY or VERTEX_USE_ADC=1");

  const known = resolved.get(cacheKey(opts.models));
  const queue = known ? [known] : opts.models;

  const body = JSON.stringify({
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: {
      ...(opts.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
      ...(opts.responseModalities ? { responseModalities: opts.responseModalities } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    },
  });

  const failures: string[] = [];
  for (const model of queue) {
    let res: Response;
    try {
      const { url, headers } = await requestTarget(model);
      res = await fetch(url, { method: "POST", headers, body });
    } catch (err) {
      failures.push(`${model}: network error ${err instanceof Error ? err.message : err}`);
      continue;
    }

    if (res.ok) {
      resolved.set(cacheKey(opts.models), model);
      const json = (await res.json()) as GenerateResult;
      return { ...json, model };
    }

    const text = await res.text().catch(() => "");
    // 404/400 usually means "this model id doesn't exist here" — try the next.
    // Keep plenty of the body: quota/permission errors name the exact limit,
    // and truncating that turns a 30-second diagnosis into guesswork.
    failures.push(`${model}: HTTP ${res.status} ${text.replace(/\s+/g, " ").slice(0, 1200)}`);
    if (res.status === 401 || res.status === 403) break; // auth problem: no point probing further
  }

  throw new Error(`Vertex generateContent failed.\n${failures.join("\n")}`);
}

/** First text part of the first candidate, or "". */
export function firstText(result: GenerateResult): string {
  const parts = result.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("").trim();
}

/** First inline image of the first candidate as a Buffer, or null. */
export function firstImage(result: GenerateResult): Buffer | null {
  const parts = result.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const data = p.inlineData?.data;
    if (data) return Buffer.from(data, "base64");
  }
  return null;
}

export function inlineImage(buffer: Buffer, mimeType = "image/jpeg"): InlinePart {
  return { inlineData: { mimeType, data: buffer.toString("base64") } };
}

export interface ModelInfo {
  name: string; // "models/gemini-x"
  displayName?: string;
  supportedGenerationMethods?: string[];
}

/**
 * Everything this key can reach — removes all model-id guesswork.
 * Key transport only: Vertex has no equivalent public-model listing.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const key = vertexApiKey();
  if (!key) throw new Error("listModels requires VERTEX_API_KEY (not available on the Vertex/ADC path)");
  const res = await fetch(`${HOST}/models?key=${encodeURIComponent(key)}&pageSize=200`);
  if (!res.ok) {
    throw new Error(`listModels failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { models?: ModelInfo[] };
  return json.models ?? [];
}
