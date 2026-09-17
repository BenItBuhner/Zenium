import type { FormFactor } from './types'

/**
 * What the layout decision is made from: the window's size in CSS px and what its primary
 * pointer can do (the `pointer: coarse` and `hover: hover` media features).
 */
export interface ViewportMetrics {
  width: number
  height: number
  /** The primary pointer is a finger (or the screen is a touch screen without a mouse). */
  coarse: boolean
  /** The primary pointer can hover: a mouse or trackpad. */
  hover: boolean
}

/**
 * Below this many CSS px on the deciding side the chrome is a phone. Android's own tablet line
 * (`sw600dp`), so a device gets the same class the system gives it.
 */
export const PHONE_MAX_WIDTH = 600

/**
 * How the chrome should lay itself out. Derived from the window and its pointer, not from the
 * platform name.
 *
 * A touch screen that cannot hover is held in the hand: its class follows the shorter side of the
 * window, like Android's smallest-width qualifier, so a phone turned sideways keeps its bar and
 * overview and a tablet keeps the desktop layout in either orientation. A pointer that hovers (a
 * mouse or trackpad: a laptop, a DeX desktop, a tablet with a keyboard) means a windowed desktop,
 * where only a window too narrow for the sidebar layout gets the phone one.
 */
export function classifyViewport({ width, height, coarse, hover }: ViewportMetrics): FormFactor {
  const handheld = coarse && !hover
  const side = handheld ? Math.min(width, height) : width
  if (side < PHONE_MAX_WIDTH) return 'phone'
  return coarse ? 'tablet' : 'desktop'
}
