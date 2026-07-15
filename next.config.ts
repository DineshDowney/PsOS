import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
