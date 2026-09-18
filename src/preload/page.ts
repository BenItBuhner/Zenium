import { contextBridge, ipcRenderer } from 'electron'
import type { PageMessage } from '../core/platform'
import type { PageHint } from '../shared/fullscreenHint'
import {
  installActivationReporter,
  installPageScript,
  type PageScriptFlags,
  type PageScriptMessage
} from '../shared/pageScript'
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
import { completeChromeObject } from '../shared/chromeObject'

/**
 * Runs inside every web page (isolated world). The behaviours – Glance, pinned-tab link rules,
 * the Boost "zap element" picker, the fullscreen hints – live in `shared/pageScript`, the login /
 * address / card form handling in `shared/formsScript`; this file only supplies Electron's IPC as
 * the transport. No page-visible globals are created by them, except that `alert`, `confirm` and
 * `prompt` are Zenium's own (tab-modal dialogs in the chrome; `pageDialogs.ts`).
 *
 * Tabs enable `nodeIntegrationInSubFrames` so the extension API preload reaches extension
 * iframes; the page behaviours stay with the top document, as before. Three things every frame
 * gets: Chrome's `window.chrome` members (`app`, `csi`, `loadTimes`) on the bare object
 * Electron's engine creates – Google's sign-in refuses a Chrome that lacks `chrome.app` as an
 * embedded browser (`shared/chromeObject`); the privacy signals – an embedded third party reads
 * `navigator.globalPrivacyControl` too, so the signals the user switched on are defined in the
 * main world of each document, at document start, from a synchronous ask of the main process (a
 * couple of booleans); and the dialogs, since Chrome shows an embedded page's dialogs too.
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
installPageDialogs()

const send = (message: PageScriptMessage | PageMessage): void =>
  ipcRenderer.send('zen:page', message)

if (!process.isMainFrame) {
  // A gesture inside a cross-origin iframe never reaches the host's `input-event` (Electron
  // observes the top document's widget only), so without this report the pop-up blocker would
  // refuse the `window.open` such a frame makes on a click – the "Sign in with Google" button
  // is an accounts.google.com iframe that opens its pop-up exactly that way.
  installActivationReporter({ send })
}

if (process.isMainFrame) {
  installPageScript({
    send,
    onFlags: (listener) =>
      ipcRenderer.on('zen:page-flags', (_event, next: PageScriptFlags) => listener(next)),
    onZap: (listener) => ipcRenderer.on('zen:zap', (_event, on: boolean) => listener(on)),
    onHint: (listener) =>
      ipcRenderer.on('zen:page-hint', (_event, hint: PageHint | null) => listener(hint))
  })
  installLeaveSite(send)
  // Web notifications are a web-site matter; the browser's own pages have none.
  if (location.protocol === 'https:' || location.protocol === 'http:') {
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
  }
  installFormsScript({
    send: (forms) => ipcRenderer.send('zen:page', { type: 'forms', forms }),
    onCommand: (listener) =>
      ipcRenderer.on('zen:forms', (_event, command: FormsCommand) => listener(command))
  })
}
