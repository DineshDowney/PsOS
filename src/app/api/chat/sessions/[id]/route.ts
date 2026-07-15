import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { deleteSession, listMessages } from "@/server/ai/chat";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return NextResponse.json({ messages: listMessages(id) });
});

export const DELETE = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  deleteSession(id);
  return NextResponse.json({ ok: true });
});
