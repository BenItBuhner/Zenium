import type { PageControlsSettings, PageEnvironment, Tab } from '@shared/types'
import { resolveZoom } from '@shared/pageControls'

/*
 * The rules of Chrome's zoom bubble, kept apart from the component so they can be tested: how
 * long it stays, when the pill shows its zoom chip, how Ctrl+wheel turns into steps.
 */

/** How long the bubble stays after a zoom step from the keyboard, the wheel or the menu. */
export const BUBBLE_AUTO_CLOSE_MS = 1500
/** How long it stays once one of its own buttons was pressed (the hand is on the bubble). */
export const BUBBLE_AFTER_CLICK_MS = 5000

export interface BubbleClock {
  /** A zoom step opened it (it puts itself away) or the chip did (it stays). */
  source: 'auto' | 'chip'
  /** The pointer is over the bubble: the clock waits. */
  hovered: boolean
  /** One of the bubble's buttons was pressed since it opened. */
  clicked: boolean
}

/**
 * How long the bubble may stand as things are, or null for "until the user puts it away": the
 * chip's bubble and a hovered one stay; a bubble whose buttons were used gets the longer wait.
 */
export function bubbleTimeout(clock: BubbleClock): number | null {
  if (clock.source === 'chip' || clock.hovered) return null
  return clock.clicked ? BUBBLE_AFTER_CLICK_MS : BUBBLE_AUTO_CLOSE_MS
}

/**
 * The zoom the pill's chip counts as "not zoomed": the default zoom for a web page (the system
 * font size folded in where the settings say so), 100 percent for any other page.
 */
export function defaultZoomFor(
  url: string,
  settings: PageControlsSettings,
  env: PageEnvironment
): number {
  return resolveZoom({ ...settings, siteZooms: {} }, url, env)
}

/** Whether the tab's page stands at a zoom other than its default (Chrome shows the chip then). */
export function isZoomed(tab: Tab, settings: PageControlsSettings, env: PageEnvironment): boolean {
  return Math.abs(tab.zoom - defaultZoomFor(tab.url, settings, env)) >= 0.005
}

/** The wheel travel that counts as one notch: Chromium's 53 px on Linux, 100 on Windows, less from a trackpad. */
const NOTCH = 50

/**
 * Turns Ctrl+wheel deltas into zoom steps: one step per wheel notch, the smaller deltas of a
 * trackpad pinch adding up to one. Scrolling up (away from the user) zooms in, as in Chrome.
 */
export class WheelZoom {
  private travel = 0

  /** The step the delta completes: 1 in, -1 out, 0 while a notch is still gathering. */
  step(deltaY: number): number {
    if (deltaY === 0) return 0
    // A turn the other way starts over; the gathered travel of the old direction is dropped.
    if (Math.sign(deltaY) !== Math.sign(this.travel)) this.travel = 0
    this.travel += deltaY
    if (Math.abs(this.travel) < NOTCH) return 0
    // A notch (or a few at once) is one step: a fast spin still climbs one preset at a time.
    const direction = this.travel < 0 ? 1 : -1
    this.travel = 0
    return direction
  }
}
