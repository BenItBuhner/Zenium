import type { Rect } from '@shared/types'
import { viewportStore } from './formFactor'

/**
 * What the v2 site-control surfaces (components/siteControls) share below the component level:
 * the form factor they read and the address-pill chip the desktop popovers hang under. The
 * keyboard, the surface stack and the light dismiss are the chassis's (`usePopover`, `useEscape`,
 * `lib/portals`): nothing here keeps a registry of its own.
 */

/** Attributes a surface carries for tests and drivers (`data-testid`, `data-permission`, …). */
export type DataAttributes = Record<`data-${string}`, string | undefined>

export function usePhone(): boolean {
  return viewportStore.use((s) => s.formFactor === 'phone')
}

// ---------------------------------------------------------------------------
// The site chip
// ---------------------------------------------------------------------------

/** The pill or bar a chip sits in, for `placePopover`: the chip's own box when it stands alone. */
export function barOf(chip: Element | null): Rect | null {
  const bar = chip?.closest('.zen-pill, [data-popover-bar]') ?? chip
  if (!bar) return null
  const r = bar.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/** The site icon chip in the desktop address pill: what the site-control popovers hang under. */
export const SITE_CHIP = '[data-pill-chip][aria-label="Site information"]'

/** The site chip element, for the light-dismiss registry's anchor; null while the pill is hidden. */
export function siteChip(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SITE_CHIP)
}

/** The site chip and the pill around it, in window coordinates; null while the pill is hidden. */
export function siteChipRects(): { anchor: Rect | null; bar: Rect | null } {
  const chip = siteChip()
  if (!chip) return { anchor: null, bar: null }
  const r = chip.getBoundingClientRect()
  if (r.width === 0) return { anchor: null, bar: null }
  return { anchor: { x: r.left, y: r.top, width: r.width, height: r.height }, bar: barOf(chip) }
}
