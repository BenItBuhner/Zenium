// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, SyncStatus, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The phone's Send to your devices picker (ID-27, `sendTab.open`): the menu's "Send to Your
 * Devices…" asks for it; one row per other device the folder knows, most recently seen first,
 * the device's name over when it was last active; a tap sends the tab's page to that device
 * through `sync.sendTab` once the sheet has gone; with no device left it says so (§9.17).
 * Rendered for real in happy-dom on the frame's dialog host, the frame loop cranked by hand.
 */

const SPACE = 'space'

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, {
  zen: {
    invoke,
    on: () => () => undefined
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SendTabSheetLayer } = await import('../SendTabSheet')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, openSendTabSheet, uiStore } = await import('@renderer/lib/ui')

// --- a profile ---------------------------------------------------------------------------------

const NOW = 1_700_000_000_000
const LAPTOP = { id: 'dev-2', name: 'Work laptop', lastSeen: NOW - 2 * 3_600_000 }
const DESK = { id: 'dev-3', name: 'Home desktop', lastSeen: NOW - 20_000 }

function stateOf(devices: SyncStatus['devices']): UIState {
  const tab = {
    id: 't',
    spaceId: SPACE,
    containerId: 'default',
    url: 'https://a.example/article',
    title: 'Alpha',
    favicon: null,
    pinned: false,
    essential: false,
    loading: false,
    canGoBack: false,
    canGoForward: false
  } as unknown as Tab
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: [tab.id],
    activeTabId: tab.id,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false, extensions: false, pageTabs: true },
    tabs: { [tab.id]: tab },
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: [],
    sync: { enabled: true, devices } as unknown as SyncStatus
  } as unknown as UIState
}

// --- a clock and a frame loop ------------------------------------------------------------------

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
    vi.spyOn(performance, 'now').mockImplementation(() => this.now)
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let host: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Run the springs out: a sheet lands, a picked row's action runs. */
async function land(): Promise<void> {
  await act(async () => {
    frames.run(150)
  })
  await settle()
}

/** The browser knows `devices`; the sheet is asked for as the menu's row asks. */
async function show(devices: SyncStatus['devices']): Promise<void> {
  act(() => browserStore.set({ state: stateOf(devices) }))
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(FrameDialogHost, null, createElement(SendTabSheetLayer))))
  act(() => openSendTabSheet('t'))
  await settle()
  await land()
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(NOW)
  frames.install()
  invoke.mockClear()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
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
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  uiStore.set({ sendTabSheet: null })
  browserStore.set({ state: null })
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  frames.now = 0
})

// --- helpers -----------------------------------------------------------------------------------

const CHASSIS = new Set(['overlay.snapshot', 'focus.content'])
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls
    .filter(([name]) => !CHASSIS.has(name))
    .map(([name, args]) => [name, args] as [string, unknown])
const titles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs h2')].map(
    (h) => h.textContent?.trim() ?? ''
  )
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs .zen-phone-row')
]
const rowMain = (row: HTMLElement): HTMLElement =>
  row.querySelector<HTMLElement>('[role="button"]')!
const rowText = (row: HTMLElement): { title: string; subtitle: string } => ({
  title: row.querySelector('.zen-list-title')?.textContent?.trim() ?? '',
  subtitle: row.querySelector('.zen-list-subtitle')?.textContent?.trim() ?? ''
})

// --- the sheet ---------------------------------------------------------------------------------

describe('the phone Send to your devices sheet', () => {
  it('lists the other devices most recently seen first – name over when last active – under Chrome’s title, no glyph column', async () => {
    await show([LAPTOP, DESK])
    expect(titles()).toEqual(['Send to your devices'])
    expect(uiStore.get().sendTabSheet).toEqual({ tabId: 't' })
    expect(rows().map(rowText)).toEqual([
      { title: 'Home desktop', subtitle: 'Last active just now' },
      { title: 'Work laptop', subtitle: 'Last active 2 h ago' }
    ])
    expect(rows().map((r) => rowMain(r).getAttribute('aria-label'))).toEqual([
      'Home desktop, Last active just now',
      'Work laptop, Last active 2 h ago'
    ])
    // No row draws a glyph – the record has no device kind, and one picture on every row tells
    // nothing (the #314 ruling; as the Settings › Sync device rows) – and no empty box stands
    // where one would go: the text starts at the gutter. Two-line rows.
    for (const row of rows()) {
      expect(row.querySelector('.zen-list-lead')).toBeNull()
      expect(row.querySelector('svg')).toBeNull()
      expect(row.getAttribute('data-two-line')).toBe('true')
    }
    expect(commands()).toEqual([])
  })

  it('a tap sends the tab’s page to that device once the sheet has gone, and the sheet is down', async () => {
    await show([LAPTOP, DESK])
    act(() => rowMain(rows()[1]).click())
    await land()
    expect(commands()).toEqual([
      [
        'sync.sendTab',
        { deviceId: 'dev-2', url: 'https://a.example/article', title: 'Alpha', tabId: 't' }
      ]
    ])
    expect(titles()).toEqual([])
    expect(uiStore.get().sendTabSheet).toBeNull()
  })

  it('with no device left it says so and sends nothing', async () => {
    await show([])
    expect(titles()).toEqual(['Send to your devices'])
    expect(rows()).toEqual([])
    expect(document.querySelector('.zen-frame-dialogs .zen-phone-empty')?.textContent).toBe(
      'No other device has synced to this folder yet'
    )
    expect(commands()).toEqual([])
  })

  it('is nothing for a tab that is gone', async () => {
    act(() => browserStore.set({ state: stateOf([LAPTOP, DESK]) }))
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(FrameDialogHost, null, createElement(SendTabSheetLayer))))
    act(() => openSendTabSheet('gone'))
    await settle()
    await land()
    expect(titles()).toEqual([])
  })
})
