import { contextBridge, ipcRenderer } from 'electron'
import { installPageScript, type PageScriptFlags } from '../shared/pageScript'
import { NOTIFICATION_PERMISSION_CHANNEL } from '../shared/notifications'
import { installNotificationBridge, installNotificationShim } from './notifications'

/**
 * Runs inside every web page (isolated world). The behaviours – Glance, pinned-tab link rules,
 * the Boost "zap element" picker – live in `shared/pageScript`; this file only supplies
 * Electron's IPC as the transport. No page-visible globals are created.
 *
 * Tabs enable `nodeIntegrationInSubFrames` so the extension API preload reaches extension
 * iframes; the page behaviours stay with the top document, as before.
 */
if (process.isMainFrame) {
  installPageScript({
    send: (message) => ipcRenderer.send('zen:page', message),
    onFlags: (listener) =>
      ipcRenderer.on('zen:page-flags', (_event, next: PageScriptFlags) => listener(next)),
    onZap: (listener) => ipcRenderer.on('zen:zap', (_event, on: boolean) => listener(on))
  })
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
