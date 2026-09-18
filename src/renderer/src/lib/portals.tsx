/* eslint-disable react-refresh/only-export-components -- a library module: the two layer components ship with the hooks and geometry that place surfaces in them */
import type { JSX, ReactNode, RefObject } from 'react'
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Rect } from '@shared/types'

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

/**
 * The layer modal dialogs render into: `absolute; inset: 0` over the box it is placed in (the
 * content frame on desktop, the whole shell on phones, where dialogs are sheets), its own
 * stacking context, taking the pointer only while a dialog is open. It draws the §9.5 scrim
 * (`--v2-scrim-modal`) and centres its children; several open at once stack, the last on top.
 *
 * Dialogs placed through it call `useFrameDialog` and render their panel as a child of the host,
 * in flow – never `fixed`, never with a scrim of their own. A phone sheet aligns itself with
 * `self-end justify-self-stretch`. A page surface: its root carries `data-surface="page"`, so
 * the dialogs' controls draw in the page family (§9.29).
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
  return (
    <FrameDialogHostContext.Provider value={api}>
      <div
        className="zen-frame-dialogs absolute inset-0 z-50"
        data-surface="page"
        data-open={top ? 'true' : undefined}
      >
        {top && (
          <div
            className="zen-frame-scrim zen-animate-in absolute inset-0"
            onMouseDown={() => top.onScrimPress()}
          />
        )}
        {children}
      </div>
    </FrameDialogHostContext.Provider>
  )
}

/**
 * Place the calling dialog through the nearest `FrameDialogHost`: while `active` the host shows
 * its scrim and takes the pointer, and a press on the scrim runs `onScrimPress` of the dialog on
 * top (omit it for a prompt the page waits on, which only its buttons and Escape answer).
 * Renders nothing itself: the dialog returns its panel, which the host centres.
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
 * (`useAnchorRect` and `placePopover` give §9.20 geometry); the layer never sits under a
 * transform, so those coordinates hold. Pointer events are on inside the portal; a child that
 * must let the pointer through (a drag ghost) says so itself.
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
/** How close a popover may come to the window's edges. */
export const POPOVER_MARGIN = 8

export interface Size {
  width: number
  height: number
}

export interface PopoverBox {
  left: number
  top: number
  width: number
  maxHeight: number
}

/**
 * Where a popover hanging from `anchor` goes, in viewport coordinates: its top border flush
 * with the bottom edge of `bar` – the bar or pill the anchor sits in (gap 0; the anchor itself
 * when it stands alone) – start edges aligned with the anchor's box, or end edges when the
 * anchor is in the trailing half of its bar; clamped `POPOVER_MARGIN` inside the window; and no
 * taller than 60% of the window, the window minus 16, or the room left below the bar.
 * Pure: pass `viewportSize()` for the window.
 */
export function placePopover(
  anchor: Rect,
  bar: Rect,
  viewport: Size,
  width: PopoverWidth
): PopoverBox {
  const trailing = anchor.x + anchor.width / 2 > bar.x + bar.width / 2
  let left = trailing ? anchor.x + anchor.width - width : anchor.x
  left = Math.min(Math.max(POPOVER_MARGIN, left), viewport.width - width - POPOVER_MARGIN)
  const top = bar.y + bar.height
  const maxHeight = Math.max(
    0,
    Math.min(viewport.height * 0.6, viewport.height - 16, viewport.height - top - POPOVER_MARGIN)
  )
  return { left, top, width, maxHeight }
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
