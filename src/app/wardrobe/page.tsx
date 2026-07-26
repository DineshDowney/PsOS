/**
 * The landing screen, and the one screen that server-renders.
 *
 * Every other page in the app is "use client" and fetches after hydration, which
 * means it opens on a spinner. That is tolerable on Laundry; it is not on the
 * screen you actually land on. `listItems` is synchronous (better-sqlite3), so
 * reading the wardrobe here costs one function call and no HTTP hop — the grid
 * arrives with the HTML, already full of garments.
 *
 * Filtering stays client-side in ./grid — see the seeding comment there.
 */
import { listItems } from "@/server/services/catalog";
import { WardrobeGrid } from "./grid";

// Without this Next prerenders the wardrobe at build time and the deployed app
// serves whatever was in the DB when `npm run build` ran, forever.
export const dynamic = "force-dynamic";

export default function WardrobePage() {
  return (
    <WardrobeGrid initialItems={listItems({})} initialDrafts={listItems({ state: "draft" })} />
  );
}
