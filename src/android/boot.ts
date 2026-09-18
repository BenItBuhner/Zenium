import type {
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  Events,
  UIState
} from '@shared/types'
import { cssColorToHex, resolveTheme, rgbToHex } from '@shared/theme'
import { Browser } from '@core/browser'
import type { KeyEventInput } from '@core/platform'
import {
  backStore,
  dispatchBackEvent,
  refreshBackState,
  type BackEventPayload,
  type BackPhase
} from '@renderer/lib/back'
import {
  dispatchPullEvent,
  setPullHost,
  type PullEventPayload,
  type PullEventPhase
} from '@renderer/lib/pull'
import { Bridge, getNativeBridge } from './bridge'
import { AndroidPlatform, type BootInfo, type HostEventPayloads } from './platform'
import { createPreviewBridge } from './preview'
import type { ViewEventPayloads } from './views'

/** Same shape as the Electron preload's `window.zen`, so the renderer is unchanged. */
export interface ZenApi {
  invoke<K extends CommandName>(name: K, args: CommandArgs<K>): Promise<CommandResult<K>>
  on<K extends EventName>(name: K, listener: (payload: Events[K]) => void): () => void
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
  /** The user tapped the notification / launcher again: bring a URL in. */
  openUrl(url: string): void
}

/**
 * Start Zen inside the chrome WebView: build the core on the Android platform, expose the
 * renderer API and the host callbacks. Falls back to the iframe preview host when there is no
 * Kotlin bridge (plain browser / dev server).
 */
export function bootAndroid(): { browser: Browser; api: ZenApi; preview: boolean } {
  const native = getNativeBridge()
  const preview = native === null
  const bridge = new Bridge(native ?? createPreviewBridge())
  // The host global must exist before the first (synchronous) bridge call answers.
  const platformRef: { current: AndroidPlatform | null } = { current: null }
  installHostGlobal(bridge, platformRef)

  const boot = bridge.callSync<BootInfo>('boot', {})
  const platform = new AndroidPlatform(bridge, boot)
  const browser = new Browser(platform)
  platform.bind(browser)
  platformRef.current = platform
  syncNativeTheme(bridge, platform, browser)
  syncBackState(bridge)
  syncPullToRefresh(bridge, platform)
  browser.start()

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
  // keyboard on its own.
  if (!preview) {
    const isEditable = (el: EventTarget | null): boolean =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    document.addEventListener('focusin', (e) => {
      if (isEditable(e.target)) bridge.send('chrome.showKeyboard')
    })
    document.addEventListener('focusout', (e) => {
      if (isEditable(e.target) && !isEditable(e.relatedTarget)) bridge.send('chrome.hideKeyboard')
    })
  }

  const api: ZenApi = {
    invoke: (name, args) =>
      Promise.resolve().then(() => browser.handleCommand(platform.window, name, args) as never),
    on: (name, listener) => platform.events.on(name, listener)
  }
  return { browser, api, preview }
}

/**
 * Keep the system bars and the window background in step with the active space's theme, so the
 * gradient reaches behind the status bar and its icons stay legible – and hand the chrome's
 * `--zen-scrim` token over, so what the host draws natively (the page behind an in-page back)
 * dims with the same space-tinted scrim as the chrome's own sheets.
 */
function syncNativeTheme(bridge: Bridge, platform: AndroidPlatform, browser: Browser): void {
  let last = ''
  let frame: number | null = null
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = (state: UIState): void => {
    const space = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0]
    const scheme = state.settings.colorScheme
    const dark = scheme === 'system' ? systemDark.matches : scheme === 'dark'
    const resolved = resolveTheme(space?.theme ?? null, dark)
    const background = rgbToHex(resolved.averageColor)
    // The token is read back from the document a frame later, once React has written the
    // space's variables (`useTheme`); the state event this runs on precedes that render.
    if (frame !== null) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = null
      const scrim = computedTokenColor('--zen-scrim') ?? ''
      const key = `${scheme}|${dark}|${background}|${scrim}`
      if (key === last) return
      last = key
      // `scheme` lets the host set the app's night mode, so pages' `prefers-color-scheme`
      // follows Zenium's own Light / Dark choice and not only the system's.
      bridge.send('chrome.setTheme', { dark, scheme, background, scrim })
    })
  }
  platform.events.on('state', apply)
  systemDark.addEventListener('change', () => apply(browser.state.snapshot(platform.window)))
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

function installHostGlobal(bridge: Bridge, platformRef: { current: AndroidPlatform | null }): void {
  const parse = <T>(json: string | null | undefined): T =>
    (json === null || json === undefined || json === '' ? undefined : JSON.parse(json)) as T
  const host: HostGlobal = {
    resolve: (id, json) => bridge.resolve(id, json),
    reject: (id, message) => bridge.reject(id, message),
    viewEvent: (tabId, name, json) =>
      platformRef.current?.viewEvent(
        tabId,
        name as keyof ViewEventPayloads,
        parse<ViewEventPayloads[keyof ViewEventPayloads]>(json)
      ),
    hostEvent: (name, json) =>
      platformRef.current?.hostEvent(
        name as keyof HostEventPayloads,
        parse<HostEventPayloads[keyof HostEventPayloads]>(json)
      ),
    onKey: (tabId, json) =>
      platformRef.current?.viewKey(tabId, parse<KeyEventInput>(json)) ?? false,
    backEvent: (phase, json) =>
      dispatchBackEvent(phase as BackPhase, parse<BackEventPayload | null>(json)),
    pullEvent: (tabId, phase, json) =>
      dispatchPullEvent(tabId, phase as PullEventPhase, parse<PullEventPayload | null>(json)),
    openUrl: (url) => {
      const platform = platformRef.current
      platform?.browser.openExternalUrl(url, platform.window)
    }
  }
  ;(window as unknown as { __zenHost: HostGlobal }).__zenHost = host
}
