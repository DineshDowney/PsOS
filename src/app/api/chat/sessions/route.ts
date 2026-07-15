import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { createSession, listSessions } from "@/server/ai/chat";

export const GET = withErrorHandling(async () => {
  return NextResponse.json({ sessions: listSessions() });
});

export const POST = withErrorHandling(async () => {
  return NextResponse.json({ session: createSession() }, { status: 201 });
});
