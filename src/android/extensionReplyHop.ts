/**
 * The reply hop (compat round 20): the chrome document's `__zenExtHop`, a synchronous
 * `@JavascriptInterface` object of the host's (`ExtReplyHop.kt`) that takes the runtime's
 * `ext.send` – one message to one endpoint – as three parameters and posts it to the endpoint's
 * reply proxy from the thread it arrives on.
 *
 * WHY: round 19 §4 read the storage round trip's `back` leg (the runtime's reply leaving this
 * document to the page's receipt) at 212-292 ms median on WebView 113 and 608-878 ms on the AOSP
 * lane – 97-99.7 % of the trip against Chrome's 1-5 ms – and placed it: a string off the bridge
 * port waits its turn in the app's UI thread queue twice (the platform's delivery, then the
 * dispatch after the handler thread's parse), and on the emulator that queue holds frames of
 * 0.7-3.3 s under the software GPU. A hop enters the host with no queue (0.2-2.4 ms of this
 * thread held across JNI, services perf pass 4's measure – the trade #455 rejected for the
 * chrome's hot path, right for a reply's small frame and few messages) and the proxy's post from
 * there is one UI task: one turn where there were two.
 *
 * THE SEAM: {@link withReplyHop} wraps the runtime's bridge with a `deliver` that calls the hop;
 * `AndroidExtensionRuntime.sendTo` takes `deliver` first and falls back to `post` (the port)
 * when there is no hop – the tests' fakes, a preview host, a chrome whose hop threw once (then
 * the port carries every message after it, said once in the console).
 */
import type { ReplyStamps, RuntimeBridge } from './extensionRuntime'

/** The chrome document's name for the host's object (`ExtReplyHop.NAME`). */
export const REPLY_HOP = '__zenExtHop'

/** The host's object as the chrome document sees it: `ExtReplyHop.send`. */
export interface ReplyHopHost {
  send(ep: string, message: string, at: string | null): void
}

/** The hop on `scope` (the chrome document's window), or null for a host without one. */
export function findReplyHop(scope: object): ReplyHopHost | null {
  const candidate = (scope as Record<string, unknown>)[REPLY_HOP]
  if (candidate === null || typeof candidate !== 'object') return null
  return typeof (candidate as { send?: unknown }).send === 'function'
    ? (candidate as ReplyHopHost)
    : null
}

/**
 * The runtime's bridge with the reply hop on it when `scope` holds one, the bridge itself when
 * it does not. `call`, `send` and `post` are the bridge's own (bound to it); `deliver` is the
 * hop: the stamps go as their JSON (the host reads a `JSONArray`), or null without them.
 */
export function withReplyHop(
  bridge: RuntimeBridge,
  scope: object,
  warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error)
): RuntimeBridge {
  const hop = findReplyHop(scope)
  if (hop === null) return bridge
  let failed = false
  const wrapped: RuntimeBridge = {
    call: (method, args) => bridge.call(method, args),
    send: (method, args) => bridge.send(method, args),
    deliver: (ep: string, message: string, at?: ReplyStamps): boolean => {
      if (failed) return false
      try {
        hop.send(ep, message, at ? JSON.stringify(at) : null)
        return true
      } catch (error) {
        failed = true
        warn('[zen] ext: the reply hop failed; every message goes over the port from here', error)
        return false
      }
    }
  }
  if (bridge.post) {
    const post = bridge.post
    wrapped.post = (method, args) => post.call(bridge, method, args)
  }
  return wrapped
}
