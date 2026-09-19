/**
 * A row or list glyph in the security surfaces (v2 draft §9.3): 16 px at stroke 1.5 on desktop,
 * 20 px at 1.75 on phones, both from the density tokens. Layout only – the stroke is set as a
 * CSS property so it outranks Lucide's attribute; the ink is the surface's.
 */
export const GLYPH =
  'h-[var(--v2-icon)] w-[var(--v2-icon)] shrink-0 [stroke-width:var(--v2-icon-stroke)]'
