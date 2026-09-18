import type { Rect } from '@shared/types'
import { getHost } from '@shared/url'
import type { Size } from './portals'
import { POPOVER_MARGIN, toRect } from './portals'
import { activeTab } from './selectors'
import {
  browserStore,
  captureActiveTab,
  HOVER_CARD_HIDDEN,
  invalidateSnapshot,
  uiStore,
  type HoverCardState
} from './ui'

/**
 * The tab hover card (design-language-v2-draft §9.20, Chrome's tab hover card): a 320 wide
 * popover beside the sidebar with the row's full title and host, shown once the pointer has
 * rested on a row for `HOVER_CARD_DELAY`, or at once when keyboard focus lands on a row. One at
 * a time: while a card is up, moving to another row moves the card there without the wait,
 * the way Chrome's does. It never takes the pointer and goes away on any press, a drag, a
 * scroll of the list, Escape, the window losing focus, or the pointer leaving the rows.
 *
 * The card hangs over the page, and the tab views draw above the chrome's DOM: like every
 * other chrome over the page (menus, the URL bar, the star bubble) it shows over a capture of
 * the active page, taken before it appears, while the live view is hidden underneath.
 */
export type { HoverCardState } from './ui'
export type HoverCardCause = NonNullable<HoverCardState['by']>

/** How long the pointer rests on a row before its card shows (Chrome: about 800 ms). */
export const HOVER_CARD_DELAY = 800
/**
 * How long a card outlives the pointer leaving its row: rows touch, and the leave of one fires
 * before the enter of the next, so the card moves to the neighbour rather than blinking off
 * and waiting again. Past the last row the pointer is in the gap and the card goes.
 */
export const HOVER_CARD_LEAVE_GRACE = 80

/** What the controller reads and writes: the `hoverCard` slice of the UI state, or a plain store in tests. */
export interface HoverCardStore {
  get(): HoverCardState
  set(next: HoverCardState): void
}

type Measure = () => { anchor: Rect; sidebar: Rect } | null

/**
 * The card's timing, kept out of React: a pending row and its timer, the row shown, and the
 * grace after a leave. The geometry is read from the row when the card shows (`measure`), not
 * when the pointer arrives. `prepare` runs before a card shows (the app captures the page
 * there); a pointer that leaves meanwhile leaves nothing behind.
 */
export class HoverCardController {
  private timer: ReturnType<typeof setTimeout> | null = null
  private leaveTimer: ReturnType<typeof setTimeout> | null = null
  /** The row a card is on its way to: waiting out the delay, or the page capture. */
  private pending: string | null = null
  /** Bumped by every cancel, so a capture that ends after one shows nothing. */
  private seq = 0

  constructor(
    private readonly store: HoverCardStore,
    private readonly prepare: () => Promise<unknown> = async () => undefined,
    private readonly delay = HOVER_CARD_DELAY,
    private readonly grace = HOVER_CARD_LEAVE_GRACE
  ) {}

  /** The pointer came onto a row: its card follows after the delay, or now if one is showing. */
  pointerEnter(tabId: string, measure: Measure): void {
    this.clearLeave()
    if (this.pending === tabId) return
    this.cancel()
    const shown = this.store.get().tabId
    if (shown === tabId) return
    if (shown !== null) {
      this.show(tabId, measure, 'pointer')
      return
    }
    this.pending = tabId
    this.timer = setTimeout(() => {
      this.timer = null
      this.show(tabId, measure, 'pointer')
    }, this.delay)
  }

  /** The pointer left a row: nothing pending for it any more, and its card goes after the grace. */
  pointerLeave(tabId: string): void {
    if (this.pending === tabId) this.cancel()
    const { tabId: shown, by } = this.store.get()
    if (shown !== tabId || by !== 'pointer') return
    this.clearLeave()
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null
      if (this.store.get().tabId === tabId) this.hide()
    }, this.grace)
  }

  /** Keyboard focus on a row shows its card at once (§9.22: what the pointer sees, keys reach). */
  focus(tabId: string, measure: Measure): void {
    this.cancel()
    this.clearLeave()
    this.show(tabId, measure, 'focus')
  }

  /**
   * Focus left a row: its card goes after the grace, so focus arriving on the next row (blur
   * and focus fire in the same turn) moves the card rather than taking it down and putting it
   * back up.
   */
  blur(tabId: string): void {
    if (this.pending === tabId) this.cancel()
    if (this.store.get().tabId !== tabId) return
    this.clearLeave()
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null
      if (this.store.get().tabId === tabId) this.hide()
    }, this.grace)
  }

  /** A press, a drag, a scroll, Escape, the window losing focus: nothing shows or is about to. */
  hide(): void {
    this.cancel()
    this.clearLeave()
    this.clear()
  }

  /** Whether a card is up for `tabId`, or any card when omitted. */
  showing(tabId?: string): boolean {
    const shown = this.store.get().tabId
    return tabId === undefined ? shown !== null : shown === tabId
  }

  private show(tabId: string, measure: Measure, by: HoverCardCause): void {
    const seq = ++this.seq
    this.pending = tabId
    void this.prepare().then(
      () => {
        if (seq !== this.seq) return
        this.pending = null
        const box = measure()
        if (!box) {
          this.clear()
          return
        }
        this.store.set({ tabId, anchor: box.anchor, sidebar: box.sidebar, by })
      },
      () => {
        if (seq === this.seq) this.pending = null
      }
    )
  }

  /** Take a shown card down; nothing to write when none is up. */
  private clear(): void {
    if (this.store.get().tabId !== null) this.store.set(HOVER_CARD_HIDDEN)
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    this.seq++
  }

  private clearLeave(): void {
    if (this.leaveTimer !== null) clearTimeout(this.leaveTimer)
    this.leaveTimer = null
  }
}

/**
 * The app's controller. The card lives in the UI state so the content frame knows chrome
 * covers the page (`overlayCoversContent`), the active page is captured before it shows, and
 * the capture is let go once it is down and nothing else needs it. Hiding the page takes the
 * keyboard from it; the core gives it back with the layout that shows the page again (see
 * `applyLayout` in core/window.ts), so the card never has to ask.
 */
export const hoverCard = new HoverCardController(
  {
    get: () => uiStore.get().hoverCard,
    set: (next) => {
      uiStore.set({ hoverCard: next })
      if (next.tabId === null) invalidateSnapshot()
    }
  },
  () => {
    const state = browserStore.get().state
    return captureActiveTab(state ? (activeTab(state)?.id ?? null) : null)
  }
)

/** A row's box and its sidebar's, for the controller; null once the row has left the DOM. */
export function measureRow(row: HTMLElement): { anchor: Rect; sidebar: Rect } | null {
  const aside = row.closest<HTMLElement>('aside')
  if (!aside || !row.isConnected) return null
  return {
    anchor: toRect(row.getBoundingClientRect()),
    sidebar: toRect(aside.getBoundingClientRect())
  }
}

/**
 * Where the card goes, viewport coordinates: flush against the sidebar's inner edge (gap 0),
 * on whichever side the page is, its top aligned with the row's, and kept `POPOVER_MARGIN`
 * inside the window – so a card for a row near the bottom slides up rather than being cut.
 */
export function placeHoverCard(
  anchor: Rect,
  sidebar: Rect,
  viewport: Size,
  size: Size
): { left: number; top: number } {
  const onRight = sidebar.x + sidebar.width / 2 > viewport.width / 2
  let left = onRight ? sidebar.x - size.width : sidebar.x + sidebar.width
  left = Math.min(Math.max(POPOVER_MARGIN, left), viewport.width - size.width - POPOVER_MARGIN)
  const top = Math.min(
    Math.max(POPOVER_MARGIN, anchor.y),
    Math.max(POPOVER_MARGIN, viewport.height - size.height - POPOVER_MARGIN)
  )
  return { left, top }
}

/**
 * The card's second line, what Chrome shows under the title: the page's host for web pages
 * (a leading `www.` trimmed, as Chrome's card does), the address itself for Zenium's own pages,
 * a plain word for a local file, nothing for a blank tab.
 */
export function hoverCardHost(url: string): string {
  if (!url || url === 'about:blank') return ''
  if (/^https?:\/\//i.test(url))
    return getHost(url)
      .toLowerCase()
      .replace(/^www\./, '')
  if (/^zen:\/\//i.test(url)) return url.replace(/[?#].*$/, '').replace(/\/$/, '')
  if (/^file:\/\//i.test(url)) return 'File on this computer'
  return getHost(url).toLowerCase() || url.replace(/[?#].*$/, '')
}
