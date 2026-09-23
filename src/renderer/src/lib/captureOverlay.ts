import {
  captureErrorMessage,
  isCaptureTooLarge,
  regionFromChrome,
  type PageCaptureMode,
  type PageCaptureRequest,
  type PageCaptureResult,
  type PageViewport
} from '@shared/capture'
import type { Rect, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { glanceRect, splitPaneRects } from '@renderer/lib/layout'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'

/**
 * The desktop's Web capture overlay, the part that is arithmetic and a state machine – kept
 * apart from `components/capture/CaptureOverlay.tsx` so it can be tested without a DOM. The
 * engine (`shared/capture.ts`, services' #363) owns the commands, the budget, the coordinates'
 * contract (`regionFromChrome`) and the refusal's message; this file owns the overlay's phases,
 * the marquee's geometry in chrome pixels, the words the card puts on a refusal, and the open
 * and close that every other chrome surface over the page does the same way (`openOverlay`,
 * `openScreenPicker`: the page gives way to its picture, the chrome takes the keyboard).
 *
 * Phases: `selecting` (the page dimmed under the toolbar, a drag draws the marquee) →
 * `capturing` (the engine paints) → `captured` (the result card) or `failed` (the refusal's
 * card); Escape closes from every one of them (capture-16: no half state), Close from the
 * cards, and a card's "Select again" goes back to `selecting`.
 */

/**
 * How long the overlay waits for the page's picture before it goes up over a blank one (the
 * default-browser prompt's and the screen picker's number): the capture is quick, and a page
 * that will not answer does not hold the overlay.
 */
const SNAPSHOT_WAIT_MS = 250

/**
 * The control that asked for the capture – the app menu's ⋯ button, once its menu has closed
 * on the row – or null when the keyboard was in the page (the shortcut), for the focus to go
 * back to as the overlay closes (§9.22). Read at the ask, not at the overlay's mount: the
 * picture is awaited in between.
 */
let opener: HTMLElement | null = null
let openings = 0

/** What the overlay gives the focus back to as it goes, if anything of the chrome's. */
export function captureOpener(): HTMLElement | null {
  return opener
}

/**
 * Web capture was asked for (`capture.start`): the page's picture is taken to stand in for it,
 * its geometry read for the marquee (`page.viewport`; null means the marquee is off and the
 * visible area and the full page are all the toolbar offers), the chrome takes the keyboard and
 * the overlay goes up. One at a time: a second ask while it is up changes nothing.
 */
export async function openCapture(tabId: string): Promise<void> {
  if (uiStore.get().capture) return
  const active = document.activeElement
  opener = active instanceof HTMLElement && active !== document.body ? active : null
  const [, viewport] = await Promise.all([
    Promise.race([
      captureActiveTab(tabId),
      new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
    ]),
    cmd('page.viewport', { tabId }).catch(() => null)
  ])
  if (uiStore.get().capture) return
  run('focus.chrome', undefined)
  uiStore.set({ capture: { tabId, viewport, seq: ++openings } })
}

/**
 * The overlay is going (Escape, Close, its tab gone from the screen): the flag clears, the
 * picture is let go, and the focus goes back – to the page when nothing of the chrome's asked
 * (the overlay's `usePopover` returns it to the opener otherwise, once the chrome is back from
 * its inert). Idempotent: the overlay calls it on its close and again as it unmounts.
 */
export function closeCapture(): void {
  const open = uiStore.get().capture !== null
  const to = opener
  opener = null
  if (!open && !to) return
  if (open) uiStore.set({ capture: null })
  invalidateSnapshot()
  if (!to?.isConnected) returnFocusToPage()
}

/**
 * `page.capture` through the bridge itself rather than `cmd`, whose catch logs every rejection
 * as an error: the engine's budget refusal (`CaptureTooLargeError`) is an answer the card shows
 * in the engine's own words, not a failure to report.
 */
export function capturePage(
  args: { tabId: string } & PageCaptureRequest
): Promise<PageCaptureResult | null> {
  return window.zen.invoke('page.capture', args)
}

/**
 * The page's own box inside the content frame's `area` (window coordinates, `contentAreaStore`),
 * for the marquee to clamp to and for `regionFromChrome`'s `frame`: the glance card's box when
 * the tab is the glance, its pane's view (inside the active outline's band) when it is one of
 * a split, else the whole area. In a split the drag maps to the pane's page as the engine
 * expects; the picture under it is the frame-wide stand-in every chrome overlay draws.
 */
export function pageFrame(state: UIState, tabId: string, area: Rect, gap: number): Rect {
  if (state.glance?.tabId === tabId) return glanceRect(area)
  const tab = state.tabs[tabId]
  const group = tab?.splitGroupId ? (state.splitGroups[tab.splitGroupId] ?? null) : null
  if (group && group.tabIds.length > 1) {
    const pane = splitPaneRects(area, group, gap).find((p) => p.tabId === tabId)
    if (pane) return pane.rect
  }
  return area
}

/**
 * When the overlay first nudges the engine's paint, and how often after until it answers.
 *
 * A region is painted through the debugger (`Page.captureScreenshot` with a clip, the engine's
 * `captureWithDevtools`), which waits for a compositor frame – and the live view is hidden
 * behind its stand-in while the overlay is up, as under every chrome surface over the page, so
 * the renderer paints none (Chromium 152: the request stays pending until the widget is shown
 * or a capturer wakes it; the visible area, Electron's `capturePage`, holds such a capturer
 * itself and is painted hidden in 23 ms). Asking for the page's stand-in afresh
 * (`overlay.snapshot { fresh }`, that same `capturePage`) has the hidden renderer paint one
 * frame, which the pending request takes: measured at 1600×1000 (probe 5), the region paint
 * that never returned on its own returned 20 ms after a nudge, 12 of 12 – but asked in the same
 * tick as the paint, the frame can come before the engine's request is out (2 of 4 stalled),
 * hence the wait, and the repeat for a slower attach. An engine that paints hidden views on its
 * own makes this a no-op: the answer is in before the first nudge is due.
 */
export const NUDGE_AFTER_MS = 60
export const NUDGE_EVERY_MS = 150

/** How long the overlay waits for the engine's paint in all before the failed card says so. */
export const PAINT_TIMEOUT_MS = 15_000

/**
 * The paint is out for `tabId`: from `NUDGE_AFTER_MS` on, and every `NUDGE_EVERY_MS` after, the
 * page's stand-in is asked afresh and its picture dropped – the ask is the point. Returns the
 * stop, for the answer (or the overlay's close) to call.
 */
export function nudgePaint(tabId: string): () => void {
  let timer = setTimeout(function tick() {
    void window.zen.invoke('overlay.snapshot', { tabId, fresh: true }).catch(() => null)
    timer = setTimeout(tick, NUDGE_EVERY_MS)
  }, NUDGE_AFTER_MS)
  return () => clearTimeout(timer)
}

/** A saved file's name out of the path the host answered with, whichever separator it uses. */
export function fileNameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

export interface Point {
  x: number
  y: number
}

/** A drag in progress: where the button went down and where the pointer is now (chrome px). */
export interface Drag {
  start: Point
  current: Point
}

export type CapturePhase =
  | { kind: 'selecting'; drag: Drag | null }
  | { kind: 'capturing'; mode: PageCaptureMode; marquee: Rect | null }
  | { kind: 'captured'; mode: PageCaptureMode; result: PageCaptureResult }
  | { kind: 'failed'; mode: PageCaptureMode; title: string; message: string }
  | { kind: 'closed' }

export type CaptureEvent =
  | { type: 'dragStart'; at: Point }
  | { type: 'dragMove'; at: Point }
  /**
   * The button came up. `frame` is the page's box in the overlay's pixels (the split pane the
   * tab is in, or the whole content frame), which the drag is clamped to as the engine's
   * `regionFromChrome` clamps the region.
   */
  | { type: 'dragEnd'; frame: Rect }
  /** The pointer was lost mid-drag (the window blurred, a touch was cancelled): no marquee. */
  | { type: 'dragCancel' }
  /** The toolbar's Visible area or Full page: the engine paints at once. */
  | { type: 'pick'; mode: 'viewport' | 'fullPage' }
  /** The engine answered: a picture, or null for a page that gave none. */
  | { type: 'captured'; result: PageCaptureResult | null }
  /** The engine refused or failed. */
  | { type: 'failed'; error: unknown }
  /** The engine has not answered in `PAINT_TIMEOUT_MS`: the overlay does not wait longer. */
  | { type: 'timeout' }
  /** A card's "Select again": back to the dimmed page. */
  | { type: 'again' }
  /** Escape, from anywhere: the overlay goes. */
  | { type: 'escape' }
  /** A card's Close, or the toolbar's Cancel. */
  | { type: 'close' }

export const SELECTING: CapturePhase = { kind: 'selecting', drag: null }

/** The words the failed card shows for an engine answer with no picture in it. */
export const NOTHING_TO_CAPTURE = {
  title: 'Nothing to capture',
  message: 'The page gave no picture. Try again, or capture the visible area.'
}

/** The failed card's title for the engine's budget refusal (its message is the engine's own). */
export const TOO_LARGE_TITLE = 'Capture is too large'
/** The failed card's title for any other failure. */
export const FAILED_TITLE = 'Couldn’t capture the page'
/** The words the failed card shows when the engine has not answered in `PAINT_TIMEOUT_MS`. */
export const PAINT_TIMED_OUT = {
  title: FAILED_TITLE,
  message: 'The page gave no picture in time. Try again, or capture the visible area.'
}

/** One step of the overlay: a pure function of the phase and the event, for `useReducer`. */
export function captureReducer(phase: CapturePhase, event: CaptureEvent): CapturePhase {
  switch (event.type) {
    case 'escape':
      return { kind: 'closed' }
    case 'close':
      return { kind: 'closed' }
    case 'again':
      return phase.kind === 'captured' || phase.kind === 'failed' ? SELECTING : phase
    case 'dragStart':
      return phase.kind === 'selecting'
        ? { kind: 'selecting', drag: { start: event.at, current: event.at } }
        : phase
    case 'dragMove':
      return phase.kind === 'selecting' && phase.drag
        ? { kind: 'selecting', drag: { start: phase.drag.start, current: event.at } }
        : phase
    case 'dragEnd': {
      if (phase.kind !== 'selecting' || !phase.drag) return phase
      // A press without a drag (or one wholly outside the page) captures nothing and leaves
      // the page dimmed for another go, as Edge's does.
      const marquee = marqueeOf(phase.drag, event.frame)
      return marquee ? { kind: 'capturing', mode: 'region', marquee } : SELECTING
    }
    case 'dragCancel':
      return phase.kind === 'selecting' && phase.drag ? SELECTING : phase
    case 'pick':
      return phase.kind === 'selecting'
        ? { kind: 'capturing', mode: event.mode, marquee: null }
        : phase
    case 'captured': {
      if (phase.kind !== 'capturing') return phase
      if (!event.result) return { kind: 'failed', mode: phase.mode, ...NOTHING_TO_CAPTURE }
      return { kind: 'captured', mode: phase.mode, result: event.result }
    }
    case 'failed': {
      if (phase.kind !== 'capturing') return phase
      return {
        kind: 'failed',
        mode: phase.mode,
        title: isCaptureTooLarge(event.error) ? TOO_LARGE_TITLE : FAILED_TITLE,
        message: captureErrorMessage(event.error)
      }
    }
    case 'timeout':
      return phase.kind === 'capturing'
        ? { kind: 'failed', mode: phase.mode, ...PAINT_TIMED_OUT }
        : phase
  }
}

/** The rectangle between a drag's two corners, whichever way it was drawn (may be empty). */
export function dragRect(drag: Drag): Rect {
  const x = Math.min(drag.start.x, drag.current.x)
  const y = Math.min(drag.start.y, drag.current.y)
  return {
    x,
    y,
    width: Math.abs(drag.current.x - drag.start.x),
    height: Math.abs(drag.current.y - drag.start.y)
  }
}

/**
 * The marquee a drag draws: the drag's rectangle clamped to the page's frame and snapped to
 * whole chrome pixels (the scrim's cut-out has crisp edges, and the region the engine gets is
 * the box that was shown). Null while the drag covers no pixel of the page.
 */
export function marqueeOf(drag: Drag, frame: Rect): Rect | null {
  const r = dragRect(drag)
  const left = Math.round(Math.max(r.x, frame.x))
  const top = Math.round(Math.max(r.y, frame.y))
  const right = Math.round(Math.min(r.x + r.width, frame.x + frame.width))
  const bottom = Math.round(Math.min(r.y + r.height, frame.y + frame.height))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * What the marquee's label says: the picture's size in device pixels – the size the result card
 * will report – which is the region in page pixels (the marquee over the zoom) times the page's
 * device pixel ratio. Chrome pixels when the host gave no geometry.
 */
export function marqueeSize(
  marquee: Rect,
  frame: Rect,
  viewport: PageViewport | null
): { width: number; height: number } {
  if (!viewport) return { width: marquee.width, height: marquee.height }
  const region = regionFromChrome(marquee, frame, viewport)
  if (!region) return { width: 0, height: 0 }
  return {
    width: Math.round(region.width * viewport.devicePixelRatio),
    height: Math.round(region.height * viewport.devicePixelRatio)
  }
}

/** The size label's text, `1,200 × 800`, with the multiplication sign (§9.1). */
export function sizeText(size: { width: number; height: number }): string {
  return `${size.width.toLocaleString('en-US')} × ${size.height.toLocaleString('en-US')}`
}

/** How far the size label sits from the marquee's corner, and from the frame's edges at least. */
export const LABEL_GAP = 6

/**
 * Where the marquee's size label goes: under the marquee's bottom-right corner, its right edge
 * on the marquee's, `LABEL_GAP` below; above the top-right corner when there is no room below;
 * and never past the frame's edges. `label` is the label's own box.
 */
export function labelPlacement(
  marquee: Rect,
  frame: Rect,
  label: { width: number; height: number }
): { x: number; y: number } {
  const below = marquee.y + marquee.height + LABEL_GAP
  const fitsBelow = below + label.height <= frame.y + frame.height - LABEL_GAP
  const y = fitsBelow ? below : Math.max(frame.y + LABEL_GAP, marquee.y - LABEL_GAP - label.height)
  const right = marquee.x + marquee.width
  const x = Math.min(
    Math.max(frame.x + LABEL_GAP, right - label.width),
    frame.x + frame.width - LABEL_GAP - label.width
  )
  return { x, y }
}

/**
 * The scrim's `clip-path`: the whole overlay less the marquee (even-odd, so the inner polygon
 * is a hole the undimmed page shows through). No hole without a marquee.
 */
export function scrimClipPath(marquee: Rect | null): string | undefined {
  if (!marquee) return undefined
  const l = marquee.x
  const t = marquee.y
  const r = marquee.x + marquee.width
  const b = marquee.y + marquee.height
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px, ${l}px ${t}px)`
}

/**
 * The picture's box in the result card: scaled to fit `max` (never up), keeping its aspect.
 * `result.width/height` are device pixels; the picture's CSS size at the page's ratio is the
 * most it is shown at, so a small region is not blown up.
 */
export function fitPicture(
  result: { width: number; height: number; devicePixelRatio: number },
  max: { width: number; height: number }
): { width: number; height: number } {
  const ratio = result.devicePixelRatio > 0 ? result.devicePixelRatio : 1
  const css = { width: result.width / ratio, height: result.height / ratio }
  const scale = Math.min(1, max.width / css.width, max.height / css.height)
  return { width: Math.round(css.width * scale), height: Math.round(css.height * scale) }
}
