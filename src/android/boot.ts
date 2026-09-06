import type { CommandArgs, CommandName, CommandResult, EventName, Events } from '@shared/types'
import { Browser } from '@core/browser'
import type { KeyEventInput } from '@core/platform'
import { handleSystemBack } from '@renderer/lib/ui'
import { Bridge, getNativeBridge } from './bridge'
import {
  ANDROID_CAPABILITIES,
  AndroidPlatform,
  type BootInfo,
  type HostEventPayloads
} from './platform'
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
  /** Hardware/gesture back; returns false when the host should background the app. */
  onBack(): boolean
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
  const browser = new Browser(platform, ANDROID_CAPABILITIES)
  platform.bind(browser)
  platformRef.current = platform
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
      if (browser.keys.handle(input, null)) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    },
    true
  )

  const api: ZenApi = {
    invoke: (name, args) =>
      Promise.resolve().then(() => browser.handleCommand(name, args) as never),
    on: (name, listener) => platform.chrome.on(name, listener)
  }
  return { browser, api, preview }
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
    onBack: () => handleSystemBack(),
    openUrl: (url) => platformRef.current?.browser.openExternalUrl(url)
  }
  ;(window as unknown as { __zenHost: HostGlobal }).__zenHost = host
}
