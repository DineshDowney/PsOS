import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { getAnalytics } from "@/server/services/analytics";

export const GET = withErrorHandling(async () => {
  return NextResponse.json({ analytics: getAnalytics() });
});
