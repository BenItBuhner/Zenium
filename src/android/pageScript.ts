import { installPageScript, type PageScriptFlags } from '@shared/pageScript'

/**
 * Injected by Kotlin into every page WebView (document-start). Transport is the
 * `WebViewCompat.addWebMessageListener` object `__zenPageBridge`: messages go up with
 * `postMessage`, flags come back through its `onmessage`. Kotlin replaces `__ZEN_TOKEN__` with a
 * per-session secret so pages cannot forge browser messages.
 */
interface PageBridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
  addEventListener?(type: 'message', listener: (event: { data: string }) => void): void
}

const TOKEN = '__ZEN_TOKEN__'

;(() => {
  const w = window as unknown as { __zenPageBridge?: PageBridge; __zenPageInstalled?: boolean }
  if (w.__zenPageInstalled) return
  w.__zenPageInstalled = true
  const bridge = w.__zenPageBridge
  if (!bridge) return

  installPageScript({
    trackMedia: true,
    send: (message) => bridge.postMessage(JSON.stringify({ token: TOKEN, ...message })),
    onFlags: (listener) => {
      const onMessage = (event: { data: string }): void => {
        try {
          const data = JSON.parse(event.data) as { type?: string; flags?: PageScriptFlags }
          if (data.type === 'flags' && data.flags) listener(data.flags)
        } catch {
          /* ignore */
        }
      }
      if (bridge.addEventListener) bridge.addEventListener('message', onMessage)
      else bridge.onmessage = onMessage
      // Ask for the current flags; the reply arrives through the listener above.
      bridge.postMessage(JSON.stringify({ token: TOKEN, type: 'hello' }))
    }
  })
})()
