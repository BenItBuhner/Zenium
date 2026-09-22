// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ClosedEntrySummary,
  HistoryDayGroup,
  Space,
  SyncDeviceTabs,
  Tab,
  UIState
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { dayKeyOf } from '@shared/dayKey'

/*
 * The phone History page's other devices' tabs (matrix TAB-02, history-07; the #316 gate: they
 * are History's groups beside Recently closed, as the desktop History page lists them; v2 §9.17,
 * §10.1, §10.3, §10.4): under the recently closed tabs and over the days, one group PER DEVICE
 * headed by its name with when it last published as the aside – no umbrella heading over them –
 * the tabs as rows; a row opens the tab here (or brings it to the front, ID-10) and the page
 * leaves; a device's heading held offers Hide Device, the last row brings a hidden device back.
 * Two empty states stand under the "From your other devices" heading, each with its §10.4 row as
 * the way out – sync off (Turn on sync, to Settings › Sync) and Open tabs out of what syncs (Open
 * sync settings, to the page's Open tabs switch) – and a third the user made (every device
 * hidden: Show hidden devices); with sync on and nothing published the group is absent, as
 * Recently closed is when empty. Rendered for real in happy-dom, the core stubbed.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

// --- the core ----------------------------------------------------------------------------------

let closed: ClosedEntrySummary[] = []
let remote: SyncDeviceTabs[] = []
/** One day of visits under the groups: the page's "Today". */
const today = (): HistoryDayGroup[] => [
  {
    dayKey: dayKeyOf(NOW),
    visits: [
      {
        id: 'v1',
        url: 'https://example.com/',
        title: 'Example Domain',
        favicon: null,
        visitTime: NOW - 20 * 60_000,
        transition: 'typed'
      }
    ]
  }
]
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'session.recentlyClosed') return [...closed]
  if (name === 'sync.tabsFromDevices') return remote.map((d) => ({ ...d }))
  if (name === 'history.grouped') return today()
  return null
})
Object.assign(window, {
  zen: {
    invoke,
    on: () => () => undefined
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneHistoryPanel } = await import('../PhoneHistoryPanel')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, pickMenuItem, uiStore } = await import('@renderer/lib/ui')
const { hiddenDevicesStore, showHiddenDevices } = await import('@renderer/lib/otherDevices')
const { remoteTabsStore } = await import('@renderer/lib/remoteTabs')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
    url,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...patch
  } as Tab
}

/**
 * The status' `remoteTabsVersion` of the test at hand: `useRemoteTabs` asks the core once per
 * version for the whole chrome, so every test starts at a version no test before it asked at.
 */
let version = 0

/** The engine's status: off, or on with Open tabs among what syncs unless `openTabs` says not. */
function sync(enabled: boolean, openTabs = true): UIState['sync'] {
  return {
    enabled,
    folder: enabled ? 'content://tree/Zenium' : null,
    folderName: enabled ? 'Zenium' : null,
    folderLost: false,
    deviceId: 'device-phone',
    deviceName: 'Pixel 8',
    scope: {
      spaces: true,
      folders: true,
      pinnedTabs: true,
      essentials: true,
      openTabs,
      containers: true,
      bookmarks: true,
      settings: true,
      shortcuts: true,
      boosts: true
    } as UIState['sync']['scope'],
    lastSyncAt: enabled ? NOW - 5 * 60_000 : null,
    lastError: null,
    syncing: false,
    devices: [],
    pendingMerge: false,
    remoteTabsVersion: version
  } as UIState['sync']
}

/** `tabs` in track order; the first is active. */
function stateOf(tabs: Tab[], patch: Partial<UIState> = {}): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
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
    sync: sync(false),
    ...patch
  } as unknown as UIState
}

const pages = (): Tab[] => [
  tab('ex', 'https://example.com/', { title: 'Example Domain' }),
  tab('hn', 'https://news.ycombinator.com/', { title: 'Hacker News' })
]

/** The entry the core files for a closed page. */
function entry(id: string, title: string, url: string, closedAt: number): ClosedEntrySummary {
  return { id, kind: 'tab', title, url, favicon: null, closedAt, tabCount: 1 }
}

const remoteTab = (
  tabId: string,
  url: string,
  title: string,
  lastActive: number
): SyncDeviceTabs['tabs'][number] => ({
  tabId,
  windowId: null,
  url,
  title,
  favicon: null,
  lastActive
})

/** Two devices: the laptop published two hours ago, the desktop three minutes ago. */
const devices = (): SyncDeviceTabs[] => [
  {
    deviceId: 'device-laptop',
    deviceName: 'Work laptop',
    updatedAt: NOW - 2 * HOUR,
    tabs: [
      remoteTab('l-2', 'https://developer.mozilla.org/docs/Web', 'Web | MDN', NOW - 3 * HOUR),
      remoteTab('l-1', 'https://github.com/BenItBuhner/Zenium', 'Zenium', NOW - 2 * HOUR)
    ]
  },
  {
    deviceId: 'device-desktop',
    deviceName: 'Home desktop',
    updatedAt: NOW - 3 * 60_000,
    tabs: [remoteTab('d-1', 'https://archive.org/', 'Internet Archive', NOW - 4 * 60_000)]
  }
]

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null

/** The async work between one step and the next: a list read, a command's answer, a commit. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

function render(state: UIState): HTMLElement {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(PhoneHistoryPanel, { state })))
  return host!
}

/** The browser shows `state`, and the History page is up over it. */
async function show(state: UIState): Promise<void> {
  act(() => browserStore.set({ state }))
  act(() => uiStore.set({ overlay: 'history' }))
  render(state)
  // The list's load waits 80 ms after the query settles; the closed list and the devices' come
  // back with the command's answer.
  await act(async () => {
    vi.advanceTimersByTime(100)
  })
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(NOW)
  closed = []
  remote = []
  version += 10
  remoteTabsStore.set({ version: -1, devices: [] })
  invoke.mockClear()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  uiStore.set({ toasts: [] })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  act(() => showHiddenDevices())
  uiStore.set({ toasts: [], overlay: 'none', menu: null })
  browserStore.set({ state: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// --- helpers -----------------------------------------------------------------------------------

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const buttonByText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text)
const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
/** The list row whose title reads `title`. */
const rowByTitle = (title: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.zen-v2-row')].find(
    (r) => r.querySelector('.zen-list-title')?.textContent?.trim() === title
  )!
/** The page's list: its headings and rows in order, as a reader meets them. */
const listTexts = (within: ParentNode = document): string[] =>
  [...within.querySelectorAll<HTMLElement>('.zen-v2-heading, .zen-v2-row')].map((el) =>
    el.classList.contains('zen-v2-heading')
      ? `# ${el.textContent?.trim()}`
      : (el.querySelector('.zen-list-title')?.textContent?.trim() ?? el.textContent?.trim() ?? '')
  )
const groupTexts = (): string[] => listTexts(byTestId('history-other-devices')!)
/**
 * A device's heading held: the `contextmenu` Chromium raises for a touch hold; the sheet comes
 * up once the page behind it is captured.
 */
async function hold(deviceId: string): Promise<void> {
  const heading = document.querySelector<HTMLElement>(
    `[data-device-id="${deviceId}"] .zen-device-heading-button`
  )!
  act(() => {
    heading.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
  await settle()
}
/** The sheet up over the page: its title and its items' labels. */
const menu = (): { title: string | undefined; items: string[] } | null => {
  const m = uiStore.get().menu
  return m ? { title: m.title, items: m.items.map((i) => i.label) } : null
}
/** Pick the sheet's item reading `label`: the sheet goes, the action runs once it is unpainted. */
async function pick(label: string): Promise<void> {
  const item = uiStore.get().menu!.items.find((i) => i.label === label)!
  act(() => pickMenuItem(item.id))
  await act(async () => {
    vi.advanceTimersByTime(50)
  })
  await settle()
}

// --- the group ---------------------------------------------------------------------------------

describe("the History page's other devices' groups (TAB-02)", () => {
  it('stand under Recently closed and over the days, one group per device by its last publish with no heading over them, the tabs by last activity', async () => {
    closed = [entry('c1', 'Damping - Wikipedia', 'https://en.wikipedia.org/wiki/Damping', NOW)]
    remote = devices()
    await show(stateOf(pages(), { sync: sync(true) }))
    expect(of('sync.tabsFromDevices')).toHaveLength(1)
    expect(listTexts()).toEqual([
      'Clear history',
      '# Recently closed',
      'Damping - Wikipedia',
      '# Home desktopLast active 3 min ago',
      'Internet Archive',
      '# Work laptopLast active 2 h ago',
      'Zenium',
      'Web | MDN',
      '# Today',
      'Example Domain'
    ])
    // The devices' headings are the page's group headings (§10.3), Recently closed's siblings.
    expect(
      [...document.querySelectorAll<HTMLElement>('.zen-phone-list h3')].map((h) => h.textContent)
    ).toEqual([
      'Recently closed',
      'Home desktopLast active 3 min ago',
      'Work laptopLast active 2 h ago',
      'Today'
    ])
    const headings = [...document.querySelectorAll<HTMLElement>('.zen-device-heading-button')]
    expect(headings.map((h) => h.getAttribute('aria-label'))).toEqual([
      'Home desktop, Last active 3 min ago',
      'Work laptop, Last active 2 h ago'
    ])
    expect(headings.map((h) => h.getAttribute('aria-haspopup'))).toEqual(['menu', 'menu'])
    // A row reads the title over the host.
    expect(rowByTitle('Internet Archive').textContent).toContain('archive.org')
    expect(rowByTitle('Zenium').textContent).toContain('github.com')
  })

  it("a row opens the device's tab here and the page leaves; a tab this device holds under the same id comes to the front instead (ID-10)", async () => {
    remote = [
      ...devices(),
      {
        deviceId: 'device-tablet',
        deviceName: 'Tablet',
        updatedAt: NOW - 10 * 60_000,
        tabs: [remoteTab('hn', 'https://news.ycombinator.com/', 'Hacker News', NOW - HOUR)]
      }
    ]
    await show(stateOf(pages(), { sync: sync(true) }))
    act(() => rowByTitle('Internet Archive').click())
    expect(of('tab.create')).toEqual([{ url: 'https://archive.org/', active: true }])
    expect(uiStore.get().overlay).toBe('none')

    act(() => uiStore.set({ overlay: 'history' }))
    act(() => rowByTitle('Hacker News').click())
    expect(of('tab.activate')).toEqual([{ tabId: 'hn' }])
    expect(of('tab.create')).toHaveLength(1)
    expect(uiStore.get().overlay).toBe('none')
  })

  it("a device's heading held offers Hide Device; hidden, the device leaves the group with a row to show it again", async () => {
    remote = devices()
    await show(stateOf(pages(), { sync: sync(true) }))
    await hold('device-laptop')
    expect(menu()).toEqual({ title: 'Work laptop', items: ['Hide Device'] })
    await pick('Hide Device')
    expect(hiddenDevicesStore.get().hidden.has('device-laptop')).toBe(true)
    expect(groupTexts()).toEqual([
      '# Home desktopLast active 3 min ago',
      'Internet Archive',
      'Show hidden devices'
    ])
    act(() => byTestId('history-devices-show-hidden')!.click())
    expect(hiddenDevicesStore.get().hidden.size).toBe(0)
    expect(groupTexts()).toContain('# Work laptopLast active 2 h ago')
    expect(byTestId('history-devices-show-hidden')).toBeNull()
  })

  it('with every device hidden, the From your other devices heading stands over the sentence and the row that shows them again', async () => {
    remote = devices()
    await show(stateOf(pages(), { sync: sync(true) }))
    await hold('device-laptop')
    await pick('Hide Device')
    await hold('device-desktop')
    await pick('Hide Device')
    expect(groupTexts()).toEqual([
      '# From your other devices',
      "You've hidden every device",
      'Show hidden devices'
    ])
    expect(byTestId('history-devices-hidden')?.hasAttribute('data-static')).toBe(true)
    act(() => byTestId('history-devices-show-hidden')!.click())
    expect(groupTexts()).toEqual([
      '# Home desktopLast active 3 min ago',
      'Internet Archive',
      '# Work laptopLast active 2 h ago',
      'Zenium',
      'Web | MDN'
    ])
  })

  it('with sync off the group is the sentence and the Turn on sync row, which leaves for Settings › Sync', async () => {
    await show(stateOf(pages(), { sync: sync(false) }))
    expect(groupTexts()).toEqual([
      '# From your other devices',
      'Turn on sync to see tabs from your other devices',
      'Turn on sync'
    ])
    expect(byTestId('history-devices-sync-off')?.hasAttribute('data-static')).toBe(true)
    expect(of('sync.tabsFromDevices')).toEqual([])
    act(() => buttonByText('Turn on sync')!.click())
    expect(of('page.open')).toEqual([{ id: 'settings', section: 'sync' }])
    expect(uiStore.get().overlay).toBe('none')
  })

  it("with Open tabs out of what syncs the group is that sentence and the Open sync settings row, which leaves for Settings › Sync's Open tabs switch", async () => {
    remote = devices()
    await show(stateOf(pages(), { sync: sync(true, false) }))
    expect(groupTexts()).toEqual([
      '# From your other devices',
      'Turn on Open tabs in What you sync to see them',
      'Open sync settings'
    ])
    // The lists are not read while they are out of the scope.
    expect(of('sync.tabsFromDevices')).toEqual([])
    act(() => buttonByText('Open sync settings')!.click())
    expect(of('page.open')).toEqual([
      { id: 'settings', section: 'sync', query: { row: 'sync-scope:openTabs' } }
    ])
    expect(uiStore.get().overlay).toBe('none')
  })

  it('with sync on and no other device publishing, the group is absent – Recently closed and the days meet', async () => {
    closed = [entry('c1', 'Damping - Wikipedia', 'https://en.wikipedia.org/wiki/Damping', NOW)]
    remote = []
    await show(stateOf(pages(), { sync: sync(true) }))
    expect(of('sync.tabsFromDevices')).toHaveLength(1)
    expect(byTestId('history-other-devices')).toBeNull()
    expect(listTexts()).toEqual([
      'Clear history',
      '# Recently closed',
      'Damping - Wikipedia',
      '# Today',
      'Example Domain'
    ])
    expect(document.body.textContent).not.toContain('From your other devices')
  })

  it('leaves the list while the history is searched, and comes back with the query cleared', async () => {
    remote = devices()
    await show(stateOf(pages(), { sync: sync(true) }))
    expect(byTestId('history-other-devices')).not.toBeNull()
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, 'arch')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(byTestId('history-other-devices')).toBeNull()
    act(() => {
      setter?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(byTestId('history-other-devices')).not.toBeNull()
  })

  it('reads the devices again when the status says another device published', async () => {
    remote = devices()
    await show(stateOf(pages(), { sync: sync(true) }))
    expect(of('sync.tabsFromDevices')).toHaveLength(1)
    remote = [
      ...devices(),
      {
        deviceId: 'device-tablet',
        deviceName: 'Tablet',
        updatedAt: NOW - 60_000,
        tabs: [remoteTab('t-1', 'https://example.org/', 'Example', NOW - 90_000)]
      }
    ]
    const moved = { ...sync(true), remoteTabsVersion: version + 1 }
    act(() => browserStore.set({ state: stateOf(pages(), { sync: moved }) }))
    render(stateOf(pages(), { sync: moved }))
    await settle()
    expect(of('sync.tabsFromDevices')).toHaveLength(2)
    expect(groupTexts()[0]).toBe('# TabletLast active 1 min ago')
  })
})
