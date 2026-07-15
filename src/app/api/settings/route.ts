import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { getAllSettings, setSetting, SETTING_KEYS } from "@/server/services/settings";

export const GET = withErrorHandling(async () => {
  return NextResponse.json({ settings: getAllSettings() });
});

const patchSchema = z.record(z.enum(SETTING_KEYS), z.string());

export const PATCH = withErrorHandling(async (req) => {
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) throw badRequest("Invalid settings", parsed.error.flatten());
  for (const [key, value] of Object.entries(parsed.data)) {
    setSetting(key as (typeof SETTING_KEYS)[number], value);
  }
  return NextResponse.json({ settings: getAllSettings() });
});
