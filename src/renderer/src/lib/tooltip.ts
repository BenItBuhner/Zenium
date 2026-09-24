import type { Rect } from '@shared/types'
import { insideTopPopover, openPopoverCount } from './popoverStore'
import { chromeInertHeld, insideFrameDialog, POPOVER_MARGIN, type Size } from './portals'
import { createStore } from './store'
import { HOVER_CARD_HIDDEN, overlayCoversContent, uiStore } from './ui'

/**
 * The chrome tooltip (design-language-v2-draft §9.31, a11y-26): a control's name and its
 * shortcut – "Back (Alt+←)" – on a plain panel 8 px from the control, shown once the pointer
 * has rested on the control for `TOOLTIP_DELAY`, or at once when keyboard focus lands on it
 * (`:focus-visible`), and gone when the pointer leaves, focus leaves, a press lands, or Escape
 * is pressed – a key the tooltip never consumes: it goes on to whatever it is for the control
 * (Stop, the find bar's Close, the popups' Escape stack `useEscape`, the chrome's Escape in
 * `useGlobalKeys`) in the one press, the tooltip having gone with it. One at a time, and never
 * beside other chrome: while a popover, menu or dialog has the window no tooltip shows for a
 * control outside it – the toolbar under an open bubble, the anchor that opened it – and the
 * surface's own controls keep theirs (`tooltipBlocked`): §9.31's "never while a popover is up"
 * is the hover card's sentence; plain tooltips are the platform's, which names a bubble's Pause
 * as it names a toolbar's Back, and one vocabulary asks that the name be the chrome's tooltip,
 * which a tooltip that never showed is not.
 *
 * A control takes the tooltip by carrying its text in `data-tooltip` (`TOOLTIP_ATTR`) in place
 * of a native `title`; its accessible name stays its own (`aria-label`, or its content). The
 * one host (`components/Tooltip.tsx`) listens on the document, so a control needs no handler
 * of its own and the text may change under the pointer (Reload becoming Stop). While the
 * tooltip is up the control is `aria-describedby` it (`TOOLTIP_ID`).
 *
 * Mouse and keyboard only (§9.31): a touch or pen pointer resting on a control shows nothing,
 * and the host is the desktop shell's – the phone and tablet chrome carries the attribute inertly.
 */
export const TOOLTIP_ATTR = 'data-tooltip'
export const TOOLTIP_ID = 'zen-tooltip'
/**
 * Chrome drawn in the gaps between the page views – a split pane's header (SplitChrome) –
 * carries this on its root: a tooltip for a control inside it never puts the page under its
 * picture (`holdFloatingChrome`), because the gap chrome goes with the page when the page is
 * hidden (ContentArea mounts SplitChrome only while the content shows), and the control would
 * leave the DOM under its own tooltip – the tooltip going with it, the page flashing back, the
 * control returning, and round again. Such a tooltip shows where it misses the page
 * (`placeTooltip` takes the clear side first) and stays hidden where it cannot.
 */
export const TOOLTIP_NO_COVER_ATTR = 'data-tooltip-no-cover'
/**
 * How long the pointer rests on a control before its tooltip shows: §9.31 as amended – 500 ms,
 * the platform's (Chrome's views, GTK, Windows and Firefox share the number; the draft's 600 was
 * the lead's own and is corrected).
 */
export const TOOLTIP_DELAY = 500
/** The tooltip's distance from its control's box. */
export const TOOLTIP_GAP = 8
/**
 * GTK's browse mode: for this long after a tooltip went with the pointer leaving its control,
 * the next control the pointer reaches shows its own without the wait – the row of toolbar
 * buttons read one after another, as Chrome's and GTK's do.
 */
export const TOOLTIP_BROWSE = 500

export type TooltipCause = 'pointer' | 'focus'

export interface TooltipState {
  /** The control the tooltip is up for; null while none is. */
  target: HTMLElement | null
  /** What put it up: the pointer resting on the control, or keyboard focus landing on it. */
  by: TooltipCause | null
}

export const TOOLTIP_HIDDEN: TooltipState = { target: null, by: null }

/** What the controller reads and writes: the app's `tooltipStore`, or a plain store in tests. */
export interface TooltipStore {
  get(): TooltipState
  set(next: TooltipState): void
}

export interface TooltipOptions {
  /**
   * Whether other chrome has the window right now, seen from the control asking – a popover,
   * a menu, a dialog the control is not inside, a drag: no tooltip shows for the control while
   * it says so (checked when the pointer arrives, when focus lands, and again when the delay
   * has run), and what was on its way is dropped.
   */
  blocked?: (target: HTMLElement) => boolean
  delay?: number
  browse?: number
  /** The clock, for the browse window; `performance.now` outside tests. */
  now?: () => number
}

/**
 * The tooltip's timing, kept out of React: a pending control and its timer, the control shown,
 * the browse window after a leave, and the control a press or Escape silenced until the pointer
 * leaves it (Chrome's: a clicked button's tooltip does not come back under the still pointer).
 */
export class TooltipController {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The control a tooltip is on its way to, waiting out the delay. */
  private pending: HTMLElement | null = null
  /** The control whose pointer tooltip a press or Escape took down; nothing shows for it until the pointer leaves. */
  private silenced: HTMLElement | null = null
  /** Until when the browse window is open (`TOOLTIP_BROWSE` after a pointer leave). */
  private browseUntil = 0
  private readonly blocked: (target: HTMLElement) => boolean
  private readonly delay: number
  private readonly browse: number
  private readonly now: () => number

  constructor(
    private readonly store: TooltipStore,
    options: TooltipOptions = {}
  ) {
    this.blocked = options.blocked ?? (() => false)
    this.delay = options.delay ?? TOOLTIP_DELAY
    this.browse = options.browse ?? TOOLTIP_BROWSE
    this.now = options.now ?? (() => performance.now())
  }

  /** The pointer came onto a control: its tooltip follows after the delay – or now, in browse mode or with one showing. */
  pointerEnter(target: HTMLElement): void {
    if (this.pending === target || this.silenced === target) return
    const shown = this.store.get().target
    if (shown === target) return
    this.cancel()
    if (this.blocked(target)) {
      this.clear()
      return
    }
    if (shown !== null || this.now() < this.browseUntil) {
      this.show(target, 'pointer')
      return
    }
    this.pending = target
    this.timer = setTimeout(() => {
      this.timer = null
      this.pending = null
      this.show(target, 'pointer')
    }, this.delay)
  }

  /** The pointer left a control: nothing pending for it, its tooltip goes, and browse mode opens. */
  pointerLeave(target: HTMLElement): void {
    if (this.pending === target) this.cancel()
    if (this.silenced === target) this.silenced = null
    const { target: shown, by } = this.store.get()
    if (shown === target && by === 'pointer') {
      this.clear()
      this.browseUntil = this.now() + this.browse
    }
  }

  /** Keyboard focus landed on a control (`:focus-visible`): its tooltip shows at once (§9.22). */
  focus(target: HTMLElement): void {
    this.cancel()
    if (this.blocked(target)) {
      this.clear()
      return
    }
    this.show(target, 'focus')
  }

  /** Focus left a control: the tooltip focus put up goes; one the pointer holds stays. */
  blur(target: HTMLElement): void {
    if (this.pending === target) this.cancel()
    const { target: shown, by } = this.store.get()
    if (shown === target && by === 'focus') this.clear()
  }

  /**
   * A press anywhere, or Escape: the tooltip goes, and – when the pointer put it up – the
   * control it was on stays silent until the pointer leaves it (Chrome's: a clicked button's
   * tooltip does not come back under the still pointer). One the keyboard put up silences
   * nothing: the pointer is not on the control, and its first visit should show the tooltip
   * after the dwell as on any other. Returns whether there was one to take down (the key itself
   * is never consumed on its account: Escape goes on to the control's own meaning).
   */
  dismiss(): boolean {
    const { target: shown, by } = this.store.get()
    this.cancel()
    if (shown === null) return false
    if (by === 'pointer') this.silenced = shown
    this.clear()
    return true
  }

  /** The window lost focus, the control left the DOM, other chrome opened: nothing shows or is about to. */
  hide(): void {
    this.cancel()
    this.clear()
  }

  /** Whether a tooltip is up for `target`, or any when omitted. */
  showing(target?: HTMLElement): boolean {
    const shown = this.store.get().target
    return target === undefined ? shown !== null : shown === target
  }

  private show(target: HTMLElement, by: TooltipCause): void {
    // Chrome that opened during the wait (a shortcut's bubble, a menu) has the window; a control
    // that left the DOM meanwhile has nothing to say.
    if (this.blocked(target) || !target.isConnected || !target.getAttribute(TOOLTIP_ATTR)) {
      this.clear()
      return
    }
    this.store.set({ target, by })
  }

  private clear(): void {
    if (this.store.get().target !== null) this.store.set(TOOLTIP_HIDDEN)
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }
}

/** The control an event landed in, if it carries a tooltip; a control with an empty text has none. */
export function tooltipTargetOf(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null
  const target = node.closest<HTMLElement>(`[${TOOLTIP_ATTR}]`)
  return target && target.getAttribute(TOOLTIP_ATTR) ? target : null
}

/** The tooltip's text: what the control's attribute says right now. */
export function tooltipText(target: HTMLElement): string {
  return target.getAttribute(TOOLTIP_ATTR) ?? ''
}

/**
 * The chrome pane a control sits in – the sidebar, a toolbar band, the caption strip – whose
 * box the tooltip stays inside when it can, so it never runs out over the page beside it (the
 * page views draw above the chrome's DOM). Null for a control in no pane.
 */
export function tooltipPaneOf(target: HTMLElement): HTMLElement | null {
  return target.closest<HTMLElement>('aside, header, [data-tab-strip]')
}

/**
 * Whether the tooltip of `target` may put the page under its picture to show over it: not for
 * a control in the views' gaps (`TOOLTIP_NO_COVER_ATTR` on it or an ancestor), which the cover
 * would take out of the DOM with the page.
 */
export function tooltipMayCover(target: HTMLElement): boolean {
  return target.closest(`[${TOOLTIP_NO_COVER_ATTR}]`) === null
}

/**
 * §9.20's one at a time, seen from the tooltip of `target`: other chrome has the window while a
 * popover is registered with the chrome layer, while a frame dialog holds the window chrome
 * inert, or while the UI state says something else is over the page – the URL bar, a menu, an
 * overlay, a drag, a prompt. The control's own surface is not other chrome to it: the chrome
 * layer's strata stand above the frame's, the popover on top has the window while any is
 * registered and names its own controls (`insideTopPopover`: the downloads bubble's Pause, a
 * folder menu's row) and no others – not a control in the frame or the window chrome under it,
 * nor one in a popover it sits on; with none registered a frame dialog has the window and
 * names its own (`insideFrameDialog`); with neither, the UI state's surfaces – all of them in
 * the frame or over it, so a control anywhere waits on them. A drag blocks every tooltip, the
 * pointer being spoken for; a native menu the same, the window being its. The hover card is
 * not other chrome to it (a focused control's tooltip and the card the pointer rests a row for
 * may stand together), and neither is the page's cover the tooltip itself holds
 * (`floatingChrome`, see components/Tooltip.tsx): `ownHolds` are taken off the count before it
 * is read.
 */
export function tooltipBlocked(target: HTMLElement, ownHolds = 0): boolean {
  const ui = uiStore.get()
  if (ui.drag !== null || ui.menu !== null) return true
  if (openPopoverCount() > 0) return !insideTopPopover(target)
  if (chromeInertHeld()) return !insideFrameDialog(target)
  return overlayCoversContent({
    ...ui,
    hoverCard: HOVER_CARD_HIDDEN,
    floatingChrome: Math.max(0, ui.floatingChrome - ownHolds)
  })
}

export interface TooltipBox {
  side: 'below' | 'above'
  left: number
  top: number
  /**
   * The box's width in whole pixels – the measured `max-content` width taken up to the next
   * pixel – for the host to give the element (`style.width`): with the left edge on a column and
   * the width a fraction (Seek forward's 74.36), the right hairline fell between two columns
   * and drew soft; on a whole width both hairlines stand on a column. Up, never down: a width
   * under the text's own would wrap its last word.
   */
  width: number
}

export interface TooltipPlacement {
  box: TooltipBox
  /** Whether the tooltip lies over the page's box, so the page must go under its picture first. */
  coversPage: boolean
}

/**
 * The tooltip's border box to the fraction, for the placer. `offsetWidth` rounds to the pixel
 * (a 95.17 wide tooltip reads 95, and a clamp against the margin computed from it leaves the
 * real box 0.17 over the margin – the ⋯ button's, measured by the a11y-2 drive); the client
 * rect is under the pop's scale while the appearance plays. The used width and height from the
 * computed style are neither, and `.zen-tooltip` is `box-sizing: border-box`, so they are the
 * border box. A DOM that resolves no used value (a test's) falls back to the offsets.
 */
export function tooltipSize(el: HTMLElement): Size {
  const style = getComputedStyle(el)
  const width = parseFloat(style.width)
  const height = parseFloat(style.height)
  return {
    width: width > 0 ? width : el.offsetWidth,
    height: height > 0 ? height : el.offsetHeight
  }
}

/**
 * Where the tooltip goes, in viewport coordinates for a `fixed` element: centred under its
 * control, `TOOLTIP_GAP` below its box, never over it. Placed first inside the control's own
 * pane (`pane`: the sidebar, the toolbar band) with §9.20's 8 px margin – slid sideways to stay
 * inside, flipped above the control when there is no room below – so a tooltip in the sidebar
 * never leaves the sidebar for the page beside it. A pane too short for either side (a toolbar
 * band with the page right under it) or too narrow for the text (the compact rail) hands over
 * to the window: the same slide against the window's margin, below first – flipped above when
 * below runs out of the window, and when below would lie over the page while above misses it
 * (a control in the gap between the page's views: a split pane's header at the top of the
 * frame, whose tooltip above it stands on the caption band, beside the page rather than over
 * it) – and `coversPage` says whether the box then lies over the page (`page`: the content
 * area), for the host to put the page under its picture before the tooltip shows. The box is
 * whole pixels on every edge: `size` is the element's own to the fraction (`tooltipSize`), and
 * the placer takes its width up to the next pixel (`TooltipBox.width`) before it centres and
 * clamps, so the right hairline stands on a column as the left does.
 */
export function placeTooltip(
  anchor: Rect,
  measured: Size,
  viewport: Size,
  pane: Rect | null,
  page: Rect | null
): TooltipPlacement {
  const size: Size = { width: Math.ceil(measured.width), height: measured.height }
  if (pane) {
    const inPane = fitTooltip(anchor, size, pane)
    if (inPane) return { box: inPane, coversPage: false }
  }
  const frame: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height }
  const covers = (box: TooltipBox): boolean => page !== null && intersects(box, size, page)
  const fits = [fitBelow(anchor, size, frame), fitAbove(anchor, size, frame)].filter(
    (box): box is TooltipBox => box !== null
  )
  const box = fits.find((candidate) => !covers(candidate)) ??
    fits[0] ?? {
      // Neither side fits the window: below, slid up to the margin, as far as it goes.
      side: 'below' as const,
      left: slideLeft(anchor, size, frame),
      top: Math.round(Math.max(POPOVER_MARGIN, viewport.height - POPOVER_MARGIN - size.height)),
      width: size.width
    }
  return { box, coversPage: covers(box) }
}

/** Below the control when that fits the field, else above it, else nothing. */
function fitTooltip(anchor: Rect, size: Size, field: Rect): TooltipBox | null {
  return fitBelow(anchor, size, field) ?? fitAbove(anchor, size, field)
}

/** Whole pixels: a tooltip on a half pixel draws its hairline and its text soft. */
function fitBelow(anchor: Rect, size: Size, field: Rect): TooltipBox | null {
  if (field.width - 2 * POPOVER_MARGIN < size.width) return null
  const below = anchor.y + anchor.height + TOOLTIP_GAP
  if (below + size.height > field.y + field.height - POPOVER_MARGIN) return null
  return {
    side: 'below',
    left: slideLeft(anchor, size, field),
    top: Math.round(below),
    width: size.width
  }
}

function fitAbove(anchor: Rect, size: Size, field: Rect): TooltipBox | null {
  if (field.width - 2 * POPOVER_MARGIN < size.width) return null
  const above = anchor.y - TOOLTIP_GAP - size.height
  if (above < field.y + POPOVER_MARGIN) return null
  return {
    side: 'above',
    left: slideLeft(anchor, size, field),
    top: Math.round(above),
    width: size.width
  }
}

/**
 * Centred on the control, then slid the least distance that keeps it inside the field's margin
 * – on a whole pixel, the margin's bounds rounded inwards first, so the clamp never rounds the
 * box a fraction out over the margin (a 95.2 wide tooltip against a 240 pane clamped to 136.8;
 * rounded to 137 it would end 0.2 past the margin – it lands on 136; the width comes whole by
 * now, 96, and the bounds still round inwards for a field that starts on a fraction).
 */
function slideLeft(anchor: Rect, size: Size, field: Rect): number {
  const min = Math.ceil(field.x + POPOVER_MARGIN)
  const max = Math.max(min, Math.floor(field.x + field.width - POPOVER_MARGIN - size.width))
  const centred = Math.round(anchor.x + anchor.width / 2 - size.width / 2)
  return Math.min(Math.max(centred, min), max)
}

function intersects(box: TooltipBox, size: Size, page: Rect): boolean {
  return (
    box.left < page.x + page.width &&
    box.left + size.width > page.x &&
    box.top < page.y + page.height &&
    box.top + size.height > page.y
  )
}

/** The app's tooltip: which control it is up for. Its own store – the frame has no stake in it. */
export const tooltipStore = createStore<TooltipState>(TOOLTIP_HIDDEN, 'tooltip')

/** How many of `floatingChrome`'s holds are the tooltip host's own (0 or 1). */
let ownHolds = 0

/** The host says whether it holds the page under its picture right now (see `tooltipBlocked`). */
export function tooltipCoverHeld(held: boolean): void {
  ownHolds = held ? 1 : 0
}

/** The app's controller; the host (`components/Tooltip.tsx`) feeds it the document's events. */
export const tooltip = new TooltipController(tooltipStore, {
  blocked: (target) => tooltipBlocked(target, ownHolds)
})
