/**
 * How big an upload the app accepts.
 *
 * Deliberately dependency-free: `next.config.ts` imports this, and that file is
 * loaded by Next's own config loader before any of the app's module graph
 * exists. An import of anything node-specific here breaks `next build`.
 *
 * Why this needs to be shared rather than a number in two places: Next clones
 * the request body for middleware and caps the clone at
 * `experimental.middlewareClientMaxBodySize`. Over the cap it does not reject
 * the request — it pushes EOF into the stream (see next/dist/server/
 * body-streams.js) and hands the route a TRUNCATED body. For multipart that
 * means the closing boundary is gone and `req.formData()` throws "expected
 * boundary after body". So if the route's guard and the Next cap ever disagree,
 * the failure is a confusing 500 instead of a clear message. One constant, both
 * places.
 *
 * 64 MB against real photos of ~5.8 MB each (front + back ≈ 11.4 MB, which is
 * what broke the 10 MB default on 2026-07-26). Headroom for higher-res phones
 * without letting a single request buffer unbounded on a 2 GB VM — the clone is
 * held twice while in flight.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** For error messages: "64 MB". */
export const MAX_UPLOAD_LABEL = `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`;

/** Human-readable megabytes, for "that photo is 71.2 MB" style messages. */
export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
