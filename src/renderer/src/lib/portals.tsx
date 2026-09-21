/* eslint-disable react-refresh/only-export-components -- a library module: the two layer components ship with the hooks and geometry that place surfaces in them */
import type { CSSProperties, JSX, ReactNode, RefObject } from 'react'
import {
  createContext,
  useCallback,
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
import { REDUCED_MOTION_FADE_MS, sheetBackPosition } from './motion/sheet'
import { SPRING_GENTLE, SpringAnimation, reducedMotion, type SpringConfig } from './motion/spring'
import { closeAllPopovers } from './popoverStore'
import { coverPageUnderSheet, holdFrameDialogCover, type SheetCover } from './ui'

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
 * How long a kept panel waits for the end of its exit animation before it goes regardless: an
 * animation that never reports its end (paused in a background window, or none running at all
 * where a stylesheet turned it off) must not keep the chrome inert and the page covered.
 */
const EXIT_TIMEOUT_MS = 600

/**
 * The panels of the dialogs a host has placed that are on their way out, and what settles them.
 * State the host renders (`exiting`) plus stable functions the host's `register` calls; nothing
 * here closes over a render.
 */
interface LeavingPanels {
  /** A dialog has just closed and its panel may be about to leave, or panels are on their way out. */
  exiting: boolean
  /**
   * A dialog with no chassis of its own registered: the page stays under its picture from here
   * until the way out is over (`holdFrameDialogCover`). Nothing on a host whose pose is not
   * this one's.
   */
  opened(): void
  /**
   * Such a dialog is unregistering: whatever leaves the slot by the host's next commit is kept
   * for the way out. Called before the panel goes (a layout cleanup runs before React removes
   * the subtree's DOM), so the slot still holds every panel to remember.
   */
  closing(): void
  /** A dialog registered: the way out is over at once, kept panels and all. */
  cancel(): void
}

/**
 * Watch for the end of `panel`'s exit animation (main.css `[data-leaving]`): the animation's
 * own end or cancel event on the panel itself – not one bubbling up from a descendant that
 * animates – or `EXIT_TIMEOUT_MS`, whichever first. Returns what stops watching.
 */
function watchExitEnd(panel: HTMLElement, onEnd: () => void): () => void {
  const end = (e: Event): void => {
    if (e.target === panel) onEnd()
  }
  panel.addEventListener('animationend', end)
  panel.addEventListener('animationcancel', end)
  const timer = setTimeout(onEnd, EXIT_TIMEOUT_MS)
  return () => {
    panel.removeEventListener('animationend', end)
    panel.removeEventListener('animationcancel', end)
    clearTimeout(timer)
  }
}

/**
 * DOM retention for the desktop host's way out. A dialog that returns `null` the moment its
 * state clears (the page's `alert`, the window's prompts, the bookmark dialogs) takes its panel
 * out of the slot at once, and the scrim's fade would run back over an empty slot. So the host
 * keeps the panel: as a dialog unregisters, the slot's children are remembered, and whichever
 * of them React has removed by the host's next commit is put back where it stood – the element
 * itself, with the state it had, not a copy – marked `data-leaving` (main.css runs the §9.5 pop
 * in reverse on it, 180 ms, and fades the scrim with it; the 120 ms fade in place under reduced
 * motion), `inert` and `aria-hidden` (§9.22: it takes no press and no focus, and is nothing to
 * assistive technology), until its exit animation ends (`EXIT_TIMEOUT_MS` regardless); then it
 * is removed for good. A dialog that registers meanwhile ends the way out at once, kept panels
 * and all, so a re-open never shows a stale panel under the new one; a dialog whose panel stays
 * as it unregisters (one going inactive on a form-factor change) keeps nothing. While a panel is
 * on its way out the host stays open for it: the chrome stays inert until the last panel is
 * gone, and the page stays under its picture (`holdFrameDialogCover`, held from the dialog's
 * open, since the flag that hid the page is for some dialogs the very state whose clearing
 * closes them), so the exit is seen and the core hands the page its focus back only once the
 * page shows again.
 *
 * This is the desktop pose only (`active`: the host is not on the sheet chassis). On a phone the
 * host's dialogs are sheets (§11.1) and their leave is the sheet chassis' to run – the slot's
 * slide down on its spring, the panel with it – so with `active` false nothing here keeps,
 * holds or marks anything: the slot's children are what React renders, and the host's `open`,
 * scrim and attributes follow its dialogs alone. Whatever was kept as `active` goes false (the
 * form factor changing mid-exit) is dropped at once. A sheet that draws the stack's one scrim
 * itself (`ownScrim`), and any layer on the sheet chassis already (`[data-sheet-layer]`), is
 * left out on either pose: it runs its own motion to the end before its state clears, and a
 * panel kept after that would stand still.
 */
function useLeavingPanels(slot: RefObject<HTMLElement | null>, active: boolean): LeavingPanels {
  const [exiting, setExiting] = useState(false)
  // Made once for the host's lifetime (a lazy ref, not a memo: `dispose` must run for this
  // very set of panels and no other), so `register` can be stable too. The pose is set from
  // the first render – a dialog's layout effect registers before the host's own effects run –
  // and followed from then on.
  const ref = useRef<LeavingPanelsControls | null>(null)
  const controls = (ref.current ??= leavingPanelsControls(slot, setExiting, active))
  useLayoutEffect(() => {
    controls.pose(active)
  }, [controls, active])
  // After every commit of the host: the one right after an unregister is where a panel that
  // left shows up missing.
  useLayoutEffect(() => {
    controls.collect()
  })
  useEffect(() => controls.dispose, [controls])
  return { exiting, opened: controls.opened, closing: controls.closing, cancel: controls.cancel }
}

interface LeavingPanelsControls extends Omit<LeavingPanels, 'exiting'> {
  /** The pose: `true` is the desktop's, which keeps; `false` (the sheet chassis) keeps nothing. */
  pose(active: boolean): void
  /** Whichever remembered panel React has removed by now is kept; the arming is spent. */
  collect(): void
  /** Unmounted: nothing left watching, the page released; the slot goes with the host. */
  dispose(): void
}

function leavingPanelsControls(
  slot: RefObject<HTMLElement | null>,
  setExiting: (exiting: boolean) => void,
  /** The desktop pose: the one that keeps. */
  active: boolean
): LeavingPanelsControls {
  /** Each kept panel, with what stops watching for its exit's end. */
  const kept = new Map<HTMLElement, () => void>()
  /** The slot's children as a dialog unregistered, each with the sibling after it; null when not armed. */
  let armed: Map<HTMLElement, Element | null> | null = null
  /** Dialogs without a chassis of their own placed with the host right now. */
  let placed = 0
  /** The page's cover, held from the first such dialog's open to the way out's end. */
  let cover: (() => void) | null = null

  /** The state the host renders, and the page let back once nothing is left to show. */
  const sync = (): void => {
    const exiting = armed !== null || kept.size > 0
    setExiting(exiting)
    if (exiting || placed > 0) return
    cover?.()
    cover = null
  }
  const drop = (panel: HTMLElement): void => {
    const stop = kept.get(panel)
    if (!stop) return
    kept.delete(panel)
    stop()
    panel.remove()
  }
  const dropAll = (): void => {
    for (const panel of [...kept.keys()]) drop(panel)
  }
  /** Put a removed panel back where it stood, marked for the way out, and watch for its end. */
  const keep = (panel: HTMLElement, next: Element | null): void => {
    const el = slot.current
    if (!el) return
    panel.setAttribute('data-leaving', '')
    panel.setAttribute('inert', '')
    panel.setAttribute('aria-hidden', 'true')
    el.insertBefore(panel, next && next.parentNode === el ? next : null)
    kept.set(
      panel,
      watchExitEnd(panel, () => {
        drop(panel)
        sync()
      })
    )
  }
  const controls: LeavingPanelsControls = {
    pose: (next) => {
      if (active === next) return
      active = next
      if (active) return
      // Not this pose's any more: whatever was kept or armed goes, the page with it.
      armed = null
      dropAll()
      sync()
    },
    opened: () => {
      placed++
      if (active) cover ??= holdFrameDialogCover()
    },
    closing: () => {
      placed = Math.max(0, placed - 1)
      const el = slot.current
      if (active && el) {
        const wanted = (armed ??= new Map())
        for (const child of el.children) {
          if (!(child instanceof HTMLElement) || child.hasAttribute('data-sheet-layer')) continue
          if (!kept.has(child) && !wanted.has(child)) wanted.set(child, child.nextElementSibling)
        }
      }
      sync()
    },
    cancel: () => {
      armed = null
      dropAll()
      sync()
    },
    collect: () => {
      const wanted = armed
      if (!wanted) return
      armed = null
      const el = slot.current
      if (el) for (const [panel, next] of wanted) if (panel.parentNode !== el) keep(panel, next)
      sync()
    },
    dispose: () => {
      armed = null
      for (const stop of kept.values()) stop()
      kept.clear()
      cover?.()
      cover = null
    }
  }
  return controls
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
 * (`[data-sheet-layer]`) runs its own track and does not count. A panel kept for the way down
 * (`data-leaving`) counts as it did; with no panel in the slot the last measure stands, so an
 * empty slot keeps its geometry; 0 with nothing ever measured.
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
 *
 * The sheet's leave outlives its dialogs' requests (§11.1: the store's `null` means "leave",
 * never "vanish"). A dialog's panel is rendered by its request and goes with it, in the commit
 * that clears it – the picker's Cancel, an alert the page dismissed, a prompt leaving `state` –
 * while the slot is only setting out on its way down; the chassis keeps the node: a panel its
 * owner takes out of the slot while the sheet is on its way down is put back where it stood,
 * `inert` and marked `data-leaving`, and rides the slide down until the spring lands at 0, when
 * it is dropped with the layer's release and the cover's (`retain`, on the slot's own
 * mutations; a sheet on its own chassis, `[data-sheet-layer]`, is left to `SheetPresence`). No
 * dialog grows a leaving phase of its own. The window chrome stays inert from the rise to the
 * landing, and focus returns then – not at the request's clearing – to the control that opened
 * the first dialog, if the panel's going left it nowhere (§9.22). A focus a dialog moves into
 * its panel while the slot still stands below the edge (its own effect, before the rise) never
 * scrolls the chrome to bring the panel into view: the ancestors' offsets are put back in the
 * same task. A dialog opening on the way down turns the spring round and takes the slot for
 * itself: what was kept for the way down is dropped there. Under reduced motion the way down
 * is the 120 ms fade in place, then the jump
 * (§11.3): the slot's and the scrim's opacity step to 0 on main.css's transition with the
 * panels still in the slot, and the spring jumps once the fade is over.
 */
function useSheetChassis(
  active: boolean,
  open: boolean,
  top: FrameDialogEntry | undefined,
  /** Takes (once) the control that had the focus as the first dialog registered, if any. */
  takeOpener: () => HTMLElement | null
): SheetChassis {
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
  /** Panels their owners took out of the slot on the way down, kept for it until the landing. */
  const kept = useRef<HTMLElement[]>([])
  /** The window chrome's inert hold, from the rise to the landing (`holdChromeInert`). */
  const chrome = useRef<(() => void) | null>(null)
  /** The reduced-motion fade on the way down (§11.3), until the spring's jump follows it. */
  const fade = useRef<number | null>(null)

  const paint = (): void => {
    const host = hostRef.current
    const scrim = scrimRef.current
    const slot = slotRef.current
    const q = layer.current
    // The spring overshoots a hair: the slide shows it, the opacities stop at their ends.
    const share = Math.min(1, Math.max(0, p.current))
    // The stack shows one scrim: this one's share (the registry's, from the same `p`) gives way
    // as a sheet above fades its own in. A reduced-motion fade on the way down is left alone by
    // a frame from the stack (another sheet moving).
    if (scrim && fade.current === null) scrim.style.opacity = q.scrim.toFixed(4)
    if (slot) {
      travel.current = slotTravel(slot, travel.current)
      // Below the edge at 0, the step to full opacity shows nothing (and under reduced motion,
      // where the spring has jumped the slot into place, main.css fades it in – §11.3).
      if (fade.current === null) slot.style.opacity = share > 0 ? '1' : '0'
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

  /** The panels kept for the way down go: the sheet has landed, or a dialog took the slot. */
  const drop = (): void => {
    for (const panel of kept.current) panel.remove()
    kept.current = []
  }

  /**
   * The slot's children changed: a panel taken out while the sheet is on its way down (nothing
   * wanted up, something of it still showing) is kept where it stood – before any sheet on its
   * own chassis, so it stays under one – until the landing drops it: `inert` and `aria-hidden`
   * (§9.22: it takes no press and no focus and is nothing to assistive technology), marked
   * `data-leaving` (the marking the pointer host's kept panel carries too). A panel that moved
   * (still connected) or a sheet on its own chassis is not the host's to keep.
   */
  const retain = (records: MutationRecord[]): void => {
    const slot = slotRef.current
    if (!slot || up.current || p.current <= 0) return
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement) || node.isConnected) continue
        if (node.hasAttribute('data-sheet-layer') || kept.current.includes(node)) continue
        node.setAttribute('inert', '')
        node.setAttribute('aria-hidden', 'true')
        node.setAttribute('data-leaving', '')
        const ownSheet = [...slot.children].find((c) => c.hasAttribute('data-sheet-layer')) ?? null
        slot.insertBefore(node, ownSheet)
        kept.current.push(node)
      }
    }
  }

  /**
   * The sheet has landed and the panels are gone: focus, if the panels' going left it nowhere
   * (or a kept panel still held it), returns to the control that opened the first dialog.
   */
  const returnFocus = (): void => {
    const to = takeOpener()
    if (!to?.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body && !hostRef.current?.contains(active)) return
    to.focus({ preventScroll: true })
  }

  /** Down and at rest: off the stack, the panels dropped, the chrome and the page back. */
  const landed = (): void => {
    recede.current?.release()
    recede.current = null
    leaving.current?.release()
    leaving.current = null
    drop()
    chrome.current?.()
    chrome.current = null
    reset()
    returnFocus()
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
        landed()
      }
    ))

  /** The reduced-motion fade is off: a dialog opened during it, or the chassis is going. */
  const dropFade = (): void => {
    if (fade.current === null) return
    window.clearTimeout(fade.current)
    fade.current = null
  }

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
    dropFade()
    recede.current?.release()
    recede.current = null
    cover.current?.release()
    cover.current = null
    leaving.current?.release()
    leaving.current = null
    drop()
    chrome.current?.()
    chrome.current = null
    takeOpener()
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
      // A dialog opening on the way down takes the slot: what was kept for the way down goes,
      // and a reduced-motion fade turns back into the slot as it stands.
      drop()
      dropFade()
      // On the stack from the open, above whatever is up already (§11.2), and painted at 0
      // before the first frame shows – the panel must not stand there before its rise. The
      // window chrome is inert from here to the landing (§9.5, §9.22).
      recede.current ??= registerRecedeLayer((frame) => {
        layer.current = frame
        paint()
      })
      chrome.current ??= holdChromeInert()
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
    // back when it lands (a host still waiting for its cover lands at once). The panels stay in
    // the slot for the way down (`retain`).
    if (cover.current) {
      leaving.current?.release()
      leaving.current = cover.current
      cover.current = null
    }
    backOrigin.current = null
    if (!recede.current) return
    if (reducedMotion() && p.current > 0) {
      // §11.3: the panels fade in place for 120 ms – the slot's and the scrim's opacity step to
      // 0 on main.css's transition – and the spring jumps once the fade is over.
      if (slotRef.current) slotRef.current.style.opacity = '0'
      if (scrimRef.current) scrimRef.current.style.opacity = '0'
      fade.current = window.setTimeout(() => {
        fade.current = null
        settleTo(0)
      }, REDUCED_MOTION_FADE_MS)
      return
    }
    settleTo(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refs besides `active` and `open`
  }, [active, open])

  // The slot's children are watched for as long as the host is a sheet: a panel taken out on
  // the way down is kept for it (`retain`). The records arrive after the commit that took the
  // panel out and before the frame paints, so nothing of the going shows.
  useEffect(() => {
    const slot = slotRef.current
    if (!active || !slot || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(retain)
    observer.observe(slot, { childList: true })
    return () => observer.disconnect()
  }, [active])

  // A focus moving into the slot while it stands below the frame's edge – a dialog's own effect
  // focusing its control before the rise (§9.22) – must not scroll the chrome to bring it into
  // view: the slide is the chassis' and the chrome never scrolls for it. `focus()` fires
  // `focusin` before it scrolls (the HTML focusing steps, then the scroll into view), so the
  // ancestors' offsets are read here and put back in a microtask, which runs before the frame
  // paints. Nothing inside the host is touched: a panel's own scroll container may scroll. A
  // layout effect, so the listener is on before any dialog's effect focuses, a dialog mounted
  // with the host included.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!active || !host) return
    const guard = (): void => {
      const offsets: Array<[Element, number, number]> = []
      for (let el = host.parentElement; el; el = el.parentElement) {
        offsets.push([el, el.scrollTop, el.scrollLeft])
      }
      queueMicrotask(() => {
        for (const [el, top, left] of offsets) {
          if (el.scrollTop !== top) el.scrollTop = top
          if (el.scrollLeft !== left) el.scrollLeft = left
        }
      })
    }
    host.addEventListener('focusin', guard)
    return () => host.removeEventListener('focusin', guard)
  }, [active])

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
 * a line of its own, and cannot leave them out.
 *
 * On a mouse the way out is the host's too (`useLeavingPanels`): a dialog that unmounts its
 * panel the moment its state clears leaves the panel with the host, which keeps the element in
 * the slot – `data-leaving`, `inert`, `aria-hidden` – through the §9.5 pop in reverse, the scrim
 * fading with it (main.css, 180 ms; the 120 ms fade under reduced motion), and drops it as the
 * animation ends. Until then the host is still up for it: `data-leaving` while no dialog is
 * left, so it keeps the pointer; the chrome stays inert until the last panel is gone; and the
 * page stays under its picture (`holdFrameDialogCover`, from the dialog's open). No dialog
 * needs to know: it returns `null` as it did. A dialog opening meanwhile ends the way out at
 * once.
 *
 * On a phone the way out is the sheet chassis' (§11.1: a phone dialog is a sheet, and a sheet's
 * leave outlives its request): `useLeavingPanels` keeps, holds and marks nothing for it –
 * `data-sheet` is the gate, on the host and in main.css, where the `[data-leaving]` pose rules
 * are the mouse's alone – and `useSheetChassis` keeps the panel instead: one its owner unmounts
 * as it closes – `useFrameDialog({ active })` going false with the node, or the node going with
 * its request – is put back in the slot, inert and marked `data-leaving`, for the way down, and
 * dropped when the spring lands (the chrome comes back and focus returns to the opener then,
 * §9.22); under reduced motion the way down is the 120 ms fade in place, then the drop (§11.3).
 * No dialog keeps a panel for its own leave on either pose. A sheet on its own chassis
 * (`BottomSheet`, `[data-sheet-layer]`) keeps its leave through `SheetPresence`
 * (lib/motion/presence.tsx), the same rule at a sheet boundary.
 *
 * A dialog that is a sheet on the chassis already – `BottomSheet` placed `hosted`, which drives
 * the recede and draws the stack's one scrim itself, fading with its motion (§9.24, §9.28) –
 * registers with `ownScrim`: the host draws no scrim of its own while it is on top, on a phone
 * its chassis stays down for it (the sheet is the chassis; two would recede the page twice),
 * and it keeps no panel for it: the sheet's motion is its own way out. `frame` marks the
 * frame's host (TabDialogs'): `FrameDialogPortal` reaches it from anywhere in the tree, for a
 * dialog whose state lives inside the content frame.
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
  const top = dialogs[dialogs.length - 1]
  const sheet = useViewport().formFactor === 'phone'
  // The host's own chassis runs for a dialog that has none; a sheet on the chassis already
  // (`ownScrim`) recedes the page, draws the scrim and answers the back gesture itself.
  const chassisOpen = dialogs.some((d) => !d.ownScrim)
  /** Dialogs registered right now (the state above, before it has rendered). */
  const registered = useRef(0)
  /**
   * The control that had the focus as the first dialog registered – before the dialog's own
   * effects moved it in – for the phone sheet to return it to once its leave has landed (§9.22).
   */
  const opener = useRef<HTMLElement | null>(null)
  const { hostRef, scrimRef, slotRef } = useSheetChassis(
    sheet,
    chassisOpen,
    top && !top.ownScrim ? top : undefined,
    () => {
      const to = opener.current
      opener.current = null
      return to
    }
  )
  // One callback for the host's lifetime: a ref callback made anew each render is detached
  // (set null) for the mutation phase of every commit, and a dialog unregistering in that very
  // phase from another subtree – one placed through `FrameDialogPortal` as the host re-renders –
  // would find no slot to remember the panels of.
  const setSlot = useCallback(
    (el: HTMLDivElement | null) => {
      slotRef.current = el
      setElement(el)
    },
    [slotRef]
  )
  // The way out is the host's on a mouse alone; on the sheet chassis it is the sheet's.
  const leaving = useLeavingPanels(slotRef, !sheet)
  const { opened, closing, cancel } = leaving
  const register = useCallback(
    (entry: FrameDialogEntry) => {
      if (registered.current++ === 0) {
        const active = document.activeElement
        opener.current =
          active instanceof HTMLElement && !active.closest('.zen-frame-dialogs') ? active : null
      }
      if (!entry.ownScrim) opened()
      cancel()
      setDialogs((list) => [...list, entry])
      return () => {
        registered.current--
        if (!entry.ownScrim) closing()
        setDialogs((list) => list.filter((d) => d !== entry))
      }
    },
    [opened, closing, cancel]
  )
  const api = useMemo<FrameDialogHostApi>(() => ({ register, element }), [register, element])
  useLayoutEffect(() => {
    if (!frame) return
    setFrameHost(api)
    return () => {
      if (frameHost === api) setFrameHost(null)
    }
  }, [frame, api])
  // The chrome is inert while a dialog is open (§9.5, §9.22). The host holds it for its own
  // dialogs on a mouse, and for their panels on the way out too: the chrome comes back when the
  // last one is gone. On a phone the sheet chassis holds it itself, from the rise to the landing
  // of its leave (`useSheetChassis`). Never for a sheet on the chassis already (`ownScrim`:
  // `BottomSheet` placed `hosted`), on either pose: it holds the chrome as a `BottomSheet` does,
  // and as it goes it releases that hold and then returns the focus to its opener, in the one
  // layout cleanup – a hold of the host's would still stand at that moment (the host's state
  // clears a commit later), the opener under it would refuse the focus, and focus would fall to
  // `body` (the 9.22 regression of the Settings pickers and every other hosted sheet).
  const holds = (!sheet && chassisOpen) || leaving.exiting
  useEffect(() => {
    if (!holds) return
    return holdChromeInert()
  }, [holds])
  // A dialog opening (or another stacking on it) is an open that is not a press on a popover:
  // it closes whatever popover is up (§9.20, one at a time).
  const count = dialogs.length
  const seen = useRef(0)
  useEffect(() => {
    if (count > seen.current) closeAllPopovers('all')
    seen.current = count
  }, [count])
  const showScrim = top !== undefined && !top.ownScrim
  // On a mouse the scrim leaves with the panels when it was up as the way out began; one that a
  // sheet's own scrim had already replaced on top is not brought back to fade. `scrimUp` is
  // whether the last render drew it, shown or leaving.
  const [scrimUp, setScrimUp] = useState(false)
  const scrimLeaving = !showScrim && leaving.exiting && scrimUp
  if (scrimUp !== (showScrim || scrimLeaving)) setScrimUp(showScrim || scrimLeaving)
  return (
    <FrameDialogHostContext.Provider value={api}>
      <div
        ref={hostRef}
        className="zen-frame-dialogs absolute inset-0 z-50"
        data-surface="page"
        data-open={top ? 'true' : undefined}
        data-leaving={!top && leaving.exiting ? 'true' : undefined}
        data-sheet={sheet ? 'true' : undefined}
      >
        {/* On a phone the scrim is always there, at nothing, and is written per frame with the
            chassis' progress: it has to outlast the last dialog by the way down. On a mouse it
            outlasts it by its fade (`data-leaving`). */}
        {(sheet || showScrim || scrimLeaving) && (
          <div
            ref={scrimRef}
            className={sheet ? 'zen-frame-scrim' : 'zen-frame-scrim zen-animate-in'}
            style={sheet ? { opacity: 0 } : undefined}
            data-leaving={!sheet && scrimLeaving ? 'true' : undefined}
            onPointerDown={() => top?.onScrimPress()}
          />
        )}
        <div ref={setSlot} className="zen-frame-dialogs-slot">
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
 * its panel, which the host centres above the scrim, and may unmount it the moment it closes –
 * on a mouse the host keeps the panel through its exit, on a phone the sheet chassis runs the
 * leave (see `FrameDialogHost`). `ownScrim` is for a sheet
 * that draws the stack's one scrim itself, fading with its motion (`BottomSheet` placed
 * `hosted`): the host then draws none while that sheet is on top, keeps its own chassis and
 * back surface down for it and no panel for it, and the sheet's scrim takes the press.
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
  const register = useContext(FrameDialogHostContext)?.register
  const latest = useRef(onScrimPress)
  useLayoutEffect(() => {
    latest.current = onScrimPress
  }, [onScrimPress])
  const dismissable = onScrimPress !== undefined
  useLayoutEffect(() => {
    if (!active || !register) return
    return register({ onScrimPress: () => latest.current?.(), ownScrim, dismissable })
  }, [active, register, ownScrim, dismissable])
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
   * Whether the 60%-of-window height cap applies (default true). `false` only for the surfaces
   * the spec exempts by name: an extension's manifest popup at its requested size (§9.20) and
   * a menu, which takes the room to the window's bottom margin and scrolls only past it (§6
   * "Menus": the app menu stands whole on an 800 px window) – both held by the window minus 16
   * alone.
   */
  capHeight?: boolean
  /**
   * The column a bar-less anchor stands in – its scroll container or the frame (lib/anchor.ts
   * `columnOf`): the anchor's half of it, not of `bar`, decides the alignment in (1), while the
   * popover still hangs from `bar` (the anchor's own box then). Without it an anchor that is its
   * own bar sits in neither half and always start-aligns.
   */
  column?: Rect
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
 * stands alone) – or, for an anchor standing alone, of `options.column`, the column it stands
 * in; (2) a box that would cross the margin flips to the other alignment, still on
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
  const half = options.column ?? bar
  const trailing = anchor.x + anchor.width / 2 > half.x + half.width / 2
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

  // The 60% cap holds for every chassis popover, an explicit height included: a known-height
  // panel shrinks to it and scrolls under its sticky title (§9.20). Only a surface the spec
  // exempts by name – an extension's manifest popup (§9.20), a menu (§6 "Menus") – opts out
  // with `capHeight: false` and is held by the window minus 16 alone.
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

/** Which side of its parent panel a cascaded panel stands on. */
export type BesideEdge = 'after' | 'before'

/**
 * The distance from a `.zen-v2-menu` panel's outer top edge to its first row: the 1 px border
 * and the menu's 6 px padding. A cascaded panel is offset by it so its first row lines up with
 * the row that opened it, as Chrome's and Firefox's submenus do.
 */
export const MENU_PANEL_INSET = 7

/**
 * `placePopover`'s cascade mode (§9.20): where a panel opened from a row of another panel goes –
 * a folder panel's sub-folder, a menu's submenu – in viewport coordinates for a `fixed` element
 * (`popoverStyle` turns it into the inline style). Flush against its parent panel's trailing
 * edge (gap 0), its first row on the row that opened it (`anchor`, `inset` above the row's
 * top). Against the window it follows the same order as a popover under a bar, with
 * `POPOVER_MARGIN`: a panel that would cross the trailing margin flips to the parent's leading
 * side; if neither side fits it slides the least distance inside the margins on the trailing
 * side, still overlapping its parent; wider than the window minus 16 it shrinks to that.
 * Vertically it starts on the row and, when it would cross the bottom margin, flips above – its
 * last row on the row's bottom – when there is more room above than below (or the room below is
 * under `POPOVER_HEIGHT_FLOOR`); otherwise it stays and shrinks to the room left, never taller
 * than the window minus 16. Pure: pass `viewportSize()` for the window. The bookmarks bar's
 * folder panels were the first caller (its local `placeBeside` folded in here in shell pass
 * 7(b)); `MenuSheet`'s flyout submenus are the second.
 */
export function placeBeside(
  anchor: Rect,
  parent: Rect,
  viewport: Size,
  size: Size,
  inset = MENU_PANEL_INSET
): PopoverBox & { edge: BesideEdge } {
  const width = Math.max(0, Math.min(size.width, viewport.width - 2 * POPOVER_MARGIN))
  const minLeft = POPOVER_MARGIN
  const maxLeft = viewport.width - POPOVER_MARGIN - width
  const fits = (left: number): boolean => left >= minLeft && left <= maxLeft
  const after = parent.x + parent.width
  const before = parent.x - width
  let edge: BesideEdge = 'after'
  let left: number
  if (fits(after)) left = after
  else if (fits(before)) {
    edge = 'before'
    left = before
  } else left = Math.min(Math.max(minLeft, after), Math.max(minLeft, maxLeft))

  const edgeRoom = Math.max(0, viewport.height - 2 * POPOVER_MARGIN)
  const wanted = Math.max(0, Math.min(size.height, edgeRoom))
  // Start-aligned: the panel's first row on the anchor row's top, never above the margin.
  // End-aligned: its last row on the row's bottom, never under the margin.
  const top = Math.max(POPOVER_MARGIN, anchor.y - inset)
  const bottom = Math.max(POPOVER_MARGIN, viewport.height - (anchor.y + anchor.height + inset))
  const below = Math.max(0, viewport.height - POPOVER_MARGIN - top)
  const above = Math.max(0, viewport.height - POPOVER_MARGIN - bottom)
  const side: PopoverBox['side'] =
    wanted <= below ? 'below' : above > below || below < POPOVER_HEIGHT_FLOOR ? 'above' : 'below'
  const maxHeight = Math.min(wanted, side === 'below' ? below : above)
  return side === 'below'
    ? { side, left, top, width, maxHeight, edge }
    : { side, left, bottom, width, maxHeight, edge }
}

/**
 * The pop's origin for a cascaded panel (design-language.md §7): it grows out of the row that
 * opened it, from the row's vertical centre on the panel's edge nearest its parent.
 */
export function besideOrigin(
  anchor: Rect,
  box: PopoverBox & { edge: BesideEdge },
  viewport: Size,
  height: number
): string {
  const top = box.side === 'below' ? box.top : viewport.height - box.bottom - height
  const y = Math.max(0, Math.min(height, anchor.y + anchor.height / 2 - top))
  return `${box.edge === 'after' ? '0' : '100%'} ${y}px`
}

/**
 * A `fixed` panel's box as laid out – its offsets, which ignore the transform the pop animation
 * scales it by, where the client rect on the animation's first frame would be 6% off. What
 * `placeBeside` takes for the parent panel.
 */
export function layoutRect(el: HTMLElement): Rect {
  return { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
}

/**
 * A panel's intrinsic size before `placePopover` pins it: the used width and height from the
 * computed style, which keep the fraction of a pixel the longest row's text runs to – the
 * offsets round it away, and a menu pinned to the rounded width (§5: a menu is as wide as its
 * longest row) puts an ellipsis on that very row – and, like the offsets, ignore the pop
 * animation's transform. Rounded up, so the pinned box never runs short of its content. Where
 * there is no layout (tests) the offsets stand in.
 */
export function intrinsicSize(el: HTMLElement): Size {
  const style = getComputedStyle(el)
  const width = parseFloat(style.width)
  const height = parseFloat(style.height)
  return {
    width: Number.isFinite(width) && width > 0 ? Math.ceil(width) : el.offsetWidth,
    height: Number.isFinite(height) && height > 0 ? Math.ceil(height) : el.offsetHeight
  }
}

/**
 * A row's box in the viewport, from its offsets inside the panel that holds it (`panel`, the
 * row's offset parent and its scroll container) and that panel's own `layoutRect`: the offsets
 * count from the panel's padding edge, so its border (`clientTop` / `clientLeft`) is added back.
 * What `placeBeside` takes for the anchor row.
 */
export function rowRect(row: HTMLElement, panel: HTMLElement, panelBox: Rect): Rect {
  return {
    x: panelBox.x + panel.clientLeft + row.offsetLeft,
    y: panelBox.y + panel.clientTop + row.offsetTop - panel.scrollTop,
    width: row.offsetWidth,
    height: row.offsetHeight
  }
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
