import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../../shared/types'
import type { PrivacyFlags } from '../../../shared/privacy'
import { EXTENSION_SETTING_KEYS, STRICT_POLE } from '../../../shared/extensionSettings'
import { DEFAULT_PRIVACY_SETTINGS } from '../../../shared/privacy'
import { Browser } from '../../../core/browser'
import { decideSave } from '../../../core/credentials/fill'
import type { RequestContext } from '../../../core/blocking/rules'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../../../core/platform'
import type { HostRequest, WebRequestBase } from '../webRequest'
import { EXTENSION_LAYER_HOLD_MS, StartupHold, extensionLayerNeedsHold } from '../startupHold'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/nowhere',
    configureHostResolver: () => {
      throw new Error('the test injects its own configurator')
    }
  },
  ipcMain: { on: () => undefined }
}))

const { PreloadHandler, PrivacyRequestHandler } = await import('../privacy')

afterEach(() => {
  vi.useRealTimers()
})

describe('StartupHold', () => {
  it('is open until told otherwise: what is run runs at once', async () => {
    const hold = new StartupHold()
    const ran: string[] = []
    expect(hold.open).toBe(true)
    hold.run(() => ran.push('a'))
    expect(ran).toEqual(['a'])
    await expect(hold.whenOpen()).resolves.toBeUndefined()
  })

  it('holds what is run until the load settles, then runs it in the order asked, and stays open', async () => {
    const hold = new StartupHold()
    let settle!: () => void
    hold.until(new Promise<void>((resolve) => (settle = resolve)))
    const ran: string[] = []
    hold.run(() => ran.push('first document'))
    hold.run(() => ran.push('second document'))
    const opened = hold.whenOpen().then(() => ran.push('awaited'))
    expect(hold.open).toBe(false)
    expect(ran).toEqual([])
    settle()
    await opened
    expect(ran).toEqual(['first document', 'second document', 'awaited'])
    expect(hold.open).toBe(true)
    hold.run(() => ran.push('later'))
    expect(ran[3]).toBe('later')
  })

  it('opens on a rejected load too – a failed extension load holds nothing', async () => {
    const hold = new StartupHold()
    let fail!: (error: Error) => void
    hold.until(new Promise<void>((_resolve, reject) => (fail = reject)))
    const ran: string[] = []
    hold.run(() => ran.push('document'))
    fail(new Error('manifest.json not found'))
    await hold.whenOpen()
    expect(ran).toEqual(['document'])
  })

  it(`opens at the bound (${EXTENSION_LAYER_HOLD_MS} ms) when the load never settles, saying so once`, () => {
    vi.useFakeTimers()
    const hold = new StartupHold()
    const warn = vi.fn()
    hold.until(new Promise<void>(() => undefined), EXTENSION_LAYER_HOLD_MS, warn)
    const ran: string[] = []
    hold.run(() => ran.push('document'))
    vi.advanceTimersByTime(EXTENSION_LAYER_HOLD_MS - 1)
    expect(ran).toEqual([])
    expect(hold.open).toBe(false)
    vi.advanceTimersByTime(1)
    expect(ran).toEqual(['document'])
    expect(hold.open).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(`${EXTENSION_LAYER_HOLD_MS} ms`)
  })

  it('keeps the close it has: a second load while closed neither restarts the bound nor reopens', async () => {
    vi.useFakeTimers()
    const hold = new StartupHold()
    const warn = vi.fn()
    let settle!: () => void
    hold.until(new Promise<void>((resolve) => (settle = resolve)), 1000, warn)
    vi.advanceTimersByTime(600)
    hold.until(new Promise<void>(() => undefined), 1000, warn)
    const ran: string[] = []
    hold.run(() => ran.push('document'))
    vi.advanceTimersByTime(300)
    expect(ran).toEqual([])
    settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(ran).toEqual(['document'])
    expect(hold.open).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    // A late failure of the load, and a late bound, change nothing.
    vi.advanceTimersByTime(5000)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a held document that throws on its turn does not hold the rest back', async () => {
    const hold = new StartupHold()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let settle!: () => void
    hold.until(new Promise<void>((resolve) => (settle = resolve)))
    const ran: string[] = []
    hold.run(() => {
      throw new Error('destroyed')
    })
    hold.run(() => ran.push('next'))
    settle()
    await hold.whenOpen()
    expect(ran).toEqual(['next'])
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})

describe('extensionLayerNeedsHold', () => {
  const values: Record<string, Record<string, unknown>> = {
    holder: { 'services.passwordSavingEnabled': { regular: false } },
    quiet: {}
  }
  const privacyValues = (id: string): Record<string, unknown> => values[id] ?? {}

  it('is true only for an enabled extension with persisted chrome.privacy values', () => {
    expect(extensionLayerNeedsHold([{ id: 'holder', enabled: true }], privacyValues)).toBe(true)
    expect(
      extensionLayerNeedsHold(
        [
          { id: 'quiet', enabled: true },
          { id: 'holder', enabled: true }
        ],
        privacyValues
      )
    ).toBe(true)
  })

  it('is false with no extensions, with quiet ones, and for a holder that is disabled (not loaded)', () => {
    expect(extensionLayerNeedsHold([], privacyValues)).toBe(false)
    expect(extensionLayerNeedsHold([{ id: 'quiet', enabled: true }], privacyValues)).toBe(false)
    expect(extensionLayerNeedsHold([{ id: 'holder', enabled: false }], privacyValues)).toBe(false)
    expect(extensionLayerNeedsHold([{ id: 'unknown', enabled: true }], privacyValues)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The cold start, with the core: the order the hold keeps
// ---------------------------------------------------------------------------

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
  readonly tabId: string
  /** The documents that went out to the page, in order. */
  readonly loads: string[]
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  /** Every push of the privacy flags to the host (`Platform.privacy.apply`), in order. */
  applied: PrivacyFlags[]
  /** The documents every page of the run was given, in order. */
  loads(): string[]
  /**
   * The chrome document of the first window finished loading (`did-finish-load` →
   * `ZenWindow.onChromeReady`): the core claims the window's visible pages, which creates the
   * restored page and asks for its document – the first navigation of a cold start.
   */
  chromeReady(): void
}

/**
 * A run of the core on a desktop-like host whose pages take their documents through `hold`,
 * the way the desktop's `ElectronTabView.loadURL` does (`views.ts`). `io` shared between two
 * fixtures is a restart: the second reads what the first persisted. `beforeStart` runs where the
 * platform wires the default session – after the core exists, before `browser.start()`.
 */
function run(io: StoreIO, hold: StartupHold, beforeStart?: (browser: Browser) => void): Fixture {
  const views: Recorded[] = []
  const applied: PrivacyFlags[] = []
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({
      windows: true,
      updates: false,
      agents: false,
      secureDns: true,
      quitsThroughCore: true,
      lookalikeHolds: true
    }),
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
      createView: (tab: Tab) => {
        let url = ''
        const record: Recorded = { tabId: tab.id, loads: [] }
        views.push(record)
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (next: string) => {
            hold.run(() => {
              url = next
              record.loads.push(next)
            })
          },
          restoreNavigation: async (snapshot) => {
            await hold.whenOpen()
            const current = snapshot.entries[snapshot.index]?.url ?? ''
            url = current
            record.loads.push(current)
          },
          navigationEntries: () => ({ entries: [], index: -1 })
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
    privacy: {
      apply: (flags) => {
        applied.push(flags)
      },
      bundledLookalikeTable: async () => null
    },
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  beforeStart?.(browser)
  browser.start()
  return {
    browser,
    views,
    applied,
    loads: () => views.flatMap((v) => v.loads),
    chromeReady: () => browser.onChromeReady(browser.focusedWindow())
  }
}

const LOGIN_PAGE = 'https://example.com/login'

/** A run before this one that left the login page open, "Restore previous session" on (the default). */
function profileWithLoginPage(): StoreIO {
  const io = memoryIo()
  const before = run(io, new StartupHold())
  before.browser.handleCommand(before.browser.focusedWindow(), 'urlbar.submit', {
    input: LOGIN_PAGE,
    newTab: true,
    tabId: null,
    background: false
  })
  // The first window's New Tab went out first, then the login page, the tab in front at the end.
  expect(before.loads()).toEqual(['zen://newtab', LOGIN_PAGE])
  // A clean quit: the next run restores the pages instead of offering a crashed session's.
  before.browser.state.markExiting()
  before.browser.state.flushSync()
  return io
}

/**
 * The extension load of the default session as the platform sees it (`ExtensionService.
 * attachSession`): the API host publishes the layer inside Electron's `extension-loaded`
 * (`extensionApi/privacy.ts` `load` → `recompute` → `publishControls`), the promise settles after.
 */
function extensionLoad(): { load: Promise<void>; settle(): void } {
  let settle!: () => void
  const load = new Promise<void>((resolve) => (settle = resolve))
  return { load, settle }
}

function lastFlags(f: Fixture): PrivacyFlags {
  return f.applied[f.applied.length - 1]
}

function request(ctx: Partial<RequestContext> & { url: string }, tabId: string): HostRequest {
  const full: RequestContext = { type: 'main_frame', method: 'GET', ...ctx }
  const base: WebRequestBase = {
    requestId: '1',
    url: full.url,
    method: full.method,
    resourceType: full.type,
    frameId: full.type === 'main_frame' ? 0 : 7,
    parentFrameId: full.type === 'main_frame' ? -1 : 0,
    tabId,
    partition: 'default',
    initiator: full.initiator ?? null,
    documentUrl: full.documentUrl ?? null,
    timestamp: 0
  }
  return { ctx: full, containerId: 'default', tabId, base, state: new Map() }
}

const GUARD = { extensionId: 'pejdijmoenmkgeppbflobdenhhabjlaj', name: 'iCloud Passwords' }

describe('the cold start under an extension holding a privacy setting (services pass 10, the root’s merge condition)', () => {
  it('without the hold the restored page’s document goes out before the layer’s first publish – the order the hold is for', () => {
    const io = profileWithLoginPage()
    const f = run(io, new StartupHold())
    // `browser.start()` restored the window; its chrome document loads and the core claims the
    // restored page, issuing its document at once. The extension load has not settled and
    // nothing is published yet – the first page's decisions read the user's values, the
    // extension's arrive after.
    expect(f.loads()).toEqual([])
    f.chromeReady()
    expect(f.loads()).toEqual([LOGIN_PAGE])
    expect(f.browser.state.extensionControls).toEqual({})
    expect(f.browser.autofill.offerToSave()).toBe(true)
  })

  it('holds the first page’s document until the load publishes, so its password offer reads the extension’s passwordSavingEnabled=false and is refused', async () => {
    const io = profileWithLoginPage()
    const hold = new StartupHold()
    const { load, settle } = extensionLoad()
    // The platform closes the hold at the default session's extension load, before the windows.
    hold.until(load)
    const f = run(io, hold)
    // The window is up. On the desktop its chrome document waits for the same hold; a window
    // focused or ready before it (the pages' own funnel) claims the restored page – its view
    // exists, and its document has not gone out.
    f.chromeReady()
    expect(f.views.map((v) => v.tabId)).toHaveLength(1)
    expect(f.loads()).toEqual([])
    expect(f.browser.autofill.offerToSave()).toBe(true)

    // The load lands: the publish, then the promise – the document only after both.
    f.browser.state.setExtensionControls({
      [EXTENSION_SETTING_KEYS.passwordSaving]: { ...GUARD, value: false }
    })
    expect(f.loads()).toEqual([])
    settle()
    await hold.whenOpen()
    expect(f.loads()).toEqual([LOGIN_PAGE])

    // The first page's password form submits: the offer's decision reads the layer.
    expect(f.browser.autofill.offerToSave()).toBe(false)
    expect(
      decideSave(
        {
          origin: 'https://example.com',
          url: LOGIN_PAGE,
          username: 'ada',
          password: 'hunter2',
          newPassword: false
        },
        {
          offerToSave: f.browser.autofill.offerToSave(),
          isPrivate: false,
          neverSave: false,
          matches: []
        }
      )
    ).toEqual({ kind: 'none', reason: 'disabled' })
    // The user's own switch is untouched underneath.
    expect(f.browser.state.settings.passwords.offerToSave).toBe(true)
  })

  it('holds the first page’s document until the load publishes, so its first webRequest reads the extension’s thirdPartyCookiesAllowed=false and loses its cookie', async () => {
    const io = profileWithLoginPage()
    const hold = new StartupHold()
    const { load, settle } = extensionLoad()
    hold.until(load)
    const f = run(io, hold)
    f.chromeReady()
    // The flags the request handler reads (the desktop's `ElectronPrivacy.apply` keeps the last
    // push): the user's `block-private` at start, which keeps a normal window's cookies.
    const handler = new PrivacyRequestHandler(() => lastFlags(f))
    expect(lastFlags(f).thirdPartyCookies).toBe('block-private')
    expect(f.views).toHaveLength(1)
    expect(f.loads()).toEqual([])

    f.browser.state.setExtensionControls({
      [EXTENSION_SETTING_KEYS.thirdPartyCookies]: { ...GUARD, value: false }
    })
    // The publish re-pushed the flags: the block everywhere, before any document went out.
    expect(lastFlags(f).thirdPartyCookies).toBe('block')
    expect(f.loads()).toEqual([])
    settle()
    await hold.whenOpen()
    expect(f.loads()).toEqual([LOGIN_PAGE])

    // The first page's first third-party request: its cookie goes, under the extension's value.
    const tabId = f.views[0].tabId
    const sent = { Cookie: 'id=1', Accept: '*/*' }
    handler.onBeforeSendHeaders(
      request(
        { url: 'https://tracker.example/pixel', type: 'image', documentUrl: LOGIN_PAGE },
        tabId
      ),
      sent
    )
    expect(sent).toEqual({ Accept: '*/*' })
    // The user's own mode is untouched underneath.
    expect(f.browser.state.settings.privacy.thirdPartyCookies).toBe('block-private')
  })
})

// ---------------------------------------------------------------------------
// The bound fires first: the pending layer fails safe (ADDENDUM C, C1 – the root's condition)
// ---------------------------------------------------------------------------

/**
 * The platform's wiring at the default session's extension load (`platform/index.ts`): the layer
 * is pending, the load's settling ends it (registered before the hold's own `then`), and the
 * documents wait behind the hold – bounded.
 */
function holdForLayer(
  browser: Browser,
  hold: StartupHold,
  load: Promise<void>,
  boundMs: number,
  warn: (message: string) => void
): void {
  browser.state.setExtensionLayerPending(true)
  const settled = (): void => browser.state.setExtensionLayerPending(false)
  load.then(settled, settled)
  hold.until(load, boundMs, warn)
}

/**
 * A run before this one that left the login page open and every one of the six settings at its
 * PERMISSIVE value – the values the bound must not let the first documents read.
 */
function permissiveProfileWithLoginPage(): StoreIO {
  const io = memoryIo()
  const before = run(io, new StartupHold())
  const win = before.browser.focusedWindow()
  before.browser.updateSettings(
    {
      privacy: {
        ...DEFAULT_PRIVACY_SETTINGS,
        safeBrowsingEnabled: false,
        thirdPartyCookies: 'allow',
        thirdPartyCookiesPrivate: 'allow'
      },
      searchSuggestions: true,
      preloadPages: 'standard'
    },
    win
  )
  expect(before.browser.state.settings.passwords.offerToSave).toBe(true)
  expect(before.browser.state.settings.autofill).toEqual({ addresses: true, cards: true })
  before.browser.handleCommand(win, 'urlbar.submit', {
    input: LOGIN_PAGE,
    newTab: true,
    tabId: null,
    background: false
  })
  before.browser.state.markExiting()
  before.browser.state.flushSync()
  return io
}

/** A short bound, so the tests wait for it rather than for `EXTENSION_LAYER_HOLD_MS`. */
const SHORT_BOUND_MS = 20

interface TimedOut {
  f: Fixture
  hold: StartupHold
  settle(): void
  warn: ReturnType<typeof vi.fn>
}

/** The cold start whose extension load outlasts the bound: the documents went, nothing is published. */
async function coldStartTimedOut(): Promise<TimedOut> {
  const io = permissiveProfileWithLoginPage()
  const hold = new StartupHold()
  const { load, settle } = extensionLoad()
  const warn = vi.fn()
  const f = run(io, hold, (browser) => holdForLayer(browser, hold, load, SHORT_BOUND_MS, warn))
  f.chromeReady()
  expect(f.loads()).toEqual([])
  expect(f.browser.state.extensionLayer.pending).toBe(true)
  await hold.whenOpen()
  expect(warn).toHaveBeenCalledTimes(1)
  expect(f.loads()).toEqual([LOGIN_PAGE])
  expect(f.browser.state.extensionControls).toEqual({})
  expect(f.browser.state.extensionLayer.pending).toBe(true)
  return { f, hold, settle, warn }
}

describe('the bound fires before the publish: the pending layer fails safe (the root’s condition, ADDENDUM C)', () => {
  it(`the platform's bound (${EXTENSION_LAYER_HOLD_MS} ms) is under the window's ready-to-show fallback, and the pending layer outlives it`, async () => {
    const { f, settle } = await coldStartTimedOut()
    // The hold is open – the documents went – and the layer is still pending: the two are
    // decoupled on purpose, the order lost is made up for by the strict pole.
    expect(f.browser.state.extensionLayer.pending).toBe(true)
    settle()
    await Promise.resolve()
    expect(f.browser.state.extensionLayer.pending).toBe(false)
  })

  it('passwordSavingEnabled: no save offer – the decision reads the strict pole, not the user’s on', async () => {
    const { f } = await coldStartTimedOut()
    expect(f.browser.state.settings.passwords.offerToSave).toBe(true)
    expect(f.browser.autofill.offerToSave()).toBe(false)
    expect(
      decideSave(
        {
          origin: 'https://example.com',
          url: LOGIN_PAGE,
          username: 'ada',
          password: 'hunter2',
          newPassword: false
        },
        {
          offerToSave: f.browser.autofill.offerToSave(),
          isPrivate: false,
          neverSave: false,
          matches: []
        }
      )
    ).toEqual({ kind: 'none', reason: 'disabled' })
  })

  it('autofillAddressEnabled / autofillCreditCardEnabled: no autofill offer, either kind', async () => {
    const { f } = await coldStartTimedOut()
    expect(f.browser.state.settings.autofill).toEqual({ addresses: true, cards: true })
    expect(f.browser.autofill.addressesEnabled()).toBe(false)
    expect(f.browser.autofill.cardsEnabled()).toBe(false)
  })

  it('safeBrowsingEnabled: protection ON – the lookups, the sweep and the lookalike check run, and the hosts’ flags say so – over the user’s off', async () => {
    const { f } = await coldStartTimedOut()
    expect(f.browser.state.settings.privacy.safeBrowsingEnabled).toBe(false)
    expect(f.browser.protection.safeBrowsing.enabled).toBe(true)
    expect(lastFlags(f).safeBrowsing).toBe(true)
    expect(f.browser.protection.status().safeBrowsing.enabled).toBe(true)
  })

  it('thirdPartyCookiesAllowed: BLOCKED everywhere – the flags, the request handler’s cookie strip, the private switch locked on with no name yet – over the user’s allow', async () => {
    const { f } = await coldStartTimedOut()
    expect(f.browser.state.settings.privacy.thirdPartyCookies).toBe('allow')
    expect(lastFlags(f).thirdPartyCookies).toBe('block')
    const handler = new PrivacyRequestHandler(() => lastFlags(f))
    const sent = { Cookie: 'id=1', Accept: '*/*' }
    handler.onBeforeSendHeaders(
      request(
        { url: 'https://tracker.example/pixel', type: 'image', documentUrl: LOGIN_PAGE },
        f.views[0].tabId
      ),
      sent
    )
    expect(sent).toEqual({ Accept: '*/*' })
    // The private New Tab's switch reads the block: locked, an extension's – unnamed until the
    // publish says which.
    expect(f.browser.protection.status().privateThirdPartyCookies).toEqual({
      blocked: true,
      locked: true,
      lockedByExtension: ''
    })
  })

  it('searchSuggestEnabled: OFF – no query leaves the device – over the user’s on', async () => {
    const { f } = await coldStartTimedOut()
    expect(f.browser.state.settings.searchSuggestions).toBe(true)
    expect(f.browser.suggestions.suggestionsEnabled()).toBe(false)
  })

  it('networkPredictionEnabled: `none` – the flags carry it and the preload handler refuses the prerender’s fetch – over the user’s standard', async () => {
    const { f } = await coldStartTimedOut()
    expect(f.browser.state.settings.preloadPages).toBe('standard')
    expect(lastFlags(f).preloadPages).toBe('none')
    const handler = new PreloadHandler(() => lastFlags(f))
    expect(
      handler.onBeforeSendHeaders(
        request({ url: 'https://news.example/after' }, f.views[0].tabId),
        {
          'Sec-Purpose': 'prefetch;prerender',
          'Sec-Fetch-Dest': 'document'
        }
      )
    ).toEqual({ cancel: true })
  })

  it('the publish ends the interval: from the next decision on, the extension’s value where it holds one and the user’s where it does not – and the flags are pushed again', async () => {
    const { f, settle } = await coldStartTimedOut()
    const pushes = f.applied.length
    // The holder's publish: one key held at the user's-permissive pole, the rest not held.
    f.browser.state.setExtensionControls({
      [EXTENSION_SETTING_KEYS.passwordSaving]: { ...GUARD, value: true }
    })
    expect(f.browser.state.extensionLayer.pending).toBe(false)
    expect(f.browser.autofill.offerToSave()).toBe(true)
    expect(f.browser.autofill.addressesEnabled()).toBe(true)
    expect(f.browser.autofill.cardsEnabled()).toBe(true)
    expect(f.browser.protection.safeBrowsing.enabled).toBe(false)
    expect(f.browser.suggestions.suggestionsEnabled()).toBe(true)
    expect(f.applied.length).toBe(pushes + 1)
    expect(lastFlags(f)).toMatchObject({
      safeBrowsing: false,
      thirdPartyCookies: 'allow',
      thirdPartyCookiesPrivate: 'allow',
      preloadPages: 'standard'
    })
    expect(f.browser.protection.status().privateThirdPartyCookies).toEqual({
      blocked: false,
      locked: false
    })
    // The load's settling after that changes nothing more.
    settle()
    await Promise.resolve()
    expect(f.applied.length).toBe(pushes + 1)
    expect(f.browser.state.extensionLayer.pending).toBe(false)
  })

  it('the load’s settling ends the interval when no publish carried a privacy key – a holder of the other settings, or a failed load', async () => {
    // Resolved: the holder's values were webRTC / referrers / hyperlink auditing alone, whose
    // publish is empty and never reaches the core.
    const first = await coldStartTimedOut()
    const pushes = first.f.applied.length
    first.settle()
    await Promise.resolve()
    expect(first.f.browser.state.extensionLayer.pending).toBe(false)
    expect(first.f.applied.length).toBe(pushes + 1)
    expect(lastFlags(first.f)).toMatchObject({ safeBrowsing: false, thirdPartyCookies: 'allow' })
    expect(first.f.browser.autofill.offerToSave()).toBe(true)

    // Rejected: the extension failed to load, so it holds nothing – the user's values, as Chrome.
    const io = permissiveProfileWithLoginPage()
    const hold = new StartupHold()
    let fail!: (error: Error) => void
    const load = new Promise<void>((_resolve, reject) => (fail = reject))
    const f = run(io, hold, (browser) => holdForLayer(browser, hold, load, SHORT_BOUND_MS, vi.fn()))
    f.chromeReady()
    await hold.whenOpen()
    expect(f.browser.state.extensionLayer.pending).toBe(true)
    fail(new Error('manifest.json not found'))
    await Promise.resolve()
    expect(f.browser.state.extensionLayer.pending).toBe(false)
    expect(f.browser.autofill.offerToSave()).toBe(true)
  })

  it('a publish that carries none of the privacy keys – the font rows’ – leaves the interval open', async () => {
    const { f, settle } = await coldStartTimedOut()
    f.browser.state.setExtensionControls({
      'fonts.standard': { ...GUARD, value: 'Inter' }
    })
    expect(f.browser.state.extensionLayer.pending).toBe(true)
    expect(f.browser.autofill.offerToSave()).toBe(false)
    expect(lastFlags(f).thirdPartyCookies).toBe('block')
    // The font hold is read as published, untouched by the pending flag.
    expect(f.browser.state.extensionControls['fonts.standard']?.value).toBe('Inter')
    settle()
    await Promise.resolve()
    expect(f.browser.state.extensionLayer.pending).toBe(false)
  })

  it('on the ordinary path – the load settles inside the bound – the interval ends before the documents go', async () => {
    const io = permissiveProfileWithLoginPage()
    const hold = new StartupHold()
    const { load, settle } = extensionLoad()
    const order: string[] = []
    const f = run(io, hold, (browser) => {
      holdForLayer(browser, hold, load, EXTENSION_LAYER_HOLD_MS, vi.fn())
      browser.state.onExtensionControlsChange(() =>
        order.push(`layer:${browser.state.extensionLayer.pending ? 'pending' : 'settled'}`)
      )
    })
    f.chromeReady()
    hold.run(() => order.push('document'))
    expect(f.loads()).toEqual([])
    settle()
    await hold.whenOpen()
    expect(f.loads()).toEqual([LOGIN_PAGE])
    expect(order).toEqual(['layer:settled', 'document'])
  })

  it('every strict pole is the setting’s least permissive value, and every decision answers at once – nothing waits on the layer', async () => {
    const { f } = await coldStartTimedOut()
    // The table the body carries: the pole per key.
    expect(STRICT_POLE).toEqual({
      [EXTENSION_SETTING_KEYS.passwordSaving]: false,
      [EXTENSION_SETTING_KEYS.autofillAddresses]: false,
      [EXTENSION_SETTING_KEYS.autofillCards]: false,
      [EXTENSION_SETTING_KEYS.safeBrowsing]: true,
      [EXTENSION_SETTING_KEYS.thirdPartyCookies]: false,
      [EXTENSION_SETTING_KEYS.searchSuggestions]: false,
      [EXTENSION_SETTING_KEYS.preloadPages]: false
    })
    // Synchronous answers: booleans and flags, no promise to await, no thread stalled.
    expect(typeof f.browser.autofill.offerToSave()).toBe('boolean')
    expect(typeof f.browser.autofill.addressesEnabled()).toBe('boolean')
    expect(typeof f.browser.autofill.cardsEnabled()).toBe('boolean')
    expect(typeof f.browser.protection.safeBrowsing.enabled).toBe('boolean')
    expect(typeof f.browser.suggestions.suggestionsEnabled()).toBe('boolean')
    expect(typeof lastFlags(f).preloadPages).toBe('string')
  })
})

describe('State.extensionLayer (the pending interval)', () => {
  it('is one object per change, its listeners told once per change, and a no-op when nothing changes', () => {
    const f = run(memoryIo(), new StartupHold())
    const state = f.browser.state
    const notified = vi.fn()
    state.onExtensionControlsChange(notified)
    const initial = state.extensionLayer
    expect(initial).toEqual({ controls: {}, pending: false })
    state.setExtensionLayerPending(false)
    expect(notified).not.toHaveBeenCalled()
    expect(state.extensionLayer).toBe(initial)
    state.setExtensionLayerPending(true)
    expect(notified).toHaveBeenCalledTimes(1)
    expect(state.extensionLayer).not.toBe(initial)
    expect(state.extensionLayer.pending).toBe(true)
    state.setExtensionLayerPending(true)
    expect(notified).toHaveBeenCalledTimes(1)
    state.setExtensionLayerPending(false)
    expect(notified).toHaveBeenCalledTimes(2)
    expect(state.extensionLayer).toEqual({ controls: {}, pending: false })
  })

  it('a publish carrying a privacy key ends the interval; one carrying none, or an empty one, does not', () => {
    const f = run(memoryIo(), new StartupHold())
    const state = f.browser.state
    state.setExtensionLayerPending(true)
    state.setExtensionControls({})
    expect(state.extensionLayer.pending).toBe(true)
    state.setExtensionControls({ 'fonts.standard': { ...GUARD, value: 'Inter' } })
    expect(state.extensionLayer.pending).toBe(true)
    for (const key of Object.values(EXTENSION_SETTING_KEYS)) {
      state.setExtensionLayerPending(true)
      state.setExtensionControls({ [key]: { ...GUARD, value: false } })
      expect(state.extensionLayer, key).toEqual({
        controls: { [key]: { ...GUARD, value: false } },
        pending: false
      })
    }
  })
})
