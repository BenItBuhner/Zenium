import { contextBridge, ipcRenderer } from 'electron'
import type { PageMessage } from '../core/platform'
import {
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

/**
 * Runs inside every web page (isolated world). The behaviours – Glance, pinned-tab link rules,
 * the Boost "zap element" picker – live in `shared/pageScript`; this file only supplies
 * Electron's IPC as the transport. No page-visible globals are created by them, except that
 * `alert`, `confirm` and `prompt` are Zenium's own (tab-modal dialogs in the chrome;
 * `pageDialogs.ts`).
 *
 * Tabs enable `nodeIntegrationInSubFrames` so the extension API preload reaches extension
 * iframes; the page behaviours stay with the top document, as before. Two things every frame
 * gets: the privacy signals – an embedded third party reads `navigator.globalPrivacyControl`
 * too, so the signals the user switched on are defined in the main world of each document, at
 * document start, from a synchronous ask of the main process (a couple of booleans) – and the
 * dialogs, since Chrome shows an embedded page's dialogs too.
 */
const signals = ipcRenderer.sendSync(PRIVACY_SIGNALS_CHANNEL) as PrivacySignals | undefined
if (signals && (signals.gpc || signals.dnt))
  contextBridge.executeInMainWorld({
    func: installNavigatorSignals,
    args: [signals.gpc, signals.dnt]
  })
installPageDialogs()

if (process.isMainFrame) {
  const send = (message: PageScriptMessage | PageMessage): void =>
    ipcRenderer.send('zen:page', message)
  installPageScript({
    send,
    onFlags: (listener) =>
      ipcRenderer.on('zen:page-flags', (_event, next: PageScriptFlags) => listener(next)),
    onZap: (listener) => ipcRenderer.on('zen:zap', (_event, on: boolean) => listener(on))
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
}
