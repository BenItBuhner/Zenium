import type { BaseWindowConstructorOptions } from 'electron'
import type { Rect } from '../../shared/types'

/**
 * The agent stage (MCP B): the pure rules behind `ElectronTabView.setAgentDriven` and
 * `ElectronTabViewHost.stageFor` in `views.ts`, kept out of it so they run in a unit test
 * without Electron.
 *
 * WHY. In background mode an agent's tabs are hidden `WebContentsView`s kept OUT of the window
 * (`inWindow` in `views.ts`: Electron 44 hands a new hidden view inside the window the keyboard).
 * A view in no window has no size: the page lays out at 0 × 0 (`innerWidth` 0),
 * `browser_snapshot` drops every element whose box is empty (`hasBox` in `core/agent/page.ts`),
 * and `capturePage` answers nothing (`GetViewBounds` empty) while a full-page or region capture
 * through the protocol hangs. Measured on the packaged Linux build before this change: 0 × 0,
 * `visibilityState` `hidden`, a snapshot with one ref of three (the button; the heading and the
 * paragraph gone), the viewport shot "could not be captured" in 4 ms, the fullPage and element
 * shots not back after 6 s and the session's tool queue blocked behind them.
 *
 * THE STAGE is one never-shown `BaseWindow` per user window (`stageWindowOptions`) whose
 * `contentView` takes the agent-driven hidden views as shown children, in the user window's
 * page area (`stageBox`). A page there lays out at that size and paints; its aura window is
 * HIDDEN to Chromium's occlusion tracker (the stage's root was never shown), so
 * `document.visibilityState` reads `hidden` as a Chrome background tab's does – until the
 * page's first `capturePage`. Electron's `backgroundThrottling: false`, which
 * `AgentService.prepare` sets so a hidden page paints at all, keeps a page a capture made
 * visible visible for good (Electron's page-visibility notes say as much; measured with plain
 * and `stayHidden` captures alike, and with the throttling put back: nothing re-hides it until
 * the user shows and hides the tab). With the throttling on, `capturePage` on the stage failed
 * at once (no frame to copy), so working screenshots were taken over strict parity there:
 * `hidden` until the first screenshot, `visible` after it.
 *
 * MEASURED against the other candidates (Electron 44, Xvfb, `--disable-gpu`): a detached view
 * under `Emulation.setDeviceMetricsOverride` lays out but reads `visible` at once and every
 * capture hung; a hidden view inside the user window takes the keyboard when its renderer
 * comes up; parking in the user window (W6-F5's box) works but reads `visible` from the start
 * and has four corners; the stage lays out, reads `hidden` until the first capture, paints in
 * 4–8 ms, takes no keyboard even with `webContents.focus()` on the staged page (the window is
 * `focusable: false` and never shown), and five staged views cost what five parked ones do
 * (1296 vs 1298 MB over the whole app).
 *
 * FULL PAGES AND REGIONS never go through the protocol on the stage: `Page.captureScreenshot`
 * with `captureBeyondViewport` on a never-shown window hung (three of three tries without a
 * clip, one of three with the document's clip), and a hung call left its device-metrics
 * override on the page (the view read 1185 × 2002 afterwards wherever it went). The view is
 * grown to the document instead (`grownBox`; a child view may be taller than its window, the
 * `NativeViewHost` clips nothing there – measured: a 1200 × 2002 view in a 1200 × 700 stage
 * painted whole in 12–20 ms), `capturePage` paints all of it, the region is cut out of that
 * (`regionCrop`) and the box is put back. Growing resets the page's scroll offset (measured:
 * `scrollY` 500 → 0), so the offset is restored once the box is back (`SCROLL_RESTORE_SCRIPT`).
 */

export interface Size {
  width: number
  height: number
}

/** The state of a view that decides whether it stands on the stage (`belongsOnStage`). */
export interface StageState {
  /** An agent drives the page (`TabView.setAgentDriven`). */
  agentDriven: boolean
  /** The core's layout shows the page. */
  visible: boolean
  /** The page is parked under a chrome cover (W6-F5): shown and sized already, in the window. */
  parked: boolean
  /** The view is attached to a live window (the stage is the window's). */
  hosted: boolean
}

/**
 * Whether a view in this state belongs on the stage: an agent drives it, the layout hides it,
 * it is not parked under a chrome cover (parked it has its size and paints in the window
 * already) and it has a window whose stage to take.
 */
export function belongsOnStage(state: StageState): boolean {
  return state.agentDriven && !state.visible && !state.parked && state.hosted
}

/** Where a staged view is laid out when neither the page area nor the window has a size yet. */
export const STAGE_FALLBACK: Size = { width: 1024, height: 768 }

/**
 * The box a staged view stands in, at the stage's origin: the user window's page area – where
 * the core's layout puts the shown tab's page (`ZenWindow.contentRect`), so a hidden page lays
 * out exactly as it would on screen – or the window's content size before the first layout,
 * and `STAGE_FALLBACK` when neither has a size. Never empty: an empty box is what the stage is
 * there to avoid.
 */
export function stageBox(pageArea: Size | null, contentSize: Size | null): Rect {
  const width = sized(pageArea?.width) ?? sized(contentSize?.width) ?? STAGE_FALLBACK.width
  const height = sized(pageArea?.height) ?? sized(contentSize?.height) ?? STAGE_FALLBACK.height
  return { x: 0, y: 0, width, height }
}

/** A whole number of DIP at least 1, or null for anything else (not laid out, not a number). */
function sized(n: number | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const whole = Math.round(n)
  return whole >= 1 ? whole : null
}

/**
 * The box a staged view is grown to for a full-page or region paint: the document's size in
 * DIP – its CSS pixels times the page zoom, the unit a view's box is in – never smaller than
 * the stage box (a short document keeps the viewport), the height cut at `maxHeight` CSS
 * pixels (`fullPageCut`: Chromium's texture limit for the paint) and the width at the same
 * limit. A view grown this way holds the whole document with no scrolling, which is why
 * `regionCrop` needs no scroll offset.
 */
export function grownBox(
  box: Rect,
  document: { documentWidth: number; documentHeight: number; zoom: number },
  maxHeight: number
): Rect {
  const zoom = Number.isFinite(document.zoom) && document.zoom > 0 ? document.zoom : 1
  const cut = Number.isFinite(maxHeight) && maxHeight >= 1 ? Math.floor(maxHeight) : 1
  const inDip = (css: number): number =>
    Number.isFinite(css) && css > 0 ? Math.ceil(Math.min(css, cut) * zoom) : 0
  return {
    x: box.x,
    y: box.y,
    width: Math.max(box.width, inDip(document.documentWidth)),
    height: Math.max(box.height, inDip(document.documentHeight))
  }
}

/**
 * The part of a staged view's paint that is `region` (CSS pixels of the document, as
 * `AgentCaptureOptions.region` has it): the region less the page's scroll offset (0 for a view
 * grown to its document; the page's own for a document that fitted the box) at `ratio` device
 * pixels per CSS pixel (the page's `devicePixelRatio`: the display's scale times the zoom, the
 * unit `capturePage`'s bitmap is in), cut at the edge of `visible` – the paint's page content,
 * the gutter left out (`visibleAreaClip`) – as the shown path cuts a region; null when nothing
 * of the region was painted (a region past the cut of a very long page).
 */
export function regionCrop(
  region: Rect,
  scroll: { scrollX: number; scrollY: number },
  ratio: number,
  visible: Size
): Rect | null {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  const x = Math.max(0, Math.round((region.x - scroll.scrollX) * r))
  const y = Math.max(0, Math.round((region.y - scroll.scrollY) * r))
  const width = Math.min(visible.width - x, Math.round(region.width * r))
  const height = Math.min(visible.height - y, Math.round(region.height * r))
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * Whether a paint is the one a grown view was waited for: at least `wanted` (the grown box in
 * the display's pixels), a pixel of rounding allowed each way – a `capturePage` straight after
 * the `setBounds` that grew the view can only copy the frame the view has, the box's size, and
 * that is not the document. Any paint fits when nothing was wanted (a viewport capture).
 */
export function frameFits(bitmap: Size, wanted: Size | null): boolean {
  if (!wanted) return true
  return bitmap.width + 1 >= wanted.width && bitmap.height + 1 >= wanted.height
}

/**
 * A staged page's first frame comes a few hundred milliseconds after it is staged
 * (measured: `capturePage` refused at 50 ms with no surface to copy, painted at 350 ms), and
 * one made just before a layout may come back empty: a failed attempt is tried again this
 * often, within this long from the first attempt. Anything not painted by the deadline is no
 * picture (`ElectronTabView.captureOnStage` answers null, as the shown path does for an empty
 * bitmap): well under the 5 s a tool call may take before it counts as hung.
 */
export const STAGED_CAPTURE_RETRY_MS = 100
export const STAGED_CAPTURE_DEADLINE_MS = 3000

/** Whether a staged capture that failed `elapsedMs` after the first attempt is tried again. */
export function retryStagedCapture(elapsedMs: number): boolean {
  return elapsedMs + STAGED_CAPTURE_RETRY_MS <= STAGED_CAPTURE_DEADLINE_MS
}

/**
 * The scroll offset put back after a grown view's box is restored: the page relays out on its
 * next frame, and a `scrollTo` before that clamps to the grown document's range of nothing, so
 * the script waits for the viewport to read its old height again (or gives up after twenty
 * turns) and scrolls then. Run in the isolated world; the page sees no script of ours.
 */
export function scrollRestoreScript(scroll: {
  scrollX: number
  scrollY: number
  height: number
}): string {
  const x = Math.max(0, Math.round(scroll.scrollX))
  const y = Math.max(0, Math.round(scroll.scrollY))
  const h = Math.max(0, Math.round(scroll.height))
  return `(function () {
  var n = 0
  function go() {
    if (window.innerHeight === ${h} || n++ > 20) window.scrollTo(${x}, ${y})
    else setTimeout(go, 16)
  }
  go()
})()`
}

/**
 * The never-shown window a stage is: nothing the user can see, focus or find – not shown, not
 * focusable (a staged page asked for the keyboard cannot take the user's), off the taskbar,
 * out of Mission Control (the Window menu's exclusion is a property set after construction),
 * frameless – at the user window's place, so the display it is nearest is the user window's
 * (that display's scale is a staged page's `devicePixelRatio` and its bitmap's), with the
 * window's content size. The size is only a starting point: a staged view may stand taller
 * than the stage (`grownBox`).
 */
export function stageWindowOptions(
  place: { x: number; y: number },
  contentSize: Size
): BaseWindowConstructorOptions {
  const size = stageBox(null, contentSize)
  return {
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    useContentSize: true,
    x: Math.round(place.x),
    y: Math.round(place.y),
    width: size.width,
    height: size.height,
    title: 'Zenium agent stage'
  }
}
