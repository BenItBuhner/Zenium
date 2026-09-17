import { rubberBand, SWIPE_THRESHOLDS, type SwipeThresholds } from './swipe'

/**
 * Pure decisions for a draggable bottom sheet. The sheet lives on a one-dimensional track
 * measured in px of visible height: 0 = off the bottom of the screen, `collapsed` = the peek
 * detent, `expanded` = as tall as its content (or the screen) allows. A finger drags the
 * position; on release these helpers pick the detent to settle on, with the same fling and
 * projection rules as the paged swipes in `swipe.ts`.
 */
export interface SheetDetents {
  /** Visible height (px) of the peek detent; equals `expanded` when the sheet has one detent. */
  collapsed: number
  /** Visible height (px) of the sheet at its tallest. */
  expanded: number
}

/** Share of the layer height the peek detent shows. */
export const SHEET_PEEK_FRACTION = 0.52
/** Room (px) kept between the top inset and an expanded sheet, so the page still shows above it. */
export const SHEET_TOP_MARGIN = 32
/** Detents closer than this (px) fold into one: a second stop a couple of rows away is noise. */
export const SHEET_MIN_DETENT_GAP = 96
/** How far (px) the sheet can be stretched past its expanded detent, with diminishing returns. */
export const SHEET_OVERDRAG = 96
/** Share of the sheet's height a predictive back gesture pulls it down by at full progress. */
export const SHEET_BACK_TRAVEL = 0.4

/** The tallest a sheet may be on a layer `layerHeight` px tall under `insetTop` px of status bar. */
export function sheetMaxHeight(layerHeight: number, insetTop: number): number {
  return Math.max(0, Math.round(layerHeight - insetTop - SHEET_TOP_MARGIN))
}

/**
 * Detents for content `intrinsic` px tall (grip, body and bottom inset together). Content that
 * fits within the peek height gets a single detent; a taller sheet peeks at about half the
 * screen and expands up to the top margin.
 */
export function computeDetents(
  intrinsic: number,
  layerHeight: number,
  insetTop: number
): SheetDetents {
  const expanded = Math.max(
    0,
    Math.min(Math.round(intrinsic), sheetMaxHeight(layerHeight, insetTop))
  )
  const peek = Math.round(layerHeight * SHEET_PEEK_FRACTION)
  const collapsed = expanded - peek >= SHEET_MIN_DETENT_GAP ? peek : expanded
  return { collapsed, expanded }
}

export interface SheetFrame {
  /** Height (px) the sheet element is laid out at. */
  height: number
  /** How far (px) the sheet is pushed down off its resting place. */
  translateY: number
  /** 0…1 share of the scrim's full opacity. */
  scrim: number
}

/**
 * Geometry for a sheet whose visible height is `position`. Between the detents the sheet
 * changes height – content stays anchored to the top edge and the bottom edge, with its fading
 * scroll edge, stays on screen; below the peek detent the whole sheet slides down instead, and
 * the scrim thins out with it.
 */
export function sheetFrame(position: number, detents: SheetDetents): SheetFrame {
  const visible = Math.max(0, position)
  const { collapsed } = detents
  if (visible >= collapsed) return { height: visible, translateY: 0, scrim: 1 }
  return {
    height: collapsed,
    translateY: collapsed - visible,
    scrim: collapsed > 0 ? visible / collapsed : 0
  }
}

/**
 * Where a finger that grabbed the sheet at `start` px and has since travelled `delta` px
 * upwards puts it: it cannot be pushed below the screen edge and resists past the expanded
 * detent.
 */
export function sheetDragPosition(start: number, delta: number, detents: SheetDetents): number {
  const raw = start + delta
  if (raw <= 0) return 0
  if (raw > detents.expanded)
    return detents.expanded + rubberBand(raw - detents.expanded, SHEET_OVERDRAG)
  return raw
}

/**
 * Which detent a released sheet settles on: 0 (dismissed), `collapsed` or `expanded`. A fling
 * (px/s, positive = upwards) goes to the next detent in its own direction, so flinging back the
 * way you came cancels a drag; a slow release goes to the detent nearest the velocity-projected
 * position.
 */
export function settleDetent(
  position: number,
  velocity: number,
  detents: SheetDetents,
  thresholds: SwipeThresholds = SWIPE_THRESHOLDS
): number {
  const stops = [...new Set([0, detents.collapsed, detents.expanded])].sort((a, b) => a - b)
  if (Math.abs(velocity) >= thresholds.flingVelocity) {
    if (velocity > 0) return stops.find((s) => s > position + 1) ?? stops[stops.length - 1]
    return [...stops].reverse().find((s) => s < position - 1) ?? 0
  }
  const projected = position + velocity * thresholds.projectionSeconds
  let best = stops[0]
  for (const s of stops) if (Math.abs(s - projected) < Math.abs(best - projected)) best = s
  return best
}

/**
 * Visible height of a sheet that rested `origin` px tall while a predictive back gesture is
 * `progress` (0…1) of the way: a preview that leaves the sheet on screen; committing finishes
 * the slide with the spring.
 */
export function sheetBackPosition(origin: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return origin * (1 - SHEET_BACK_TRAVEL * p)
}
