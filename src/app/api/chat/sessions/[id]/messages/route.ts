import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { sendMessage } from "@/server/ai/chat";

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 300;

const bodySchema = z.object({ text: z.string().min(1) });

/** POST a user message; response is an SSE stream of ChatStreamEvent JSON. */
export const POST = withErrorHandling<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) throw badRequest("text is required");
  const text = parsed.data.text;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of sendMessage(id, text)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", text: message })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});
