import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { PageHostMessage, PageMessage } from '../core/platform'
import type { PageHint } from '../shared/fullscreenHint'
import {
  PAGE_HOST_CHANNEL,
  installActivationReporter,
  installPageScript,
  type PageScriptFlags,
  type PageScriptMessage
} from '../shared/pageScript'
import { installInstallPromptShim } from '../shared/installPrompt'
import {
  DISPLAY_MODE_CHANNEL,
  DISPLAY_MODE_EVENT,
  installDisplayModeShim,
  type DisplayMode
} from '../shared/displayMode'
import { installMediaSessionBridge, installMediaSessionShim } from '../shared/mediaSessionShim'
import {
  SCREEN_CAPTURE_INTENT_CHANNEL,
  installScreenCaptureBridge,
  installScreenCaptureShim
} from '../shared/screenCapture'
import { installCaptureReporter, installCaptureShim } from '../shared/captureState'
import { installShareBridge, installShareShim } from '../shared/share'
import { installGeolocationBridge, installGeolocationShim } from '../shared/geolocation'
import { NOTIFICATION_PERMISSION_CHANNEL } from '../shared/notifications'
import { installNotificationBridge, installNotificationShim } from './notifications'
import {
  PRIVACY_SIGNALS_CHANNEL,
  installNavigatorSignals,
  type PrivacySignals
} from '../shared/privacySignals'
import { installLeaveSite, installPageDialogs } from './pageDialogs'
import { installFormsScript } from '../shared/formsScript'
import type { FormsCommand } from '../shared/forms'
import { USER_SCRIPTS_CHANNELS } from '../shared/userScripts'
import { installUserScripts } from './userScripts'
import { completeChromeObject } from '../shared/chromeObject'
import { installNewTabPage } from '../shared/newTabPageScript'
import type { NewTabPageCommand, NewTabPageState } from '../shared/types'
import { isNewTabUrl } from '../shared/url'

/**
 * Runs inside every web page (isolated world). The behaviours – Glance, pinned-tab link rules,
 * the Boost "zap element" picker, the fullscreen hints – live in `shared/pageScript`, the login /
 * address / card form handling in `shared/formsScript`; this file only supplies Electron's IPC as
 * the transport. No page-visible globals are created by them, except that `alert`, `confirm` and
 * `prompt` are Zenium's own (tab-modal dialogs in the chrome; `pageDialogs.ts`).
 *
 * Tabs enable `nodeIntegrationInSubFrames` so the extension API preload reaches extension
 * iframes; the page behaviours stay with the top document, as before. Four things every frame
 * gets: Chrome's `window.chrome` members (`app`, `csi`, `loadTimes`) on the bare object
 * Electron's engine creates – Google's sign-in refuses a Chrome that lacks `chrome.app` as an
 * embedded browser (`shared/chromeObject`); the privacy signals – an embedded third party reads
 * `navigator.globalPrivacyControl` too, so the signals the user switched on are defined in the
 * main world of each document, at document start, from a synchronous ask of the main process (a
 * couple of booleans); the dialogs, since Chrome shows an embedded page's dialogs too; and
 * extensions' user scripts (`chrome.userScripts`), from a second synchronous ask.
 */
try {
  // Serialised into the main world: the function falls back to that world's `globalThis`.
  contextBridge.executeInMainWorld({ func: completeChromeObject })
} catch (error) {
  console.warn('[zen] window.chrome unavailable:', (error as Error).message)
}
const signals = ipcRenderer.sendSync(PRIVACY_SIGNALS_CHANNEL) as PrivacySignals | undefined
if (signals && (signals.gpc || signals.dnt))
  contextBridge.executeInMainWorld({
    func: installNavigatorSignals,
    args: [signals.gpc, signals.dnt]
  })
// `display-mode` (MW-23): Electron's engine answers `browser` in every window; the page's world
// gets Zenium's answer for its window (standalone in an app window) before its first script.
try {
  const displayMode = ipcRenderer.sendSync(DISPLAY_MODE_CHANNEL) as DisplayMode | undefined
  contextBridge.executeInMainWorld({
    func: installDisplayModeShim,
    args: [displayMode ?? 'browser', DISPLAY_MODE_EVENT]
  })
} catch (error) {
  console.warn('[zen] display-mode shim unavailable:', (error as Error).message)
}
installPageDialogs()
installUserScripts({
  plan: (request) => ipcRenderer.sendSync(USER_SCRIPTS_CHANNELS.plan, request),
  message: (message) => ipcRenderer.invoke(USER_SCRIPTS_CHANNELS.message, message),
  port: (wire) => ipcRenderer.send(USER_SCRIPTS_CHANNELS.port, wire),
  answer: (answer) => ipcRenderer.send(USER_SCRIPTS_CHANNELS.answer, answer),
  onPort: (listener) =>
    ipcRenderer.on(USER_SCRIPTS_CHANNELS.port, (_event, wire) => listener(wire)),
  onDeliver: (listener) =>
    ipcRenderer.on(USER_SCRIPTS_CHANNELS.deliver, (_event, delivery) => listener(delivery)),
  onExecute: (listener) =>
    ipcRenderer.on(USER_SCRIPTS_CHANNELS.execute, (_event, execution) => listener(execution)),
  executeInMainWorld: (code) => webFrame.executeJavaScript(code),
  executeInIsolatedWorld: (worldId, code) =>
    webFrame.executeJavaScriptInIsolatedWorld(worldId, [{ code }]),
  setIsolatedWorldInfo: (worldId, info) => webFrame.setIsolatedWorldInfo(worldId, info)
})

const send = (message: PageScriptMessage | PageMessage): void =>
  ipcRenderer.send('zen:page', message)

// Screen capture (MW-19), in every frame of a site (an iframe allowed `display-capture` may
// call too): the page's `getDisplayMedia` announces whether it asked for audio before the
// engine's permission request, which does not say, so the picker offers system audio when
// Chrome's would. The ask is synchronous – the permission request follows the call at once.
if (location.protocol === 'https:' || location.protocol === 'http:') {
  installScreenCaptureBridge({
    intent: (audio) => {
      ipcRenderer.sendSync(SCREEN_CAPTURE_INTENT_CHANNEL, audio)
    },
    installShim: (eventName) => {
      try {
        contextBridge.executeInMainWorld({ func: installScreenCaptureShim, args: [eventName] })
      } catch (error) {
        console.warn('[zen] screen capture shim unavailable:', (error as Error).message)
      }
    }
  })
  // The tab's alert indicator (tabs-43), from every frame: the main-world shim counts the live
  // camera / microphone / display tracks, this world watches picture-in-picture, and each change
  // goes to the browser as one `capture-state` message under the frame's own id.
  installCaptureReporter({
    send,
    installShim: (eventName) => {
      try {
        contextBridge.executeInMainWorld({ func: installCaptureShim, args: [eventName] })
      } catch (error) {
        console.warn('[zen] capture shim unavailable:', (error as Error).message)
      }
    }
  })
}

if (!process.isMainFrame) {
  // A gesture inside a cross-origin iframe never reaches the host's `input-event` (Electron
  // observes the top document's widget only), so without this report the pop-up blocker would
  // refuse the `window.open` such a frame makes on a click – the "Sign in with Google" button
  // is an accounts.google.com iframe that opens its pop-up exactly that way.
  installActivationReporter({ send })
}

if (process.isMainFrame) {
  // Browser → page messages (`TabView.postToPage`), one channel told apart by `type`: the
  // web-app install events, media controls, share results and geolocation answers.
  type HostType = PageHostMessage['type']
  const hostListeners = new Map<HostType, Array<(message: PageHostMessage) => void>>()
  ipcRenderer.on(PAGE_HOST_CHANNEL, (_event, message: PageHostMessage) => {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return
    for (const listener of hostListeners.get(message.type) ?? []) listener(message)
  })
  const onHost = <T extends HostType>(
    type: T,
    listener: (message: Extract<PageHostMessage, { type: T }>) => void
  ): void => {
    const list = hostListeners.get(type) ?? []
    list.push(listener as (message: PageHostMessage) => void)
    hostListeners.set(type, list)
  }
  const inMainWorld = <A extends unknown[]>(func: (...args: A) => void, args: A): void => {
    try {
      contextBridge.executeInMainWorld({ func, args })
    } catch (error) {
      console.warn('[zen] page shim unavailable:', (error as Error).message)
    }
  }

  // The window went fullscreen or the page moved to another window: the shim's lists fire `change`.
  onHost('display-mode', (message) =>
    document.dispatchEvent(new CustomEvent(DISPLAY_MODE_EVENT, { detail: message.mode }))
  )

  installPageScript({
    send,
    onFlags: (listener) =>
      ipcRenderer.on('zen:page-flags', (_event, next: PageScriptFlags) => listener(next)),
    onZap: (listener) => ipcRenderer.on('zen:zap', (_event, on: boolean) => listener(on)),
    onHint: (listener) =>
      ipcRenderer.on('zen:page-hint', (_event, hint: PageHint | null) => listener(hint)),
    // Web apps (MW-22): the manifest probe here, the install events in the page's world.
    onWebApp: (listener) =>
      onHost('webapp', (message) =>
        listener({ type: 'webapp', action: message.action, outcome: message.outcome })
      ),
    installInstallPromptShim: (events) => inMainWorld(installInstallPromptShim, [events]),
    // Read aloud (CT-12 / CT-13): the extraction request and the highlight, in every document
    // (the `zen://reader` page included, which the same code paints).
    onReadAloud: (listener) => onHost('readAloud', listener)
  })
  installLeaveSite(send)
  const webPage = location.protocol === 'https:' || location.protocol === 'http:'
  // The media hub and MPRIS (MW-16, MW-18) read the page's Media Session; a local video file
  // counts too. The report leaves the tab's audible flag to the engine's own events.
  if (webPage || location.protocol === 'file:') {
    installMediaSessionBridge({
      send: (report) => ipcRenderer.send('zen:page', { type: 'media', media: report }),
      onControl: (listener) => onHost('mediaSession', listener),
      installShim: (events, actions) => inMainWorld(installMediaSessionShim, [events, actions])
    })
  }
  // Web notifications, sharing and location are a web-site matter; the browser's own pages have none.
  if (webPage) {
    installNotificationBridge({
      status: () => ipcRenderer.sendSync(NOTIFICATION_PERMISSION_CHANNEL),
      onStatus: (listener) =>
        ipcRenderer.on(NOTIFICATION_PERMISSION_CHANNEL, (_event, status: unknown) =>
          listener(status)
        ),
      focus: () => ipcRenderer.send('zen:page', { type: 'focus' }),
      installShim: (events) =>
        contextBridge.executeInMainWorld({ func: installNotificationShim, args: [events] })
    })
    // `navigator.share` / `canShare` (MW-21): Electron's engine has none; the chrome's sheet answers.
    installShareBridge({
      send: (call) => ipcRenderer.send('zen:page', { type: 'share', share: call }),
      onResult: (listener) => onHost('share', (message) => listener(message.id, message.result)),
      installShim: (events) => inMainWorld(installShareShim, [events])
    })
    // Geolocation (MW-04): Linux has no location provider in the engine, so every call is
    // answered by Zenium's network provider; Windows and macOS ask the OS first and fall back.
    installGeolocationBridge(
      {
        send: (call) => ipcRenderer.send('zen:page', { type: 'geolocation', geolocation: call }),
        onResult: (listener) =>
          onHost('geolocation', (message) =>
            listener({ id: message.id, position: message.position, error: message.error })
          ),
        installShim: (events, mode) => inMainWorld(installGeolocationShim, [events, mode])
      },
      process.platform === 'linux' ? 'replace' : 'fallback'
    )
  }
  installFormsScript({
    send: (forms) => ipcRenderer.send('zen:page', { type: 'forms', forms }),
    onCommand: (listener) =>
      ipcRenderer.on('zen:forms', (_event, command: FormsCommand) => listener(command))
  })

  // The new tab page is filled by `shared/newTabPageScript` over the same kind of transport.
  // The first state is fetched synchronously so the page paints in its theme from the first
  // frame; the main process checks the sender before answering, so a site cannot ask.
  if (isNewTabUrl(location.href)) {
    installNewTabPage({
      initialState: () => {
        const state: unknown = ipcRenderer.sendSync('zen:newtab-state')
        return state && typeof state === 'object' ? (state as NewTabPageState) : null
      },
      onState: (listener) =>
        ipcRenderer.on('zen:newtab-state', (_event, state: NewTabPageState) => listener(state)),
      onCommand: (listener) =>
        ipcRenderer.on('zen:newtab-command', (_event, command: NewTabPageCommand) =>
          listener(command)
        ),
      send: (action) => ipcRenderer.send('zen:newtab', action)
    })
  }
}
