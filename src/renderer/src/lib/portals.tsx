/* eslint-disable react-refresh/only-export-components -- a library module: the two layer components ship with the hooks and geometry that place surfaces in them */
import type { CSSProperties, JSX, ReactNode, RefObject } from 'react'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import type { Rect } from '@shared/types'
import { closeAllPopovers } from './popoverStore'

export {
  closeAllPopovers,
  openPopover,
  openPopoverCount,
  subscribePopovers,
  useLightDismiss,
  type DismissReason,
  type LightDismissOptions,
  type PopoverChange,
  type PopoverRegistration
} from './popoverStore'

/*
 * Where chrome surfaces render. One rule:
 *
 *   Modal dialogs render in the content frame through `FrameDialogHost` (the scrim dims the
 *   frame only). Popovers, menus, toasts and anything anchored to chrome outside the frame
 *   render through `ChromePortal`. Never position a dialog with `fixed` inside the frame.
 *
 * The content frame is a containing block for `fixed` descendants whenever it carries a
 * transform (the phone's recede, `.zen-content-frame`), so a `fixed` surface rendered under it
 * lands offset inside the frame and a viewport-sized scrim gets clipped to it. Dialogs want the
 * frame's box (design-language-v2-draft §9.5: the sidebar and toolbar stay undimmed and inert);
 * popovers want the window (§9.20: no scrim, aligned to an anchor in the pill, bar or toolbar).
 *
 * And what they draw in – two token families, never mixed (§9.29):
 *
 *   Window surfaces (toolbars, the URL pill and its chips, the sidebar and tab strip, the
 *   bookmarks bar) draw in the theme's foreground with `--v2-window-fill` /
 *   `--v2-window-fill-hover` / `--zen-accent`. Page surfaces (pages, panels, popovers, menus,
 *   dialogs, cards) draw in `--v2-text` / `--v2-fill` / `--v2-accent`. A chip, badge or icon
 *   button takes the family of the surface it sits on through `data-surface="window" | "page"`
 *   on its nearest surface root, never from props.
 *
 * Both layers here are page surfaces: the host's root and `#zen-chrome-layer` carry
 * `data-surface="page"`; the window chrome roots (Toolbar, SidebarTop, Sidebar, BookmarksBar)
 * carry `data-surface="window"`. `[data-surface]` in main.css maps each family onto the shared
 * control roles – `--v2-control-text`, `--v2-control-text-deemphasized`, `--v2-control-fill`,
 * `--v2-control-fill-hover`, `--v2-control-accent` – so a control that reads those draws in its
 * surface's family wherever it is placed.
 */

// ---------------------------------------------------------------------------
// Frame dialogs
// ---------------------------------------------------------------------------

interface FrameDialogEntry {
  /** Pressing the scrim: dismiss, or nothing for a prompt the page waits on. */
  onScrimPress: () => void
}

interface FrameDialogHostApi {
  register: (entry: FrameDialogEntry) => () => void
}

const FrameDialogHostContext = createContext<FrameDialogHostApi | null>(null)

/** The window chrome roots (§9.29): what goes inert while a frame dialog is open (§9.5). */
const WINDOW_CHROME_ROOTS = '[data-surface="window"]'
/** Where a window root does not count as chrome to make inert: inside a host or the chrome layer. */
const NOT_CHROME = '.zen-frame-dialogs, .zen-chrome-layer'

let inertHolds = 0
const inertMarked = new Set<Element>()
let inertObserver: MutationObserver | null = null

function markWindowChromeInert(): void {
  for (const el of document.querySelectorAll(WINDOW_CHROME_ROOTS)) {
    if (inertMarked.has(el) || el.hasAttribute('inert') || el.closest(NOT_CHROME)) continue
    el.setAttribute('inert', '')
    inertMarked.add(el)
  }
}

/**
 * Make the window chrome inert (§9.5: while a dialog is open the sidebar, toolbar, pill and
 * bookmarks bar stay undimmed and inert – no press, hover, focus or shortcut button reaches
 * them) until the returned release runs. Holds nest: the chrome comes back when the last one is
 * released. The roots are the `data-surface="window"` elements outside the dialog hosts and the
 * chrome layer, including any mounted while the hold lasts (a compact-mode sidebar revealed
 * under a prompt); an element that was inert already is left to whoever made it so.
 */
export function holdChromeInert(): () => void {
  if (++inertHolds === 1) {
    markWindowChromeInert()
    if (typeof MutationObserver !== 'undefined') {
      inertObserver = new MutationObserver(markWindowChromeInert)
      inertObserver.observe(document.body, { childList: true, subtree: true })
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--inertHolds > 0) return
    inertObserver?.disconnect()
    inertObserver = null
    for (const el of inertMarked) el.removeAttribute('inert')
    inertMarked.clear()
  }
}

/** Whether a hold on the window chrome is in force right now: a frame dialog is open. */
export function chromeInertHeld(): boolean {
  return inertHolds > 0
}

/**
 * The layer modal dialogs render into: `absolute; inset: 0` over the box it is placed in (the
 * content frame on desktop, the whole shell on phones, where dialogs are sheets), its own
 * stacking context, taking the pointer only while a dialog is open. It draws the §9.5 scrim
 * (`--v2-scrim-modal`) and centres its children; several open at once stack, the last on top.
 *
 * Dialogs placed through it call `useFrameDialog` and render their panel as a child of the host,
 * in flow – never `fixed`, never with a scrim of their own, and with no positioning of their own
 * needed to sit above the scrim. A phone sheet aligns itself with `self-end justify-self-stretch`.
 * A page surface: its root carries `data-surface="page"`, so the dialogs' controls draw in the
 * page family (§9.29).
 *
 * Layering: the scrim is a positioned child painted first, and the children render in a slot
 * after it with its own stacking context above the scrim (`.zen-frame-dialogs-slot`,
 * `z-index: 1`), so a dialog paints over the scrim and takes the pointer whether or not it is
 * positioned itself; between the dialogs the slot lets the pointer through to the scrim, whose
 * press – consumed on `pointerdown` (§9.20 amended) – goes to the dialog on top. While a dialog
 * is open the window chrome outside the frame is inert (`holdChromeInert`, §9.5) and every open
 * popover closes; Escape and the dialog's own controls stay live.
 *
 * Modal dialogs render in the content frame through FrameDialogHost (scrim dims the frame only).
 * Popovers, menus, toasts and anything anchored to chrome outside the frame render through
 * ChromePortal. Never position a dialog with `fixed` inside the frame.
 */
export function FrameDialogHost({ children }: { children?: ReactNode }): JSX.Element {
  const [dialogs, setDialogs] = useState<FrameDialogEntry[]>([])
  const api = useMemo<FrameDialogHostApi>(
    () => ({
      register: (entry) => {
        setDialogs((list) => [...list, entry])
        return () => setDialogs((list) => list.filter((d) => d !== entry))
      }
    }),
    []
  )
  const top = dialogs[dialogs.length - 1]
  const open = dialogs.length > 0
  useEffect(() => {
    if (!open) return
    return holdChromeInert()
  }, [open])
  // A dialog opening (or another stacking on it) is an open that is not a press on a popover:
  // it closes whatever popover is up (§9.20, one at a time).
  const count = dialogs.length
  const seen = useRef(0)
  useEffect(() => {
    if (count > seen.current) closeAllPopovers('all')
    seen.current = count
  }, [count])
  return (
    <FrameDialogHostContext.Provider value={api}>
      <div
        className="zen-frame-dialogs absolute inset-0 z-50"
        data-surface="page"
        data-open={top ? 'true' : undefined}
      >
        {top && (
          <div
            className="zen-frame-scrim zen-animate-in"
            onPointerDown={() => top.onScrimPress()}
          />
        )}
        <div className="zen-frame-dialogs-slot">{children}</div>
      </div>
    </FrameDialogHostContext.Provider>
  )
}

/**
 * Place the calling dialog through the nearest `FrameDialogHost`: while `active` the host shows
 * its scrim, makes the window chrome inert and takes the pointer, and a press on the scrim – on
 * `pointerdown`, mouse, touch or pen alike – runs `onScrimPress` of the dialog on top (omit it
 * for a prompt the page waits on, which only its buttons and Escape answer). Renders nothing
 * itself: the dialog returns its panel, which the host centres above the scrim.
 *
 * Modal dialogs render in the content frame through FrameDialogHost (scrim dims the frame only).
 * Popovers, menus, toasts and anything anchored to chrome outside the frame render through
 * ChromePortal. Never position a dialog with `fixed` inside the frame.
 */
export function useFrameDialog({
  onScrimPress,
  active = true
}: { onScrimPress?: () => void; active?: boolean } = {}): void {
  const host = useContext(FrameDialogHostContext)
  const latest = useRef(onScrimPress)
  useLayoutEffect(() => {
    latest.current = onScrimPress
  }, [onScrimPress])
  useLayoutEffect(() => {
    if (!active || !host) return
    return host.register({ onScrimPress: () => latest.current?.() })
  }, [active, host])
}

// ---------------------------------------------------------------------------
// Chrome layer
// ---------------------------------------------------------------------------

const CHROME_LAYER_ID = 'zen-chrome-layer'

/**
 * The one element popovers portal into: appended to `document.body` on first use, `fixed;
 * inset: 0` over the whole window and above everything in it (`.zen-chrome-layer` in main.css),
 * catching no pointer events of its own – each portal's subtree turns them back on. A page
 * surface (`data-surface="page"`): popovers and menus draw in the page family (§9.29).
 */
export function chromeLayer(): HTMLElement {
  let layer = document.getElementById(CHROME_LAYER_ID)
  if (!layer) {
    layer = document.createElement('div')
    layer.id = CHROME_LAYER_ID
    layer.className = 'zen-chrome-layer'
    layer.setAttribute('data-surface', 'page')
    document.body.appendChild(layer)
  }
  return layer
}

/**
 * Render into the chrome layer: for popovers, menus, toasts and anything anchored to chrome
 * outside the content frame. Children position themselves with `fixed` in viewport coordinates
 * (`useAnchorRect`, `placePopover` and `popoverStyle` give §9.20 geometry); the layer never sits
 * under a transform, so those coordinates hold. Pointer events are on inside the portal; a child
 * that must let the pointer through (a drag ghost) says so itself.
 *
 * Light dismiss is the layer's, not the popover's (§9.20 amended, `lib/popoverStore.ts`): a
 * popover calls `useLightDismiss(ref, onClose, { anchor })` once and draws no `fixed inset-0`
 * consumer of its own. One `pointerdown` listener, in the capture phase, closes every open
 * popover a press lands outside of and consumes the press – a second anchor's first press only
 * closes the open popover, the open anchor's own press closes without reopening, nothing under
 * the popover receives the press – and scroll, resize, another popover opening and a frame
 * dialog opening close it too. Escape stays with the popover, which returns focus to its anchor
 * (§9.22).
 *
 * Modal dialogs render in the content frame through FrameDialogHost (scrim dims the frame only).
 * Popovers, menus, toasts and anything anchored to chrome outside the frame render through
 * ChromePortal. Never position a dialog with `fixed` inside the frame.
 */
export function ChromePortal({ children }: { children: ReactNode }): JSX.Element {
  return createPortal(<div className="contents pointer-events-auto">{children}</div>, chromeLayer())
}

// ---------------------------------------------------------------------------
// Popover geometry (design-language-v2-draft §9.20)
// ---------------------------------------------------------------------------

/**
 * The three popover widths, chosen by content and never fitted to it: a list without trailing
 * controls, a notice or a single action; rows with trailing controls, forms and wrapping
 * descriptions; two columns or a table.
 */
export const POPOVER_WIDTH = { list: 320, form: 400, table: 480 } as const
export type PopoverWidth = (typeof POPOVER_WIDTH)[keyof typeof POPOVER_WIDTH]
/**
 * A popover's width: one of the three fixed values for chassis popovers, or the width a
 * content-sized surface measured for itself – a menu at its intrinsic 232–332 (§5), an
 * extension's manifest popup at the size it asks for (§9.20 exempts both from the fixed set).
 */
export type PopoverExtent = PopoverWidth | { measured: number }
/** How close a popover may come to the window's edges. */
export const POPOVER_MARGIN = 8
/** The least height a popover shrinks to before it flips to the other side of its bar. */
export const POPOVER_HEIGHT_FLOOR = 160

export interface Size {
  width: number
  height: number
}

interface PopoverBoxBase {
  left: number
  width: number
  /** The most the popover may be tall; its content decides the rest. */
  maxHeight: number
}

/**
 * Where a popover goes, in viewport coordinates, for a `fixed` element: `popoverStyle` turns it
 * into the inline style. Hanging below its bar it is pinned by `top` (flush with the bar's
 * bottom edge); flipped above, by `bottom` – the distance from the window's bottom to the bar's
 * top edge – so a popover shorter than `maxHeight` still ends on the bar.
 */
export type PopoverBox =
  | (PopoverBoxBase & { side: 'below'; top: number })
  | (PopoverBoxBase & { side: 'above'; bottom: number })

const extent = (width: PopoverExtent): number =>
  typeof width === 'number' ? width : width.measured

/**
 * Where a popover hanging from `anchor` goes, in viewport coordinates – §9.20's placement, in
 * order: flip, then slide, then shrink, against the window with an 8 px margin and never
 * against the bar or sidebar the anchor sits in.
 *
 * Horizontally: (1) start edges aligned with the anchor's box, or end edges when the anchor is
 * in the trailing half of `bar` – the bar or pill the anchor sits in (the anchor itself when it
 * stands alone); (2) a box that would cross the margin flips to the other alignment, still on
 * the anchor's edge (a right-hand sidebar's or a bar's last button grows the other way); (3) if
 * neither fits, the aligned box slides the least distance that does, so the popover keeps
 * overlapping the anchor's box and never detaches from what opened it; (4) a popover wider than
 * the window minus 16 shrinks to that and is centred.
 *
 * Vertically, the same order: below the bar, top edge flush with its bottom (gap 0), as tall as
 * `height` – the popover's own height when it is known (a menu's rows, a manifest popup's
 * document), capped only by the window minus 16 – or, with no `height`, up to 60% of the window
 * (a chassis popover's body scrolls under its title) and never more than the window minus 16.
 * When that would cross the bottom margin it flips above the bar (bottom edge flush with the
 * bar's top) when there is more room above than below, as Firefox flips panels near the bottom;
 * otherwise it stays below and shrinks to the room left – but never under `POPOVER_HEIGHT_FLOOR`:
 * a room shorter than that flips it above regardless. Whatever side, it never crosses the
 * window's margin.
 *
 * `width` is one of the three fixed widths for chassis popovers, or `{ measured }` for a menu or
 * a manifest-sized popup (`PopoverExtent`). Pure: pass `viewportSize()` for the window; compute
 * once on open and again when the anchor moves, never animate between positions.
 */
export function placePopover(
  anchor: Rect,
  bar: Rect,
  viewport: Size,
  width: PopoverExtent,
  height?: number
): PopoverBox {
  // (4) A window narrower than the popover plus the margins: the popover gives, centred.
  const w = Math.max(0, Math.min(extent(width), viewport.width - 2 * POPOVER_MARGIN))
  const minLeft = POPOVER_MARGIN
  const maxLeft = viewport.width - POPOVER_MARGIN - w
  const fits = (left: number): boolean => left >= minLeft && left <= maxLeft
  const start = anchor.x
  const end = anchor.x + anchor.width - w
  const trailing = anchor.x + anchor.width / 2 > bar.x + bar.width / 2
  const preferred = trailing ? end : start
  const flipped = trailing ? start : end
  let left: number
  if (fits(preferred)) left = preferred
  else if (fits(flipped)) left = flipped
  // (3) Slide the aligned box the least distance inside the margins. Inside the window this
  // still overlaps the anchor (otherwise the flipped alignment would have fit); an anchor off
  // the window's edge gets the nearest box there is.
  else left = Math.min(Math.max(minLeft, preferred), maxLeft)

  const edge = Math.max(0, viewport.height - 2 * POPOVER_MARGIN)
  const cap = height === undefined ? Math.min(viewport.height * 0.6, edge) : edge
  const wanted = Math.max(0, Math.min(height ?? cap, cap))
  const below = viewport.height - (bar.y + bar.height) - POPOVER_MARGIN
  const above = bar.y - POPOVER_MARGIN
  const side: PopoverBox['side'] =
    wanted <= below ? 'below' : above > below || below < POPOVER_HEIGHT_FLOOR ? 'above' : 'below'
  const maxHeight = Math.max(0, Math.min(wanted, side === 'below' ? below : above))
  return side === 'below'
    ? { side, left, top: bar.y + bar.height, width: w, maxHeight }
    : { side, left, bottom: viewport.height - bar.y, width: w, maxHeight }
}

/** The inline style that puts a popover where `placePopover` said, on a `fixed` element. */
export function popoverStyle(box: PopoverBox): CSSProperties {
  const style: CSSProperties = { left: box.left, width: box.width, maxHeight: box.maxHeight }
  if (box.side === 'below') style.top = box.top
  else style.bottom = box.bottom
  return style
}

/** The window's inner size, the `viewport` `placePopover` wants. */
export function viewportSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** A `DOMRect` as the plain rect the placement helpers take. */
export function toRect(r: DOMRect): Rect {
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * The viewport rect of the element `ref` points at – a popover's anchor – measured after layout
 * and again when it or the window resizes; null until it is on screen. Pair with `placePopover`.
 */
export function useAnchorRect(ref: RefObject<Element | null>): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      setRect(null)
      return
    }
    const measure = (): void => {
      const next = toRect(el.getBoundingClientRect())
      setRect((prev) => (prev && sameRect(prev, next) ? prev : next))
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [ref])
  return rect
}
