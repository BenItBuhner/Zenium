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
  Folder,
  MagicStackModuleId,
  RevokedSitePermissions,
  Tab,
  UIState
} from '@shared/types'
import { emptyPasswordsStatus } from '@shared/defaults'
import {
  EDUCATIONAL_TIP_ANY_INTERVAL_MS,
  EDUCATIONAL_TIP_CARD_INTERVAL_MS,
  emptyEducationalTipMemory,
  type EducationalTipCardId,
  type EducationalTipMemory
} from '@shared/educationalTips'
import { DEFAULT_NEW_TAB_SETTINGS } from '@shared/newTab'
import { DEFAULT_PRIVACY_SETTINGS } from '@shared/privacy'
import {
  emptySafetyHubCardMemory,
  pickSafetyHubCard,
  type SafetyHubCardMemories,
  type SafetyHubCardMemory
} from '@shared/safetyHubCard'
import { BLANK_URL } from '@shared/url'
import { viewportStore } from '@renderer/lib/formFactor'
import { dismissOverview, stageStore } from '@renderer/lib/gestures/stage'
import { closeCustomize, customizeStore, openCustomize } from '@renderer/lib/newtab'
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
 * The fixture's phone has a tip to show (the default page: the theme card), so the tip card is
 * the stack's fourth; the tip card's own tests are NTP-20's block below.
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

  /**
   * Drop whatever a test left queued and start the clock over: a test that failed mid-spring
   * leaves its frames here, and run into the next test they would fail it too (a cascade of
   * three for one, measured on the pitch test's mutants).
   */
  reset(): void {
    this.queue.clear()
    this.now = 0
    this.seq = 0
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
    settings: {
      privacy: structuredClone(DEFAULT_PRIVACY_SETTINGS),
      newTab: structuredClone(DEFAULT_NEW_TAB_SETTINGS)
    },
    recentlyClosed: [CLOSED],
    downloads: [DOWNLOAD],
    bookmarks: BOOKMARKS,
    defaultBrowser: { isDefault: false, prompt: null },
    newTabHiddenModules: [],
    newTabSafetyHubCard: {},
    newTabEducationalTips: emptyEducationalTipMemory(),
    revokedUnusedPermissions: [],
    passwords: emptyPasswordsStatus(),
    ...over
  } as unknown as UIState
}

/** A tip shown this instant: the module rests three days, so no tip card is drawn. */
const TIPS_RESTING = (): EducationalTipMemory => ({
  ...emptyEducationalTipMemory(),
  shownAt: Date.now()
})

/** The tip card's face, in Chrome's words for the theme card the fixture's phone gets first. */
const THEME_TIP_LABEL =
  'Zenium tips: Customise your homepage. Make Zenium your own with custom colours and images for your homepage'

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
function scroller(
  strip: HTMLElement,
  at = 0
): { writes: number[]; readonly offset: number; move(to: number): void } {
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
    },
    /** The engine's own move of the offset (a re-snap at a layout change): no write of the pager's. */
    move(to: number) {
      offset = to
    }
  }
}

/** The content frame's box at rest, for a strip laid out under it (`layOut`). */
const FRAME = { width: 400, height: 800 }

/**
 * A strip laid out, for the tracker to measure: every card 100 wide at 100 times its place in
 * the content, painted at that less `offset()` – the strip's offset – and every other box
 * empty. With `recede()` set, the content frame stands receded (§11.1): the frame paints at the
 * scale about its origin, and so does every card in it. Returns the way to put the prototype back.
 */
function layOut(
  offset: () => number,
  recede: () => { scale: number; origin: { x: number; y: number } } | null = () => null
): () => void {
  const rectOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
  const box = (x: number, y: number, width: number, height: number): DOMRect =>
    ({ x, y, top: y, left: x, right: x + width, bottom: y + height, width, height }) as DOMRect
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const r = recede()
      const s = r?.scale ?? 1
      const dx = r ? (1 - s) * r.origin.x : 0
      const dy = r ? (1 - s) * r.origin.y : 0
      if (this.classList.contains('zen-content-frame'))
        return box(dx, dy, FRAME.width * s, FRAME.height * s)
      if (!this.classList.contains('zen-mstack-card')) return box(0, 0, 0, 0)
      const index = Array.prototype.indexOf.call(this.parentElement!.children, this)
      return box(dx + s * (index * 100 - offset()), dy, 100 * s, 0)
    }
  })
  return () => {
    if (rectOf) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', rectOf)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect
  }
}

const transforms = (): string[] => cards().map((c) => c.style.transform)

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
  uiStore.set({ menu: null, clearBrowsingDataOpen: false })
  closeMagicStackCustomize()
  closeCustomize()
  dismissOverview()
  browserStore.set({ state: null })
  pageViewStore.set({ phases: new Map(), lastApplied: null })
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
  vi.unstubAllGlobals()
  frames.reset()
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('the Magic Stack on the page (NTP-16)', () => {
  it('draws one card per module with content, in the stack’s order, each a page surface named for TalkBack, the strip a carousel with a dot per page', () => {
    render(stack(state()))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
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
      THEME_TIP_LABEL
    ])
    // Every ⋮ names its module; the shared 44 icon button.
    expect(qa('.zen-mstack-more').map((b) => b.getAttribute('aria-label'))).toEqual([
      'More options for Continue where you left off',
      'More options for Downloads',
      'More options for Bookmarks',
      'More options for Zenium tips'
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
          newTabEducationalTips: TIPS_RESTING()
        })
      )
    )
    expect(q('.zen-mstack')).toBeNull()
    render(stack(state({ newTabHiddenModules: ['continue', 'downloads', 'bookmarks', 'tips'] })))
    expect(q('.zen-mstack')).toBeNull()
    // One card alone: no dots.
    render(stack(state({ newTabHiddenModules: ['continue', 'bookmarks', 'tips'] })))
    expect(cardIds()).toEqual(['downloads'])
    expect(q('.zen-mstack-dots')).toBeNull()
  })

  it('one action a card, and only one its rows do not already do: See all on Downloads and Bookmarks, the tip’s button, none on Continue; the rows reopen, open and open', () => {
    render(stack(state()))
    const buttons = qa<HTMLButtonElement>('.zen-mstack-action')
    expect(buttons.map((b) => b.textContent)).toEqual(['See all', 'See all', 'Try it now'])
    expect(qa('.zen-mstack-actions').map((a) => a.closest('li')?.dataset.cell)).toEqual([
      'downloads',
      'bookmarks',
      'tips'
    ])
    expect(q('.zen-mstack-card[data-cell="continue"] .zen-mstack-actions')).toBeNull()
    // The tip's primary opens what the tip is about: the theme card, the page's Customise sheet.
    click(buttons[2]!)
    expect(customizeStore.get().open).toBe(true)
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
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
    // The fade's end takes it out, the state not yet back.
    act(() => {
      leaving.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))
    })
    expect(cardIds()).toEqual(['downloads', 'bookmarks', 'tips'])
    // A state publish without the id yet (another field moved) does not bring the card back.
    render(stack(state({ newTabHiddenModules: [] })))
    expect(cardIds()).toEqual(['downloads', 'bookmarks', 'tips'])
    // The core's list arrives with the id: the same three.
    render(stack(state({ newTabHiddenModules: ['continue'] })))
    expect(cardIds()).toEqual(['downloads', 'bookmarks', 'tips'])
    // Re-enabled (the Customise sheet's switch): the card is back in its seat.
    render(stack(state({ newTabHiddenModules: [] })))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
  })

  it('under reduced motion Hide This cuts the card at once', async () => {
    reduced = true
    render(stack(state()))
    await openMenu('bookmarks')
    pick('Hide This')
    expect(commands('newtab.setModuleHidden')).toEqual([{ id: 'bookmarks', hidden: true }])
    expect(cardIds()).toEqual(['continue', 'downloads', 'tips'])
    expect(q('[data-leaving]')).toBeNull()
  })

  it('a card a switch turns on arrives in view: the strip pages to it on the spring, its snapping off for the motion and on again a frame after the rest; the card comes in on the fade’s mirror and the dots follow', () => {
    render(stack(state({ newTabHiddenModules: ['bookmarks'] })))
    expect(cardIds()).toEqual(['continue', 'downloads', 'tips'])
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    const scroll = scroller(strip)
    // The switch: the core's list drops the id.
    render(stack(state({ newTabHiddenModules: [] })))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
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
    render(stack(state({ newTabHiddenModules: ['tips'] })))
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    const scroll = scroller(strip)
    render(stack(state({ newTabHiddenModules: [] })))
    expect(q('.zen-mstack-card[data-cell="tips"]')!.dataset.arriving).toBe('true')
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
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
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
      expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
      expect(scroll.offset).toBe(108)
      act(() => frames.run(1))
      expect(snapOf(strip)).toBe('')
      // The fourth card, gone and back: three pitches would be 324, but the strip stops at 300.
      render(stack(state({ newTabHiddenModules: ['tips'] })))
      expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks'])
      render(stack(state({ newTabHiddenModules: [] })))
      expect(q('.zen-mstack-card[data-cell="tips"]')!.dataset.arriving).toBe('true')
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
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
    expect(q('[data-arriving]')).toBeNull()
    expect(scroll.writes).toEqual([])
    expect(snapOf(strip)).toBe('')
    expect(frames.scheduled).toBe(false)
    // The fade's end: the gap closed, a dot fewer, the page read anew.
    act(() => {
      leaving.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))
    })
    expect(cardIds()).toEqual(['continue', 'bookmarks', 'tips'])
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
    expect(cardIds()).toEqual(['continue', 'tips'])
    expect(q('[data-leaving]')).toBeNull()
    expect(q('[data-arriving]')).toBeNull()
    expect(scroll.writes).toEqual([])
  })

  it('the departure’s glide – the cards after the gone one closing the gap – runs with the strip’s snapping off and on again a frame after its rest: Chromium re-snaps a mandatory container to a transformed card on every frame, which would hold the card at the gap’s edge; nothing pages', () => {
    // A laid-out strip: each card 100 wide at 100 times its place, so a card gone moves the ones
    // after it by a pitch – a glide of 100 (the tracker measures the painted box: no frame here).
    const rectOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement): DOMRect {
        const card = this.classList.contains('zen-mstack-card')
        const index = card ? Array.prototype.indexOf.call(this.parentElement!.children, this) : 0
        const x = index * 100
        const width = card ? 100 : 0
        return {
          x,
          y: 0,
          top: 0,
          left: x,
          right: x + width,
          bottom: 0,
          width,
          height: 0
        } as DOMRect
      }
    })
    try {
      render(stack(state()))
      const strip = q<HTMLUListElement>('.zen-mstack-strip')!
      const scroll = scroller(strip)
      expect(snapOf(strip)).toBe('')
      // The switch turns Downloads off: the fade, the snap still on – nothing has moved yet.
      render(stack(state({ newTabHiddenModules: ['downloads'] })))
      const leaving = q('.zen-mstack-card[data-cell="downloads"]')!
      expect(leaving.dataset.leaving).toBe('true')
      expect(snapOf(strip)).toBe('')
      expect(frames.scheduled).toBe(false)
      // The fade's end takes the card out: the two after it are drawn where they were, a pitch
      // to the right of their new slots, the glide under way and the snap off for it.
      act(() => {
        leaving.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))
      })
      expect(cardIds()).toEqual(['continue', 'bookmarks', 'tips'])
      const glided = (): string[] =>
        ['bookmarks', 'tips'].map((id) => q(`.zen-mstack-card[data-cell="${id}"]`)!.style.transform)
      expect(glided()).toEqual(['translate(100px, 0px)', 'translate(100px, 0px)'])
      expect(q('.zen-mstack-card[data-cell="continue"]')!.style.transform).toBe('')
      expect(snapOf(strip)).toBe('none')
      expect(frames.scheduled).toBe(true)
      expect(scroll.writes).toEqual([])
      // Frame by frame to the slots, the snap off throughout, the frame before each remembered.
      act(() => frames.run(2))
      for (const t of glided()) {
        const x = Number.parseFloat(t.slice('translate('.length))
        expect(x).toBeGreaterThan(0)
        expect(x).toBeLessThan(100)
      }
      expect(snapOf(strip)).toBe('none')
      let before = { snap: '', transforms: ['?'] }
      for (let i = 0; i < 200 && snapOf(strip) === 'none'; i++) {
        before = { snap: snapOf(strip), transforms: glided() }
        act(() => frames.run(1))
      }
      // The snap is back a frame after the rest, which had drawn the cards in their slots with
      // the snap still off; the offset was never written – the departure pages nothing.
      expect(snapOf(strip)).toBe('')
      expect(before).toEqual({ snap: 'none', transforms: ['', ''] })
      expect(glided()).toEqual(['', ''])
      expect(frames.scheduled).toBe(false)
      expect(scroll.writes).toEqual([])
    } finally {
      if (rectOf) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', rectOf)
      else
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect
    }
  })

  it('the cards are measured in layout space: the content frame receded under the sheet (§11.1) between the baseline and a switch’s act paints every card moved, and none of that glides – the card before the gone one stands, the two after it glide by the pitch alone', () => {
    // The frame at rest for the baseline; then the sheet up and the frame receded – scale .97
    // about its centre – so every card paints 6 to the right less 3 % of its place. The layout
    // box run back through the frame's transform is where the card was; the painted box is not.
    let recede: { scale: number; origin: { x: number; y: number } } | null = null
    const restore = layOut(
      () => 0,
      () => recede
    )
    try {
      const page = (s: UIState): ReactElement => <div className="zen-content-frame">{stack(s)}</div>
      render(page(state()))
      expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
      const frame = q('.zen-content-frame')!
      frame.style.transform = 'matrix(0.97, 0, 0, 0.97, 0, 0)'
      frame.style.transformOrigin = '200px 400px'
      recede = { scale: 0.97, origin: { x: 200, y: 400 } }
      // The switch turns Downloads off from under the sheet: the fade, and nothing else moves –
      // as painted every card has (by the recede), as laid out none has.
      render(page(state({ newTabHiddenModules: ['downloads'] })))
      const leaving = q('.zen-mstack-card[data-cell="downloads"]')!
      expect(leaving.dataset.leaving).toBe('true')
      expect(transforms()).toEqual(['', '', '', ''])
      expect(frames.scheduled).toBe(false)
      // The fade's end: the two after the gone card glide by its pitch, the one before it stands.
      act(() => {
        leaving.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }))
      })
      expect(cardIds()).toEqual(['continue', 'bookmarks', 'tips'])
      expect(transforms()).toEqual(['', 'translate(100px, 0px)', 'translate(100px, 0px)'])
      rest()
      expect(transforms()).toEqual(['', '', ''])
    } finally {
      restore()
    }
  })

  it('a card brought back ahead of the one in view (W6-4b’s finding 4), under an engine that keeps its snapped card through the layout change: the offset moves by a pitch under the commit, the card in view stands still – no transform ever written on it – and the strip pages back to the arrival on the spring', () => {
    let scroll: ReturnType<typeof scroller> | null = null
    const restore = layOut(() => scroll?.offset ?? 0)
    try {
      render(stack(state({ newTabHiddenModules: ['continue'] })))
      expect(cardIds()).toEqual(['downloads', 'bookmarks', 'tips'])
      const strip = q<HTMLUListElement>('.zen-mstack-strip')!
      scroll = scroller(strip)
      Object.defineProperty(strip, 'scrollWidth', {
        configurable: true,
        get: () => strip.children.length * 100
      })
      Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => 100 })
      // The switch brings Continue back ahead of the Downloads card in view. The engine keeps
      // Downloads snapped: as the commit is laid out the offset stands a pitch to the right, by
      // no write of the pager's (WebView in run 3 – the card kept, the offset 328).
      scroll.move(100)
      render(stack(state({ newTabHiddenModules: [] })))
      expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
      expect(q('.zen-mstack-card[data-cell="continue"]')!.dataset.arriving).toBe('true')
      const inView = q('.zen-mstack-card[data-cell="downloads"]')!
      // Nothing glides: the baseline followed the offset, and the card in view is where it was.
      expect(transforms()).toEqual(['', '', '', ''])
      // The paging back is under way, the snap off for it, nothing written yet.
      expect(snapOf(strip)).toBe('none')
      expect(frames.scheduled).toBe(true)
      expect(scroll.writes).toEqual([])
      let before = { snap: '', offset: -1 }
      for (let i = 0; i < 200 && snapOf(strip) === 'none'; i++) {
        before = { snap: snapOf(strip), offset: scroll.offset }
        act(() => frames.run(1))
        // Frame by frame to the first card, the card in view carried by the offset alone.
        expect(inView.style.transform).toBe('')
      }
      expect(scroll.writes.length).toBeGreaterThan(3)
      expect(scroll.writes[0]).toBeLessThan(100)
      expect(scroll.offset).toBe(0)
      expect(snapOf(strip)).toBe('')
      expect(before).toEqual({ snap: 'none', offset: 0 })
      expect(frames.scheduled).toBe(false)
      expect(transforms()).toEqual(['', '', '', ''])
      act(() => {
        strip.dispatchEvent(new Event('scroll'))
      })
      expect(q('.zen-mstack-dots')!.textContent).toBe('Page 1 of 4')
      // The fade's end is one more commit, at the new offset: nothing moved, nothing glides.
      act(() => {
        q('.zen-mstack-card[data-cell="continue"]')!.dispatchEvent(
          new AnimationEvent('animationend', { bubbles: true })
        )
      })
      expect(q('[data-arriving]')).toBeNull()
      expect(transforms()).toEqual(['', '', '', ''])
      expect(frames.scheduled).toBe(false)
    } finally {
      restore()
    }
  })

  it('a card brought back ahead of the one in view, under an engine that leaves the offset where it was: the card in view is drawn where it was and glides a pitch to its slot – never a jump – as the arrival fades in at the head; nothing pages, the offset being the arrival’s snap position already', () => {
    let scroll: ReturnType<typeof scroller> | null = null
    const restore = layOut(() => scroll?.offset ?? 0)
    try {
      render(stack(state({ newTabHiddenModules: ['continue'] })))
      const strip = q<HTMLUListElement>('.zen-mstack-strip')!
      scroll = scroller(strip)
      Object.defineProperty(strip, 'scrollWidth', {
        configurable: true,
        get: () => strip.children.length * 100
      })
      Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => 100 })
      render(stack(state({ newTabHiddenModules: [] })))
      expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
      const inView = q('.zen-mstack-card[data-cell="downloads"]')!
      // Drawn where they were, a pitch to the left of their new slots; the arrival at the head.
      expect(transforms()).toEqual([
        '',
        'translate(-100px, 0px)',
        'translate(-100px, 0px)',
        'translate(-100px, 0px)'
      ])
      expect(scroll.writes).toEqual([])
      expect(snapOf(strip)).toBe('none')
      expect(frames.scheduled).toBe(true)
      act(() => frames.run(2))
      const x = Number.parseFloat(inView.style.transform.slice('translate('.length))
      expect(x).toBeGreaterThan(-100)
      expect(x).toBeLessThan(0)
      let before = { snap: '', transform: '?' }
      for (let i = 0; i < 200 && snapOf(strip) === 'none'; i++) {
        before = { snap: snapOf(strip), transform: inView.style.transform }
        act(() => frames.run(1))
      }
      expect(snapOf(strip)).toBe('')
      expect(before).toEqual({ snap: 'none', transform: '' })
      expect(transforms()).toEqual(['', '', '', ''])
      expect(frames.scheduled).toBe(false)
      expect(scroll.writes).toEqual([])
      expect(scroll.offset).toBe(0)
      act(() => {
        strip.dispatchEvent(new Event('scroll'))
      })
      expect(q('.zen-mstack-dots')!.textContent).toBe('Page 1 of 4')
    } finally {
      restore()
    }
  })

  it('a hidden set that changed by more than one id is no switch’s act: the cards are cut, nothing leaves, arrives or pages', () => {
    render(stack(state({ newTabHiddenModules: ['continue', 'downloads'] })))
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    const scroll = scroller(strip)
    render(stack(state({ newTabHiddenModules: ['bookmarks', 'tips'] })))
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
      /animation: zen-mstack-leave var\(--zen-motion-state\)/
    )
    expect(rule(":root[data-form-factor='phone'] .zen-mstack-card[data-arriving]")).toMatch(
      /animation: zen-mstack-arrive var\(--zen-motion-state\)/
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
      'Safety checkPermissions removed from unused sites, Safe Browsing off, compromised passwords',
      'Zenium tipsOne tip at a time: customising the page, the default browser, tab groups, deleting browsing data'
    ])
    expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'true',
      'true',
      'true'
    ])
    click(switches[1]!)
    expect(commands('newtab.setModuleHidden')).toEqual([{ id: 'downloads', hidden: false }])
    click(switches[4]!)
    expect(commands('newtab.setModuleHidden')).toEqual([
      { id: 'downloads', hidden: false },
      { id: 'tips', hidden: true }
    ])
  })

  it('the Customise sheet lists the tips row on a host that cannot ask for the browser role too: the other tips need nothing of the host (Chrome’s one switch for every tip)', async () => {
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
    expect(
      qa('[role="switch"]').map((s) => s.querySelector('.zen-settings-label')?.textContent)
    ).toEqual([
      'Continue where you left off',
      'Downloads',
      'Bookmarks',
      'Safety check',
      'Zenium tips'
    ])
  })

  it('the page’s gear sheet seats its Cards row first, above Layout with a hairline after it – the way to the switches once every card is hidden; it leaves first and the stack’s sheet comes up as it has gone', async () => {
    browserStore.set({
      state: state({
        settings: { newTab: structuredClone(DEFAULT_NEW_TAB_SETTINGS) },
        newTabHiddenModules: ['continue', 'downloads', 'bookmarks', 'safety-hub', 'tips']
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
      'false',
      'false'
    ])
  })
})

/*
 * The Safety check card (NTP-19; Chrome's Safety Hub module): one of Chrome's types at a time,
 * picked by the shared machine at the stack's mount from the memory the device holds and the
 * state's revoked permissions, Safe Browsing switch and compromised count; the pick's memory
 * written back once; the card's face – the tile, the title, the summary, the primary button –
 * in Chrome's words; the button's route per type, Review leaving the run to its course and the
 * other two ending it; Safe Browsing back on or the count gone ending the run while the card is
 * up; a hidden module making no impression and the switch bringing it back making one.
 */
describe('the Safety check card (NTP-19)', () => {
  const DAY = 24 * 3_600_000
  const NOW = Date.UTC(2026, 8, 27, 12)
  const REVOKED: RevokedSitePermissions[] = [
    {
      origin: 'https://forum.example',
      permissions: ['geolocation'],
      revokedAt: NOW - 2 * DAY,
      expiresAt: NOW + 28 * DAY
    }
  ]
  let clock: ReturnType<typeof vi.spyOn> | null = null

  /** The state with the safety inputs given; everything else as the fixture has it. */
  function safety(over: {
    revoked?: RevokedSitePermissions[]
    safeBrowsing?: boolean
    compromised?: number
    memories?: SafetyHubCardMemories
    hidden?: MagicStackModuleId[]
  }): UIState {
    return state({
      settings: {
        privacy: {
          ...structuredClone(DEFAULT_PRIVACY_SETTINGS),
          safeBrowsingEnabled: over.safeBrowsing ?? true
        },
        newTab: structuredClone(DEFAULT_NEW_TAB_SETTINGS)
      },
      revokedUnusedPermissions: over.revoked ?? [],
      passwords: {
        ...emptyPasswordsStatus(),
        checkupSummary: {
          ...emptyPasswordsStatus().checkupSummary,
          compromised: over.compromised ?? 0
        }
      },
      newTabSafetyHubCard: over.memories ?? {},
      newTabHiddenModules: over.hidden ?? []
    } as Partial<UIState>)
  }

  const memoryWrites = (): SafetyHubCardMemories[] =>
    (commands('newtab.setSafetyHubCardMemory') as Array<{ memories: SafetyHubCardMemories }>).map(
      (c) => c.memories
    )
  const card = (): HTMLElement | null => q('.zen-mstack-card[data-cell="safety-hub"]')
  const button = (): HTMLElement | null =>
    q('.zen-mstack-card[data-cell="safety-hub"] .zen-mstack-action')

  beforeEach(() => {
    clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    clock?.mockRestore()
    clock = null
  })

  it('draws the revoked-permissions card after the content modules, in Chrome’s words, with the impression written once', () => {
    render(stack(safety({ revoked: REVOKED })))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'safety-hub', 'tips'])
    const c = card()!
    expect(c.getAttribute('aria-label')).toBe('Safety check: Removed permissions for 1 site')
    expect(c.querySelector('.zen-mstack-title')?.textContent).toBe('Safety check')
    const face = c.querySelector<HTMLElement>('.zen-mstack-safety')!
    expect(face.dataset.type).toBe('revoked-permissions')
    expect(face.querySelector('.zen-mstack-safety-tile svg')).not.toBeNull()
    expect(face.querySelector('.zen-mstack-safety-tile')?.getAttribute('aria-hidden')).toBe('true')
    expect(face.querySelector('.zen-mstack-safety-title')?.textContent).toBe(
      'Removed permissions for 1 site'
    )
    // Chrome's revoked card carries no summary line.
    expect(face.querySelector('.zen-mstack-safety-summary')).toBeNull()
    const b = button()!
    expect(b.textContent).toBe('Review')
    expect(b.getAttribute('aria-label')).toBe('Review Safety check')
    expect(b.dataset.primary).toBe('true')
    expect(c.querySelector('.zen-mstack-more')?.getAttribute('aria-label')).toBe(
      'More options for Safety check'
    )
    // The impression: the run started now, one impression, the other records begun (Safe
    // Browsing's with its day), and nothing written twice.
    const writes = memoryWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0]!['revoked-permissions']).toEqual({
      ...emptySafetyHubCardMemory(),
      activeSince: NOW,
      impressions: 1,
      lastShownAt: NOW,
      result: 'https://forum.example'
    })
    expect(writes[0]!['safe-browsing']).toEqual({
      ...emptySafetyHubCardMemory(),
      showAfter: NOW + DAY,
      result: 'on'
    })
    expect(writes[0]!.passwords).toEqual({ ...emptySafetyHubCardMemory(), result: '0' })
  })

  it('Review opens Settings on the Safety check group and leaves the run to its course', () => {
    render(stack(safety({ revoked: REVOKED })))
    click(button())
    expect(commands('page.open')).toEqual([
      { id: 'settings', section: 'privacy', query: { group: 'safety-check' } }
    ])
    expect(memoryWrites()).toHaveLength(1)
    expect(card()).not.toBeNull()
  })

  it('picks by priority: the passwords over Safe Browsing over the revoked permissions; Change passwords opens the checkup and ends the run', async () => {
    render(stack(safety({ revoked: REVOKED, safeBrowsing: false, compromised: 2 })))
    const c = card()!
    expect(c.getAttribute('aria-label')).toBe(
      'Safety check: Change passwords. Found 2 compromised passwords'
    )
    expect(c.querySelector<HTMLElement>('.zen-mstack-safety')?.dataset.type).toBe('passwords')
    expect(c.querySelector('.zen-mstack-safety-title')?.textContent).toBe('Change passwords')
    expect(c.querySelector('.zen-mstack-safety-summary')?.textContent).toBe(
      'Found 2 compromised passwords'
    )
    expect(button()!.textContent).toBe('Change passwords')
    expect(button()!.getAttribute('aria-label')).toBe('Change passwords')
    click(button())
    await flush()
    expect(uiStore.get().overlay).toBe('passwords')
    expect(uiStore.get().overlaySection).toBe('checkup')
    // The run ends: dismissed in the memory, the card gone from the stack.
    const writes = memoryWrites()
    expect(writes).toHaveLength(2)
    expect(writes[1]!.passwords).toMatchObject({ activeSince: null, impressions: 0, runs: 1 })
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
  })

  it('the Safe Browsing card waits its day, then Go to settings opens the Safe Browsing group and ends the run', () => {
    // The first look after the switch went off: the record starts with its day, no card.
    render(stack(safety({ safeBrowsing: false })))
    expect(card()).toBeNull()
    expect(memoryWrites()).toHaveLength(1)
    expect(memoryWrites()[0]!['safe-browsing']).toMatchObject({
      showAfter: NOW + DAY,
      result: 'off'
    })
    act(() => root!.unmount())
    root = null
    run.mockClear()
    // The day passed: the card, in Chrome's words.
    const waited: SafetyHubCardMemory = {
      ...emptySafetyHubCardMemory(),
      showAfter: NOW - 1,
      result: 'off'
    }
    render(stack(safety({ safeBrowsing: false, memories: { 'safe-browsing': waited } })))
    const c = card()!
    expect(c.getAttribute('aria-label')).toBe(
      'Safety check: Turn on Safe Browsing. Safe Browsing is off'
    )
    expect(c.querySelector<HTMLElement>('.zen-mstack-safety')?.dataset.type).toBe('safe-browsing')
    expect(c.querySelector('.zen-mstack-safety-summary')?.textContent).toBe('Safe Browsing is off')
    expect(button()!.textContent).toBe('Go to settings')
    click(button())
    expect(commands('page.open')).toEqual([
      { id: 'settings', section: 'privacy', query: { group: 'safe-browsing' } }
    ])
    const writes = memoryWrites()
    expect(writes).toHaveLength(2)
    expect(writes[0]!['safe-browsing']).toMatchObject({ activeSince: NOW, impressions: 1 })
    expect(writes[1]!['safe-browsing']).toMatchObject({
      activeSince: null,
      impressions: 0,
      runs: 1
    })
    expect(card()).toBeNull()
  })

  it('Safe Browsing switched back on while the card is up ends the run: the card leaves, the memory is dismissed', () => {
    const waited: SafetyHubCardMemory = {
      ...emptySafetyHubCardMemory(),
      showAfter: NOW - 1,
      result: 'off'
    }
    render(stack(safety({ safeBrowsing: false, memories: { 'safe-browsing': waited } })))
    expect(card()).not.toBeNull()
    render(stack(safety({ safeBrowsing: true, memories: memoryWrites()[0]! })))
    expect(card()).toBeNull()
    const writes = memoryWrites()
    expect(writes).toHaveLength(2)
    expect(writes[1]!['safe-browsing']).toMatchObject({ activeSince: null, runs: 1, result: 'off' })
    // Off again in the same mount: nothing re-picks (Chrome's mHasBeenDismissed).
    render(stack(safety({ safeBrowsing: false, memories: writes[1]! })))
    expect(card()).toBeNull()
    expect(memoryWrites()).toHaveLength(2)
  })

  it('the compromised count reaching zero while the passwords card is up ends the run the same way', () => {
    render(stack(safety({ compromised: 1 })))
    expect(card()).not.toBeNull()
    render(stack(safety({ compromised: 0, memories: memoryWrites()[0]! })))
    expect(card()).toBeNull()
    expect(memoryWrites()).toHaveLength(2)
    expect(memoryWrites()[1]!.passwords).toMatchObject({ activeSince: null, runs: 1 })
  })

  it('a run on the record continues at the mount: the card holds and the impression counts', () => {
    const running: SafetyHubCardMemory = {
      ...emptySafetyHubCardMemory(),
      activeSince: NOW - DAY,
      impressions: 2,
      lastShownAt: NOW - DAY,
      result: 'https://forum.example'
    }
    render(stack(safety({ revoked: REVOKED, memories: { 'revoked-permissions': running } })))
    expect(card()).not.toBeNull()
    expect(memoryWrites()[0]!['revoked-permissions']).toMatchObject({
      activeSince: NOW - DAY,
      impressions: 3,
      lastShownAt: NOW
    })
  })

  it('writes nothing when the record is settled already', () => {
    const inputs = { revokedOrigins: [], safeBrowsingEnabled: true, compromisedPasswords: 0 }
    const once = pickSafetyHubCard(inputs, {}, NOW).memories
    const settled = pickSafetyHubCard(inputs, once, NOW).memories
    render(stack(safety({ memories: settled })))
    expect(card()).toBeNull()
    expect(memoryWrites()).toEqual([])
  })

  it('a hidden module makes no impression; the Cards sheet’s switch bringing it back makes one', () => {
    render(stack(safety({ revoked: REVOKED, hidden: ['safety-hub'] })))
    expect(card()).toBeNull()
    expect(memoryWrites()).toEqual([])
    // The switch: the module back, picked and written in its own impression.
    render(stack(safety({ revoked: REVOKED })))
    const writes = memoryWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0]!['revoked-permissions']).toMatchObject({ activeSince: NOW, impressions: 1 })
    // The card reads the record its impression wrote, as the state publishes it.
    render(stack(safety({ revoked: REVOKED, memories: writes[0]! })))
    expect(card()).not.toBeNull()
    expect(card()!.querySelector('.zen-mstack-safety-title')?.textContent).toBe(
      'Removed permissions for 1 site'
    )
    expect(memoryWrites()).toHaveLength(1)
  })

  it('the Cards sheet lists the module as Safety check with its description', async () => {
    browserStore.set({ state: safety({ revoked: REVOKED }) })
    render(
      <FrameDialogHost frame>
        <MagicStack state={browserStore.get().state!} tab={TAB} dock="top" />
        <MagicStackCustomizeLayer />
      </FrameDialogHost>
    )
    await openMenu('safety-hub')
    pick('Customise')
    await settle()
    rest()
    const row = qa('[role="switch"]').find(
      (s) => s.querySelector('.zen-settings-label')?.textContent === 'Safety check'
    )!
    expect(row).toBeDefined()
    expect(row.textContent).toContain(
      'Permissions removed from unused sites, Safe Browsing off, compromised passwords'
    )
    expect(row.getAttribute('aria-checked')).toBe('true')
    click(row)
    expect(commands('newtab.setModuleHidden')).toEqual([{ id: 'safety-hub', hidden: true }])
  })
})

/*
 * The tip card (NTP-20; Chrome's educational tip module): one of Chrome's four cards at a time,
 * picked by the shared machine at the stack's mount in Chrome's priority – the theme, the
 * default browser, tab groups, Quick Delete – from the signals the state already publishes and
 * the memory the device holds; the impression written back once; the card's face in Chrome's
 * words, spelt as this surface spells; the button opening what the tip is about and retiring
 * the card for good; a signal cleared under the card taking it down; the cadence (a tip once in
 * three days, a card once in seven, the caps, a tap) keeping the module quiet; a hidden module
 * making no impression and the switch bringing it back making one.
 */
describe('the tip card (NTP-20)', () => {
  const DAY = 24 * 3_600_000
  const NOW = Date.UTC(2026, 8, 27, 12)
  let clock: ReturnType<typeof vi.spyOn> | null = null

  /** The state with the tip signals given; everything else as the fixture has it. */
  function tips(over: {
    customized?: boolean
    canAsk?: boolean
    isDefault?: boolean | null
    prompt?: 'sheet' | 'banner' | null
    groups?: number
    tabs?: number
    memory?: EducationalTipMemory
    hidden?: MagicStackModuleId[]
  }): UIState {
    const count = over.tabs ?? 1
    const tabs: Record<string, Tab> = {}
    for (let i = 0; i < count; i++)
      tabs[i === 0 ? 'r' : `t${i}`] = { ...TAB, id: i === 0 ? 'r' : `t${i}` }
    const folders: Record<string, Folder> = {}
    for (let i = 0; i < (over.groups ?? 0); i++)
      folders[`g${i}`] = {
        id: `g${i}`,
        spaceId: 'space',
        name: `Group ${i}`,
        icon: '',
        collapsed: false
      }
    return state({
      capabilities: { privateTabs: true, defaultBrowser: over.canAsk ?? true },
      settings: {
        privacy: structuredClone(DEFAULT_PRIVACY_SETTINGS),
        newTab: {
          ...structuredClone(DEFAULT_NEW_TAB_SETTINGS),
          background: over.customized ? 'solid' : 'space'
        }
      },
      tabs,
      spaces: [{ id: 'space', activeTabId: 'r', tabIds: Object.keys(tabs) }],
      folders,
      defaultBrowser: {
        isDefault: over.isDefault === undefined ? false : over.isDefault,
        prompt: over.prompt ?? null
      },
      newTabEducationalTips: over.memory ?? emptyEducationalTipMemory(),
      newTabHiddenModules: over.hidden ?? []
    } as Partial<UIState>)
  }

  const memoryWrites = (): EducationalTipMemory[] =>
    (commands('newtab.setEducationalTipMemory') as Array<{ memory: EducationalTipMemory }>).map(
      (c) => c.memory
    )
  const card = (): HTMLElement | null => q('.zen-mstack-card[data-cell="tips"]')
  const face = (): HTMLElement | null => q('.zen-mstack-card[data-cell="tips"] .zen-mstack-tip')
  const shown = (): EducationalTipCardId | null =>
    (face()?.dataset.card as EducationalTipCardId | undefined) ?? null
  const button = (): HTMLElement | null =>
    q('.zen-mstack-card[data-cell="tips"] .zen-mstack-action')

  /** A memory in which `id` was shown once, `ago` ms before now. */
  const seen = (
    id: EducationalTipCardId,
    ago: number,
    over: Partial<EducationalTipMemory['cards'][EducationalTipCardId]> = {}
  ): EducationalTipMemory => ({
    cards: { [id]: { impressions: 1, shownAt: NOW - ago, interacted: false, ...over } },
    shownAt: NOW - ago,
    browsingDataClearedAt: null
  })

  beforeEach(() => {
    clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    clock?.mockRestore()
    clock = null
  })

  it('draws the theme card first, after the content modules, in Chrome’s words spelt as this surface spells, with the impression written once', () => {
    render(stack(tips({})))
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks', 'tips'])
    const c = card()!
    expect(c.getAttribute('aria-label')).toBe(THEME_TIP_LABEL)
    expect(c.querySelector('.zen-mstack-title')?.textContent).toBe('Zenium tips')
    expect(shown()).toBe('ntp-theme')
    // The face: the tile with its glyph, the title, the description – the Safety check card's form.
    const f = face()!
    expect(f.classList.contains('zen-mstack-safety')).toBe(true)
    expect(f.querySelector('.zen-mstack-safety-tile svg')).not.toBeNull()
    expect(f.querySelector('.zen-mstack-safety-tile')?.getAttribute('aria-hidden')).toBe('true')
    expect(f.querySelector('.zen-mstack-safety-title')?.textContent).toBe('Customise your homepage')
    expect(f.querySelector('.zen-mstack-tip-summary')?.textContent).toBe(
      'Make Zenium your own with custom colours and images for your homepage'
    )
    const b = button()!
    expect(b.textContent).toBe('Try it now')
    expect(b.getAttribute('aria-label')).toBe('Try it now: Customise your homepage')
    expect(b.dataset.primary).toBe('true')
    expect(c.querySelector('.zen-mstack-more')?.getAttribute('aria-label')).toBe(
      'More options for Zenium tips'
    )
    // Chrome's name and Chrome's spelling are nowhere on the card.
    expect(c.textContent).not.toContain('Chrome')
    expect(c.textContent).not.toContain('Customize')
    // The impression: the card counted and stamped, the module's rest begun, written once.
    expect(memoryWrites()).toEqual([
      {
        cards: { 'ntp-theme': { impressions: 1, shownAt: NOW, interacted: false } },
        shownAt: NOW,
        browsingDataClearedAt: null
      }
    ])
  })

  it('falls through the priority as the signals say: the default browser, then tab groups, then Quick Delete', () => {
    // The page customised: the default-browser card, with §9.29's "Set as default" (the lead's
    // fold on #695 for Chrome's "Set default").
    render(stack(tips({ customized: true, tabs: 12 })))
    expect(shown()).toBe('default-browser')
    expect(face()!.querySelector('.zen-mstack-safety-title')?.textContent).toBe(
      'Use Zenium by default'
    )
    expect(face()!.querySelector('.zen-mstack-tip-summary')?.textContent).toBe(
      'You can use Zenium any time you tap links in messages, documents and other apps'
    )
    expect(button()!.textContent).toBe('Set as default')
    expect(button()!.getAttribute('aria-label')).toBe('Set as default: Use Zenium by default')
    // Zenium the default already, twelve tabs and no group: the tab-groups card, its sentence
    // the lead's (saying when the groups sync) and its button "Try it now" – the overview it
    // opens shows no how.
    act(() => root!.unmount())
    root = null
    render(stack(tips({ customized: true, isDefault: true, tabs: 12 })))
    expect(shown()).toBe('tab-groups')
    expect(face()!.querySelector('.zen-mstack-safety-title')?.textContent).toBe(
      'Tidy up with tab groups'
    )
    expect(face()!.querySelector('.zen-mstack-tip-summary')?.textContent).toBe(
      'Create tab groups that save and update across your devices when sync is on'
    )
    expect(button()!.textContent).toBe('Try it now')
    expect(button()!.getAttribute('aria-label')).toBe('Try it now: Tidy up with tab groups')
    // A group made: Quick Delete.
    act(() => root!.unmount())
    root = null
    render(stack(tips({ customized: true, isDefault: true, tabs: 12, groups: 1 })))
    expect(shown()).toBe('quick-delete')
    expect(face()!.querySelector('.zen-mstack-safety-title')?.textContent).toBe(
      'Manage your browsing data'
    )
    expect(face()!.querySelector('.zen-mstack-tip-summary')?.textContent).toBe(
      'You can delete some or all of your history, cookies, site data and more'
    )
    expect(button()!.textContent).toBe('Show me how')
    // A host that cannot ask for the role, ten tabs exactly: past the default-browser and the
    // tab-groups cards to Quick Delete.
    act(() => root!.unmount())
    root = null
    render(stack(tips({ customized: true, canAsk: false, tabs: 10 })))
    expect(shown()).toBe('quick-delete')
  })

  it('the default-browser card yields to the first-run banner or sheet; the role answered while the card is up takes the card down', () => {
    render(stack(tips({ customized: true, prompt: 'banner', tabs: 12 })))
    expect(shown()).toBe('tab-groups')
    act(() => root!.unmount())
    root = null
    run.mockClear()
    render(stack(tips({ customized: true, tabs: 5 })))
    expect(shown()).toBe('default-browser')
    // The host's answer arrives: Zenium is the default – the card leaves, the stack shorter.
    render(stack(tips({ customized: true, tabs: 5, isDefault: true, memory: memoryWrites()[0]! })))
    expect(card()).toBeNull()
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks'])
    expect(memoryWrites()).toHaveLength(1)
  })

  it('Try it now opens the page’s Customise sheet and retires the card: interacted for good, the card kept for the mount, the next mount picking the next card', () => {
    render(stack(tips({})))
    click(button())
    expect(customizeStore.get().open).toBe(true)
    const writes = memoryWrites()
    expect(writes).toHaveLength(2)
    expect(writes[1]!.cards['ntp-theme']).toEqual({
      impressions: 1,
      shownAt: NOW,
      interacted: true
    })
    expect(card()).not.toBeNull()
    // The record back from the core: the card stays for the mount, nothing written again.
    render(stack(tips({ memory: writes[1]! })))
    expect(shown()).toBe('ntp-theme')
    expect(memoryWrites()).toHaveLength(2)
    // The next page, three days on: the retired card is passed over.
    act(() => root!.unmount())
    root = null
    run.mockClear()
    clock!.mockReturnValue(NOW + 3 * DAY)
    render(stack(tips({ memory: writes[1]! })))
    expect(shown()).toBe('default-browser')
  })

  it('Set as default asks the host for the browser role under the page’s own source', () => {
    render(stack(tips({ customized: true })))
    expect(shown()).toBe('default-browser')
    expect(button()!.textContent).toBe('Set as default')
    click(button())
    expect(commands('defaultBrowser.request')).toEqual([{ source: 'newtab' }])
    expect(memoryWrites()[1]!.cards['default-browser']?.interacted).toBe(true)
  })

  it('Try it now on the tab-groups card opens the overview, where a tab dropped on another makes a group', () => {
    render(stack(tips({ customized: true, isDefault: true, tabs: 12 })))
    expect(shown()).toBe('tab-groups')
    expect(button()!.textContent).toBe('Try it now')
    expect(stageStore.get().overview.phase).toBe('closed')
    click(button())
    expect(stageStore.get().overview.phase).not.toBe('closed')
    expect(stageStore.get().overview.target).toBe(1)
    expect(memoryWrites()[1]!.cards['tab-groups']?.interacted).toBe(true)
  })

  it('Show me how on the Quick Delete card opens the Delete browsing data sheet', async () => {
    render(stack(tips({ customized: true, isDefault: true, groups: 1 })))
    expect(shown()).toBe('quick-delete')
    expect(uiStore.get().clearBrowsingDataOpen).toBe(false)
    click(button())
    await flush()
    expect(uiStore.get().clearBrowsingDataOpen).toBe(true)
    expect(memoryWrites()[1]!.cards['quick-delete']?.interacted).toBe(true)
  })

  it('keeps Chrome’s cadence: a tip shown within three days rests the module; a card shown within seven days yields to the next', () => {
    // The theme card shown yesterday: no tip at all, and nothing written.
    render(stack(tips({ memory: seen('ntp-theme', DAY) })))
    expect(card()).toBeNull()
    expect(cardIds()).toEqual(['continue', 'downloads', 'bookmarks'])
    expect(memoryWrites()).toEqual([])
    // Shown four days ago: the module is rested, the theme card is not – the default-browser card.
    act(() => root!.unmount())
    root = null
    render(stack(tips({ memory: seen('ntp-theme', 4 * DAY) })))
    expect(shown()).toBe('default-browser')
    expect(memoryWrites()[0]!.cards['ntp-theme']).toEqual({
      impressions: 1,
      shownAt: NOW - 4 * DAY,
      interacted: false
    })
    expect(memoryWrites()[0]!.cards['default-browser']).toEqual({
      impressions: 1,
      shownAt: NOW,
      interacted: false
    })
    expect(EDUCATIONAL_TIP_ANY_INTERVAL_MS).toBe(3 * DAY)
    expect(EDUCATIONAL_TIP_CARD_INTERVAL_MS).toBe(7 * DAY)
  })

  it('keeps Chrome’s caps: ten impressions retire a card, three the default-browser card, a tap any; browsing data deleted this month rests the Quick Delete card', () => {
    const capped: EducationalTipMemory = {
      cards: {
        'ntp-theme': { impressions: 10, shownAt: NOW - 30 * DAY, interacted: false },
        'default-browser': { impressions: 3, shownAt: NOW - 30 * DAY, interacted: false },
        'tab-groups': { impressions: 1, shownAt: NOW - 30 * DAY, interacted: true }
      },
      shownAt: NOW - 30 * DAY,
      browsingDataClearedAt: null
    }
    render(stack(tips({ tabs: 12, memory: capped })))
    expect(shown()).toBe('quick-delete')
    // The browsing data deleted yesterday: nothing left to say, and nothing written.
    act(() => root!.unmount())
    root = null
    run.mockClear()
    render(stack(tips({ tabs: 12, memory: { ...capped, browsingDataClearedAt: NOW - DAY } })))
    expect(card()).toBeNull()
    expect(memoryWrites()).toEqual([])
  })

  it('a hidden module makes no impression; the Cards sheet’s switch bringing it back makes one', () => {
    render(stack(tips({ hidden: ['tips'] })))
    expect(card()).toBeNull()
    expect(memoryWrites()).toEqual([])
    // The switch: the module back, picked and written in its own impression.
    render(stack(tips({})))
    expect(shown()).toBe('ntp-theme')
    const writes = memoryWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0]!.cards['ntp-theme']).toEqual({
      impressions: 1,
      shownAt: NOW,
      interacted: false
    })
    // The record back from the core: the same card, nothing written again.
    render(stack(tips({ memory: writes[0]! })))
    expect(shown()).toBe('ntp-theme')
    expect(memoryWrites()).toHaveLength(1)
  })

  it('another tab’s page under the same mounted stack is a page of its own: a new tab opened from a new tab page keeps the component and changes its tab, and the change is an impression – none while the module rests, the next card once it has rested', () => {
    render(stack(tips({})))
    expect(shown()).toBe('ntp-theme')
    const [written] = memoryWrites()
    // The next tab, moments later, under the memory as written: the module rests three days –
    // no card, nothing written – where the same tab would have kept the theme card.
    const page = (id: string, s: UIState): ReactElement => (
      <MagicStack state={s} tab={{ ...TAB, id }} dock="top" />
    )
    render(page('n2', tips({ memory: written! })))
    expect(card()).toBeNull()
    expect(memoryWrites()).toHaveLength(1)
    // Eight days on, the theme card tapped meanwhile, a third tab: the next card in Chrome's
    // order, its impression written once; the same tab again writes nothing more.
    clock!.mockReturnValue(NOW + 8 * DAY)
    const tapped: EducationalTipMemory = {
      ...written!,
      cards: { 'ntp-theme': { ...written!.cards['ntp-theme']!, interacted: true } }
    }
    render(page('n3', tips({ memory: tapped })))
    expect(shown()).toBe('default-browser')
    const writes = memoryWrites()
    expect(writes).toHaveLength(2)
    expect(writes[1]!.cards['default-browser']).toEqual({
      impressions: 1,
      shownAt: NOW + 8 * DAY,
      interacted: false
    })
    expect(writes[1]!.shownAt).toBe(NOW + 8 * DAY)
    render(page('n3', tips({ memory: writes[1]! })))
    expect(shown()).toBe('default-browser')
    expect(memoryWrites()).toHaveLength(2)
  })
})
