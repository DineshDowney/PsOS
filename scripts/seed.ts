/**
 * Seed a placeholder wardrobe so every screen is usable before real photos
 * arrive. Generates simple garment-silhouette placeholder images with sharp.
 * Refuses to run on a non-empty catalog. Run: npm run seed
 */
import path from "node:path";
import sharp from "sharp";
import { getDb, schema } from "../src/server/db/client";
import { newId, nowIso } from "../src/server/lib/ids";
import { toJson } from "../src/server/lib/json";
import { itemImageDir, relativeImagePath, saveBuffer, sha256Of } from "../src/server/imaging/storage";
import { logWear } from "../src/server/services/wear";

interface SeedItem {
  name: string;
  category: "top" | "bottom" | "full_body" | "outerwear" | "footwear" | "accessory";
  subcategory: string;
  color: string;
  hex: string;
  formality: "casual" | "smart_casual" | "business" | "formal" | "athletic";
  fit?: string;
  material?: string;
  price?: number;
  tags: string[];
  status?: "available" | "laundry" | "unavailable";
}

const SEED: SeedItem[] = [
  { name: "White Crew Tee", category: "top", subcategory: "t-shirt", color: "white", hex: "#e9e7e2", formality: "casual", fit: "regular", material: "cotton", price: 1200, tags: ["basic", "minimal"] },
  { name: "Black Crew Tee", category: "top", subcategory: "t-shirt", color: "black", hex: "#1b1b1a", formality: "casual", fit: "regular", material: "cotton", price: 1200, tags: ["basic", "minimal"] },
  { name: "Grey Hoodie", category: "top", subcategory: "hoodie", color: "grey", hex: "#7d7c78", formality: "casual", fit: "oversized", material: "fleece", price: 3500, tags: ["streetwear", "cozy"], status: "laundry" },
  { name: "White Oxford Shirt", category: "top", subcategory: "shirt", color: "white", hex: "#f0eee8", formality: "business", fit: "slim", material: "cotton", price: 4200, tags: ["office", "classic"] },
  { name: "Navy Polo", category: "top", subcategory: "polo", color: "navy", hex: "#232f45", formality: "smart_casual", fit: "regular", material: "pique cotton", price: 2800, tags: ["classic"] },
  { name: "Olive Overshirt", category: "top", subcategory: "overshirt", color: "olive", hex: "#5a5c42", formality: "smart_casual", fit: "relaxed", material: "twill", price: 5200, tags: ["layering", "utility"] },
  { name: "Indigo Slim Jeans", category: "bottom", subcategory: "jeans", color: "denim", hex: "#2e3a52", formality: "casual", fit: "slim", material: "denim", price: 5600, tags: ["denim", "everyday"] },
  { name: "Beige Chinos", category: "bottom", subcategory: "chinos", color: "beige", hex: "#b3a284", formality: "smart_casual", fit: "tapered", material: "cotton twill", price: 3900, tags: ["office", "versatile"] },
  { name: "Black Joggers", category: "bottom", subcategory: "joggers", color: "black", hex: "#191918", formality: "athletic", fit: "tapered", material: "jersey", price: 2400, tags: ["gym", "cozy"], status: "laundry" },
  { name: "Charcoal Trousers", category: "bottom", subcategory: "trousers", color: "grey", hex: "#3c3c3a", formality: "business", fit: "straight", material: "wool blend", price: 6800, tags: ["office", "tailored"] },
  { name: "White Sneakers", category: "footwear", subcategory: "sneakers", color: "white", hex: "#eceae4", formality: "casual", material: "leather", price: 7500, tags: ["minimal", "everyday"] },
  { name: "Brown Loafers", category: "footwear", subcategory: "loafers", color: "brown", hex: "#5c4634", formality: "business", material: "suede", price: 9200, tags: ["office", "classic"] },
  { name: "Black Bomber", category: "outerwear", subcategory: "bomber jacket", color: "black", hex: "#161616", formality: "casual", fit: "regular", material: "nylon", price: 8800, tags: ["streetwear", "layering"] },
  { name: "Camel Overcoat", category: "outerwear", subcategory: "overcoat", color: "beige", hex: "#a98e63", formality: "business", fit: "regular", material: "wool", price: 14500, tags: ["winter", "tailored"] },
];

/** Rough garment silhouettes as SVG paths per category, rendered onto a plain background. */
function silhouette(category: SeedItem["category"], hex: string): string {
  const shapes: Record<string, string> = {
    top: `<path d="M155 90 L200 70 L245 90 L290 120 L270 160 L245 145 L245 330 L155 330 L155 145 L130 160 L110 120 Z" />`,
    bottom: `<path d="M150 70 L250 70 L262 330 L215 330 L200 170 L185 330 L138 330 Z" />`,
    full_body: `<path d="M160 70 L200 60 L240 70 L268 120 L250 150 L238 135 L246 330 L154 330 L162 135 L150 150 L132 120 Z" />`,
    outerwear: `<path d="M145 85 L200 65 L255 85 L300 125 L275 165 L252 148 L252 335 L148 335 L148 148 L125 165 L100 125 Z M200 100 L200 330" stroke="#0a0a09" stroke-width="4" fill-rule="evenodd"/>`,
    footwear: `<path d="M110 230 L115 180 L160 175 L200 195 L265 215 L295 235 L295 260 L108 260 Z" />`,
    accessory: `<circle cx="200" cy="200" r="90" />`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <rect width="400" height="400" fill="#111110"/>
    <g fill="${hex}" stroke="${hex}">${shapes[category] ?? shapes.accessory}</g>
  </svg>`;
}

async function main() {
  const db = getDb();
  const existing = db.select({ id: schema.items.id }).from(schema.items).all();
  if (existing.length > 0) {
    console.log(`Catalog already has ${existing.length} items — seed skipped.`);
    return;
  }

  const ids: string[] = [];
  for (const s of SEED) {
    const id = newId();
    ids.push(id);
    const ts = nowIso();
    const svg = Buffer.from(silhouette(s.category, s.hex));
    const png = await sharp(svg).png().toBuffer();
    const dir = itemImageDir(id);

    const frontPath = path.join(dir, "front.jpg");
    const frontJpg = await sharp(png).flatten({ background: "#111110" }).jpeg({ quality: 90 }).toBuffer();
    await saveBuffer(frontPath, frontJpg);
    const thumbPath = path.join(dir, "thumbnail.jpg");
    await saveBuffer(thumbPath, frontJpg);

    db.insert(schema.items).values({
      id,
      state: "active",
      status: s.status ?? "available",
      name: s.name,
      category: s.category,
      subcategory: s.subcategory,
      description: `${s.color} ${s.subcategory} (seeded placeholder — replace with a real photo import).`,
      primaryColor: s.color,
      secondaryColors: toJson([]),
      pattern: "solid",
      fit: s.fit ?? null,
      material: s.material ?? null,
      formality: s.formality,
      seasons: toJson(["all_season"]),
      price: s.price ?? null,
      fieldSources: toJson({}),
      createdAt: ts,
      updatedAt: ts,
    }).run();

    for (const [role, p, buf] of [["front", frontPath, frontJpg], ["thumbnail", thumbPath, frontJpg]] as const) {
      db.insert(schema.itemImages).values({
        id: newId(), itemId: id, role, path: relativeImagePath(p),
        width: 400, height: 400, sha256: sha256Of(buf), createdAt: ts,
      }).run();
    }
    for (const tag of s.tags) {
      db.insert(schema.itemTags).values({ itemId: id, tag, source: "ai" }).onConflictDoNothing().run();
    }
  }

  // A little wear history for analytics/freshness.
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return d.toLocaleDateString("sv-SE");
  };
  const byName = (name: string) => ids[SEED.findIndex((s) => s.name === name)]!;
  logWear({ itemIds: [byName("White Crew Tee"), byName("Indigo Slim Jeans"), byName("White Sneakers")], wornOn: day(1) });
  logWear({ itemIds: [byName("White Oxford Shirt"), byName("Charcoal Trousers"), byName("Brown Loafers")], wornOn: day(2) });
  logWear({ itemIds: [byName("Black Crew Tee"), byName("Indigo Slim Jeans"), byName("White Sneakers")], wornOn: day(4) });
  logWear({ itemIds: [byName("Navy Polo"), byName("Beige Chinos"), byName("White Sneakers")], wornOn: day(7) });

  console.log(`Seeded ${SEED.length} items with placeholder images and wear history.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
