// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  BookmarkNode,
  ClosedEntrySummary,
  DownloadItem,
  MagicStackModuleId,
  Tab,
  UIState
} from '@shared/types'
import { DEFAULT_NEW_TAB_SETTINGS } from '@shared/newTab'
import { BLANK_URL } from '@shared/url'
import { viewportStore } from '@renderer/lib/formFactor'
import { closeCustomize, openCustomize } from '@renderer/lib/newtab'
import { pageViewStore } from '@renderer/lib/pageView'
import { FrameDialogHost } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'

/*
 * The Magic Stack on the page (NTP-16; "Cards" to the user): the cards drawn from the state in
 * the stack's order, each a page surface named for TalkBack, the strip a carousel with its page
 * indicator (dots that are no controls, a status line reading the page); the rows act and a card
 * carries at most one action its rows cannot do; the ⋮ opening the shared local menu with Hide
 * This and Customise; Hide This writing the device's hidden set and taking the card out on the
 * 120 ms fade (a cut under reduced motion), the card kept out between the command and the state
 * and back when the state re-enables it; the Customise sheet's switch rows writing the set; the
 * stack not drawn at all when nothing has content. A card a switch turns on arrives in view –
 * the strip pages to it on the spring, a cut under reduced motion, a finger taking the motion
 * over – and a card a switch turns off leaves as Hide This's does, the strip closing the gap and
 * the dots following, nothing paging (§9.29, §11.4). The page's gear sheet seats its Cards row
 * first, above Layout, a hairline after it (§9.13). The dots' one dimmed number is .4 (§9.30).
 */

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: async () => null,
  onEvent: () => () => undefined
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { MagicStack, MagicStackCustomizeLayer } = await import('../MagicStack')
const { NewTabCustomizeLayer } = await import('../CustomizeSheet')
const { openMagicStackCustomize, closeMagicStackCustomize, magicStackCustomizeStore } =
  await import('../magicStackCustomize')
const { pickMenuItem } = await import('@renderer/lib/ui')

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null
let reduced = false
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

const TAB = {
  id: 'r',
  spaceId: 'space',
  containerId: 'default',
  url: BLANK_URL,
  title: '',
  favicon: null,
  pinned: false,
  essential: false,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  discarded: false,
  frozen: false,
  zoom: 1,
  createdAt: 0,
  lastActiveAt: 0
} as unknown as Tab

const CLOSED: ClosedEntrySummary = {
  id: 'c1',
  kind: 'tab',
  title: 'Espresso - Wikipedia',
  url: 'https://en.wikipedia.org/wiki/Espresso',
  favicon: null,
  closedAt: 1_000,
  tabCount: 1
}

const DOWNLOAD = {
  id: 'd1',
  url: 'https://files.example/design-language.pdf',
  referrer: '',
  filename: 'design-language.pdf',
  finalName: 'design-language.pdf',
  savePath: '/downloads/design-language.pdf',
  totalBytes: 2_411_520,
  receivedBytes: 2_411_520,
  state: 'completed',
  startedAt: 900,
  completedAt: 950,
  endedAt: 950,
  mimeType: 'application/pdf',
  canResume: false,
  danger: { level: 'safe', reason: 'none', message: '' },
  dangerAccepted: false,
  openWhenDone: false,
  bytesPerSecond: 0,
  etaMs: null,
  private: false,
  containerId: 'default'
} as unknown as DownloadItem

const BOOKMARKS: BookmarkNode[] = [
  { id: 'root', parentId: null, index: 0, type: 'folder', title: '', dateAdded: 0 },
  {
    id: 'other',
    parentId: 'root',
    index: 0,
    type: 'folder',
    title: 'Other bookmarks',
    dateAdded: 0
  },
  {
    id: 'b1',
    parentId: 'other',
    index: 0,
    type: 'url',
    title: 'Damping - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Damping',
    dateAdded: 500
  },
  {
    id: 'b2',
    parentId: 'other',
    index: 1,
    type: 'url',
    title: 'RFC 2324: HTCPCP/1.0',
    url: 'https://www.rfc-editor.org/rfc/rfc2324.html',
    dateAdded: 400
  }
]

function state(over: Partial<UIState> = {}): UIState {
  return {
    platform: 'android',
    capabilities: { privateTabs: true, defaultBrowser: true },
    tabs: { r: TAB },
    spaces: [{ id: 'space', activeTabId: 'r', tabIds: ['r'] }],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    settings: {},
    recentlyClosed: [CLOSED],
    downloads: [DOWNLOAD],
    bookmarks: BOOKMARKS,
    defaultBrowser: { isDefault: false, prompt: null },
    newTabHiddenModules: [],
    ...over
  } as unknown as UIState
}

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

const stack = (s: UIState): ReactElement => <MagicStack state={s} tab={TAB} dock="top" />

/** Let the menu's capture of the page (none here) resolve and the sheet come up. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Let every pending promise chain run out (a macrotask's worth). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

/** Run a spring to rest. */
function rest(): void {
  for (let i = 0; i < 200 && frames.scheduled; i++) act(() => frames.run(1))
  expect(frames.scheduled).toBe(false)
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const qa = <T extends HTMLElement>(selector: string): T[] => [
  ...document.querySelectorAll<T>(selector)
]
const cards = (): HTMLElement[] => qa('.zen-mstack-card')
const cardIds = (): string[] => cards().map((c) => c.dataset.cell ?? '')
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const commands = (name: string): unknown[] =>
  run.mock.calls.filter(([n]) => n === name).map(([, args]) => args)

/** The ⋮ menu of the card `id`, opened and its descriptor read. */
async function openMenu(
  id: MagicStackModuleId
): Promise<NonNullable<ReturnType<typeof uiStore.get>['menu']>> {
  click(q(`.zen-mstack-card[data-cell="${id}"] .zen-mstack-more`))
  await settle()
  const menu = uiStore.get().menu
  expect(menu).not.toBeNull()
  return menu!
}

/**
 * happy-dom neither lays out nor scrolls: the strip's offset gets a backing value here and every
 * write the pager makes is recorded. A card is 0 wide, so the pitch is the 8 gap alone and the
 * third card's snap position is 16, the fourth's 24.
 */
function scroller(strip: HTMLElement, at = 0): { writes: number[]; readonly offset: number } {
  const writes: number[] = []
  let offset = at
  Object.defineProperty(strip, 'scrollLeft', {
    configurable: true,
    get: () => offset,
    set: (v: number) => {
      offset = v
      writes.push(v)
    }
  })
  return {
    writes,
    get offset() {
      return offset
    }
  }
}

const snapOf = (strip: HTMLElement): string => strip.style.getPropertyValue('scroll-snap-type')

/** Pick the open menu's item labelled `label`: the sheet is unpainted over two frames first. */
function pick(label: string): void {
  const menu = uiStore.get().menu!
  const item = menu.items.find((i) => i.label === label)!
  act(() => {
    pickMenuItem(item.id)
    frames.run(2)
  })
}

beforeEach(() => {
  run.mockClear()
  frames.install()
  reduced = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }))
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone', coarse: true })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  uiStore.set({ menu: null })
  closeMagicStackCustomize()
  closeCustomize()
  browserStore.set({ state: null })
  pageViewStore.set({ phases: new Map(), lastApplied: null })
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
  vi.unstubAllGlobals()
  frames.now = 0
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('the Magic Stack on the page (NTP-16)', () => {
  it('draws one card per module with content, in the stack’s order, each a page surface named for TalkBack, the strip a carousel with a dot per page', () => {
    render(stack(state()))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'default-browser'])
    const strip = q('.zen-mstack-strip')!
    expect(strip.getAttribute('role')).toBe('list')
    expect(strip.getAttribute('aria-roledescription')).toBe('carousel')
    // The surface is called Cards; Chrome's name stays in Chrome's UI.
    expect(q('.zen-mstack')!.getAttribute('aria-label')).toBe('Cards')
    expect(document.body.textContent).not.toContain('Magic Stack')
    for (const card of cards()) expect(card.dataset.surface).toBe('page')
    expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual([
      'Continue where you left off: Espresso - Wikipedia',
      'Downloads: design-language.pdf',
      'Bookmarks: Damping - Wikipedia, RFC 2324: HTCPCP/1.0',
      'Default browser: set Zenium as your default browser'
    ])
    // Every ⋮ names its module; the shared 44 icon button.
    expect(qa('.zen-mstack-more').map((b) => b.getAttribute('aria-label'))).toEqual([
      'More options for Continue where you left off',
      'More options for Downloads',
      'More options for Bookmarks',
      'More options for Default browser'
    ])
    for (const more of qa('.zen-mstack-more'))
      expect(more.classList.contains('zen-v2-icon-button')).toBe(true)
    // The indicator: a status line reading the page and a dot per card, the first current; the
    // dots are no controls – hidden from the reader, no tab, no button, nothing to tap.
    const indicator = q('.zen-mstack-dots')!
    expect(indicator.getAttribute('role')).toBe('status')
    expect(indicator.textContent).toBe('Page 1 of 4')
    const dots = qa('.zen-mstack-dot')
    expect(dots).toHaveLength(4)
    expect(dots.map((d) => d.hasAttribute('data-current'))).toEqual([true, false, false, false])
    for (const dot of dots) {
      expect(dot.getAttribute('aria-hidden')).toBe('true')
      expect(dot.tagName).toBe('SPAN')
      expect(dot.hasAttribute('role')).toBe(false)
    }
    expect(qa('.zen-mstack-dots button, .zen-mstack-dots [role="tab"]')).toEqual([])
    expect(q('.zen-mstack [role="tablist"]')).toBeNull()
  })

  it('the indicator follows the strip’s scroll on its own subscription, the strip itself untouched', () => {
    render(stack(state()))
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    // happy-dom lays nothing out: a card is 0 wide, so the pitch is the 8 gap alone.
    const observer = new MutationObserver(() => undefined)
    observer.observe(strip, { attributes: true, childList: true, subtree: true })
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: 8 })
    act(() => {
      strip.dispatchEvent(new Event('scroll'))
    })
    expect(q('.zen-mstack-dots')!.textContent).toBe('Page 2 of 4')
    expect(qa('.zen-mstack-dot').map((d) => d.hasAttribute('data-current'))).toEqual([
      false,
      true,
      false,
      false
    ])
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
  })

  it('draws nothing at all when no module has content, or every one is hidden', () => {
    render(
      stack(
        state({
          recentlyClosed: [],
          downloads: [],
          bookmarks: [],
          defaultBrowser: { isDefault: true, prompt: null }
        })
      )
    )
    expect(q('.zen-mstack')).toBeNull()
    render(
      stack(
        state({ newTabHiddenModules: ['continue', 'downloads', 'bookmarks', 'default-browser'] })
      )
    )
    expect(q('.zen-mstack')).toBeNull()
    // One card alone: no dots.
    render(stack(state({ newTabHiddenModules: ['continue', 'bookmarks', 'default-browser'] })))
    expect(cardIds()).toEqual(['downloads'])
    expect(q('.zen-mstack-dots')).toBeNull()
  })

  it('one action a card, and only one its rows do not already do: See all on Downloads and Bookmarks, Set as default on the reminder, none on Continue; the rows reopen, open and open', () => {
    render(stack(state()))
    const buttons = qa<HTMLButtonElement>('.zen-mstack-action')
    expect(buttons.map((b) => b.textContent)).toEqual(['See all', 'See all', 'Set as default'])
    expect(qa('.zen-mstack-actions').map((a) => a.closest('li')?.dataset.cell)).toEqual([
      'downloads',
      'bookmarks',
      'default-browser'
    ])
    expect(q('.zen-mstack-card[data-cell="continue"] .zen-mstack-actions')).toBeNull()
    // The reminder's primary asks the host under the card's own source.
    click(buttons[2]!)
    expect(commands('defaultBrowser.request')).toEqual([{ source: 'newtab' }])
    expect(buttons[2]!.dataset.primary).toBe('true')
    // The rows are the cards' acts, named for what they do.
    const row = (id: MagicStackModuleId): HTMLElement | null =>
      q(`.zen-mstack-card[data-cell="${id}"] .zen-mstack-row`)
    expect(row('continue')!.getAttribute('aria-label')).toBe('Reopen Espresso - Wikipedia')
    click(row('continue'))
    expect(commands('session.restoreClosed')).toEqual([{ id: 'c1' }])
    expect(row('downloads')!.getAttribute('aria-label')).toBe('Open design-language.pdf')
    click(row('downloads'))
    expect(commands('download.open')).toEqual([{ id: 'd1' }])
    expect(row('bookmarks')!.getAttribute('aria-label')).toBe('Open Damping - Wikipedia')
    click(row('bookmarks'))
    expect(commands('bookmark.open')).toEqual([{ id: 'b1', newTab: false, tabId: 'r' }])
  })

  it('the Continue card’s detail reads the host then the time, the Downloads card’s register; a closed window has the time alone', () => {
    const now = Date.now()
    render(
      stack(
        state({
          recentlyClosed: [{ ...CLOSED, closedAt: now - 5 * 60_000 }],
          downloads: [
            { ...DOWNLOAD, completedAt: now - 3 * 3_600_000, endedAt: now - 3 * 3_600_000 }
          ]
        })
      )
    )
    const detail = (id: MagicStackModuleId): string | undefined =>
      q(`.zen-mstack-card[data-cell="${id}"] .zen-mstack-row-detail`)?.textContent ?? undefined
    expect(detail('continue')).toBe('en.wikipedia.org · 5 min ago')
    expect(detail('downloads')).toBe('2.3 MB · 3 h ago')
    render(
      stack(
        state({
          recentlyClosed: [
            { ...CLOSED, kind: 'window', title: '', url: null, tabCount: 3, closedAt: now - 60_000 }
          ]
        })
      )
    )
    expect(q('.zen-mstack-card[data-cell="continue"] .zen-mstack-row-title')!.textContent).toBe(
      'Window with 3 tabs'
    )
    expect(detail('continue')).toBe('1 min ago')
  })

  it('the ⋮ opens the shared local menu titled by the module, with Hide This and Customise', async () => {
    render(stack(state()))
    const menu = await openMenu('downloads')
    expect(menu.source).toBe('newtab')
    expect(menu.title).toBe('Downloads')
    expect(menu.items.map((i) => i.label)).toEqual(['Hide This', 'Customise'])
  })

  it('Hide This writes the device’s hidden set and fades the card out over 120 ms; the card stays out until the state carries the id, and comes back when the state drops it', async () => {
    render(stack(state()))
    await openMenu('continue')
    pick('Hide This')
    expect(commands('newtab.setModuleHidden')).toEqual([{ id: 'continue', hidden: true }])
    // The card is still drawn, leaving on its fade, out of the way of the finger.
    const leaving = q('.zen-mstack-card[data-cell="continue"]')!
    expect(leaving.dataset.leaving).toBe('true')
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'default-browser'])
    // The fade's end takes it out, the state not yet back.
    act(() => {
      leaving.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))
    })
    expect(cardIds()).toEqual(['downloads', 'bookmarks', 'default-browser'])
    // A state publish without the id yet (another field moved) does not bring the card back.
    render(stack(state({ newTabHiddenModules: [] })))
    expect(cardIds()).toEqual(['downloads', 'bookmarks', 'default-browser'])
    // The core's list arrives with the id: the same three.
    render(stack(state({ newTabHiddenModules: ['continue'] })))
    expect(cardIds()).toEqual(['downloads', 'bookmarks', 'default-browser'])
    // Re-enabled (the Customise sheet's switch): the card is back in its seat.
    render(stack(state({ newTabHiddenModules: [] })))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'default-browser'])
  })

  it('under reduced motion Hide This cuts the card at once', async () => {
    reduced = true
    render(stack(state()))
    await openMenu('bookmarks')
    pick('Hide This')
    expect(commands('newtab.setModuleHidden')).toEqual([{ id: 'bookmarks', hidden: true }])
    expect(cardIds()).toEqual(['continue', 'downloads', 'default-browser'])
    expect(q('[data-leaving]')).toBeNull()
  })

  it('a card a switch turns on arrives in view: the strip pages to it on the spring, its snapping off for the motion and on again a frame after the rest; the card comes in on the fade’s mirror and the dots follow', () => {
    render(stack(state({ newTabHiddenModules: ['bookmarks'] })))
    expect(cardIds()).toEqual(['continue', 'downloads', 'default-browser'])
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    const scroll = scroller(strip)
    // The switch: the core's list drops the id.
    render(stack(state({ newTabHiddenModules: [] })))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'default-browser'])
    const card = q('.zen-mstack-card[data-cell="bookmarks"]')!
    expect(card.dataset.arriving).toBe('true')
    expect(q('[data-leaving]')).toBeNull()
    // The paging is under way: the snap is off and a frame asked for, nothing written yet.
    expect(snapOf(strip)).toBe('none')
    expect(frames.scheduled).toBe(true)
    expect(scroll.writes).toEqual([])
    // Frame by frame towards the third card's snap position.
    act(() => frames.run(3))
    expect(scroll.writes).toHaveLength(3)
    for (const w of scroll.writes) {
      expect(w).toBeGreaterThan(0)
      expect(w).toBeLessThan(16)
    }
    expect(snapOf(strip)).toBe('none')
    // To the rest, one frame at a time, the frame before each one remembered.
    let before = { snap: '', offset: -1 }
    for (let i = 0; i < 200 && snapOf(strip) === 'none'; i++) {
      before = { snap: snapOf(strip), offset: scroll.offset }
      act(() => frames.run(1))
    }
    // The snap is back, with the offset on the snap position exactly and nothing more to run…
    expect(snapOf(strip)).toBe('')
    expect(scroll.offset).toBe(16)
    expect(scroll.writes.at(-1)).toBe(16)
    expect(frames.scheduled).toBe(false)
    // …a frame after the rest, which had put the offset there with the snap still off.
    expect(before).toEqual({ snap: 'none', offset: 16 })
    // The dots follow the strip to the card.
    act(() => {
      strip.dispatchEvent(new Event('scroll'))
    })
    expect(q('.zen-mstack-dots')!.textContent).toBe('Page 3 of 4')
    expect(qa('.zen-mstack-dot').map((d) => d.hasAttribute('data-current'))).toEqual([
      false,
      false,
      true,
      false
    ])
    // The fade's end takes the arriving mark off.
    act(() => {
      card.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))
    })
    expect(card.hasAttribute('data-arriving')).toBe(false)
  })

  it('a finger on the strip takes the paging over: the spring stops where it is and the snap returns at once', () => {
    render(stack(state({ newTabHiddenModules: ['default-browser'] })))
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    const scroll = scroller(strip)
    render(stack(state({ newTabHiddenModules: [] })))
    expect(q('.zen-mstack-card[data-cell="default-browser"]')!.dataset.arriving).toBe('true')
    // Two frames on the way to the fourth card (24)…
    act(() => frames.run(2))
    const caught = scroll.offset
    expect(caught).toBeGreaterThan(0)
    expect(caught).toBeLessThan(24)
    expect(snapOf(strip)).toBe('none')
    // …and the finger lands: no frame is asked for, the offset stays where it was, the snap is on.
    act(() => {
      strip.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(frames.scheduled).toBe(false)
    expect(snapOf(strip)).toBe('')
    expect(scroll.offset).toBe(caught)
    const written = scroll.writes.length
    act(() => frames.run(3))
    expect(scroll.writes).toHaveLength(written)
  })

  it('under reduced motion the paging is a cut: the offset lands on the card at once and the snap is back a frame later', () => {
    reduced = true
    render(stack(state({ newTabHiddenModules: ['bookmarks'] })))
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    const scroll = scroller(strip)
    render(stack(state({ newTabHiddenModules: [] })))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'default-browser'])
    expect(scroll.offset).toBe(16)
    expect(scroll.writes.every((w) => w === 16)).toBe(true)
    expect(snapOf(strip)).toBe('none')
    act(() => frames.run(1))
    expect(snapOf(strip)).toBe('')
    expect(frames.scheduled).toBe(false)
  })

  it('the pager’s pitch is the arriving card’s layout width, not its client rect – the entrance scales that from .96 for 120 ms – and the last card’s snap position is the strip’s extent, the tail of the card before it still showing', () => {
    reduced = true
    // A laid-out strip: cards 100 wide (a pitch of 108), their rects 96 as the entrance scales
    // them, the strip's extent 300 – short of the fourth card's 324 by the third's tail.
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const rectOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
    const isCard = (el: HTMLElement): boolean => el.classList.contains('zen-mstack-card')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return isCard(this) ? 100 : 0
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement): DOMRect {
        const width = isCard(this) ? 96 : 0
        return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
      }
    })
    const restore = (name: string, original: PropertyDescriptor | undefined): void => {
      if (original) Object.defineProperty(HTMLElement.prototype, name, original)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
    try {
      render(stack(state({ newTabHiddenModules: ['downloads'] })))
      const strip = q<HTMLUListElement>('.zen-mstack-strip')!
      const scroll = scroller(strip)
      Object.defineProperty(strip, 'scrollWidth', { configurable: true, get: () => 700 })
      Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => 400 })
      // Downloads comes back second: one pitch of the layout width, 108 – not 104 off the rect.
      render(stack(state({ newTabHiddenModules: [] })))
      expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'default-browser'])
      expect(scroll.offset).toBe(108)
      act(() => frames.run(1))
      expect(snapOf(strip)).toBe('')
      // The fourth card, gone and back: three pitches would be 324, but the strip stops at 300.
      render(stack(state({ newTabHiddenModules: ['default-browser'] })))
      expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks'])
      render(stack(state({ newTabHiddenModules: [] })))
      expect(q('.zen-mstack-card[data-cell="default-browser"]')!.dataset.arriving).toBe('true')
      expect(scroll.offset).toBe(300)
      expect(scroll.writes.every((w) => w === 108 || w === 300)).toBe(true)
      act(() => frames.run(1))
      expect(snapOf(strip)).toBe('')
      expect(frames.scheduled).toBe(false)
    } finally {
      restore('offsetWidth', offsetWidth)
      restore('getBoundingClientRect', rectOf)
    }
  })

  it('a card a switch turns off leaves as Hide This’s does – the fade, the strip closing the gap, the dots following – and nothing pages; Hide This pages nothing either', async () => {
    render(stack(state()))
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    const scroll = scroller(strip)
    // The switch: the core's list gains the id, the card's own menu having asked nothing.
    render(stack(state({ newTabHiddenModules: ['downloads'] })))
    expect(commands('newtab.setModuleHidden')).toEqual([])
    const leaving = q('.zen-mstack-card[data-cell="downloads"]')!
    expect(leaving.dataset.leaving).toBe('true')
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'default-browser'])
    expect(q('[data-arriving]')).toBeNull()
    expect(scroll.writes).toEqual([])
    expect(snapOf(strip)).toBe('')
    expect(frames.scheduled).toBe(false)
    // The fade's end: the gap closed, a dot fewer, the page read anew.
    act(() => {
      leaving.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))
    })
    expect(cardIds()).toEqual(['continue', 'bookmarks', 'default-browser'])
    expect(qa('.zen-mstack-dot')).toHaveLength(3)
    expect(q('.zen-mstack-dots')!.textContent).toBe('Page 1 of 3')
    expect(scroll.writes).toEqual([])
    // Hide This from a card's menu keeps its rule: the departure under the finger, no paging.
    await openMenu('bookmarks')
    pick('Hide This')
    expect(commands('newtab.setModuleHidden')).toEqual([{ id: 'bookmarks', hidden: true }])
    const hidden = q('.zen-mstack-card[data-cell="bookmarks"]')!
    expect(hidden.dataset.leaving).toBe('true')
    expect(scroll.writes).toEqual([])
    expect(snapOf(strip)).toBe('')
    act(() => {
      hidden.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))
    })
    // The state carries both ids now: the same two cards, no second departure, nothing paged.
    render(stack(state({ newTabHiddenModules: ['downloads', 'bookmarks'] })))
    expect(cardIds()).toEqual(['continue', 'default-browser'])
    expect(q('[data-leaving]')).toBeNull()
    expect(q('[data-arriving]')).toBeNull()
    expect(scroll.writes).toEqual([])
  })

  it('a hidden set that changed by more than one id is no switch’s act: the cards are cut, nothing leaves, arrives or pages', () => {
    render(stack(state({ newTabHiddenModules: ['continue', 'downloads'] })))
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    const scroll = scroller(strip)
    render(stack(state({ newTabHiddenModules: ['bookmarks', 'default-browser'] })))
    expect(cardIds()).toEqual(['continue', 'downloads'])
    expect(q('[data-leaving]')).toBeNull()
    expect(q('[data-arriving]')).toBeNull()
    expect(scroll.writes).toEqual([])
    expect(snapOf(strip)).toBe('')
    expect(frames.scheduled).toBe(false)
  })

  it('the stylesheet: 6 px dots, the current at full ink and the rest at .4 – §9.30’s one dimmed number – and the arrival the leave’s 120 ms mirror', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at, selector).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    const dot = rule(":root[data-form-factor='phone'] .zen-mstack-dot")
    expect(dot).toMatch(/width: 6px;/)
    expect(dot).toMatch(/height: 6px;/)
    expect(dot.match(/opacity: [\d.]+;/g)).toEqual(['opacity: 0.4;'])
    expect(rule(":root[data-form-factor='phone'] .zen-mstack-dot[data-current]")).toMatch(
      /opacity: 1;/
    )
    expect(rule(":root[data-form-factor='phone'] .zen-mstack-card[data-leaving]")).toMatch(
      /animation: zen-mstack-leave 120ms/
    )
    expect(rule(":root[data-form-factor='phone'] .zen-mstack-card[data-arriving]")).toMatch(
      /animation: zen-mstack-arrive 120ms/
    )
    expect(rule('@keyframes zen-mstack-arrive')).toMatch(
      /from \{\s*opacity: 0;\s*transform: scale\(0\.96\);/
    )
  })

  it('Customise opens the sheet of switch rows, one per module the host has; a switch writes the hidden set at once', async () => {
    browserStore.set({ state: state({ newTabHiddenModules: ['downloads'] }) })
    render(
      <FrameDialogHost frame>
        <MagicStack state={browserStore.get().state!} tab={TAB} dock="top" />
        <MagicStackCustomizeLayer />
      </FrameDialogHost>
    )
    expect(q('.zen-sheet[role="dialog"]')).toBeNull()
    await openMenu('continue')
    pick('Customise')
    await settle()
    rest()
    const sheet = q('.zen-sheet[role="dialog"]')
    expect(sheet).not.toBeNull()
    // Titled "Cards", its one section "Show"; Chrome's name for the feature is nowhere on it.
    expect(sheet!.querySelector('h2.zen-sheet-title')?.textContent).toBe('Cards')
    expect(sheet!.querySelector('h3.zen-v2-heading')?.textContent).toBe('Show')
    expect(sheet!.textContent).not.toContain('Magic Stack')
    const switches = qa('[role="switch"]')
    expect(switches.map((s) => s.textContent)).toEqual([
      'Continue where you left offThe tab you closed last, ready to reopen',
      'DownloadsThe file you downloaded last',
      'BookmarksThe bookmarks you added most recently',
      'Default browserA reminder to make Zenium your default browser'
    ])
    expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'true',
      'true'
    ])
    click(switches[1]!)
    expect(commands('newtab.setModuleHidden')).toEqual([{ id: 'downloads', hidden: false }])
    click(switches[3]!)
    expect(commands('newtab.setModuleHidden')).toEqual([
      { id: 'downloads', hidden: false },
      { id: 'default-browser', hidden: true }
    ])
  })

  it('the Customise sheet lists no default-browser row on a host that cannot ask', async () => {
    browserStore.set({
      state: state({
        capabilities: { privateTabs: true, defaultBrowser: false }
      } as Partial<UIState>)
    })
    render(
      <FrameDialogHost frame>
        <MagicStackCustomizeLayer />
      </FrameDialogHost>
    )
    act(() => openMagicStackCustomize())
    await settle()
    rest()
    expect(qa('[role="switch"]').map((s) => s.textContent?.split('The')[0])).toEqual([
      'Continue where you left off',
      'Downloads',
      'Bookmarks'
    ])
  })

  it('the page’s gear sheet seats its Cards row first, above Layout with a hairline after it – the way to the switches once every card is hidden; it leaves first and the stack’s sheet comes up as it has gone', async () => {
    browserStore.set({
      state: state({
        settings: { newTab: structuredClone(DEFAULT_NEW_TAB_SETTINGS) },
        newTabHiddenModules: ['continue', 'downloads', 'bookmarks', 'default-browser']
      } as Partial<UIState>)
    })
    // The page is under its cover already: the gear sheet presents (and so leaves on a spring).
    pageViewStore.set({ phases: new Map([['r', 'hidden']]), lastApplied: null })
    render(
      <FrameDialogHost frame>
        <NewTabCustomizeLayer />
        <MagicStackCustomizeLayer />
      </FrameDialogHost>
    )
    act(() => openCustomize())
    await flush()
    rest()
    const gear = q('.zen-sheet[role="dialog"]')!
    expect(gear.querySelector('h2.zen-sheet-title')?.textContent).toBe('New tab page')
    const row = qa('.zen-sheet[role="dialog"] .zen-v2-row').find((r) =>
      r.textContent?.startsWith('Cards')
    )
    expect(row).toBeDefined()
    expect(row!.dataset.row).toBe('magic-stack')
    expect(row!.textContent).toContain('Choose which cards show under the shortcuts')
    expect(gear.textContent).not.toContain('Magic Stack')
    // The seat (§9.13: a control panel's action rows first): the row is the body's first child,
    // a hairline the second, the Layout section – the first heading – the third, so the sheet
    // at its rest height shows the row and the fold cuts Layout's grid.
    const body = gear.querySelector('.zen-ntp-customize')!
    const [first, second, third] = [...body.children] as HTMLElement[]
    expect(first).toBe(row)
    expect(second!.classList.contains('zen-sheet-sep')).toBe(true)
    expect(second!.getAttribute('aria-hidden')).toBe('true')
    expect(third!.classList.contains('zen-v2-section')).toBe(true)
    expect(third!.querySelector('h3.zen-v2-heading')?.textContent).toBe('Layout')
    expect(qa('.zen-sheet[role="dialog"] h3.zen-v2-heading')[0]!.textContent).toBe('Layout')
    // One Cards row on the sheet: the Show section's foot no longer carries a copy.
    expect(qa('.zen-sheet[role="dialog"] [data-row="magic-stack"]')).toHaveLength(1)
    click(row!)
    // One sheet over the page (§9.24): the stack's waits for the gear's landing.
    expect(magicStackCustomizeStore.get().open).toBe(false)
    expect(frames.scheduled).toBe(true)
    rest()
    expect(magicStackCustomizeStore.get().open).toBe(true)
    await flush()
    rest()
    const sheets = qa('.zen-sheet[role="dialog"]')
    expect(sheets.map((s) => s.querySelector('h2.zen-sheet-title')?.textContent)).toEqual(['Cards'])
    expect(qa('[role="switch"]').map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'false',
      'false'
    ])
  })
})
