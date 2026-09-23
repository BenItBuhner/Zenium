import type {
  ColorScheme,
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  Events,
  UIState
} from '@shared/types'
import { cssColorToHex, resolveTheme, rgbToHex } from '@shared/theme'
import { Browser } from '@core/browser'
import type { SelectionToolbarItem } from '@core/menus'
import type { KeyEventInput } from '@core/platform'
import { THEME_PAINTED_EVENT, type ThemePaintedDetail } from '@renderer/hooks/useTheme'
import {
  backStore,
  dispatchBackEvent,
  refreshBackState,
  type BackEventPayload,
  type BackPhase
} from '@renderer/lib/back'
import { applyPrivateLock, setPrivateLockHost } from '@renderer/lib/privateLock'
import { privateSurfaceNow, subscribePrivateSurface } from '@renderer/lib/privateSurface'
import {
  dispatchBarNavigation,
  dispatchBarScroll,
  setBarHideHost,
  setBarHideTouchExploration,
  showBar,
  type BarScrollPayload,
  type BarScrollPhase
} from '@renderer/lib/barHide'
import {
  dispatchHistoryNavEvent,
  setHistoryNavHost,
  type HistoryNavEventPayload,
  type HistoryNavEventPhase
} from '@renderer/lib/historyNav'
import {
  dispatchPullEvent,
  setPullHost,
  type PullEventPayload,
  type PullEventPhase
} from '@renderer/lib/pull'
import { applyTextScale } from '@renderer/lib/textScale'
import { pushToast } from '@renderer/lib/ui'
import { Bridge, getNativeBridge } from './bridge'
import { fetchDeferredDocuments, type HandoffFetch } from './handoff'
import { showHostToast } from './hostToast'
import { installKeyboardPolicy } from './keyboard'
import { schemeForPages } from './pageScheme'
import { AndroidPlatform, type BootInfo, type HostEventPayloads } from './platform'
import { createPreviewBridge } from './preview'
import { openShortcutPrivateTab } from './privateShortcut'
import { AndroidStoreIO, readDocument } from './storeIo'
import type { ViewEventPayloads } from './views'

/** Same shape as the Electron preload's `window.zen`, so the renderer is unchanged. */
export interface ZenApi {
  invoke<K extends CommandName>(name: K, args: CommandArgs<K>): Promise<CommandResult<K>>
  on<K extends EventName>(name: K, listener: (payload: Events[K]) => void): () => void
  /** Filesystem path of a dropped `File`; Android has no file drops, so it is left undefined. */
  pathForFile?(file: File): string
}

/** What Kotlin calls (`window.__zenHost`). Payloads travel as JSON strings. */
export interface HostGlobal {
  resolve(id: number, json: string | null): void
  reject(id: number, message: string): void
  viewEvent(tabId: string, name: string, json: string): void
  hostEvent(name: string, json: string): void
  /** Physical key from a page WebView (or null tab for the chrome); returns "consumed". */
  onKey(tabId: string | null, json: string): boolean
  /**
   * The system back gesture aimed at the chrome: `start` / `progress` / `cancel` as it happens,
   * `commit` when it is let go (also on its own, from a back button). Returns whether the chrome
   * had anything for it; a `commit` that returns false leaves the host to background the app.
   */
  backEvent(phase: string, json: string | null): boolean
  /**
   * A pull-to-refresh on a tab's page as the host recognises it: `start`, then `move` with the
   * finger's travel, then `release` or `cancel` (see `PullGestureClassifier.kt`).
   */
  pullEvent(tabId: string, phase: string, json: string | null): void
  /**
   * An edge drag that navigates a tab's history as the host recognises it in 3-button navigation
   * mode: `start` with the edge, then `move` with the finger's travel, then `release` or
   * `cancel` (see `HistoryNavClassifier.kt`, `lib/historyNav.ts`).
   */
  historyNavEvent(tabId: string, phase: string, json: string | null): void
  /**
   * The active page's scroll as the host reports it for the bar that hides on scroll: `start`
   * (a finger down), `move` (the scroll since the last report), `end` (the finger lifted) or
   * `show` (the page pushed against its top: the bar comes back). See `BarHideGesture.kt`.
   */
  barScroll(tabId: string, phase: string, json: string | null): void
  /**
   * Accessibility focus (TalkBack) landed in the chrome while the bar that hides on scroll was
   * off its edge: the bar comes back so what was focused is on screen (see `Host.kt`).
   */
  barShow(): void
  /**
   * Touch exploration (TalkBack) turned on or off (`AccessibilityManager`'s change listener,
   * `Host.kt`; the boot payload carries the state at start): on, the bar that hides on scroll
   * stays put and comes back if it was off its edge.
   */
  barTouchExploration(enabled: boolean): void
  /** The user tapped the notification / launcher again: bring a URL in. */
  openUrl(url: string): void
  /**
   * Zenium's items for the floating toolbar over a page's selected text (`{ text }`): `[{ id,
   * title }]` in order, `[]` before the core has started. Answered in place: the host reads the
   * evaluation's result (the array as JSON text) while the system's action mode is coming up.
   */
  selectionMenu(tabId: string, json: string | null): SelectionToolbarItem[]
  /** The launcher's "New private tab" shortcut: a private tab in the current space. */
  newPrivateTab(): void
}
/**
 * Start Zen inside the chrome WebView: build the core on the Android platform, expose the
 * renderer API and the host callbacks. Falls back to the iframe preview host when there is no
 * Kotlin bridge (plain browser / dev server).
 *
 * Asynchronous for one reason: the boot payload names the core's big documents instead of
 * carrying them, and they are fetched as files (`handoff.ts`); the store is complete before the
 * platform and the core are built, so that their constructors' synchronous reads (the new tab
 * background, the session, the history, the downloads, the permissions, the extension registry)
 * find every document as they always did. A document read before its file has arrived would be
 * read through the bridge instead (`AndroidStoreIO`), never reported absent: a profile is not
 * mistaken for a first run and overwritten. The Safe Browsing feed documents – the megabytes a
 * refreshed profile would otherwise boot through – are not in the payload at all: the Kotlin
 * engine holds the tables, and the core's service reads them once it is up (`AndroidStoreIO.read`).
 */
export async function bootAndroid(): Promise<{ browser: Browser; api: ZenApi; preview: boolean }> {
  const native = getNativeBridge()
  const preview = native === null
  const bridge = new Bridge(native ?? createPreviewBridge())
  // The host global must exist before the first (synchronous) bridge call answers.
  const platformRef: { current: AndroidPlatform | null } = { current: null }
  const hostGlobal = installHostGlobal(bridge, platformRef)

  const boot = bridge.callSync<BootInfo>('boot', {})
  const handoffFetch: HandoffFetch = (url, init) => fetch(url, init)
  const io = new AndroidStoreIO(bridge, boot.files, boot.deferred, handoffFetch)
  io.adopt(
    await fetchDeferredDocuments(boot.deferred, {
      fetch: handoffFetch,
      readSync: (name) => readDocument(bridge, name)
    })
  )
  // From here on nothing yields until the core has started: what the host sends in reaches a
  // started core, as it did when this was one synchronous run.
  const platform = new AndroidPlatform(bridge, boot, io)
  const browser = new Browser(platform)
  platform.bind(browser)
  platformRef.current = platform
  syncNativeTheme(bridge, platform, browser)
  syncPrivateSurface(bridge)
  syncPrivateLock(bridge, boot, platform)
  syncBackState(bridge)
  syncPullToRefresh(bridge, platform)
  syncBarHide(bridge, boot)
  syncHistoryNavBubble(bridge)
  // The chrome's text at the system font size (A11Y-05): the host drew it at `textZoom` already;
  // the line boxes follow from here. Changes arrive with the `environment` event (platform.ts).
  applyTextScale(boot.environment)
  browser.start()
  hostGlobal.flush()

  // Shortcuts typed into the chrome itself go through the same table as page keys.
  window.addEventListener(
    'keydown',
    (e) => {
      const input: KeyEventInput = {
        type: 'keyDown',
        key: e.key,
        control: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
        isAutoRepeat: e.repeat
      }
      if (browser.keys.handle(input, null, platform.window)) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    },
    true
  )

  // Chrome inputs (URL bar, rename, settings) are focused programmatically after an async
  // snapshot, i.e. outside the tap's user-gesture window, so the WebView would not raise the
  // keyboard on its own; only fields count (a radio or a checkbox taking focus wants none), and
  // a busy form's field turned editable again gets it back (keyboard.ts).
  if (!preview) installKeyboardPolicy((message) => bridge.send(message))

  const api: ZenApi = {
    invoke: (name, args) =>
      Promise.resolve().then(() => browser.handleCommand(platform.window, name, args) as never),
    on: (name, listener) => platform.events.on(name, listener)
  }
  return { browser, api, preview }
}

/**
 * Keep the system bars and the window background in step with the theme the chrome has painted
 * – the active space's, or the private blend's once it has crossed to its dark side (MOT-14:
 * the status bar follows the chrome's own spring, not a guess at it) – so the gradient reaches
 * behind the status bar and its icons stay legible; and hand the chrome's `--zen-scrim` token
 * over, so what the host draws natively (the page behind an in-page back) dims with the same
 * space-tinted scrim as the chrome's own sheets, and `--v2-accent` / `--v2-on-accent`, so a native
 * primary control (the page dialog sheet's OK, PUI-27) is the chrome's own. `useTheme` announces
 * each paint that matters (`zen-theme-painted`); before its first one the space theme is worked
 * out from the state.
 */
function syncNativeTheme(bridge: Bridge, platform: AndroidPlatform, browser: Browser): void {
  let last = ''
  let frame: number | null = null
  let painted: ThemePaintedDetail | null = null
  // The scheme the host has for the pages' night mode (`schemeForPages`).
  let handed: ColorScheme | null = null
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
  const fromState = (state: UIState): ThemePaintedDetail => {
    const space = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0]
    const scheme = state.settings.colorScheme
    const dark = scheme === 'system' ? systemDark.matches : scheme === 'dark'
    const resolved = resolveTheme(space?.theme ?? null, dark)
    return { dark, background: rgbToHex(resolved.averageColor) }
  }
  const send = (state: UIState): void => {
    const { dark, background } = painted ?? fromState(state)
    // `scheme` lets the host set the app's night mode, so pages' `prefers-color-scheme`
    // follows Zenium's own Light / Dark choice and not only the system's – handed over as the
    // chrome's paint crosses to the scheme's side, so the pages flip with the chrome and not
    // a blend ahead of it (`pageScheme.ts`).
    handed = schemeForPages(handed, state.settings.colorScheme, dark, systemDark.matches)
    const scrim = computedTokenColor('--zen-scrim') ?? ''
    const accent = computedTokenColor('--v2-accent') ?? ''
    const onAccent = computedTokenColor('--v2-on-accent') ?? ''
    const key = `${handed}|${dark}|${background}|${scrim}|${accent}|${onAccent}`
    if (key === last) return
    last = key
    bridge.send('chrome.setTheme', { dark, scheme: handed, background, scrim, accent, onAccent })
  }
  const apply = (state: UIState): void => {
    // The token is read back from the document a frame later, once React has written the
    // theme's variables (`useTheme`); the state event this runs on precedes that render.
    if (frame !== null) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = null
      send(state)
    })
  }
  const current = (): UIState => browser.state.snapshot(platform.window)
  platform.events.on('state', apply)
  systemDark.addEventListener('change', () => apply(current()))
  window.addEventListener(THEME_PAINTED_EVENT, (e) => {
    painted = (e as CustomEvent<ThemePaintedDetail>).detail
    // A paint is on the root already (`useTheme` writes the variables before it announces):
    // the host hears of the crossing in the same frame, and the pages flip with the chrome.
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    send(current())
  })
}

/**
 * The window's screenshot guard (`FLAG_SECURE`, `window.setSecure`): up while a private tab is
 * in view or the overview shows the private pane, so Recents shows no private page and none is
 * captured (Chrome hides Incognito from the app switcher the same way); down again the moment
 * the chrome leaves the private surface. The stores fire before React renders, so the flag is
 * up before the private page's view is placed on screen.
 */
function syncPrivateSurface(bridge: Bridge): void {
  const send = (secure: boolean): void => bridge.send('window.setSecure', { secure })
  subscribePrivateSurface(send)
  send(privateSurfaceNow())
}

/**
 * "Lock private tabs when you leave Zenium" (`lib/privateLock.ts`, `PrivateLock.kt`): the host
 * holds the lock and shows the system's prompt; the chrome draws the cover. The Settings switch
 * is mirrored to the host off the state, as pull-to-refresh is (the host arms the lock from it
 * as the window leaves), whether a screen lock is set is read off the boot payload here, and the
 * host's word on the lock arrives as `private.lock` (`installHostGlobal`). The lock is never on
 * at boot: it lives in the host's memory, and a start is a fresh one.
 */
function syncPrivateLock(bridge: Bridge, boot: BootInfo, platform: AndroidPlatform): void {
  setPrivateLockHost({
    unlock: (reason) => bridge.call<{ locked: boolean }>('private.unlock', { reason }),
    verify: (reason) => bridge.call<boolean>('reauth.verify', { reason })
  })
  applyPrivateLock({ locked: false, screenLock: boot.screenLock === true })
  let last: boolean | null = null
  platform.events.on('state', (state: UIState) => {
    const enabled = state.privateLockOnLeave
    if (enabled === last) return
    last = enabled
    bridge.send('private.setLockOnLeave', { enabled })
  })
}

/** The colour a chrome CSS token currently computes to, as `#rrggbbaa` (null when unreadable). */
function computedTokenColor(token: string): string | null {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = `var(${token})`
  document.documentElement.appendChild(probe)
  try {
    return cssColorToHex(getComputedStyle(probe).color)
  } finally {
    probe.remove()
  }
}

/**
 * Tell Kotlin ahead of every back gesture whether the chrome would take it and which tab's page
 * is up: it registers its back callback only then, so with nothing to pop the system's own
 * back-to-home animation runs (see `PredictiveBack.kt` and the chrome's `lib/back.ts`).
 */
function syncBackState(bridge: Bridge): void {
  const send = (): void => bridge.send('back.update', backStore.get())
  backStore.subscribe(send)
  refreshBackState()
  send()
}

/**
 * Pull-to-refresh: the host recognises the gesture on the page WebView and streams it to the
 * chrome's `lib/pull.ts`, which answers with the one value it works out – how far down the page
 * sits – for the host to move the page by. The Settings switch is mirrored to the host, which
 * then leaves such drags to the page like any other.
 */
function syncPullToRefresh(bridge: Bridge, platform: AndroidPlatform): void {
  setPullHost({
    setOffset: (tabId, offset) => bridge.send('view.setPullOffset', { tabId, offset })
  })
  let last: boolean | null = null
  platform.events.on('state', (state: UIState) => {
    const enabled = state.settings.pullToRefresh
    if (enabled === last) return
    last = enabled
    bridge.send('chrome.setPullToRefresh', { enabled })
  })
}

/**
 * The bar that hides on scroll (`lib/barHide.ts`): the host streams the active page's scroll in
 * and hears back, per frame, where the bar is – it moves the page's edge on the bar's side to
 * match, and watches (or, with the bar docked at the top, takes over) the page's touches only
 * while the frame says the bar may hide (`null` turns it off). Whether an accessibility service
 * explores by touch is read off the boot payload here; changes arrive as
 * `__zenHost.barTouchExploration`.
 */
function syncBarHide(bridge: Bridge, boot: BootInfo): void {
  setBarHideHost({
    // One way: a frame per scrolled frame, and no answer to run on the chrome's thread for each.
    apply: (frame) => bridge.post('chrome.setBarHide', frame ?? { enabled: false }),
    // The chrome's console reaches the logcat (`ZenChrome`): each phase, and every move of the
    // bar that was not the finger's, on the record next to the host's own (`BarHide`, `ZenHost`).
    note: (reason) => console.debug(`bar hide: ${reason}`)
  })
  setBarHideTouchExploration(boot.touchExploration === true)
}

/**
 * The history navigation bubble (`lib/historyNav.ts`, GN-04). The pages are layered above the
 * chrome's WebView here, so a disc the chrome drew at a page's side would never show (only a
 * band the host opens, as pull-to-refresh's, shows the chrome through); the host draws the disc
 * itself (`HistoryNavBubbleView`, above the pages) where the chrome says, per frame over the
 * one-way channel, in CSS px it scales by its density; `{ visible: false }` takes it down.
 */
function syncHistoryNavBubble(bridge: Bridge): void {
  setHistoryNavHost({
    apply: (frame) => bridge.post('chrome.historyNavBubble', frame ?? { visible: false })
  })
}

/**
 * Install `window.__zenHost`. What Kotlin sends before the platform exists – a view event, an
 * insets change, the URL the app was launched with – waits in order and is delivered by
 * `flush()` once the core has started (before the boot fetched documents, nothing could arrive
 * in between: the boot was one synchronous run).
 */
function installHostGlobal(
  bridge: Bridge,
  platformRef: { current: AndroidPlatform | null }
): { flush(): void } {
  const parse = <T>(json: string | null | undefined): T =>
    (json === null || json === undefined || json === '' ? undefined : JSON.parse(json)) as T
  let queued: Array<(platform: AndroidPlatform) => void> | null = []
  /** What waited, by name, for the boot log below (`hostEvent` and `viewEvent` name theirs). */
  const queuedNames: string[] = []
  const withPlatform = (deliver: (platform: AndroidPlatform) => void, name = ''): void => {
    const platform = platformRef.current
    if (platform && queued === null) deliver(platform)
    else {
      queued?.push(deliver)
      if (name) queuedNames.push(name)
    }
  }
  const host: HostGlobal = {
    resolve: (id, json) => bridge.resolve(id, json),
    reject: (id, message) => bridge.reject(id, message),
    viewEvent: (tabId, name, json) =>
      withPlatform((platform) => {
        const payload = parse<ViewEventPayloads[keyof ViewEventPayloads]>(json)
        platform.viewEvent(tabId, name as keyof ViewEventPayloads, payload)
        // After the core: the bar that hides on scroll keys the page's document by this commit,
        // and the `inPage` flag is what tells a pushState from a document (`lib/barHide.ts`).
        if (name === 'navigated')
          dispatchBarNavigation(
            tabId,
            (payload as ViewEventPayloads['navigated'] | undefined)?.inPage === true
          )
      }, `view.${name}`),
    hostEvent: (name, json) => {
      // The private lock is the chrome's alone (`lib/privateLock.ts`): its store takes the
      // host's word as it comes, the core having no part in it.
      if (name === 'private.lock') {
        applyPrivateLock(parse<HostEventPayloads['private.lock'] | undefined>(json) ?? {})
        return
      }
      withPlatform((platform) => {
        // The host's own toasts go straight to the chrome's cards (the renderer is in reach here,
        // not in the platform): the file chooser's camera refused, Open settings when for good.
        if (name === 'toast') {
          showHostToast(parse(json), {
            toast: (message, kind, action) => pushToast(message, kind, action ? { action } : {}),
            openSettings: () => bridge.send('app.openSettings')
          })
          return
        }
        const payload = parse<HostEventPayloads[keyof HostEventPayloads]>(json)
        platform.hostEvent(name as keyof HostEventPayloads, payload)
        // A configuration change: the host has re-zoomed the chrome's text already, and the
        // line boxes follow the factor it reports (`lib/textScale.ts`).
        if (name === 'environment') applyTextScale(payload as HostEventPayloads['environment'])
      }, name)
    },
    onKey: (tabId, json) =>
      queued === null
        ? (platformRef.current?.viewKey(tabId, parse<KeyEventInput>(json)) ?? false)
        : false,
    backEvent: (phase, json) =>
      dispatchBackEvent(phase as BackPhase, parse<BackEventPayload | null>(json)),
    pullEvent: (tabId, phase, json) =>
      dispatchPullEvent(tabId, phase as PullEventPhase, parse<PullEventPayload | null>(json)),
    historyNavEvent: (tabId, phase, json) =>
      dispatchHistoryNavEvent(
        tabId,
        phase as HistoryNavEventPhase,
        parse<HistoryNavEventPayload | null>(json)
      ),
    barScroll: (tabId, phase, json) =>
      dispatchBarScroll(tabId, phase as BarScrollPhase, parse<BarScrollPayload | null>(json)),
    barShow: () => showBar(),
    barTouchExploration: (enabled) => setBarHideTouchExploration(enabled === true),
    openUrl: (url) =>
      withPlatform((platform) =>
        platform.browser.openExternalUrl(url, platform.window, { fromIntent: true })
      ),
    selectionMenu: (tabId, json) =>
      queued === null
        ? (platformRef.current?.selectionMenu(
            tabId,
            parse<{ text?: unknown } | undefined>(json) ?? {}
          ) ?? [])
        : [],
    newPrivateTab: () =>
      withPlatform((platform) => {
        openShortcutPrivateTab(platform.browser, platform.window)
      })
  }
  ;(window as unknown as { __zenHost: HostGlobal }).__zenHost = host
  return {
    flush: () => {
      const platform = platformRef.current
      const pending = queued ?? []
      queued = null
      // On the record (logcat `ZenChrome`): what the host sent while the boot fetched its
      // deferred documents. An `insets` here is the one the chrome used to lose – delivered
      // before React had subscribed; the bus keeps it now (`InProcessEvents`).
      if (pending.length > 0)
        console.debug(
          `[zen] boot: ${pending.length} host message(s) waited for the core: ${queuedNames.join(', ')}`
        )
      if (platform) for (const deliver of pending) deliver(platform)
    }
  }
}
