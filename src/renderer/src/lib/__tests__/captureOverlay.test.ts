// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CaptureTooLargeError,
  regionFromChrome,
  type PageCaptureResult,
  type PageViewport
} from '@shared/capture'
import type { Rect, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { cmd, run } from '@renderer/lib/api'
import {
  captureOpener,
  captureReducer,
  clientFrame,
  closeCapture,
  dragRect,
  FAILED_TITLE,
  fileNameOf,
  fitPicture,
  folderNameOf,
  inRect,
  LABEL_GAP,
  labelPlacement,
  marqueeOf,
  marqueeSize,
  NOTHING_TO_CAPTURE,
  NUDGE_AFTER_MS,
  NUDGE_EVERY_MS,
  nudgePaint,
  openCapture,
  pageFrame,
  PAINT_TIMED_OUT,
  PAINT_TIMEOUT_MS,
  scrimClipPath,
  SELECTING,
  sizeText,
  TOO_LARGE_TITLE,
  type CapturePhase
} from '@renderer/lib/captureOverlay'
import { glanceRect, SPLIT_GAP, splitPaneRects } from '@renderer/lib/layout'
import { uiStore } from '@renderer/lib/ui'

/*
 * The desktop's Web capture overlay, the part without a DOM (lib/captureOverlay.ts): the
 * phases and what moves them (capture-16: Escape from every one of them is `closed`, nothing
 * half done), the marquee's arithmetic in chrome pixels and its mapping to the page's document
 * through the engine's `regionFromChrome` (§3 of the capture interface: scroll, zoom and the
 * device pixel ratio), the size label's placement, the scrim's cut-out, the card's picture
 * fit, the page's frame in a split or a glance, and the open and close that take and give
 * back the page.
 */

const FRAME: Rect = { x: 0, y: 0, width: 1200, height: 800 }
const VIEWPORT: PageViewport = {
  scrollX: 0,
  scrollY: 0,
  width: 1200,
  height: 800,
  clientWidth: 1200,
  clientHeight: 800,
  rtl: false,
  zoom: 1,
  devicePixelRatio: 1,
  documentWidth: 1200,
  documentHeight: 3000
}
/** The same page with a classic 15 px scrollbar (Linux, Windows): a column of the frame no capture can take. */
const SCROLLBAR: PageViewport = { ...VIEWPORT, clientWidth: 1185 }
const RESULT: PageCaptureResult = {
  dataUrl: 'data:image/png;base64,AAAA',
  width: 400,
  height: 300,
  devicePixelRatio: 1
}

const drag = (
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { start: Point; current: Point } => ({
  start: { x: x1, y: y1 },
  current: { x: x2, y: y2 }
})
interface Point {
  x: number
  y: number
}

describe('the phases (capture-16: Escape from any phase closes cleanly)', () => {
  const capturing: CapturePhase = {
    kind: 'capturing',
    mode: 'region',
    marquee: { x: 10, y: 10, width: 100, height: 50 }
  }
  const captured: CapturePhase = { kind: 'captured', mode: 'viewport', result: RESULT }
  const failed: CapturePhase = { kind: 'failed', mode: 'fullPage', title: 't', message: 'm' }
  const dragging: CapturePhase = { kind: 'selecting', drag: drag(10, 10, 60, 40) }

  it('starts on the dimmed page with no drag', () => {
    expect(SELECTING).toEqual({ kind: 'selecting', drag: null })
  })

  it.each<[string, CapturePhase]>([
    ['selecting', SELECTING],
    ['mid-drag', dragging],
    ['capturing', capturing],
    ['captured', captured],
    ['failed', failed]
  ])('Escape from %s is closed', (_, phase) => {
    expect(captureReducer(phase, { type: 'escape' })).toEqual({ kind: 'closed' })
  })

  it.each<[string, CapturePhase]>([
    ['selecting', SELECTING],
    ['captured', captured],
    ['failed', failed]
  ])('Close (a card’s button, the toolbar’s Cancel) from %s is closed', (_, phase) => {
    expect(captureReducer(phase, { type: 'close' })).toEqual({ kind: 'closed' })
  })

  it('a drag draws from where the button went down, follows the pointer and ends in a region capture', () => {
    const down = captureReducer(SELECTING, { type: 'dragStart', at: { x: 100, y: 200 } })
    expect(down).toEqual({
      kind: 'selecting',
      drag: { start: { x: 100, y: 200 }, current: { x: 100, y: 200 } }
    })
    const moved = captureReducer(down, { type: 'dragMove', at: { x: 40, y: 260 } })
    expect(moved).toEqual({
      kind: 'selecting',
      drag: { start: { x: 100, y: 200 }, current: { x: 40, y: 260 } }
    })
    const up = captureReducer(moved, { type: 'dragEnd', frame: FRAME })
    // Whichever way it was drawn, the marquee is the box between the corners.
    expect(up).toEqual({
      kind: 'capturing',
      mode: 'region',
      marquee: { x: 40, y: 200, width: 60, height: 60 }
    })
  })

  it('a press without a drag, or one wholly off the page, captures nothing and leaves the page dimmed for another go', () => {
    const down = captureReducer(SELECTING, { type: 'dragStart', at: { x: 100, y: 200 } })
    expect(captureReducer(down, { type: 'dragEnd', frame: FRAME })).toEqual(SELECTING)
    const off = captureReducer(
      captureReducer(SELECTING, { type: 'dragStart', at: { x: -50, y: -50 } }),
      { type: 'dragMove', at: { x: -10, y: -10 } }
    )
    expect(captureReducer(off, { type: 'dragEnd', frame: FRAME })).toEqual(SELECTING)
  })

  it('a lost pointer mid-drag drops the marquee; without a drag it changes nothing', () => {
    expect(captureReducer(dragging, { type: 'dragCancel' })).toEqual(SELECTING)
    expect(captureReducer(SELECTING, { type: 'dragCancel' })).toBe(SELECTING)
    expect(captureReducer(captured, { type: 'dragCancel' })).toBe(captured)
  })

  it('a drag is only drawn on the dimmed page: not over a card, not while the engine paints', () => {
    for (const phase of [capturing, captured, failed]) {
      expect(captureReducer(phase, { type: 'dragStart', at: { x: 1, y: 1 } })).toBe(phase)
      expect(captureReducer(phase, { type: 'dragMove', at: { x: 1, y: 1 } })).toBe(phase)
      expect(captureReducer(phase, { type: 'dragEnd', frame: FRAME })).toBe(phase)
    }
    // A move without a press draws nothing either.
    expect(captureReducer(SELECTING, { type: 'dragMove', at: { x: 1, y: 1 } })).toBe(SELECTING)
  })

  it('the toolbar’s Visible area and Full page capture at once, with no marquee', () => {
    expect(captureReducer(SELECTING, { type: 'pick', mode: 'viewport' })).toEqual({
      kind: 'capturing',
      mode: 'viewport',
      marquee: null
    })
    expect(captureReducer(dragging, { type: 'pick', mode: 'fullPage' })).toEqual({
      kind: 'capturing',
      mode: 'fullPage',
      marquee: null
    })
    expect(captureReducer(captured, { type: 'pick', mode: 'viewport' })).toBe(captured)
  })

  it('the engine’s picture is the result card; no picture is the "Nothing to capture" card', () => {
    expect(captureReducer(capturing, { type: 'captured', result: RESULT })).toEqual({
      kind: 'captured',
      mode: 'region',
      result: RESULT
    })
    expect(captureReducer(capturing, { type: 'captured', result: null })).toEqual({
      kind: 'failed',
      mode: 'region',
      ...NOTHING_TO_CAPTURE
    })
  })

  it('the budget refusal is a failed card in the engine’s own words, any other failure under its own title', () => {
    const tooLarge = new CaptureTooLargeError(50_000_000, { width: 10000, height: 5000 })
    expect(captureReducer(capturing, { type: 'failed', error: tooLarge })).toEqual({
      kind: 'failed',
      mode: 'region',
      title: TOO_LARGE_TITLE,
      message: tooLarge.message
    })
    // The desktop bridge's rejection carries the name and Electron's prefix; both are stripped.
    const overIpc = new Error(
      `Error invoking remote method 'zen:cmd': CaptureTooLarge: ${tooLarge.message}`
    )
    expect(captureReducer(capturing, { type: 'failed', error: overIpc })).toEqual({
      kind: 'failed',
      mode: 'region',
      title: TOO_LARGE_TITLE,
      message: tooLarge.message
    })
    expect(captureReducer(capturing, { type: 'failed', error: new Error('Error: boom') })).toEqual({
      kind: 'failed',
      mode: 'region',
      title: FAILED_TITLE,
      message: 'boom'
    })
  })

  it('a paint that never comes is a failed card in the overlay’s words, not a wait', () => {
    expect(captureReducer(capturing, { type: 'timeout' })).toEqual({
      kind: 'failed',
      mode: 'region',
      ...PAINT_TIMED_OUT
    })
    expect(PAINT_TIMED_OUT.title).toBe(FAILED_TITLE)
    // The clock only runs while the engine paints: a card, or the dimmed page, is not moved.
    expect(captureReducer(captured, { type: 'timeout' })).toBe(captured)
    expect(captureReducer(SELECTING, { type: 'timeout' })).toBe(SELECTING)
  })

  it('an engine answer that arrives late – after Escape, or after another go – changes nothing', () => {
    const closed: CapturePhase = { kind: 'closed' }
    expect(captureReducer(closed, { type: 'captured', result: RESULT })).toBe(closed)
    expect(captureReducer(closed, { type: 'failed', error: new Error('x') })).toBe(closed)
    expect(captureReducer(SELECTING, { type: 'captured', result: RESULT })).toBe(SELECTING)
    expect(captureReducer(closed, { type: 'pick', mode: 'viewport' })).toBe(closed)
    expect(captureReducer(closed, { type: 'again' })).toBe(closed)
    expect(captureReducer(closed, { type: 'timeout' })).toBe(closed)
  })

  it('a card’s "Select again" / "Try again" is the dimmed page once more', () => {
    expect(captureReducer(captured, { type: 'again' })).toEqual(SELECTING)
    expect(captureReducer(failed, { type: 'again' })).toEqual(SELECTING)
    expect(captureReducer(capturing, { type: 'again' })).toBe(capturing)
  })
})

describe('the marquee', () => {
  it('is the box between the drag’s corners, drawn any way round', () => {
    expect(dragRect(drag(10, 20, 110, 70))).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    expect(dragRect(drag(110, 70, 10, 20))).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    expect(dragRect(drag(10, 70, 110, 20))).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    expect(dragRect(drag(5, 5, 5, 5))).toEqual({ x: 5, y: 5, width: 0, height: 0 })
  })

  it('is clamped to the page’s frame and snapped to whole pixels', () => {
    const frame: Rect = { x: 100, y: 50, width: 600, height: 400 }
    expect(marqueeOf(drag(50, 20, 300, 200), frame)).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 150
    })
    expect(marqueeOf(drag(650, 400, 900, 700), frame)).toEqual({
      x: 650,
      y: 400,
      width: 50,
      height: 50
    })
    expect(marqueeOf(drag(120.4, 60.6, 220.5, 160.2), frame)).toEqual({
      x: 120,
      y: 61,
      width: 101,
      height: 99
    })
  })

  it('is nothing for an empty drag or one outside the frame', () => {
    expect(marqueeOf(drag(10, 10, 10, 10), FRAME)).toBeNull()
    expect(marqueeOf(drag(10, 10, 10, 300), FRAME)).toBeNull()
    expect(marqueeOf(drag(-100, -100, -1, -1), FRAME)).toBeNull()
    expect(marqueeOf(drag(1200, 0, 1300, 100), FRAME)).toBeNull()
    expect(marqueeOf(drag(10.2, 10.2, 10.4, 10.4), FRAME)).toBeNull()
  })
})

describe('the capturable field (§5: the layout viewport, the scrollbar’s gutter left out)', () => {
  it('is the frame less the gutter, from the frame’s top-left corner: clientWidth × clientHeight at the zoom', () => {
    expect(clientFrame(FRAME, SCROLLBAR)).toEqual({ x: 0, y: 0, width: 1185, height: 800 })
    // A horizontal scrollbar too: a row off the bottom.
    expect(clientFrame(FRAME, { ...SCROLLBAR, clientHeight: 785 })).toEqual({
      x: 0,
      y: 0,
      width: 1185,
      height: 785
    })
    // The frame away from the window's corner keeps its origin; only the far edges move.
    const frame: Rect = { x: 240, y: 88, width: 1200, height: 800 }
    expect(clientFrame(frame, SCROLLBAR)).toEqual({ x: 240, y: 88, width: 1185, height: 800 })
  })

  it('the gutter is its own width in the chrome’s pixels at any zoom: (width − clientWidth) × zoom', () => {
    // At 125 % the page reads 960 CSS px across the 1200 frame, 948 of them content: the 12 CSS
    // px gutter is the same 15 window pixels.
    const zoomed: PageViewport = { ...VIEWPORT, zoom: 1.25, width: 960, clientWidth: 948 }
    expect(clientFrame(FRAME, zoomed)).toEqual({ x: 0, y: 0, width: 1185, height: 800 })
    // At 50 % a 30 CSS px gutter is still 15.
    const small: PageViewport = { ...VIEWPORT, zoom: 0.5, width: 2400, clientWidth: 2370 }
    expect(clientFrame(FRAME, small)).toEqual({ x: 0, y: 0, width: 1185, height: 800 })
  })

  it('is anchored at the top-left corner in a right-to-left document too: rtl is information, not an offset', () => {
    // Chromium keeps the main frame's vertical scrollbar in the right-hand columns whatever the
    // document's direction (the engine's measurement), so the field is the same box.
    expect(clientFrame(FRAME, { ...SCROLLBAR, rtl: true })).toEqual(clientFrame(FRAME, SCROLLBAR))
  })

  it('is the whole frame where scrollbars overlay the page, where the host reports no client size, and without geometry', () => {
    expect(clientFrame(FRAME, VIEWPORT)).toEqual(FRAME)
    // An older host's answer, the fields not there: read through the engine's `clientSide`.
    const older = { ...VIEWPORT } as Partial<PageViewport>
    delete older.clientWidth
    delete older.clientHeight
    expect(clientFrame(FRAME, older as PageViewport)).toEqual(FRAME)
    // Nothing usable: a page with no layout yet (0), a value past the visible area.
    expect(clientFrame(FRAME, { ...VIEWPORT, clientWidth: 0, clientHeight: 0 })).toEqual(FRAME)
    expect(clientFrame(FRAME, { ...VIEWPORT, clientWidth: 1300 })).toEqual(FRAME)
    expect(clientFrame(FRAME, null)).toEqual(FRAME)
  })

  it('a drag past the gutter is clamped at the field’s edge, and its region ends at clientWidth', () => {
    const field = clientFrame(FRAME, SCROLLBAR)
    const marquee = marqueeOf(drag(1000, 100, 1300, 300), field)
    expect(marquee).toEqual({ x: 1000, y: 100, width: 185, height: 200 })
    // The size chip and the engine's region read the same box: 185 wide, to the page's 1185.
    expect(marqueeSize(marquee!, field, SCROLLBAR)).toEqual({ width: 185, height: 200 })
    expect(regionFromChrome(marquee!, field, SCROLLBAR)).toEqual({
      x: 1000,
      y: 100,
      width: 185,
      height: 200
    })
    // A drag wholly on the gutter draws nothing.
    expect(marqueeOf(drag(1190, 100, 1199, 300), field)).toBeNull()
  })

  it('a press is inside the field up to its far edges, which are the gutter’s first pixels', () => {
    const field = clientFrame(FRAME, SCROLLBAR)
    expect(inRect({ x: 0, y: 0 }, field)).toBe(true)
    expect(inRect({ x: 1184, y: 799 }, field)).toBe(true)
    expect(inRect({ x: 1185, y: 100 }, field)).toBe(false)
    expect(inRect({ x: 100, y: 800 }, field)).toBe(false)
    expect(inRect({ x: -1, y: 100 }, field)).toBe(false)
  })
})

describe('the size label (§3: the marquee mapped to the page’s document)', () => {
  it('reads the picture’s size in device pixels: the marquee over the zoom, times the ratio', () => {
    const marquee: Rect = { x: 100, y: 200, width: 300, height: 150 }
    expect(marqueeSize(marquee, FRAME, VIEWPORT)).toEqual({ width: 300, height: 150 })
    expect(marqueeSize(marquee, FRAME, { ...VIEWPORT, devicePixelRatio: 2 })).toEqual({
      width: 600,
      height: 300
    })
    // At 150 % a 300 px marquee covers 200 CSS px of the page; at DPR 2 that is 400 device px.
    expect(marqueeSize(marquee, FRAME, { ...VIEWPORT, zoom: 1.5, devicePixelRatio: 2 })).toEqual({
      width: 400,
      height: 200
    })
    expect(marqueeSize(marquee, FRAME, { ...VIEWPORT, zoom: 0.5 })).toEqual({
      width: 600,
      height: 300
    })
  })

  it('a scrolled page and a frame away from the window’s corner change the region, not its size', () => {
    const frame: Rect = { x: 240, y: 88, width: 1200, height: 800 }
    const marquee: Rect = { x: 340, y: 288, width: 300, height: 150 }
    const scrolled = { ...VIEWPORT, scrollX: 40, scrollY: 1000 }
    expect(marqueeSize(marquee, frame, scrolled)).toEqual({ width: 300, height: 150 })
  })

  it('without the page’s geometry the label says the marquee’s own pixels', () => {
    expect(marqueeSize({ x: 0, y: 0, width: 320, height: 200 }, FRAME, null)).toEqual({
      width: 320,
      height: 200
    })
  })

  it('a marquee off the page (never drawn, but clamped defensively) is 0 × 0', () => {
    expect(marqueeSize({ x: 2000, y: 2000, width: 10, height: 10 }, FRAME, VIEWPORT)).toEqual({
      width: 0,
      height: 0
    })
  })

  it('says W × H with the multiplication sign and grouped thousands', () => {
    expect(sizeText({ width: 1200, height: 800 })).toBe('1,200 × 800')
    expect(sizeText({ width: 16, height: 9 })).toBe('16 × 9')
  })

  it('sits under the marquee’s bottom-right corner, flips above when there is no room below, and never leaves the frame', () => {
    const label = { width: 80, height: 20 }
    const marquee: Rect = { x: 100, y: 100, width: 300, height: 200 }
    expect(labelPlacement(marquee, FRAME, label)).toEqual({ x: 320, y: 300 + LABEL_GAP })
    const low: Rect = { x: 100, y: 500, width: 300, height: 290 }
    expect(labelPlacement(low, FRAME, label)).toEqual({ x: 320, y: 500 - LABEL_GAP - 20 })
    const tall: Rect = { x: 100, y: 0, width: 300, height: 800 }
    expect(labelPlacement(tall, FRAME, label)).toEqual({ x: 320, y: LABEL_GAP })
    const narrow: Rect = { x: 0, y: 0, width: 40, height: 40 }
    expect(labelPlacement(narrow, FRAME, label)).toEqual({ x: LABEL_GAP, y: 40 + LABEL_GAP })
    const atRight: Rect = { x: 1100, y: 0, width: 100, height: 40 }
    expect(labelPlacement(atRight, FRAME, label)).toEqual({
      x: 1200 - LABEL_GAP - 80,
      y: 40 + LABEL_GAP
    })
  })
})

describe('the scrim’s cut-out', () => {
  it('is an even-odd polygon: the whole overlay with the marquee as the hole', () => {
    expect(scrimClipPath({ x: 10, y: 20, width: 100, height: 50 })).toBe(
      'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, 10px 20px, 110px 20px, 110px 70px, 10px 70px, 10px 20px)'
    )
  })

  it('is no clip without a marquee: the page dimmed whole', () => {
    expect(scrimClipPath(null)).toBeUndefined()
  })
})

describe('the card’s picture', () => {
  it('shows a picture at its CSS size when it fits, never scaled up', () => {
    // The card's column is 364 (`PICTURE_COLUMN`): a 400 × 300 picture scales to 364 × 273.
    expect(fitPicture(RESULT, { width: 364, height: 400 })).toEqual({ width: 364, height: 273 })
    expect(fitPicture({ ...RESULT, width: 100, height: 60 }, { width: 364, height: 400 })).toEqual({
      width: 100,
      height: 60
    })
  })

  it('a DPR 2 picture is shown at half its device pixels, then fitted', () => {
    const result = { width: 800, height: 600, devicePixelRatio: 2 }
    expect(fitPicture(result, { width: 364, height: 400 })).toEqual({ width: 364, height: 273 })
    expect(fitPicture(result, { width: 600, height: 400 })).toEqual({ width: 400, height: 300 })
  })

  it('a tall full-page picture is bounded by the height', () => {
    expect(
      fitPicture({ width: 1200, height: 9000, devicePixelRatio: 1 }, { width: 364, height: 400 })
    ).toEqual({ width: 53, height: 400 })
  })

  it('a ratio of 0 or less is taken as 1', () => {
    expect(
      fitPicture({ width: 100, height: 50, devicePixelRatio: 0 }, { width: 364, height: 400 })
    ).toEqual({ width: 100, height: 50 })
  })
})

describe('the page’s frame in the content area', () => {
  const area: Rect = { x: 240, y: 88, width: 1360, height: 912 }
  const state = {
    tabs: {
      a: { id: 'a', splitGroupId: 'g' },
      b: { id: 'b', splitGroupId: 'g' },
      c: { id: 'c' },
      lone: { id: 'lone', splitGroupId: 'solo' }
    },
    splitGroups: {
      g: { id: 'g', spaceId: 's', tabIds: ['a', 'b'], layout: 'vertical', sizes: [0.5, 0.5] },
      solo: { id: 'solo', spaceId: 's', tabIds: ['lone'], layout: 'vertical', sizes: [1] }
    },
    glance: null
  } as unknown as UIState

  it('is the whole area for a plain tab', () => {
    expect(pageFrame(state, 'c', area, SPLIT_GAP)).toEqual(area)
  })

  it('is the pane’s view for a tab in a split, the one the engine expects the drag against', () => {
    const group = state.splitGroups['g']!
    const panes = splitPaneRects(area, group, SPLIT_GAP)
    expect(pageFrame(state, 'a', area, SPLIT_GAP)).toEqual(panes.find((p) => p.tabId === 'a')!.rect)
    expect(pageFrame(state, 'b', area, SPLIT_GAP)).toEqual(panes.find((p) => p.tabId === 'b')!.rect)
    expect(pageFrame(state, 'a', area, SPLIT_GAP)).not.toEqual(area)
  })

  it('a group of one is no split: the whole area', () => {
    expect(pageFrame(state, 'lone', area, SPLIT_GAP)).toEqual(area)
  })

  it('is the glance card’s box for the tab the glance shows', () => {
    const glanced = {
      ...state,
      glance: { tabId: 'c', parentTabId: 'a', originX: 0.5, originY: 0.5 }
    } as unknown as UIState
    expect(pageFrame(glanced, 'c', area, SPLIT_GAP)).toEqual(glanceRect(area))
  })
})

describe('a saved file’s name', () => {
  it('is the path’s last segment on either separator', () => {
    expect(fileNameOf('/home/b/Downloads/Screenshot 2026-09-23 at 14.05.09.png')).toBe(
      'Screenshot 2026-09-23 at 14.05.09.png'
    )
    expect(fileNameOf('C:\\Users\\b\\Downloads\\Screenshot.png')).toBe('Screenshot.png')
    expect(fileNameOf('Screenshot.png')).toBe('Screenshot.png')
  })

  it('names the folder the file sits in, on either separator – what the save toast reports (§9.33)', () => {
    expect(folderNameOf('/home/b/Downloads/Screenshot 2026-09-23 at 14.05.09.png')).toBe(
      'Downloads'
    )
    expect(folderNameOf('C:\\Users\\b\\Downloads\\Screenshot.png')).toBe('Downloads')
    // The folder the user chose instead of Downloads, by its own name.
    expect(folderNameOf('/home/b/Pictures/Captures/Screenshot.png')).toBe('Captures')
    expect(folderNameOf('D:\\captures\\Screenshot.png')).toBe('captures')
  })

  it('has no folder to name for a file at a root or a bare name', () => {
    expect(folderNameOf('/Screenshot.png')).toBe('')
    expect(folderNameOf('Screenshot.png')).toBe('')
    // A drive's root is the drive.
    expect(folderNameOf('C:\\Screenshot.png')).toBe('C:')
  })
})

describe('the paint’s nudge (the hidden view painted a frame for the engine’s request)', () => {
  const invoke = vi.fn(async (): Promise<string | null> => 'data:image/jpeg;base64,PIC')

  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockClear()
    vi.stubGlobal('zen', { invoke })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('asks for the page’s stand-in afresh once the paint is 60 ms out, then every 150 ms until stopped', () => {
    const stop = nudgePaint('t1')
    vi.advanceTimersByTime(NUDGE_AFTER_MS - 1)
    expect(invoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1', fresh: true })
    vi.advanceTimersByTime(NUDGE_EVERY_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(NUDGE_EVERY_MS)
    expect(invoke).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(10 * NUDGE_EVERY_MS)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('an answer before the first nudge is due leaves the page alone', () => {
    const stop = nudgePaint('t1')
    vi.advanceTimersByTime(NUDGE_AFTER_MS - 10)
    stop()
    vi.advanceTimersByTime(1000)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('a stand-in the host will not give is no error', async () => {
    invoke.mockRejectedValueOnce(new Error('gone'))
    const stop = nudgePaint('t1')
    vi.advanceTimersByTime(NUDGE_AFTER_MS)
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    stop()
  })

  it('the wait is shorter than the paint the engine gives a shown page, and well inside the overlay’s patience', () => {
    // Measured: a region paint answers in ~30 ms with the view shown, ~80 ms nudged; the
    // nudge must not come in the same tick as the ask (the frame can beat the engine's request).
    expect(NUDGE_AFTER_MS).toBeGreaterThanOrEqual(50)
    expect(NUDGE_AFTER_MS).toBeLessThan(NUDGE_EVERY_MS)
    expect(PAINT_TIMEOUT_MS).toBeGreaterThan(20 * NUDGE_EVERY_MS)
  })
})

describe('opening and closing', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  let opener: HTMLButtonElement

  beforeEach(() => {
    vi.mocked(cmd).mockReset()
    vi.mocked(run).mockReset()
    uiStore.set({ capture: null, snapshot: null, snapshotTabId: null })
    opener = document.createElement('button')
    document.body.appendChild(opener)
  })

  afterEach(() => {
    closeCapture()
    opener.remove()
    uiStore.set({ capture: null, snapshot: null, snapshotTabId: null })
  })

  it('takes the page’s picture and geometry, gives the chrome the keyboard and raises the flag', async () => {
    vi.mocked(cmd).mockImplementation(async (name: string) => {
      if (name === 'overlay.snapshot') return 'data:image/jpeg;base64,PIC'
      if (name === 'page.viewport') return VIEWPORT
      return null
    })
    await openCapture('t1')
    const names = vi.mocked(cmd).mock.calls.map(([name]) => name)
    expect(names).toContain('overlay.snapshot')
    expect(names).toContain('page.viewport')
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(uiStore.get().capture).toMatchObject({ tabId: 't1', viewport: VIEWPORT })
    expect(uiStore.get().capture!.seq).toBeGreaterThan(0)
  })

  it('remembers the chrome control that asked, for the focus to go back to; the body (the shortcut from the page) is no opener', async () => {
    opener.focus()
    await openCapture('t1')
    expect(captureOpener()).toBe(opener)
    closeCapture()
    expect(captureOpener()).toBeNull()

    ;(document.activeElement as HTMLElement | null)?.blur()
    await openCapture('t2')
    expect(captureOpener()).toBeNull()
  })

  it('a page whose geometry the host cannot give still opens, with the marquee off (viewport null)', async () => {
    vi.mocked(cmd).mockImplementation(async (name: string) => {
      if (name === 'page.viewport') throw new Error('no view')
      return null
    })
    await openCapture('t1')
    expect(uiStore.get().capture).toMatchObject({ tabId: 't1', viewport: null })
  })

  it('a page that will not give its picture does not hold the overlay past the wait', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(cmd).mockImplementation(
        (name: string) =>
          new Promise((resolve) => {
            if (name === 'page.viewport') resolve(VIEWPORT)
            // overlay.snapshot never answers
          }) as never
      )
      const opened = openCapture('t1')
      await vi.advanceTimersByTimeAsync(300)
      await opened
      expect(uiStore.get().capture).toMatchObject({ tabId: 't1', viewport: VIEWPORT })
    } finally {
      vi.useRealTimers()
    }
  })

  it('one at a time: a second ask while it is up changes nothing', async () => {
    await openCapture('t1')
    const first = uiStore.get().capture
    vi.mocked(cmd).mockClear()
    await openCapture('t2')
    expect(uiStore.get().capture).toBe(first)
    expect(cmd).not.toHaveBeenCalledWith('page.viewport', expect.anything())
  })

  it('closing clears the flag, lets the picture go and hands the page its focus when nothing of the chrome’s asked', async () => {
    await openCapture('t1')
    uiStore.set({ snapshot: 'data:image/jpeg;base64,PIC', snapshotTabId: 't1' })
    vi.mocked(run).mockClear()
    closeCapture()
    expect(uiStore.get().capture).toBeNull()
    expect(uiStore.get().snapshot).toBeNull()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('with a chrome opener still there the page is not given the focus (the overlay’s popover returns it to the opener)', async () => {
    opener.focus()
    await openCapture('t1')
    vi.mocked(run).mockClear()
    closeCapture()
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
  })

  it('is idempotent: a second close is nothing', async () => {
    await openCapture('t1')
    closeCapture()
    vi.mocked(run).mockClear()
    closeCapture()
    expect(run).not.toHaveBeenCalled()
    expect(uiStore.get().capture).toBeNull()
  })

  it('an opener gone from the document by the close (a menu row) hands the page its focus', async () => {
    opener.focus()
    await openCapture('t1')
    opener.remove()
    vi.mocked(run).mockClear()
    closeCapture()
    await flush()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })
})
