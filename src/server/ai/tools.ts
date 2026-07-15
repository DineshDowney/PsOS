import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { listItems, getItem, setItemStatus } from "@/server/services/catalog";
import { generateOutfits } from "@/server/engine/outfit-engine";
import { recentWearCombos, logWear } from "@/server/services/wear";
import { saveOutfit, listOutfits, getOutfit } from "@/server/services/outfits";
import { createPlan, listPlans } from "@/server/services/plans";
import { getAnalytics } from "@/server/services/analytics";
import { todayLocal } from "@/server/lib/ids";
import { CATEGORIES, FORMALITIES, type Item } from "@/shared/types";

/**
 * Wardrobe tools exposed to Claude in chat via an in-process MCP server.
 * Tool names surface to the agent as mcp__wardrobe__<name>.
 *
 * Outfit generation goes through the deterministic engine — the model curates
 * and explains; it does not invent combinations item-by-item.
 */

function compactItem(item: Item) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    subcategory: item.subcategory,
    color: item.primaryColor,
    pattern: item.pattern,
    formality: item.formality,
    status: item.status,
    wearCount: item.wearCount,
    lastWornAt: item.lastWornAt,
    tags: item.tags.map((t) => t.tag),
  };
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
  };
}

const searchWardrobe = tool(
  "search_wardrobe",
  "Search the user's wardrobe. All filters optional; returns compact item summaries including availability status.",
  {
    query: z.string().optional().describe("free-text search"),
    category: z.enum(CATEGORIES).optional(),
    color: z.string().optional(),
    tag: z.string().optional(),
    status: z.enum(["available", "laundry", "unavailable"]).optional(),
  },
  async (args) => {
    const items = listItems({
      q: args.query,
      category: args.category,
      color: args.color,
      tag: args.tag,
      status: args.status,
    });
    return json({ count: items.length, items: items.map(compactItem) });
  },
);

const getItemDetails = tool(
  "get_item",
  "Get full details for one wardrobe item by id.",
  { itemId: z.string() },
  async ({ itemId }) => {
    const item = getItem(itemId);
    return json({ ...compactItem(item), description: item.description, notes: item.notes, material: item.material, brand: item.brand, fit: item.fit, seasons: item.seasons, price: item.price });
  },
);

const suggestOutfits = tool(
  "suggest_outfits",
  "Generate outfit suggestions from AVAILABLE items using the deterministic outfit engine (color harmony, freshness, rotation, recent-repeat penalty). Use this instead of inventing combinations.",
  {
    formality: z.enum(FORMALITIES).optional(),
    count: z.number().int().min(1).max(8).optional(),
  },
  async (args) => {
    const suggestions = generateOutfits(listItems(), {
      recentCombos: recentWearCombos(),
      formality: args.formality,
      count: args.count ?? 4,
    });
    return json(
      suggestions.map((s) => ({
        score: s.score,
        items: s.items.map((x) => ({ slot: x.slot, ...compactItem(x.item) })),
      })),
    );
  },
);

const markWorn = tool(
  "log_wear",
  "Log that the user wore items on a date (YYYY-MM-DD). Optionally move them to laundry.",
  {
    itemIds: z.array(z.string()).min(1),
    wornOn: z.string().describe("YYYY-MM-DD; use today's date if the user says 'today'"),
    sendToLaundry: z.boolean().optional(),
  },
  async (args) => {
    const event = logWear({
      itemIds: args.itemIds,
      wornOn: args.wornOn,
      sendToLaundry: args.sendToLaundry,
      actor: "ai",
    });
    return json({ ok: true, wearEventId: event.id });
  },
);

const setStatus = tool(
  "set_item_status",
  "Set an item's availability: available, laundry, or unavailable.",
  {
    itemId: z.string(),
    status: z.enum(["available", "laundry", "unavailable"]),
  },
  async (args) => {
    setItemStatus(args.itemId, args.status, "ai");
    return json({ ok: true });
  },
);

const saveOutfitTool = tool(
  "save_outfit",
  "Save an outfit (a named combination of items with slots) to the user's collection.",
  {
    name: z.string().optional(),
    notes: z.string().optional(),
    items: z
      .array(z.object({ itemId: z.string(), slot: z.enum(CATEGORIES) }))
      .min(1),
  },
  async (args) => {
    const outfit = saveOutfit({
      name: args.name ?? null,
      notes: args.notes ?? null,
      source: "ai",
      items: args.items,
    });
    return json({ ok: true, outfitId: outfit.id });
  },
);

const listSavedOutfits = tool(
  "list_outfits",
  "List the user's saved outfits.",
  {},
  async () => {
    return json(
      listOutfits().map((o) => ({
        id: o.id,
        name: o.name,
        items: o.items.map((x) => ({ slot: x.slot, name: x.item.name, id: x.item.id })),
      })),
    );
  },
);

const planOutfit = tool(
  "plan_outfit",
  "Plan a saved outfit for a calendar date (YYYY-MM-DD). The outfit must exist — save it first if needed.",
  { planDate: z.string(), outfitId: z.string() },
  async (args) => {
    getOutfit(args.outfitId);
    const plan = createPlan({ ...args, actor: "ai" });
    return json({ ok: true, planId: plan.id });
  },
);

const getCalendar = tool(
  "get_calendar",
  "List planned outfits between two dates (YYYY-MM-DD).",
  { from: z.string(), to: z.string() },
  async (args) => {
    return json(
      listPlans(args.from, args.to).map((p) => ({
        id: p.id,
        date: p.planDate,
        status: p.status,
        outfit: {
          id: p.outfit.id,
          name: p.outfit.name,
          items: p.outfit.items.map((x) => x.item.name),
        },
      })),
    );
  },
);

const wardrobeStats = tool(
  "wardrobe_stats",
  "Summary statistics: counts by category/color/status, most and least worn items.",
  {},
  async () => {
    const a = getAnalytics();
    return json({
      totalItems: a.totalItems,
      byCategory: a.byCategory,
      byColor: a.byColor,
      byStatus: a.byStatus,
      mostWorn: a.mostWorn.map((m) => ({ name: m.item.name, wears: m.wearCount })),
      leastWorn: a.leastWorn.map((m) => ({ name: m.item.name, wears: m.wearCount })),
    });
  },
);

export const wardrobeMcpServer = createSdkMcpServer({
  name: "wardrobe",
  version: "1.0.0",
  tools: [
    searchWardrobe,
    getItemDetails,
    suggestOutfits,
    markWorn,
    setStatus,
    saveOutfitTool,
    listSavedOutfits,
    planOutfit,
    getCalendar,
    wardrobeStats,
  ],
});

export const WARDROBE_TOOL_NAMES = [
  "mcp__wardrobe__search_wardrobe",
  "mcp__wardrobe__get_item",
  "mcp__wardrobe__suggest_outfits",
  "mcp__wardrobe__log_wear",
  "mcp__wardrobe__set_item_status",
  "mcp__wardrobe__save_outfit",
  "mcp__wardrobe__list_outfits",
  "mcp__wardrobe__plan_outfit",
  "mcp__wardrobe__get_calendar",
  "mcp__wardrobe__wardrobe_stats",
];

export function chatSystemPrompt(): string {
  return `You are the stylist inside "Personal Stylist OS", a local wardrobe app. Today is ${todayLocal()}.

You have tools (mcp__wardrobe__*) that read and modify the user's real wardrobe data. Ground every answer in tool results — never invent items the user doesn't own.

Guidelines:
- For outfit requests, call suggest_outfits (it already handles color harmony, laundry status and rotation), then present the options with brief styling notes. Offer to save or plan ones the user likes.
- For packing/travel questions, search the wardrobe by category and build a packing list from real items, considering the destination and duration.
- Only items with status "available" can be worn today; mention when something relevant is in the laundry.
- When the user says they wore something, log it with log_wear (ask about laundry if unclear).
- Be concise and direct. No filler, no flattery.`;
}
