import { vi, type Mock } from 'vitest'
import type { QuitHoldPanel } from '../../shared/quitHoldPanel'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type {
  AppHost,
  KeyEventInput,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'
import { closeBootTabs } from './bootTab'

/*
 * A desktop host under the quit hold's tests (session-08): a `Browser` on a fake platform that
 * counts the quits asked of it, page views that record the panel's posting, and the quit chord
 * as the key table sees it. Shared by the core's suite (`quitHold.test.ts`) and the hosts' routes
 * into the key table (the extension popup's, `main/platform/__tests__/extensionPopupKeys.test.ts`).
 */

export function memoryIo(): StoreIO {
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

/** Anything the browser touches on the host answers with a harmless no-op. */
export function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** A page view of the fake host, with the panel's posting under the test's eye. */
export type FakeView = TabView & {
  /** The tab the view was made for (`closeBootTabs` drops the boot tab's record by it). */
  tabId: string
  showQuitHold: Mock<(panel: QuitHoldPanel | null) => void>
}

export interface Host {
  quits: number
  os: PlatformOs
  /** The page views made, in order. */
  views: FakeView[]
  /** With `objecting`: the "Leave site?" questions asked of the pages, each answered by the test. */
  unloadAnswers: Array<(leave: boolean) => void>
}

export interface HostOptions {
  os: PlatformOs
  /** The drives' flag (`AppHost.quitHoldEverywhere`). */
  everywhere?: boolean
  /** A host whose page views draw no panel (Android's `TabView` has no `showQuitHold`). */
  pageless?: boolean
  /** Pages whose `beforeunload` objects: a quit's "Leave site?" stays open until the test answers it. */
  objecting?: boolean
}

/** A desktop host on `os`, counting the quits the core asks of it; `everywhere` is the drives' flag. */
export function fakePlatform(
  io: StoreIO,
  { os, everywhere = false, pageless = false, objecting = false }: HostOptions
): Platform & { host: Host } {
  const host: Host = { quits: 0, os, views: [], unloadAnswers: [] }
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    pageControls: false,
    darkenSites: false,
    quitsThroughCore: true
  })
  return {
    host,
    info: { os, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab) => {
        const view = stub<FakeView>({
          tabId: tab.id,
          isDestroyed: () => false,
          isVisible: () => true,
          getZoom: () => 1,
          // No page objects to unloading unless asked to: a quit's checks pass without a
          // "Leave site?"; an objecting page's question waits for the test's answer.
          confirmUnload: objecting
            ? () =>
                new Promise<boolean>((resolve) => {
                  host.unloadAnswers.push(resolve)
                })
            : undefined,
          // An explicit undefined stays undefined through the stub, as a host without the method.
          showQuitHold: pageless ? undefined : vi.fn<(panel: QuitHoldPanel | null) => void>()
        })
        host.views.push(view)
        return view
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>({
      quit: () => void host.quits++,
      ...(everywhere ? { quitHoldEverywhere: () => true } : {})
    }),
    readabilitySource: () => null
  }
}

export function start(options: HostOptions): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  win: ZenWindow
} {
  const platform = fakePlatform(memoryIo(), options)
  const browser = new Browser(platform)
  browser.start()
  // From the bare space: the scenes below count their tabs, and the boot tab (W5-F2) is not one of them.
  closeBootTabs(browser, platform.host.views)
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win }
}

/** The Chrome preset's quit chord on `os`: ⌘Q on macOS, Ctrl+Shift+Q elsewhere. */
export function quitChord(
  os: PlatformOs,
  type: KeyEventInput['type'],
  isAutoRepeat = false
): KeyEventInput {
  const mac = os === 'darwin'
  return {
    type,
    key: 'q',
    control: !mac,
    alt: false,
    shift: !mac,
    meta: mac,
    isAutoRepeat
  }
}

export const release = (key: string): KeyEventInput => ({
  type: 'keyUp',
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  isAutoRepeat: false
})

/** Let the quit's checks (all async) run through. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** What a quit request resolved to once the checks ran, or 'pending' while it waits on an answer. */
export async function outcome(request: Promise<boolean>): Promise<boolean | 'pending'> {
  let result: boolean | 'pending' = 'pending'
  void request.then((agreed) => {
    result = agreed
  })
  await settle()
  return result
}
