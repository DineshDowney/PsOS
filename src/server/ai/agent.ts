import {
  query,
  type Options,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { getSetting } from "@/server/services/settings";

/**
 * Thin wrapper around the Claude Agent SDK.
 *
 * Authentication: the SDK runs the bundled Claude Code runtime, which uses the
 * machine's existing Claude Code login (~/.claude). No API key is stored or
 * required by this app. All other AI modules go through this file — it is the
 * single place to swap in a direct-API implementation later.
 */

export interface RunAgentOptions {
  prompt: string;
  /** Tool names the agent may use; everything else is denied. */
  allowedTools?: string[];
  mcpServers?: Options["mcpServers"];
  systemPrompt?: string;
  maxTurns?: number;
  resume?: string;
  model?: string;
  includePartialMessages?: boolean;
  cwd?: string;
  abortController?: AbortController;
}

export function runAgent(opts: RunAgentOptions): AsyncGenerator<SDKMessage, void> {
  const allowed = new Set(opts.allowedTools ?? []);
  const model = opts.model ?? getSetting("ai.model") ?? undefined;

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (allowed.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    return {
      behavior: "deny",
      message: `Tool ${toolName} is not permitted in this context.`,
    };
  };

  return query({
    prompt: opts.prompt,
    options: {
      model,
      cwd: opts.cwd ?? process.cwd(),
      allowedTools: opts.allowedTools,
      canUseTool,
      maxTurns: opts.maxTurns ?? 12,
      mcpServers: opts.mcpServers,
      resume: opts.resume,
      includePartialMessages: opts.includePartialMessages ?? false,
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.abortController ? { abortController: opts.abortController } : {}),
    },
  }) as AsyncGenerator<SDKMessage, void>;
}

/** Run to completion and return the final result text (non-streaming helper). */
export async function runAgentToResult(opts: RunAgentOptions): Promise<string> {
  let result: string | null = null;
  let errorSubtype: string | null = null;
  for await (const message of runAgent(opts)) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        result = message.result;
      } else {
        errorSubtype = message.subtype;
      }
    }
  }
  if (result === null) {
    throw new Error(
      `Claude agent run did not produce a result${errorSubtype ? ` (${errorSubtype})` : ""}. ` +
        "Check that Claude Code is logged in on this machine.",
    );
  }
  return result;
}
