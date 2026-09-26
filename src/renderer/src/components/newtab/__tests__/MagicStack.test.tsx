// @vitest-environment happy-dom
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
 * The Magic Stack on the page (NTP-16): the cards drawn from the state in the stack's order,
 * each a page surface named for TalkBack, the strip a carousel with its page dots; the ⋮ opening
 * the shared local menu with Hide This and Customise; Hide This writing the device's hidden set
 * and taking the card out on the 120 ms fade (a cut under reduced motion), the card kept out
 * between the command and the state and back when the state re-enables it; the Customise sheet's
 * switch rows writing the set; the stack not drawn at all when nothing has content.
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
    expect(q('.zen-mstack')!.getAttribute('aria-label')).toBe('Magic Stack')
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
    // The dots: a tablist of the pages, the first selected, each named for its page.
    const dots = qa('.zen-mstack-dots [role="tab"]')
    expect(q('.zen-mstack-dots')!.getAttribute('role')).toBe('tablist')
    expect(dots).toHaveLength(4)
    expect(dots.map((d) => d.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false'
    ])
    expect(dots[1]!.getAttribute('aria-label')).toBe('Page 2 of 4: Downloads')
  })

  it('the dots follow the strip’s scroll on their own subscription, the strip itself untouched', () => {
    render(stack(state()))
    const strip = q<HTMLUListElement>('.zen-mstack-strip')!
    // happy-dom lays nothing out: a card is 0 wide, so the pitch is the 8 gap alone.
    const observer = new MutationObserver(() => undefined)
    observer.observe(strip, { attributes: true, childList: true, subtree: true })
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: 8 })
    act(() => {
      strip.dispatchEvent(new Event('scroll'))
    })
    const dots = qa('.zen-mstack-dots [role="tab"]')
    expect(dots.map((d) => d.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false'
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

  it('the actions run their commands: Reopen restores the closed tab, Open opens the download, Set as default asks the host', () => {
    render(stack(state()))
    const buttons = qa<HTMLButtonElement>('.zen-mstack-action')
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Reopen',
      'Open',
      'See all',
      'See all',
      'Set as default'
    ])
    click(buttons[0]!)
    expect(commands('session.restoreClosed')).toEqual([{ id: 'c1' }])
    click(buttons[1]!)
    expect(commands('download.open')).toEqual([{ id: 'd1' }])
    click(buttons[4]!)
    expect(commands('defaultBrowser.request')).toEqual([{ source: 'banner' }])
    expect(buttons[4]!.dataset.primary).toBe('true')
    // A bookmark row opens its bookmark in this tab.
    click(q('.zen-mstack-card[data-cell="bookmarks"] .zen-mstack-row'))
    expect(commands('bookmark.open')).toEqual([{ id: 'b1', newTab: false, tabId: 'r' }])
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
    expect(sheet!.textContent).toContain('Magic Stack')
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

  it('the page’s gear sheet carries a Magic Stack row – the way to the switches once every card is hidden; it leaves first and the stack’s sheet comes up as it has gone', async () => {
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
      r.textContent?.startsWith('Magic Stack')
    )
    expect(row).toBeDefined()
    expect(row!.textContent).toContain('Choose which cards show under the shortcuts')
    click(row!)
    // One sheet over the page (§9.24): the stack's waits for the gear's landing.
    expect(magicStackCustomizeStore.get().open).toBe(false)
    expect(frames.scheduled).toBe(true)
    rest()
    expect(magicStackCustomizeStore.get().open).toBe(true)
    await flush()
    rest()
    const sheets = qa('.zen-sheet[role="dialog"]')
    expect(sheets.map((s) => s.querySelector('h2.zen-sheet-title')?.textContent)).toEqual([
      'Magic Stack'
    ])
    expect(qa('[role="switch"]').map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'false',
      'false'
    ])
  })
})
