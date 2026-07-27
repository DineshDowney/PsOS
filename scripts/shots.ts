/**
 * Screenshot every screen, so a UI change can be looked at instead of guessed at.
 *
 * Drives the Edge that ships with Windows via playwright-core — deliberately NOT
 * the full `playwright` package, which downloads its own ~150MB Chromium. This is
 * a devDependency and `npm run build` on the VM installs devDependencies, so a
 * bundled browser would ride along to a machine that will never open one.
 *
 *   npm run dev              # in another terminal
 *   npm run shots            # all screens, both widths
 *   npm run shots -- --only wardrobe,item --width desktop
 *
 * Output lands in the scratchpad by default (see OUT_DEFAULT) — these are build
 * artifacts, not project files, and they must never end up in data/ or git.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const BASE = process.env.PSOS_SHOTS_BASE ?? "http://localhost:3000";

const OUT_DEFAULT = path.join(
  process.env.TEMP ?? process.env.TMPDIR ?? ".",
  "psos-shots",
);

/** 1440 is the narrowest desktop the fixed 208px sidebar still looks right on. */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

type WidthName = keyof typeof VIEWPORTS;

interface Screen {
  name: string;
  /** Resolved late so `item` can depend on what is actually in the database. */
  path: string | (() => Promise<string | null>);
  /** Run before the shot — open a panel, type a filter, etc. */
  prepare?: (page: Page) => Promise<void>;
}

/** First active item, so the item page shot has real garment photos on it. */
async function firstItemPath(): Promise<string | null> {
  const res = await fetch(`${BASE}/api/items?state=active`);
  if (!res.ok) return null;
  const body = (await res.json()) as { items: Array<{ id: string }> };
  const id = body.items[0]?.id;
  return id ? `/items/${id}` : null;
}

const SCREENS: Screen[] = [
  { name: "wardrobe", path: "/wardrobe" },
  { name: "item", path: firstItemPath },
  {
    name: "item-regen-open",
    path: firstItemPath,
    prepare: async (page) => {
      await page.getByRole("button", { name: /regenerate images/i }).click();
      await page.waitForTimeout(300);
    },
  },
  { name: "import", path: "/import" },
  { name: "outfits", path: "/outfits" },
  { name: "laundry", path: "/laundry" },
  { name: "calendar", path: "/calendar" },
  { name: "analytics", path: "/analytics" },
  { name: "settings", path: "/settings" },
  { name: "chat", path: "/chat" },
];

/**
 * Wait until the garments are actually painted. `networkidle` alone is not
 * enough: thumbnails are `loading="lazy"`, so an image below the fold stays
 * unrequested until it scrolls into view — and a full-page screenshot resizes
 * the viewport rather than scrolling, which never triggers the load.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(async () => {
    for (const img of Array.from(document.images)) img.loading = "eager";
    await Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map((img) => new Promise((r) => img.addEventListener("load", r, { once: true }))
          // A broken image must not hang the run.
          .catch(() => {})),
    );
  });
  // Entrance animations are capped at 12 * 40ms + 380ms in globals.css.
  await page.waitForTimeout(900);
}

async function shoot(
  browser: Browser,
  screen: Screen,
  width: WidthName,
  outDir: string,
): Promise<string | null> {
  const target = typeof screen.path === "string" ? screen.path : await screen.path();
  if (!target) {
    console.warn(`  skip ${screen.name} (${width}) — no url resolved`);
    return null;
  }

  const context = await browser.newContext({
    viewport: VIEWPORTS[width],
    deviceScaleFactor: 1,
    // Layout is judged on the real thing, so no reduced-motion override here —
    // every entrance animation uses `both`, which settles on the final frame.
  });
  const page = await context.newPage();

  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  try {
    await page.goto(`${BASE}${target}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settle(page);
    if (screen.prepare) await screen.prepare(page);

    const file = path.join(outDir, `${screen.name}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    if (errors.length > 0) {
      console.warn(`  ${screen.name} (${width}) — ${errors.length} console error(s):`);
      for (const e of errors.slice(0, 3)) console.warn(`      ${e}`);
    }
    return file;
  } catch (err) {
    console.error(`  FAILED ${screen.name} (${width}): ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    await context.close();
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const outDir = arg("out") ?? OUT_DEFAULT;
  const only = arg("only")?.split(",").map((s) => s.trim());
  const widthArg = arg("width") as WidthName | undefined;
  const widths: WidthName[] = widthArg ? [widthArg] : ["desktop", "phone"];

  const probe = await fetch(`${BASE}/api/items?limit=1`).catch(() => null);
  if (!probe?.ok) {
    throw new Error(
      `No app at ${BASE}. Start it first (npm run dev), or point PSOS_SHOTS_BASE elsewhere.`,
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  const screens = only ? SCREENS.filter((s) => only.includes(s.name)) : SCREENS;
  if (screens.length === 0) throw new Error(`No screens matched --only ${only?.join(",")}`);

  const browser = await chromium.launch({ channel: "msedge" });
  const written: string[] = [];
  try {
    for (const width of widths) {
      console.log(`${width} (${VIEWPORTS[width].width}px)`);
      for (const screen of screens) {
        const file = await shoot(browser, screen, width, outDir);
        if (file) {
          written.push(file);
          console.log(`  ${screen.name}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${written.length} shot(s) -> ${outDir}`);
}

main().catch((err) => {
  console.error(`[shots] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
