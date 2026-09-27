import { internalPageAliasUrl, isInternalPageUrl } from '@shared/internalPages'
import type { Rect, UIState } from '@shared/types'
import {
  BLANK_URL,
  displayHost,
  ERROR_URL_PREFIX,
  extensionPageOf,
  getHost,
  READER_URL_PREFIX
} from '@shared/url'
import type { PopoverBox, Size } from './portals'
import {
  chromeInertHeld,
  openPopoverCount,
  POPOVER_HEIGHT_FLOOR,
  POPOVER_MARGIN,
  toRect,
  viewportSize
} from './portals'
import { activeTab, tabStateLines, tabTitle } from './selectors'
import { createStore } from './store'
import { captureThumbnail } from './thumbnails'
import {
  browserStore,
  captureActiveTab,
  HOVER_CARD_HIDDEN,
  invalidateSnapshot,
  overlayCoversContent,
  uiStore,
  type HoverCardState
} from './ui'

/**
 * The tab hover card (design-language-v2-draft §9.20, Chrome's tab hover card): a 320 wide
 * popover beside the sidebar with the row's full title and host – and, for a page in the
 * background, a preview of it above them (tabs-19) – shown once the pointer has rested on a
 * row for `HOVER_CARD_DELAY`, or at once when keyboard focus lands on a row. One at
 * a time: while a card is up, moving to another row moves the card there without the wait,
 * the way Chrome's does. It never takes the pointer and goes away on any press, a drag, a
 * scroll of the list, Escape, the window losing focus, or the pointer leaving the rows.
 *
 * It is not a popover – nothing dismisses it, it registers nowhere, it takes no pointer – but
 * §9.20's one at a time holds for it: it never shows beside an open popover or under a frame
 * dialog (`chromeBusy`), and it goes the moment one opens (the app subscribes to the chrome
 * layer's registry, `subscribePopovers`, and to the UI state).
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

/** A row's box and its list's frame – the sidebar, or the strip's band (`axis: 'x'`). */
export interface RowMeasure {
  anchor: Rect
  sidebar: Rect
  axis?: 'x'
}

type Measure = () => RowMeasure | null

export interface HoverCardOptions {
  /**
   * Runs before a card shows, with the row's tab (the app captures the active page there, and
   * the hovered page for the card's preview); the card waits for it.
   */
  prepare?: (tabId: string) => Promise<unknown>
  /**
   * Whether other chrome has the window right now – a popover, a menu, a dialog, an overlay:
   * no card shows while it says so (checked when the pointer arrives, when focus lands, and
   * again once the delay and `prepare` have run), and what was on its way is dropped.
   */
  blocked?: () => boolean
  delay?: number
  grace?: number
}

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
  private readonly prepare: (tabId: string) => Promise<unknown>
  private readonly blocked: () => boolean
  private readonly delay: number
  private readonly grace: number

  constructor(
    private readonly store: HoverCardStore,
    options: HoverCardOptions = {}
  ) {
    this.prepare = options.prepare ?? (async () => undefined)
    this.blocked = options.blocked ?? (() => false)
    this.delay = options.delay ?? HOVER_CARD_DELAY
    this.grace = options.grace ?? HOVER_CARD_LEAVE_GRACE
  }

  /** The pointer came onto a row: its card follows after the delay, or now if one is showing. */
  pointerEnter(tabId: string, measure: Measure): void {
    this.clearLeave()
    if (this.pending === tabId) return
    this.cancel()
    if (this.blocked()) {
      this.clear()
      return
    }
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
    if (this.blocked()) {
      this.clear()
      return
    }
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
    // Chrome that opened during the wait (a shortcut's bubble, a page's dialog) has the window.
    if (this.blocked()) {
      this.pending = null
      this.clear()
      return
    }
    const seq = ++this.seq
    this.pending = tabId
    void this.prepare(tabId).then(
      () => {
        if (seq !== this.seq) return
        this.pending = null
        const box = this.blocked() ? null : measure()
        if (!box) {
          this.clear()
          return
        }
        this.store.set({ tabId, anchor: box.anchor, sidebar: box.sidebar, axis: box.axis, by })
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
 * §9.20's one at a time, seen from the card: other chrome has the window while a popover is
 * registered with the chrome layer (the star bubble, a bar folder panel, the zoom bubble, a
 * menulist's list), while a frame dialog holds the window chrome inert, or while the UI state
 * says something else is over the page – the URL bar, a menu, an overlay, a drag, a prompt.
 */
export function chromeBusy(): boolean {
  return (
    openPopoverCount() > 0 ||
    chromeInertHeld() ||
    overlayCoversContent({ ...uiStore.get(), hoverCard: HOVER_CARD_HIDDEN })
  )
}

/**
 * Whether the card for `tabId` previews the page (tabs-19): a tab that is not the active one
 * (the active page is under the card itself) and has a live view to picture – a sleeping tab
 * has none and shows none. The masked private row never gets a card at all (`TabItem`).
 */
export function hoverCardPreviews(state: UIState | null, tabId: string): boolean {
  const tab = state?.tabs[tabId]
  if (!tab || tab.discarded) return false
  return activeTab(state)?.id !== tabId
}

/**
 * Card hosts mounted: `TabHoverCard`, which the desktop shell mounts (App.tsx), or the tablet
 * chrome's headless `TabletHoverCardHost` where a native host draws the card (below). Every row
 * drives the controller (`TabItem`, for a mouse pointer on any chrome), and the card's
 * dismissals live in the host – a tab coming to the front, a press, a wheel, a key. With no
 * host no card could show, while the controller's capture-and-hide of the live page would
 * still run for a pointer resting on a row, and hold past a tab switch under it until the
 * pointer left the rows – the stage empty meanwhile, the new page having no capture (a mouse on
 * the tablet chrome under Samsung DeX, OS-12, before the tablet had a host). So the app's
 * controller raises nothing until a host is mounted.
 */
let hosts = 0
let domHosts = 0

/** Whether a card host is mounted: without one the controller raises no card. */
export function hoverCardHosted(): boolean {
  return hosts > 0
}

/**
 * Whether the chrome's own card (`TabHoverCard`) is mounted: the document's `#zen-tab-hover-card`
 * is then its, and the tablet's host adds no second node of that id (one per document – a row's
 * `aria-describedby` names the first).
 */
export function domHoverCardHosted(): boolean {
  return domHosts > 0
}

/**
 * The card as a host that draws it itself receives it (Android's tablet chrome, TABLET-05: the
 * pages are layered above the chrome's WebView there, so a card the chrome drew beside the
 * sidebar would never show over them – or would need the live page hidden behind a capture,
 * the desktop's cost, where the ruling is that the page keeps playing under the card). The
 * chrome keeps the card's machine – the delay, the grace, one at a time, the rows' hover and
 * focus, the dismissals – and sends the host what to draw, per change, in CSS px of the
 * chrome's window that the host scales by its density: the row's box and its list's, the
 * window's size, and the card's text as the desktop card renders it. `null` takes it down.
 */
export interface HoverCardFrame {
  visible: true
  tabId: string
  /** The row's title as the desktop card shows it (`tabTitle`). */
  title: string
  /** The second line: the page's site as the URL pill shows it (`hoverCardHost`). */
  host: string
  /** The state lines the row's tooltip carried (`tabStateLines`). */
  lines: string[]
  /**
   * Whether the card pictures the page (tabs-19: a background tab with a view to picture); the
   * host reads its own picture of the tab, stamped with `url`, and shows none when it has none.
   */
  preview: boolean
  /** The tab's document. */
  url: string
  anchor: Rect
  sidebar: Rect
  axis?: 'x'
  viewport: Size
  by: HoverCardCause
}

/** A host that draws the card where the chrome says (Android's `boot.ts` registers its bridge). */
export interface HoverCardHost {
  apply(frame: HoverCardFrame | null): void
}

let nativeHost: HoverCardHost | null = null

/**
 * Register the host that draws the card, or none: the chrome's own `TabHoverCard` then does. A
 * bounded registration with no I/O – nothing runs until a card is on its way – so it may go at
 * construction (Android's cold-start rule).
 */
export function setHoverCardHost(next: HoverCardHost | null): void {
  nativeHost = next
}

/** The host that draws the card, when one is registered. */
export function hoverCardNativeHost(): HoverCardHost | null {
  return nativeHost
}

/**
 * What a native host shows: the controller's state while one is registered, kept out of the UI
 * state – `overlayCoversContent` would count a card there as chrome over the page (the page is
 * live under this one) – with the frame the host was last sent beside it. The tablet's host
 * reads it to bind the dismissals for as long as a card is up, and to keep the card's text in
 * the chrome's document for the row to be described by (`useHoverCardUp`).
 */
export const nativeHoverCard = createStore<{ card: HoverCardState; frame: HoverCardFrame | null }>(
  { card: HOVER_CARD_HIDDEN, frame: null },
  'nativeHoverCard'
)

/**
 * Whether the card stands for `tabId`, whichever host draws it – the chrome's own card in the
 * UI state, or a native host's in `nativeHoverCard`: the row names the card's node
 * (`#zen-tab-hover-card`) in its `aria-describedby` either way.
 */
export function useHoverCardUp(tabId: string): boolean {
  const dom = uiStore.use((s) => s.hoverCard.tabId === tabId)
  const native = nativeHoverCard.use((s) => s.card.tabId === tabId)
  return dom || native
}

/**
 * The frame a native host draws from the controller's state; null when no card is up, or its
 * tab has gone (a row of a closed tab under a resting pointer).
 */
export function hoverCardFrame(
  card: HoverCardState,
  state: UIState | null,
  viewport: Size
): HoverCardFrame | null {
  if (card.tabId === null || !card.anchor || !card.sidebar || !card.by) return null
  const tab = state?.tabs[card.tabId]
  if (!tab) return null
  const agent = state.agents.find((a) => a.tabIds.includes(tab.id)) ?? null
  return {
    visible: true,
    tabId: tab.id,
    title: tabTitle(tab),
    host: hoverCardHost(tab.url),
    lines: tabStateLines(tab, agent?.name ?? null),
    preview: hoverCardPreviews(state, tab.id),
    url: tab.url,
    anchor: card.anchor,
    sidebar: card.sidebar,
    ...(card.axis ? { axis: card.axis } : {}),
    viewport,
    by: card.by
  }
}

/**
 * The app's controller. The card lives in the UI state so the content frame knows chrome
 * covers the page (`overlayCoversContent`), the active page is captured before it shows, and
 * the capture is let go once it is down and nothing else needs it. Hiding the page takes the
 * keyboard from it; the core gives it back with the layout that shows the page again (see
 * `applyLayout` in core/window.ts), so the card never has to ask.
 *
 * The hovered page is captured beside it for the card's preview (tabs-19), asked for fresh:
 * its view is hidden, and Electron paints a hidden view on request (`window.snapshot(tabId,
 * fresh)`); the two captures run together, so the card waits for the slower and not the sum.
 * A host that cannot picture a hidden page answers null and the card shows no preview.
 *
 * With a native host registered (`setHoverCardHost`) the same machine drives that host
 * instead: its state goes to `nativeHoverCard` and out as a frame, never to the UI state, and
 * nothing is captured – the page keeps playing under the card, and the host pictures the tab
 * from its own store.
 */
export const hoverCard = new HoverCardController(
  {
    get: () => (nativeHost ? nativeHoverCard.get().card : uiStore.get().hoverCard),
    set: (next) => {
      const host = nativeHost
      if (host) {
        const frame = hoverCardFrame(next, browserStore.get().state, viewportSize())
        nativeHoverCard.set({ card: frame ? next : HOVER_CARD_HIDDEN, frame })
        host.apply(frame)
        return
      }
      uiStore.set({ hoverCard: next })
      if (next.tabId === null) invalidateSnapshot()
    }
  },
  {
    prepare: (tabId) => {
      if (nativeHost) return Promise.resolve()
      const state = browserStore.get().state
      const cover = captureActiveTab(state ? (activeTab(state)?.id ?? null) : null)
      const preview = hoverCardPreviews(state, tabId)
        ? captureThumbnail(tabId, { fresh: true })
        : Promise.resolve(null)
      return Promise.all([cover, preview])
    },
    blocked: () => !hoverCardHosted() || chromeBusy()
  }
)

/**
 * The card's dismissals while it is up, bound by its host (`TabHoverCard`, the tablet's
 * `TabletHoverCardHost`) for as long as a card shows; the return releases them. Any press or
 * context menu, a wheel or a scroll anywhere, the window losing focus or changing size, and
 * the keys: Escape, and typing – the page under the card had the keyboard until the card hid
 * it (the desktop; above), so a letter means the user is back at the page. Arrows, Tab and
 * Enter are the rows' own keys and move or activate instead.
 */
export function bindHoverCardDismissals(hide: () => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const typing = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete' || typing) hide()
  }
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('contextmenu', hide, true)
  document.addEventListener('wheel', hide, { capture: true, passive: true })
  document.addEventListener('scroll', hide, { capture: true, passive: true })
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', hide)
  window.addEventListener('resize', hide)
  return () => {
    document.removeEventListener('pointerdown', hide, true)
    document.removeEventListener('contextmenu', hide, true)
    document.removeEventListener('wheel', hide, { capture: true })
    document.removeEventListener('scroll', hide, { capture: true })
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', hide)
    window.removeEventListener('resize', hide)
  }
}

/**
 * A card host mounted (`TabHoverCard`'s mount effect): the controller may raise the card until
 * the returned release runs at the unmount, which takes down whatever card the last host left.
 * The desktop shell's HTML-fullscreen return (`App.tsx`) unmounts its card with the rest of the
 * chrome, so the host count falls to none for the duration and a pointer entering a row in the
 * frame the card remounts on the way out is dropped, not captured – the `hide()` here at that
 * moment is the last host leaving, not a card lost.
 *
 * `kind` says what the host draws: the chrome's own card in the document (`dom`, the default –
 * `TabHoverCard`), or nothing itself, a native host drawing it (`native` – the tablet's host),
 * which `domHoverCardHosted` tells apart.
 */
export function hostHoverCard(kind: 'dom' | 'native' = 'dom'): () => void {
  hosts++
  if (kind === 'dom') domHosts++
  let mounted = true
  return () => {
    if (!mounted) return
    mounted = false
    hosts--
    if (kind === 'dom') domHosts--
    if (hosts === 0) hoverCard.hide()
  }
}

/**
 * A row's box and its sidebar's – or, for a row of the strip along the caption band (§9.37),
 * the band's, with the axis turned – for the controller; null once the row has left the DOM.
 */
export function measureRow(row: HTMLElement): RowMeasure | null {
  if (!row.isConnected) return null
  const band = row.closest<HTMLElement>('[data-tab-strip]')
  if (band) {
    return {
      anchor: toRect(row.getBoundingClientRect()),
      sidebar: toRect(band.getBoundingClientRect()),
      axis: 'x'
    }
  }
  // The collapsed rail's flyout (`useRailFlyout`) is the sidebar's box out over the page: a card
  // for one of its rows hangs off the flyout's inner edge, not the rail's under it.
  const aside = row.closest<HTMLElement>('[data-rail-flyout], aside')
  if (!aside) return null
  return {
    anchor: toRect(row.getBoundingClientRect()),
    sidebar: toRect(aside.getBoundingClientRect())
  }
}

/**
 * Where the card goes, in viewport coordinates for a `fixed` element (`popoverStyle` turns it
 * into the inline style): flush against the sidebar's inner edge (gap 0), on whichever side
 * the page is, and start-aligned with its row – top edges together. Against the window it is
 * clamped as §9.20 clamps a popover, with `POPOVER_MARGIN` and in the same order: a card that
 * would cross the bottom margin flips above – end-aligned, its bottom edge on the row's – when
 * there is more room above than below (or the room below is under `POPOVER_HEIGHT_FLOOR`);
 * otherwise it stays and shrinks to the room left. Either way it overlaps its row's box and is
 * never taller than the window minus 16. A card wider than the window minus 16 shrinks to that.
 *
 * With the rows along the caption band (`axis: 'x'`, §9.37) the same rule turned: the card
 * hangs flush under the band (gap 0), start-aligned with its tab – left edges together – and
 * slid back inside the window's margin when the tab is near the trailing edge; it takes the
 * room down to the bottom margin.
 */
export function placeHoverCard(
  anchor: Rect,
  sidebar: Rect,
  viewport: Size,
  size: Size,
  axis?: 'x'
): PopoverBox {
  const width = Math.max(0, Math.min(size.width, viewport.width - 2 * POPOVER_MARGIN))
  if (axis === 'x') {
    const top = Math.max(POPOVER_MARGIN, sidebar.y + sidebar.height)
    const left = Math.min(
      Math.max(POPOVER_MARGIN, anchor.x),
      Math.max(POPOVER_MARGIN, viewport.width - width - POPOVER_MARGIN)
    )
    const room = Math.max(0, viewport.height - POPOVER_MARGIN - top)
    return { side: 'below', left, top, width, maxHeight: Math.min(size.height, room) }
  }
  const onRight = sidebar.x + sidebar.width / 2 > viewport.width / 2
  const flush = onRight ? sidebar.x - width : sidebar.x + sidebar.width
  const left = Math.min(
    Math.max(POPOVER_MARGIN, flush),
    Math.max(POPOVER_MARGIN, viewport.width - width - POPOVER_MARGIN)
  )

  const edge = Math.max(0, viewport.height - 2 * POPOVER_MARGIN)
  const wanted = Math.max(0, Math.min(size.height, edge))
  // Start-aligned: the card's top on the row's top, never above the margin (a row half under
  // the list's top edge). End-aligned: its bottom on the row's bottom, never under the margin.
  const top = Math.max(POPOVER_MARGIN, anchor.y)
  const bottom = Math.max(POPOVER_MARGIN, viewport.height - (anchor.y + anchor.height))
  const below = Math.max(0, viewport.height - POPOVER_MARGIN - top)
  const above = Math.max(0, viewport.height - POPOVER_MARGIN - bottom)
  const side: PopoverBox['side'] =
    wanted <= below ? 'below' : above > below || below < POPOVER_HEIGHT_FLOOR ? 'above' : 'below'
  const maxHeight = Math.min(wanted, side === 'below' ? below : above)
  return side === 'below'
    ? { side, left, top, width, maxHeight }
    : { side, left, bottom, width, maxHeight }
}

/**
 * The card's second line, what Chrome shows under the title: the page's site for web pages as
 * the URL pill shows it (`displayHost`: a leading `www.` trimmed, a non-default port kept, an
 * error or Reader page standing in for its site), the address itself for Zenium's own pages –
 * a page tab's as the user knows it, `zenium://history`, never the `zen://` the tab carries
 * (v2 §10.1), page and section without the query as the pill says it – and for an extension's
 * (`chrome-extension://<id>/<path>`, whichever form the tab carries), a plain word for a local
 * file, nothing for a blank tab.
 */
export function hoverCardHost(url: string): string {
  if (!url || url === 'about:blank' || url === BLANK_URL) return ''
  const extension = extensionPageOf(url)
  if (extension) return extension.url.replace(/[?#].*$/, '')
  if (
    /^https?:\/\//i.test(url) ||
    url.startsWith(ERROR_URL_PREFIX) ||
    url.startsWith(READER_URL_PREFIX)
  )
    return displayHost(url).toLowerCase()
  if (isInternalPageUrl(url)) return internalPageAliasUrl(url)
  if (/^zen:\/\//i.test(url)) return url.replace(/[?#].*$/, '').replace(/\/$/, '')
  if (/^file:\/\//i.test(url)) return 'File on this computer'
  return getHost(url).toLowerCase() || url.replace(/[?#].*$/, '')
}

/**
 * Chrome's `TabResourceUsage::kHighMemoryUsageThreshold`, 800 MiB: past it the card says "High
 * memory usage" whether the setting is on or off.
 */
export const HOVER_CARD_HIGH_MEMORY_MB = 800

/**
 * A memory figure as Chrome's `ui::FormatBytes` writes it, in the card's line: the unit that
 * keeps the amount under 1024 (megabytes to a gigabyte, then gigabytes), one decimal while the
 * amount is under 100 – "45.3 MB", "123 MB", "1.2 GB".
 */
export function formatHoverCardMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`
}

/**
 * The card's memory line (settings-29; Chrome's `FadePerformanceFooterRow`): "Memory usage:
 * 123 MB" for a tab with a measured usage while Settings › Performance's Show tab memory usage
 * is on – off by default, Chrome 152's effective default after `MigrateHoverCardMemoryPref`, so
 * only an explicit `true` shows it – the governor's last sample (`ResourceSnapshot.tabs`, working
 * set, refreshed every few seconds), so a tab the governor has not measured yet has no line –
 * and "High memory usage: 1.2 GB" past Chrome's threshold whatever the setting says. Never for a
 * sleeping tab: its card says what the page gave back instead (`tabStateLines`' "Memory saved"),
 * as Chrome's discard footer stands in for the memory row. Null where there is nothing to say.
 */
export function hoverCardMemoryLine(state: UIState | null, tabId: string): string | null {
  const tab = state?.tabs[tabId]
  if (!state || !tab || tab.discarded) return null
  const usage = state.resources?.tabs.find((t) => t.tabId === tabId)
  if (!usage || !Number.isFinite(usage.memoryMb) || usage.memoryMb <= 0) return null
  if (usage.memoryMb > HOVER_CARD_HIGH_MEMORY_MB)
    return `High memory usage: ${formatHoverCardMemory(usage.memoryMb)}`
  if (state.settings.hoverCardMemoryUsage !== true) return null
  return `Memory usage: ${formatHoverCardMemory(usage.memoryMb)}`
}
