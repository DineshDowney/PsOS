/**
 * Gemini via Vertex AI, API-key auth (express mode).
 *
 * Auth: VERTEX_API_KEY from the environment only — never from `settings` (that
 * table is served publicly by /api/settings) and never committed. On the VM it
 * lives in ~/psos/.env.local.
 *
 * Model IDs move faster than this code; every caller passes a CANDIDATE LIST and
 * we use the first model the API accepts, remembering it for the rest of the
 * process. A 404/400 on one candidate is expected, not an error.
 */

const HOST = "https://aiplatform.googleapis.com/v1";

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

export function hasVertexKey(): boolean {
  return vertexApiKey() !== null;
}

/** Model that worked last, per process — avoids re-probing dead candidates. */
const resolved = new Map<string, string>();

function cacheKey(models: string[]): string {
  return models.join("|");
}

export async function generateContent(opts: GenerateOptions): Promise<GenerateResult> {
  const key = vertexApiKey();
  if (!key) throw new Error("VERTEX_API_KEY is not set");

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
    const url = `${HOST}/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
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
    failures.push(`${model}: HTTP ${res.status} ${text.slice(0, 300)}`);
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
