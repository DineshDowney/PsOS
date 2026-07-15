import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { notFound } from "@/server/lib/errors";
import { parseJson, toJson } from "@/server/lib/json";
import { runAgent } from "@/server/ai/agent";
import { wardrobeMcpServer, WARDROBE_TOOL_NAMES, chatSystemPrompt } from "@/server/ai/tools";
import { logActivity } from "@/server/services/activity";
import type { ChatMessage, ChatMessageBlock, ChatSession } from "@/shared/types";

export function listSessions(): ChatSession[] {
  return getDb()
    .select()
    .from(schema.chatSessions)
    .orderBy(desc(schema.chatSessions.updatedAt))
    .all()
    .map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt }));
}

export function createSession(): ChatSession {
  const id = newId();
  const ts = nowIso();
  getDb()
    .insert(schema.chatSessions)
    .values({ id, title: null, createdAt: ts, updatedAt: ts })
    .run();
  return { id, title: null, createdAt: ts, updatedAt: ts };
}

export function deleteSession(id: string): void {
  getDb().delete(schema.chatSessions).where(eq(schema.chatSessions.id, id)).run();
}

export function listMessages(sessionId: string): ChatMessage[] {
  const rows = getDb()
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .all();
  return rows
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: parseJson<ChatMessageBlock[]>(r.content, []),
      createdAt: r.createdAt,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function storeMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: ChatMessageBlock[],
): ChatMessage {
  const id = newId();
  const ts = nowIso();
  getDb()
    .insert(schema.chatMessages)
    .values({ id, sessionId, role, content: toJson(content), createdAt: ts })
    .run();
  getDb()
    .update(schema.chatSessions)
    .set({ updatedAt: ts })
    .where(eq(schema.chatSessions.id, sessionId))
    .run();
  return { id, role, content, createdAt: ts };
}

export interface ChatStreamEvent {
  type: "text_delta" | "tool_use" | "assistant_message" | "done" | "error";
  text?: string;
  toolName?: string;
  message?: ChatMessage;
}

/**
 * Send a user message and stream the assistant's response.
 * Conversation continuity uses the Agent SDK's session resume; our own DB
 * keeps the durable transcript.
 */
export async function* sendMessage(
  sessionId: string,
  text: string,
): AsyncGenerator<ChatStreamEvent> {
  const db = getDb();
  const session = db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId))
    .get();
  if (!session) throw notFound("Chat session", sessionId);

  storeMessage(sessionId, "user", [{ type: "text", text }]);
  if (!session.title) {
    db.update(schema.chatSessions)
      .set({ title: text.slice(0, 60) })
      .where(eq(schema.chatSessions.id, sessionId))
      .run();
  }
  logActivity("user", "chat.message_sent", { type: "chat_session", id: sessionId });

  const blocks: ChatMessageBlock[] = [];
  let currentText = "";

  const flushText = () => {
    if (currentText.trim()) blocks.push({ type: "text", text: currentText });
    currentText = "";
  };

  try {
    const stream = runAgent({
      prompt: text,
      systemPrompt: chatSystemPrompt(),
      mcpServers: { wardrobe: wardrobeMcpServer },
      allowedTools: WARDROBE_TOOL_NAMES,
      resume: session.sdkSessionId ?? undefined,
      includePartialMessages: true,
      maxTurns: 25,
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        if (message.session_id && message.session_id !== session.sdkSessionId) {
          db.update(schema.chatSessions)
            .set({ sdkSessionId: message.session_id })
            .where(eq(schema.chatSessions.id, sessionId))
            .run();
        }
      } else if (message.type === "stream_event") {
        const event = message.event as {
          type: string;
          delta?: { type: string; text?: string };
        };
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          currentText += event.delta.text;
          yield { type: "text_delta", text: event.delta.text };
        }
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            flushText();
            const name = String(block.name).replace(/^mcp__wardrobe__/, "");
            blocks.push({ type: "tool_use", toolName: name });
            yield { type: "tool_use", toolName: name };
          }
        }
      } else if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(`Agent run failed (${message.subtype})`);
        }
      }
    }

    flushText();
    if (blocks.length === 0) {
      blocks.push({ type: "text", text: "(no response)" });
    }
    const stored = storeMessage(sessionId, "assistant", blocks);
    yield { type: "assistant_message", message: stored };
    yield { type: "done" };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    console.error("[psos] chat error:", err);
    flushText();
    blocks.push({
      type: "text",
      text: `Something went wrong talking to Claude: ${messageText}`,
    });
    storeMessage(sessionId, "assistant", blocks);
    yield { type: "error", text: messageText };
  }
}
