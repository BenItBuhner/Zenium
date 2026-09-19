import { useCallback, useEffect, useRef } from 'react'
import type { Rect } from '@shared/types'
import { viewportStore } from './formFactor'

/**
 * What the v2 site-control surfaces (components/siteControls) share below the component level:
 * the form factor they read, the stack that hands Escape to the top surface only, and the
 * address-pill chip the desktop popovers hang under.
 */

/** Attributes a surface carries for tests and drivers (`data-testid`, `data-permission`, …). */
export type DataAttributes = Record<`data-${string}`, string | undefined>

export function usePhone(): boolean {
  return viewportStore.use((s) => s.formFactor === 'phone')
}

// ---------------------------------------------------------------------------
// The surface stack
// ---------------------------------------------------------------------------

/** The v2 surfaces up right now, bottom to top. */
const surfaces: symbol[] = []

/**
 * Register the calling surface for as long as it is mounted and learn whether it is the one on
 * top. Escape, like the back gesture, is for the top surface only (§9.22, §9.24): a menulist's
 * picker over a popover or a sheet takes the key and the surface under it stays.
 */
export function useSurfaceLayer(): () => boolean {
  const id = useRef<symbol | null>(null)
  if (id.current === null) id.current = Symbol('surface')
  useEffect(() => {
    const own = id.current as symbol
    surfaces.push(own)
    return () => {
      const at = surfaces.indexOf(own)
      if (at !== -1) surfaces.splice(at, 1)
    }
  }, [])
  return useCallback(() => surfaces[surfaces.length - 1] === id.current, [])
}

/** How many v2 surfaces are up; for tests. */
export function surfaceDepth(): number {
  return surfaces.length
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
