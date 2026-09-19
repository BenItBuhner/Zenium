/* eslint-disable react-refresh/only-export-components -- a library module: the two layer components ship with the hooks and geometry that place surfaces in them */
import type { CSSProperties, JSX, ReactNode, RefObject } from 'react'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { createPortal } from 'react-dom'
import type { Rect } from '@shared/types'
import { useBackSurface } from './back'
import { useViewport } from './formFactor'
import { registerRecedeLayer, type RecedeHandle, type RecedeLayerFrame } from './motion/recede'
import { sheetBackPosition } from './motion/sheet'
import { SPRING_GENTLE, SpringAnimation, type SpringConfig } from './motion/spring'
import { closeAllPopovers } from './popoverStore'
import { coverPageUnderSheet, type SheetCover } from './ui'

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
  /**
   * The dialog draws the stack's one scrim itself – a sheet whose scrim fades with its own
   * motion (§9.24, §9.28) – so the host draws none while it is on top, and on a phone keeps its
   * own chassis down for it (the sheet is on the chassis already).
   */
  ownScrim: boolean
  /**
   * Whether the dialog gave a scrim handler at all: a dialog that did is light-dismissable, and
   * on a phone the sheet chassis answers the system back gesture for it the way the scrim
   * press does. A prompt without one keeps its own back handling (`useBackSurface`).
   */
  dismissable: boolean
}

interface FrameDialogHostApi {
  register: (entry: FrameDialogEntry) => () => void
  /** The host's slot, once mounted: what `FrameDialogPortal` renders into. */
  element: HTMLElement | null
}

const FrameDialogHostContext = createContext<FrameDialogHostApi | null>(null)

/*
 * The frame's own host – the one TabDialogs mounts over the content frame (the shell on
 * phones) – published for `FrameDialogPortal`, which a dialog whose state lives inside the
 * frame (a page's or panel's sheets, the new tab page's customise sheet) reaches from outside
 * every host's subtree.
 */
let frameHost: FrameDialogHostApi | null = null
const frameHostListeners = new Set<() => void>()

function setFrameHost(api: FrameDialogHostApi | null): void {
  frameHost = api
  for (const listener of frameHostListeners) listener()
}

function subscribeFrameHost(listener: () => void): () => void {
  frameHostListeners.add(listener)
  return () => frameHostListeners.delete(listener)
}

/**
 * The window chrome roots: what goes inert while a frame dialog or a sheet is open (§9.5,
 * §9.22). On a mouse, the window surfaces (§9.29: the toolbar, the sidebar, the bookmarks bar);
 * on a phone, the shell's chrome under its sheets – the content column, the messages, the bar,
 * the pill's stage, the drawer, the tabs menu – each marked `data-shell-chrome` where it is
 * rendered (PhoneShell and the phone components), never the shell itself, which the frame
 * dialog host and its sheets sit inside. (Not `data-window-chrome`: that is the desktop root's
 * window-frame mode, and marking the root would make its own dialogs inert.)
 */
const WINDOW_CHROME_ROOTS = '[data-surface="window"], [data-shell-chrome]'
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
 * them; §9.22: nothing focusable is left behind a sheet's scrim) until the returned release
 * runs. Holds nest: the chrome comes back when the last one is released. The roots are the
 * `WINDOW_CHROME_ROOTS` outside the dialog hosts and the chrome layer, including any mounted
 * while the hold lasts (a compact-mode sidebar revealed under a prompt); an element that was
 * inert already is left to whoever made it so. The frame dialog host holds while it has a
 * dialog, and every `BottomSheet` holds while it is up, so a sheet on the phone shell and one
 * inside the host are one mechanism.
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
 * The sheet spring for a 0…1 progress: `SPRING_GENTLE`'s motion, its rest thresholds – set in
 * px for a sheet that travels some 400 px – scaled to the unit, so the value settles to within
 * a thousandth instead of snapping the last 40 % of the way.
 */
export const SHEET_PROGRESS_SPRING: SpringConfig = {
  ...SPRING_GENTLE,
  restDelta: 0.001,
  restSpeed: 0.02
}

const LAYER_AT_REST: RecedeLayerFrame = { recede: 0, scrim: 0, inert: false }

interface SheetChassis {
  hostRef: RefObject<HTMLDivElement | null>
  scrimRef: RefObject<HTMLDivElement | null>
  slotRef: RefObject<HTMLDivElement | null>
}

/**
 * How far (px) the host's slot travels between closed and resting: the sheet's full height
 * across the frame's bottom edge (§11.1: `p` is a surface's progress over its own travel, and a
 * phone dialog is a §9.23 sheet), measured as the distance from the top edge of the highest
 * panel in the slot to the slot's bottom edge, so at 0 nothing of any panel is above the edge
 * and at 1 the panels stand where they are laid out. A sheet on its own chassis
 * (`[data-sheet-layer]`) runs its own track and does not count. With no panel in the slot (the
 * way down after the last dialog has gone) the last measure stands, so the empty slot keeps
 * its geometry; 0 with nothing ever measured.
 */
function slotTravel(slot: HTMLElement, last: number): number {
  let top = Infinity
  for (const child of slot.children) {
    if (!(child instanceof HTMLElement) || child.hasAttribute('data-sheet-layer')) continue
    top = Math.min(top, child.offsetTop)
  }
  return top === Infinity ? last : Math.max(0, slot.clientHeight - top)
}

/**
 * The host as a phone sheet on the recede chassis (design language v2 draft §11.1, §11.5): one
 * progress value `p`, run 0 → 1 on `SPRING_GENTLE` when a dialog opens and back to 0 when the
 * last one closes, is the scrim's opacity, the slot's slide over its full height across the
 * frame's bottom edge (`slotTravel`; a phone dialog is a §9.23 sheet and slides like one, the
 * desktop dialog keeps its 24 px pop) and – through the recede registry – the page's recede and
 * the bottom bar's fade; a sheet above recedes the slot and makes it inert like any lower sheet
 * (§11.2). The sheet holds the page under its cover for as long as anything of it shows
 * (`coverPageUnderSheet`): the dialogs it hosts mount before they capture the page and set
 * their own flag, and drop that flag the moment they go, so the sheet captures the page itself
 * before it rises, waits for the live page to have given way to its picture (the recede never
 * starts on a page about to be swapped), and lets the page back only once the spring has landed
 * at 0 (the page comes back at the transform it left at). Everything is written straight to the
 * three elements the returned refs are put on; React renders none of it. While anything of the
 * sheet shows the host carries `data-sheet-up` (main.css: it takes the pointer, so a press
 * during the way down lands on the scrim and not on the page under it). Under reduced motion
 * the spring jumps: the slot arrives in place and its opacity steps 0 → 1, which main.css
 * turns into the 120 ms fade of §11.3 (as it does the scrim's, both ways).
 *
 * The system back gesture (#24) drives the same `p` while the dialog on top is dismissable: the
 * finger peeks the sheet down its track (`sheetBackPosition`, as `SheetMotion` does), the page
 * coming back with it; letting go before the threshold springs it back to 1, and a commit – or
 * the back button – is the scrim press, so the same spring runs everything down from where the
 * finger left it. A prompt that gave no scrim handler is left to its own `useBackSurface`.
 */
function useSheetChassis(active: boolean, open: boolean, top?: FrameDialogEntry): SheetChassis {
  const hostRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const p = useRef(0)
  const layer = useRef<RecedeLayerFrame>(LAYER_AT_REST)
  const recede = useRef<RecedeHandle | null>(null)
  /** The page's cover, held from before the rise; `leaving` while the spring runs it back down. */
  const cover = useRef<SheetCover | null>(null)
  const leaving = useRef<SheetCover | null>(null)
  const spring = useRef<SpringAnimation | null>(null)
  /** Whether the chassis is wanted up (the latest `open`, for the spring's rest). */
  const up = useRef(false)
  /** Where the back gesture caught the sheet; null while no finger holds it. */
  const backOrigin = useRef<number | null>(null)
  /** The slot's travel (px) as last measured (`slotTravel`). */
  const travel = useRef(0)

  const paint = (): void => {
    const host = hostRef.current
    const scrim = scrimRef.current
    const slot = slotRef.current
    const q = layer.current
    // The spring overshoots a hair: the slide shows it, the opacities stop at their ends.
    const share = Math.min(1, Math.max(0, p.current))
    // The stack shows one scrim: this one's share (the registry's, from the same `p`) gives way
    // as a sheet above fades its own in.
    if (scrim) scrim.style.opacity = q.scrim.toFixed(4)
    if (slot) {
      travel.current = slotTravel(slot, travel.current)
      // Below the edge at 0, the step to full opacity shows nothing (and under reduced motion,
      // where the spring has jumped the slot into place, main.css fades it in – §11.3).
      slot.style.opacity = share > 0 ? '1' : '0'
      slot.style.transform = `translate3d(0, ${((1 - p.current) * travel.current).toFixed(2)}px, 0) scale(var(--zen-layer-scale, 1))`
      slot.style.setProperty('--zen-layer-recede', q.recede.toFixed(4))
      slot.toggleAttribute('inert', q.inert)
    }
    // Nothing of it shows at 0 (the wait for the page's cover): nothing of it takes a press.
    if (host) host.toggleAttribute('data-sheet-up', p.current > 0)
  }

  /**
   * Nothing of the chassis left on the elements: the slot is shown as rendered again (a sheet
   * that brings its own chassis may be placed in it next), the scrim at nothing.
   */
  const reset = (): void => {
    const scrim = scrimRef.current
    if (scrim) scrim.style.opacity = '0'
    const slot = slotRef.current
    if (slot) {
      slot.style.removeProperty('opacity')
      slot.style.removeProperty('transform')
      slot.style.removeProperty('--zen-layer-recede')
      slot.removeAttribute('inert')
    }
    hostRef.current?.removeAttribute('data-sheet-up')
  }

  const motion = (): SpringAnimation =>
    (spring.current ??= new SpringAnimation(
      SHEET_PROGRESS_SPRING,
      (x) => {
        p.current = x
        recede.current?.progress(x)
        paint()
      },
      (x) => {
        // Down and at rest, and nothing has opened meanwhile (a dialog that opened on the way
        // down keeps the layer and the cover; its rise comes once the page is covered): off the
        // stack, and the page may come back.
        if (x > 0 || up.current) return
        recede.current?.release()
        recede.current = null
        leaving.current?.release()
        leaving.current = null
        reset()
      }
    ))

  /**
   * Run `p` to `target` on the spring from wherever it is: a motion in flight keeps its
   * velocity, a value a finger left (the spring stopped) starts from rest there.
   */
  const settleTo = (target: number): void => {
    const m = motion()
    if (m.running) m.retarget(target)
    else m.start(p.current, 0, target)
  }

  // The back gesture over a dismissable dialog: the finger holds `p` where the spring is
  // frozen, cancel springs it back, commit is the scrim press (the close path runs the spring
  // down from where the finger left it).
  useBackSurface(
    active && open && top?.dismissable
      ? {
          name: 'frame-sheet',
          onStart: () => {
            motion().stop()
            backOrigin.current = p.current
          },
          onProgress: (progress) => {
            motion().stop()
            backOrigin.current ??= p.current
            p.current = sheetBackPosition(backOrigin.current, progress)
            recede.current?.progress(p.current)
            paint()
          },
          onCancel: () => {
            backOrigin.current = null
            settleTo(1)
          },
          onCommit: () => {
            backOrigin.current = null
            top.onScrimPress()
          }
        }
      : null
  )

  const clear = (): void => {
    spring.current?.stop()
    recede.current?.release()
    recede.current = null
    cover.current?.release()
    cover.current = null
    leaving.current?.release()
    leaving.current = null
    p.current = 0
    backOrigin.current = null
    layer.current = LAYER_AT_REST
    reset()
    // Not a sheet (or gone): the scrim, if any, is the desktop's, drawn as rendered.
    scrimRef.current?.style.removeProperty('opacity')
  }

  useLayoutEffect(() => {
    up.current = active && open
    if (!active) {
      clear()
      return
    }
    if (open) {
      // On the stack from the open, above whatever is up already (§11.2), and painted at 0
      // before the first frame shows – the panel must not stand there before its rise.
      recede.current ??= registerRecedeLayer((frame) => {
        layer.current = frame
        paint()
      })
      paint()
      if (cover.current) return
      // The cover is taken once per stay on screen: a dialog opening on the way down keeps the
      // one being let go of, and the spring turns round where it is.
      const c = leaving.current ?? coverPageUnderSheet()
      leaving.current = null
      cover.current = c
      void c.promise.then(() => {
        if (cover.current !== c) return
        settleTo(1)
      })
      return
    }
    // The last dialog went: the same spring runs the scrim and the recede back to 0, from
    // wherever they are – mid-rise, or where a back gesture left the sheet – and lets the page
    // back when it lands (a host still waiting for its cover lands at once).
    if (cover.current) {
      leaving.current?.release()
      leaving.current = cover.current
      cover.current = null
    }
    backOrigin.current = null
    if (recede.current) settleTo(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refs besides `active` and `open`
  }, [active, open])

  // Unmounted (the shell changed): no frame writes into a gone tree, the page is released.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `clear` touches refs only; once, at unmount
  useEffect(() => clear, [])

  return { hostRef, scrimRef, slotRef }
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
 * On a phone the host is a sheet on the recede chassis (`data-sheet`, `useSheetChassis`,
 * v2 draft §11): its scrim is the sheet scrim at the sheet's progress, the slot slides in over
 * its panels' full height from the frame's bottom edge and the page recedes on the same spring,
 * all reversed on close – a dialog placed through it inherits the slide and the recede without
 * a line of its own, and cannot leave them out. (A dialog's panel is the surface's to keep: one
 * that unmounts it the moment it closes leaves the scrim and the recede to run back alone.)
 *
 * A dialog that is a sheet on the chassis already – `BottomSheet` placed `hosted`, which drives
 * the recede and draws the stack's one scrim itself, fading with its motion (§9.24, §9.28) –
 * registers with `ownScrim`: the host draws no scrim of its own while it is on top, and on a
 * phone its chassis stays down for it (the sheet is the chassis; two would recede the page
 * twice). `frame` marks the frame's host (TabDialogs'): `FrameDialogPortal` reaches it from
 * anywhere in the tree, for a dialog whose state lives inside the content frame.
 *
 * Modal dialogs render in the content frame through FrameDialogHost (scrim dims the frame only).
 * Popovers, menus, toasts and anything anchored to chrome outside the frame render through
 * ChromePortal. Never position a dialog with `fixed` inside the frame.
 */
export function FrameDialogHost({
  children,
  frame = false
}: {
  children?: ReactNode
  frame?: boolean
}): JSX.Element {
  const [dialogs, setDialogs] = useState<FrameDialogEntry[]>([])
  const [element, setElement] = useState<HTMLElement | null>(null)
  const api = useMemo<FrameDialogHostApi>(
    () => ({
      register: (entry) => {
        setDialogs((list) => [...list, entry])
        return () => setDialogs((list) => list.filter((d) => d !== entry))
      },
      element
    }),
    [element]
  )
  useLayoutEffect(() => {
    if (!frame) return
    setFrameHost(api)
    return () => {
      if (frameHost === api) setFrameHost(null)
    }
  }, [frame, api])
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
  const sheet = useViewport().formFactor === 'phone'
  // The host's own chassis runs for a dialog that has none; a sheet on the chassis already
  // (`ownScrim`) recedes the page, draws the scrim and answers the back gesture itself.
  const chassisOpen = dialogs.some((d) => !d.ownScrim)
  const { hostRef, scrimRef, slotRef } = useSheetChassis(
    sheet,
    chassisOpen,
    top && !top.ownScrim ? top : undefined
  )
  return (
    <FrameDialogHostContext.Provider value={api}>
      <div
        ref={hostRef}
        className="zen-frame-dialogs absolute inset-0 z-50"
        data-surface="page"
        data-open={top ? 'true' : undefined}
        data-sheet={sheet ? 'true' : undefined}
      >
        {/* On a phone the scrim is always there, at nothing, and is written per frame with the
            chassis' progress: it has to outlast the last dialog by the way down. */}
        {(sheet || (top && !top.ownScrim)) && (
          <div
            ref={scrimRef}
            className={sheet ? 'zen-frame-scrim' : 'zen-frame-scrim zen-animate-in'}
            style={sheet ? { opacity: 0 } : undefined}
            onPointerDown={() => top?.onScrimPress()}
          />
        )}
        <div
          ref={(el) => {
            slotRef.current = el
            setElement(el)
          }}
          className="zen-frame-dialogs-slot"
        >
          {children}
        </div>
      </div>
    </FrameDialogHostContext.Provider>
  )
}

/**
 * Place the calling dialog through the nearest `FrameDialogHost`: while `active` the host shows
 * its scrim, makes the window chrome inert and takes the pointer, and a press on the scrim – on
 * `pointerdown`, mouse, touch or pen alike – runs `onScrimPress` of the dialog on top (omit it
 * for a prompt the page waits on, which only its buttons and Escape answer). On a phone the
 * host's sheet answers the system back gesture for a dialog that gave one, the same way (#24):
 * the finger peeks the sheet and un-recedes the page, a commit runs `onScrimPress`; a prompt
 * without one registers its own `useBackSurface`. Renders nothing itself: the dialog returns
 * its panel, which the host centres above the scrim. `ownScrim` is for a sheet that draws the
 * stack's one scrim itself, fading with its motion (`BottomSheet` placed `hosted`): the host
 * then draws none while that sheet is on top, keeps its own chassis and back surface down for
 * it, and the sheet's scrim takes the press.
 *
 * Modal dialogs render in the content frame through FrameDialogHost (scrim dims the frame only).
 * Popovers, menus, toasts and anything anchored to chrome outside the frame render through
 * ChromePortal. Never position a dialog with `fixed` inside the frame.
 */
export function useFrameDialog({
  onScrimPress,
  active = true,
  ownScrim = false
}: { onScrimPress?: () => void; active?: boolean; ownScrim?: boolean } = {}): void {
  const host = useContext(FrameDialogHostContext)
  const latest = useRef(onScrimPress)
  useLayoutEffect(() => {
    latest.current = onScrimPress
  }, [onScrimPress])
  const dismissable = onScrimPress !== undefined
  useLayoutEffect(() => {
    if (!active || !host) return
    return host.register({ onScrimPress: () => latest.current?.(), ownScrim, dismissable })
  }, [active, host, ownScrim, dismissable])
}

/**
 * Render a dialog into a `FrameDialogHost` from anywhere in the tree: the nearest host when
 * there is one above, else the frame's (`FrameDialogHost frame`, which TabDialogs mounts). For
 * a dialog whose state lives inside the content frame – a page's or a panel's sheets, opened by
 * its rows – which must still mount in the host, over the frame, not inside the frame's
 * transform. It portals into the host's slot, above the scrim, and the children are the host's
 * for `useFrameDialog` too, so they register with the host they render in. Renders nothing
 * until the host has mounted.
 *
 * Modal dialogs render in the content frame through FrameDialogHost (scrim dims the frame only).
 * Popovers, menus, toasts and anything anchored to chrome outside the frame render through
 * ChromePortal. Never position a dialog with `fixed` inside the frame.
 */
export function FrameDialogPortal({ children }: { children: ReactNode }): JSX.Element | null {
  const nearest = useContext(FrameDialogHostContext)
  const frame = useSyncExternalStore(subscribeFrameHost, () => frameHost)
  const host = nearest ?? frame
  if (!host?.element) return null
  return createPortal(
    <FrameDialogHostContext.Provider value={host}>{children}</FrameDialogHostContext.Provider>,
    host.element
  )
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

/** Which of the anchor's edges a popover's own edge lines up with (§9.20's horizontal order). */
export type PopoverAlignment = 'start' | 'end'

export interface PlacePopoverOptions {
  /**
   * Whether the 60%-of-window height cap applies (default true). `false` only for the surface
   * §9.20 exempts by name: an extension's manifest popup at its requested size, capped by the
   * window minus 16 alone.
   */
  capHeight?: boolean
}

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
 * document) – or, with no `height`, as tall as its content; either way up to 60% of the window
 * (the body scrolls under its sticky title) and never more than the window minus 16.
 * When that would cross the bottom margin it flips above the bar (bottom edge flush with the
 * bar's top) when there is more room above than below, as Firefox flips panels near the bottom;
 * otherwise it stays below and shrinks to the room left – but never under `POPOVER_HEIGHT_FLOOR`:
 * a room shorter than that flips it above regardless. Whatever side, it never crosses the
 * window's margin.
 *
 * `width` is one of the three fixed widths for chassis popovers, or `{ measured }` for a menu or
 * a manifest-sized popup (`PopoverExtent`). Pure: pass `viewportSize()` for the window; compute
 * once on open and again when the anchor moves, never animate between positions.
 *
 * `preferredAlignment` is §9.20's continuity clause: "a surface opened from another surface on
 * the same anchor – an extension's popup from the puzzle panel, a submenu's panel from its menu
 * – inherits its predecessor's alignment when that alignment fits, and falls back to the order
 * only when it does not, so the eye stays where the first surface was instead of jumping across
 * the anchor." Pass the predecessor's resolved `alignment` (returned with every box); without
 * it the anchor's half of the bar decides, as in (1).
 */
export function placePopover(
  anchor: Rect,
  bar: Rect,
  viewport: Size,
  width: PopoverExtent,
  height?: number,
  preferredAlignment?: PopoverAlignment,
  options: PlacePopoverOptions = {}
): PopoverBox & { alignment: PopoverAlignment } {
  // (4) A window narrower than the popover plus the margins: the popover gives, centred.
  const w = Math.max(0, Math.min(extent(width), viewport.width - 2 * POPOVER_MARGIN))
  const minLeft = POPOVER_MARGIN
  const maxLeft = viewport.width - POPOVER_MARGIN - w
  const fits = (left: number): boolean => left >= minLeft && left <= maxLeft
  const at = { start: anchor.x, end: anchor.x + anchor.width - w }
  const trailing = anchor.x + anchor.width / 2 > bar.x + bar.width / 2
  const preferred: PopoverAlignment = preferredAlignment ?? (trailing ? 'end' : 'start')
  const flipped: PopoverAlignment = preferred === 'start' ? 'end' : 'start'
  let alignment: PopoverAlignment = preferred
  let left: number
  if (fits(at[preferred])) left = at[preferred]
  else if (fits(at[flipped])) {
    alignment = flipped
    left = at[flipped]
  }
  // (3) Slide the aligned box the least distance inside the margins. Inside the window this
  // still overlaps the anchor (otherwise the flipped alignment would have fit); an anchor off
  // the window's edge gets the nearest box there is.
  else left = Math.min(Math.max(minLeft, at[preferred]), maxLeft)

  // The 60% cap holds for every chassis popover, an explicit height included: a long menu or a
  // known-height panel shrinks to it and scrolls under its sticky title (§9.20). Only a surface
  // §9.20 exempts by name – an extension's manifest popup, its own document – opts out with
  // `capHeight: false` and is held by the window minus 16 alone.
  const edge = Math.max(0, viewport.height - 2 * POPOVER_MARGIN)
  const cap = options.capHeight === false ? edge : Math.min(viewport.height * 0.6, edge)
  const wanted = Math.max(0, Math.min(height ?? cap, cap))
  const below = viewport.height - (bar.y + bar.height) - POPOVER_MARGIN
  const above = bar.y - POPOVER_MARGIN
  const side: PopoverBox['side'] =
    wanted <= below ? 'below' : above > below || below < POPOVER_HEIGHT_FLOOR ? 'above' : 'below'
  const maxHeight = Math.max(0, Math.min(wanted, side === 'below' ? below : above))
  return side === 'below'
    ? { side, left, top: bar.y + bar.height, width: w, maxHeight, alignment }
    : { side, left, bottom: viewport.height - bar.y, width: w, maxHeight, alignment }
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
