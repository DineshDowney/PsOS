import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { startRegenJob } from "@/server/imaging/regenerate";
import { logActivity } from "@/server/services/activity";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sides: z.array(z.enum(["front", "back"])).min(1),
    /**
     * What was wrong with the last generation, in Dinesh's words. Optional —
     * a blank reroll still gets the item's metadata as grounding, which is
     * more than the original generation had.
     */
    feedback: z.string().max(2000).optional(),
  })
  .strict();

/**
 * Queue a regeneration. Returns immediately with a job to poll — a two-sided
 * regen is 15-40s of sequential Gemini calls, too long to hold a request open
 * over the Funnel relay.
 */
export const POST = withErrorHandling<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) throw badRequest("Invalid regenerate request", parsed.error.flatten());

  // De-duplicated: ["front","front"] would otherwise bill twice for one side.
  const sides = [...new Set(parsed.data.sides)];
  const job = startRegenJob(id, sides, parsed.data.feedback?.trim() ?? "");

  logActivity("user", "images.regenerate.queued", { type: "item", id }, {
    jobId: job.id,
    sides,
    hasFeedback: job.feedback.length > 0,
  });
  return NextResponse.json({ job });
});
