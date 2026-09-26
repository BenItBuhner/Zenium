import type { NotificationHostMessage } from '@shared/notifications'
import { installNotificationPolyfill } from '@shared/notificationScript'

/**
 * Injected by Kotlin into an installed web app's own window (`WebAppActivity`, document-start):
 * the browser's page script cut down to what the app's window has a host for – `Notification`
 * for the app's pages (PWA-02). The WebView hides the API; `WebAppNotifications.kt` shows the
 * shade's cards under the app's own channel group, named for the app, and hands the shade's tap
 * and swipe back as the page's `click` / `close`. Transport is the browser's page bridge
 * (`WebViewCompat.addWebMessageListener`'s `__zenPageBridge`): messages go up with `postMessage`
 * and the host's answers come back through `onmessage`; Kotlin replaces `__ZEN_TOKEN__` with a
 * per-window secret so the app's pages cannot forge a host message (`routePageMessage`).
 *
 * Nothing else of the browser's script rides along – no forms, share, viewport, capture, media
 * session or extension code: the app's window has none of those hosts, and a page inside it is
 * not a browser tab.
 */
interface PageBridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
  addEventListener?(type: 'message', listener: (event: { data: string }) => void): void
}

const TOKEN = '__ZEN_TOKEN__'

;(() => {
  const w = window as unknown as Window & {
    __zenPageBridge?: PageBridge
    __zenWebAppInstalled?: boolean
    __zenPageRules?: unknown
    __zenDeviceWidth?: unknown
    __zenRotateToFullscreen?: unknown
  }
  if (w.__zenWebAppInstalled) return
  w.__zenWebAppInstalled = true
  // The view prefixes every document-start script with the browser's page rules
  // (`TabWebView.startScriptSource`); this window lays nothing out by them, and pages keep no trace.
  delete w.__zenPageRules
  delete w.__zenDeviceWidth
  delete w.__zenRotateToFullscreen
  // Top frame only, as in the browser: an embedded frame's notifications are its own page's
  // business in Chrome too (they come through the embedder's permission).
  if (w !== w.top) return
  const bridge = w.__zenPageBridge
  if (!bridge) return

  // The session token written last so no field of the message can displace it (the browser's rule).
  const up = (message: object): void =>
    bridge.postMessage(JSON.stringify({ ...message, token: TOKEN }))

  let onNotification: ((message: NotificationHostMessage) => void) | null = null
  const onMessage = (event: { data: string }): void => {
    try {
      const data = JSON.parse(event.data) as {
        type?: string
        action?: string
        status?: NotificationHostMessage['status']
        id?: string
      }
      if (data.type !== 'notification' || !data.action) return
      const message: NotificationHostMessage = {
        type: 'notification',
        action: data.action as NotificationHostMessage['action']
      }
      if (data.status !== undefined) message.status = data.status
      if (typeof data.id === 'string') message.id = data.id
      onNotification?.(message)
    } catch {
      /* the host's other messages (flags, forms config) mean nothing to this window */
    }
  }
  if (bridge.addEventListener) bridge.addEventListener('message', onMessage)
  else bridge.onmessage = onMessage

  // The hello hands the host the reply channel (`TabWebView.onPageMessage` keeps the proxy of the
  // frame that said it); the polyfill's own `query` follows it and is answered through it.
  up({ type: 'hello' })
  try {
    installNotificationPolyfill({
      send: (message) => up(message),
      onNotification: (listener) => {
        onNotification = listener
      }
    })
  } catch {
    /* a page that sealed `window` keeps going without notifications */
  }
})()
