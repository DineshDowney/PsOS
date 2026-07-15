import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import {
  archiveItem,
  getItem,
  updateItemFields,
  setItemStatus,
  addTag,
  removeTag,
} from "@/server/services/catalog";
import { CATEGORIES, FORMALITIES, SEASONS } from "@/shared/types";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    name: z.string().optional(),
    category: z.enum(CATEGORIES).nullable().optional(),
    subcategory: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    primaryColor: z.string().nullable().optional(),
    secondaryColors: z.array(z.string()).optional(),
    colorDetail: z.string().nullable().optional(),
    pattern: z.string().nullable().optional(),
    fit: z.string().nullable().optional(),
    material: z.string().nullable().optional(),
    brand: z.string().nullable().optional(),
    size: z.string().nullable().optional(),
    formality: z.enum(FORMALITIES).nullable().optional(),
    seasons: z.array(z.enum(SEASONS)).optional(),
    price: z.number().nullable().optional(),
    purchaseDate: z.string().nullable().optional(),
    status: z.enum(["available", "laundry", "unavailable"]).optional(),
    addTag: z.string().optional(),
    removeTag: z.string().optional(),
  })
  .strict();

export const GET = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return NextResponse.json({ item: getItem(id) });
});

export const PATCH = withErrorHandling<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) throw badRequest("Invalid item patch", parsed.error.flatten());
  const { status, addTag: tagToAdd, removeTag: tagToRemove, ...fields } = parsed.data;

  let item = getItem(id);
  if (Object.keys(fields).length > 0) item = updateItemFields(id, fields);
  if (status) item = setItemStatus(id, status);
  if (tagToAdd) item = addTag(id, tagToAdd);
  if (tagToRemove) item = removeTag(id, tagToRemove);
  return NextResponse.json({ item });
});

export const DELETE = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  archiveItem(id);
  return NextResponse.json({ ok: true });
});
