/**
 * Color model for search and outfit scoring.
 *
 * Free-text color names (from AI or the user) are normalized into a small set
 * of families. Neutrals pair with everything; non-neutrals are scored by hue
 * relationships (analogous / complementary good, adjacent-clash bad).
 */

export type ColorFamily =
  | "black" | "white" | "grey" | "beige" | "brown" | "navy" | "denim"
  | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink"
  | "olive" | "burgundy" | "unknown";

const NEUTRALS: ReadonlySet<ColorFamily> = new Set([
  "black", "white", "grey", "beige", "brown", "navy", "denim", "olive",
]);

/** Hue (degrees) for non-neutral families used in harmony scoring. */
const FAMILY_HUE: Partial<Record<ColorFamily, number>> = {
  red: 0,
  burgundy: 345,
  orange: 30,
  yellow: 55,
  green: 120,
  teal: 175,
  blue: 220,
  purple: 275,
  pink: 330,
};

const SYNONYMS: Array<[RegExp, ColorFamily]> = [
  [/\b(black|jet|onyx|charcoal black)\b/, "black"],
  [/\b(white|ivory|off[- ]?white|cream(?!y brown)|ecru|bone)\b/, "white"],
  [/\b(gr[ae]y|charcoal|slate|silver|heather|ash|graphite)\b/, "grey"],
  [/\b(beige|tan|khaki|sand|camel|taupe|stone|oatmeal|nude)\b/, "beige"],
  [/\b(brown|chocolate|coffee|mocha|espresso|walnut|cognac|rust brown)\b/, "brown"],
  [/\b(navy|midnight)\b/, "navy"],
  [/\b(denim|indigo|jean)\b/, "denim"],
  [/\b(burgundy|maroon|wine|oxblood|bordeaux)\b/, "burgundy"],
  [/\b(red|crimson|scarlet|cherry)\b/, "red"],
  [/\b(orange|rust|terracotta|coral|peach|apricot)\b/, "orange"],
  [/\b(yellow|mustard|gold(?:en)?|lemon|ochre)\b/, "yellow"],
  [/\b(olive|army|military green|moss)\b/, "olive"],
  [/\b(green|emerald|forest|sage|mint|lime)\b/, "green"],
  [/\b(teal|turquoise|aqua|cyan)\b/, "teal"],
  [/\b(blue|cobalt|royal|sky|azure|powder blue)\b/, "blue"],
  [/\b(purple|violet|lavender|lilac|plum|mauve)\b/, "purple"],
  [/\b(pink|rose|blush|fuchsia|magenta|salmon)\b/, "pink"],
];

export function colorFamily(raw: string | null | undefined): ColorFamily {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  for (const [re, family] of SYNONYMS) {
    if (re.test(s)) return family;
  }
  return "unknown";
}

export function isNeutral(family: ColorFamily): boolean {
  return NEUTRALS.has(family);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Pairwise color compatibility in [0, 1].
 *   neutral + anything  → 1.0
 *   same family         → 0.75 (tonal — fine, slightly less interesting)
 *   analogous (<60°)    → 0.8
 *   complementary       → 0.9
 *   awkward middle zone → 0.35
 */
export function colorPairScore(a: string | null, b: string | null): number {
  const fa = colorFamily(a);
  const fb = colorFamily(b);
  if (fa === "unknown" || fb === "unknown") return 0.6; // benefit of the doubt
  if (isNeutral(fa) || isNeutral(fb)) return 1.0;
  if (fa === fb) return 0.75;
  const ha = FAMILY_HUE[fa];
  const hb = FAMILY_HUE[fb];
  if (ha === undefined || hb === undefined) return 0.6;
  const d = hueDistance(ha, hb);
  if (d < 60) return 0.8;
  if (d >= 150) return 0.9;
  return 0.35;
}

/** Average pairwise score across an outfit's item colors. */
export function outfitColorScore(colors: Array<string | null>): number {
  const present = colors.filter((c): c is string => !!c);
  if (present.length < 2) return 0.8; // not enough info to judge
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      total += colorPairScore(present[i]!, present[j]!);
      pairs++;
    }
  }
  return total / pairs;
}
