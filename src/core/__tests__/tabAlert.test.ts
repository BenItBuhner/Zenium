import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * Tab alert indicators (tabs-43): the frames of a page report their live capture (camera,
 * microphone, display sharing, picture-in-picture) and the tab's `alert` is folded from them with
 * Chrome's priority; a document, renderer or page that goes takes its state with it.
 */

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface Recorded {
  tabId: string
  readonly events: TabViewEvents
  destroyed: boolean
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  /** `state` pushes to the window, for the volatile commit the row repaints on. */
  states: number
}

function fixture(): Fixture {
  const views: Recorded[] = []
  const f = { views, states: 0 } as Fixture
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: false,
    pageTabs: false
  })
  const platform: Platform = {
    info: { os: 'linux', version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          send: (name: string) => {
            if (name === 'state') f.states += 1
          },
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        const record: Recorded = { tabId: tab.id, events, destroyed: false }
        views.push(record)
        let url = tab.url
        return stub<TabView>({
          isDestroyed: () => record.destroyed,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
          loadURL: (u: string) => {
            url = u
          },
          destroy: () => {
            record.destroyed = true
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  f.browser = new Browser(platform)
  f.browser.state.settings.onboardingDone = true
  f.browser.start()
  return f
}

const PAGE = 'https://meet.example/call'

const report = (
  id: string,
  over: Partial<{ camera: boolean; microphone: boolean; display: boolean; pip: boolean }>
): unknown => ({ id, camera: false, microphone: false, display: false, pip: false, ...over })

function openPage(f: Fixture): { tab: Tab; view: Recorded } {
  const win = f.browser.focusedWindow()
  const tab = f.browser.tabs.createTab({ url: PAGE, active: true }, win)
  const view = f.views.find((v) => v.tabId === tab.id && !v.destroyed)!
  view.events.onNavigated(PAGE, false)
  return { tab, view }
}

describe('the tab alert from the frames’ capture reports', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('lights on a frame’s report and clears when the frame reports nothing live', async () => {
    const f = fixture()
    const { tab, view } = openPage(f)
    await vi.advanceTimersByTimeAsync(10)
    expect(f.browser.tabs.tab(tab.id)!.alert).toBeNull()
    const before = f.states
    view.events.onPageMessage({
      type: 'capture-state',
      capture: report('top', { camera: true, microphone: true })
    })
    expect(f.browser.tabs.tab(tab.id)!.alert).toBe('recording')
    await vi.advanceTimersByTimeAsync(10)
    // The row repaints once per change (of the alert or of the kinds behind it), not per report.
    expect(f.states).toBe(before + 1)
    view.events.onPageMessage({
      type: 'capture-state',
      capture: report('top', { camera: true, microphone: true })
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(f.states).toBe(before + 1)
    view.events.onPageMessage({ type: 'capture-state', capture: report('top', {}) })
    expect(f.browser.tabs.tab(tab.id)!.alert).toBeNull()
    await vi.advanceTimersByTimeAsync(10)
    expect(f.states).toBe(before + 2)
  })

  it('folds several frames with Chrome’s priority and keeps the others when one stops', () => {
    const f = fixture()
    const { tab, view } = openPage(f)
    const send = (capture: unknown): void =>
      view.events.onPageMessage({ type: 'capture-state', capture })
    send(report('player', { pip: true }))
    expect(f.browser.tabs.tab(tab.id)!.alert).toBe('pip')
    send(report('share', { display: true }))
    expect(f.browser.tabs.tab(tab.id)!.alert).toBe('capturing')
    send(report('call', { microphone: true }))
    expect(f.browser.tabs.tab(tab.id)!.alert).toBe('recording')
    send(report('call', {}))
    expect(f.browser.tabs.tab(tab.id)!.alert).toBe('capturing')
    send(report('share', {}))
    expect(f.browser.tabs.tab(tab.id)!.alert).toBe('pip')
    send(report('player', {}))
    expect(f.browser.tabs.tab(tab.id)!.alert).toBeNull()
  })

  it('a new document clears the old one’s frames; a same-document navigation does not', () => {
    const f = fixture()
    const { tab, view } = openPage(f)
    view.events.onPageMessage({ type: 'capture-state', capture: report('top', { camera: true }) })
    view.events.onNavigated(`${PAGE}#muted`, true)
    expect(f.browser.tabs.tab(tab.id)!.alert).toBe('recording')
    view.events.onNavigated('https://meet.example/lobby', false)
    expect(f.browser.tabs.tab(tab.id)!.alert).toBeNull()
    // A late all-clear from the old frame changes nothing.
    view.events.onPageMessage({ type: 'capture-state', capture: report('top', {}) })
    expect(f.browser.tabs.tab(tab.id)!.alert).toBeNull()
  })

  it('a crash and an unload take the state with them; the restored record starts clear', () => {
    const f = fixture()
    const { tab, view } = openPage(f)
    view.events.onPageMessage({ type: 'capture-state', capture: report('top', { display: true }) })
    expect(f.browser.tabs.tab(tab.id)!.alert).toBe('capturing')
    view.events.onCrashed('crashed', 5)
    expect(f.browser.tabs.tab(tab.id)!.alert).toBeNull()

    const again = f.browser.tabs.createTab(
      { url: 'https://pip.example/', active: true },
      f.browser.focusedWindow()
    )
    const v2 = f.views.find((v) => v.tabId === again.id && !v.destroyed)!
    v2.events.onNavigated('https://pip.example/', false)
    v2.events.onPageMessage({ type: 'capture-state', capture: report('top', { pip: true }) })
    expect(f.browser.tabs.tab(again.id)!.alert).toBe('pip')
    f.browser.tabs.discard(again.id)
    expect(f.browser.tabs.tab(again.id)!.alert).toBeNull()
    expect(f.browser.tabs.tab(again.id)!.discarded).toBe(true)
  })

  it('folds the kinds behind the alert into `capture`, for the pill’s in-use chip (omnibox-38)', async () => {
    const f = fixture()
    const { tab, view } = openPage(f)
    const send = (capture: unknown): void =>
      view.events.onPageMessage({ type: 'capture-state', capture })
    const read = (): Tab => f.browser.tabs.tab(tab.id)!
    await vi.advanceTimersByTimeAsync(10)
    expect(read().capture).toBeNull()
    send(report('call', { microphone: true }))
    expect(read().capture).toEqual({ camera: false, microphone: true, display: false })
    await vi.advanceTimersByTimeAsync(10)
    // The alert stays `recording`, but the kinds changed: the pill repaints for the camera.
    const before = f.states
    send(report('call', { camera: true, microphone: true }))
    expect(read().alert).toBe('recording')
    expect(read().capture).toEqual({ camera: true, microphone: true, display: false })
    await vi.advanceTimersByTimeAsync(10)
    expect(f.states).toBe(before + 1)
    // Another frame's screen share joins the reading; the alert ranks recording above it.
    send(report('share', { display: true }))
    expect(read().alert).toBe('recording')
    expect(read().capture).toEqual({ camera: true, microphone: true, display: true })
    send(report('call', {}))
    expect(read().alert).toBe('capturing')
    expect(read().capture).toEqual({ camera: false, microphone: false, display: true })
    // Picture-in-picture is an alert, not a capture.
    send(report('share', {}))
    send(report('player', { pip: true }))
    expect(read().alert).toBe('pip')
    expect(read().capture).toBeNull()
    // A report that changes neither repaints nothing.
    await vi.advanceTimersByTimeAsync(10)
    const settled = f.states
    send(report('player', { pip: true }))
    await vi.advanceTimersByTimeAsync(10)
    expect(f.states).toBe(settled)
  })

  it('takes no report it cannot read, and none for a tab without a page', () => {
    const f = fixture()
    const { tab, view } = openPage(f)
    view.events.onPageMessage({ type: 'capture-state', capture: { camera: true } })
    view.events.onPageMessage({ type: 'capture-state', capture: 'camera' })
    view.events.onPageMessage({ type: 'capture-state' })
    expect(f.browser.tabs.tab(tab.id)!.alert).toBeNull()
    f.browser.tabs.discard(tab.id)
    f.browser.tabs.onCaptureState(tab.id, report('top', { camera: true }))
    expect(f.browser.tabs.tab(tab.id)!.alert).toBeNull()
  })
})
