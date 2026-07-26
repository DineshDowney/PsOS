import type { NextConfig } from "next";
import { MAX_UPLOAD_BYTES } from "./src/server/lib/upload-limits";

const nextConfig: NextConfig = {
  experimental: {
    // src/middleware.ts matches /api/imports, so Next clones the request body —
    // and silently TRUNCATES the clone past this cap rather than rejecting it,
    // which left `req.formData()` throwing "expected boundary after body" on any
    // front+back upload (2026-07-26: two ~5.8 MB photos beat the 10 MB default).
    // Keep in step with the route's own guard via the shared constant.
    middlewareClientMaxBodySize: MAX_UPLOAD_BYTES,
  },
  // Dev-tools badge top-right. Note: if hidden via its own menu, Next.js
  // provides no API to re-show it — restarting `npm run dev` restores it.
  devIndicators: { position: "top-right" },
  // Native / heavy Node packages must not be bundled by webpack/turbopack.
  serverExternalPackages: [
    "better-sqlite3",
    "sharp",
    "@imgly/background-removal-node",
    "@anthropic-ai/claude-agent-sdk",
    "archiver",
  ],
};

export default nextConfig;
