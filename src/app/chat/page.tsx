"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { ChatMessage, ChatSession } from "@/shared/types";
import { Button, PageTitle, inputClass } from "@/components/ui";

interface StreamEvent {
  type: string;
  text?: string;
  toolName?: string;
  message?: ChatMessage;
}

export default function ChatPage() {
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [live, setLive] = useState<string>("");
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: sessionsData } = useQuery({
    queryKey: ["chat-sessions"],
    queryFn: () => apiGet<{ sessions: ChatSession[] }>("/api/chat/sessions"),
  });
  const { data: messagesData } = useQuery({
    queryKey: ["chat-messages", sessionId],
    queryFn: () => apiGet<{ messages: ChatMessage[] }>(`/api/chat/sessions/${sessionId}`),
    enabled: !!sessionId,
  });

  const messages = messagesData?.messages ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, live]);

  const newSession = async () => {
    const { session } = await apiSend<{ session: ChatSession }>("/api/chat/sessions", "POST");
    qc.invalidateQueries({ queryKey: ["chat-sessions"] });
    setSessionId(session.id);
  };

  const send = async () => {
    if (!input.trim() || busy) return;
    let sid = sessionId;
    if (!sid) {
      const { session } = await apiSend<{ session: ChatSession }>("/api/chat/sessions", "POST");
      qc.invalidateQueries({ queryKey: ["chat-sessions"] });
      setSessionId(session.id);
      sid = session.id;
    }
    const text = input;
    setInput("");
    setBusy(true);
    setLive("");
    setLiveTools([]);
    qc.setQueryData(["chat-messages", sid], (old: { messages: ChatMessage[] } | undefined) => ({
      messages: [
        ...(old?.messages ?? []),
        { id: "tmp", role: "user" as const, content: [{ type: "text" as const, text }], createdAt: new Date().toISOString() },
      ],
    }));

    try {
      const res = await fetch(`/api/chat/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) throw new Error(`Chat failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as StreamEvent;
          if (event.type === "text_delta" && event.text) setLive((t) => t + event.text);
          else if (event.type === "tool_use" && event.toolName)
            setLiveTools((t) => [...t, event.toolName!]);
          else if (event.type === "error" && event.text) setLive((t) => t + `\n[${event.text}]`);
        }
      }
    } finally {
      setBusy(false);
      setLive("");
      setLiveTools([]);
      qc.invalidateQueries({ queryKey: ["chat-messages", sid] });
      qc.invalidateQueries({ queryKey: ["chat-sessions"] });
    }
  };

  return (
    <div className="flex h-[calc(100dvh-6rem)] flex-col md:h-[calc(100dvh-7rem)]">
      <PageTitle sub="Claude with live access to your wardrobe — outfits, packing, planning.">
        Stylist Chat
      </PageTitle>

      <div className="flex min-h-0 flex-1 gap-6">
        <aside className="hidden w-56 shrink-0 flex-col gap-2 overflow-y-auto lg:flex">
          <Button onClick={newSession}>New conversation</Button>
          {(sessionsData?.sessions ?? []).map((s) => (
            <button
              key={s.id}
              onClick={() => setSessionId(s.id)}
              className={`truncate border px-3 py-2 text-left text-xs ${
                s.id === sessionId ? "border-accent text-fg" : "border-line text-muted"
              }`}
            >
              {s.title || "Untitled"}
            </button>
          ))}
        </aside>

        <div className="flex min-h-0 flex-1 flex-col border border-line bg-surface">
          <div className="flex-1 overflow-y-auto p-6">
            {messages.length === 0 && !busy ? (
              <p className="text-sm text-muted">
                Try: “What should I wear to a smart-casual dinner?” · “What's in the laundry?” ·
                “Plan my outfits for next week” · “Pack me for 5 days in Goa”.
              </p>
            ) : null}
            {messages.map((m) => (
              <div key={m.id} className={`mb-5 ${m.role === "user" ? "text-fg" : "text-muted"}`}>
                <div className="mb-1 text-[9px] uppercase tracking-[0.25em] text-faint">
                  {m.role === "user" ? "You" : "Stylist"}
                </div>
                {m.content.map((b, i) =>
                  b.type === "text" ? (
                    <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed">{b.text}</p>
                  ) : (
                    <div key={i} className="my-1 text-[10px] uppercase tracking-[0.2em] text-faint">
                      ⚙ {b.toolName?.replace(/_/g, " ")}
                    </div>
                  ),
                )}
              </div>
            ))}
            {busy ? (
              <div className="mb-5 text-muted">
                <div className="mb-1 text-[9px] uppercase tracking-[0.25em] text-faint">Stylist</div>
                {liveTools.map((t, i) => (
                  <div key={i} className="my-1 text-[10px] uppercase tracking-[0.2em] text-faint">
                    ⚙ {t.replace(/_/g, " ")}
                  </div>
                ))}
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {live || "…"}
                  <span className="animate-pulse">▍</span>
                </p>
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>
          <div className="flex gap-3 border-t border-line p-4">
            <input
              className={inputClass}
              placeholder="Ask your stylist…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              disabled={busy}
            />
            <Button variant="solid" onClick={send} disabled={busy}>
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
