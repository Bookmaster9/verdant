/**
 * Deterministic color assignment for sprouts from their plan ID.
 *
 * Used everywhere a sprout needs visual distinction — dashboard cards, today's
 * timeline events, weekly rhythm bars, schedule grid chip filter. A single
 * source of truth so the same sprout reads as "the moss one" across the app.
 *
 * Palette draws from the existing Verdant CSS tokens so colors stay on-brand.
 */

const PALETTE = [
  { fill: "var(--leaf-pale)", border: "var(--moss)", chipBg: "var(--leaf-pale)", swatch: "#cfdcae" },
  { fill: "var(--sky-soft)", border: "var(--sky-deep, #6b8da4)", chipBg: "var(--sky-soft)", swatch: "#bdd0dc" },
  { fill: "var(--sun-soft)", border: "var(--sun)", chipBg: "var(--sun-soft)", swatch: "#f3deaa" },
  { fill: "#f3cbc1", border: "var(--berry)", chipBg: "#f3cbc1", swatch: "#f3cbc1" },
  { fill: "#dcd1ee", border: "#7b6cae", chipBg: "#dcd1ee", swatch: "#dcd1ee" },
  { fill: "#c8e6d8", border: "var(--fern)", chipBg: "#c8e6d8", swatch: "#c8e6d8" },
] as const;

export type SproutColor = (typeof PALETTE)[number];

/**
 * Hash a string to a non-negative integer. Tiny djb2 variant — collisions
 * within a 6-color palette are expected and fine; we just need stability.
 */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorForSprout(planId: string): SproutColor {
  return PALETTE[hashStr(planId) % PALETTE.length];
}
