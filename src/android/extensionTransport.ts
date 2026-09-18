import type { Primordials } from '@core/extensions/api/engine'

/**
 * The transport janitor: a document-start script for the main world of every tab frame, on
 * every origin, ahead of any extension unit and of every page script. It takes the frame's
 * `__zenExtBridge` WebMessageListener object off the global before the page can see it and
 * reserves the three names the extension bootstrap uses in the main world, so that a bootstrap
 * evaluated *later* – a late boot for `scripting.executeScript` into a document that predates
 * the extension's world, or on a WebView without isolated worlds – finds a bridge, primordials
 * and property slots no page script could have spoofed. Kotlin wraps it as
 *
 *   (function () { var __zenExtBoot = { token: "<bridge token>" }; <this file> })();
 *
 * The token stays in this closure: the functions exposed here compare it and never contain it,
 * so `Function.prototype.toString` on them reveals nothing. A bootstrap that runs at document
 * start in the main world (the `with` fallback) claims the transport the same way; bootstraps in
 * isolated worlds have their own `__zenExtBridge` and never meet this script.
 */
export interface ClaimedTransport {
  post(message: string): void
  listen(sink: (event: { data: string }) => void): void
  primordials: Primordials
}

export interface TransportJanitor {
  /** The bridge of this frame's main world, for the holder of the token. */
  claim(token: string): ClaimedTransport | undefined
  /** Fill the reserved `__zenExtRuntime` / `__zenExtExec` slots; false for a wrong token or a second call. */
  install(token: string, runtime: object, exec: (...args: unknown[]) => unknown): boolean
}

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
  addEventListener?(type: 'message', listener: (event: { data: string }) => void): void
}

declare const __zenExtBoot: { token: string }

;(() => {
  const g = globalThis as typeof globalThis & {
    __zenExtBridge?: Bridge
    queueMicrotask?: (cb: () => void) => void
  }
  const bridge = g.__zenExtBridge
  if (!bridge) return
  try {
    delete g.__zenExtBridge
  } catch {
    return
  }
  const token = __zenExtBoot.token
  const rawPost = bridge.postMessage
  const stringify = JSON.stringify
  const parse = JSON.parse
  const timeout = g.setTimeout
  const micro = g.queueMicrotask ?? ((cb: () => void) => void Promise.resolve().then(cb))
  const error = console.error
  const warn = console.warn
  const primordials: Primordials = {
    stringify: (value) => stringify(value),
    parse: (text) => parse(text),
    setTimeout: (cb, ms) => timeout(cb, ms) as unknown as number,
    queueMicrotask: (cb) => micro(cb),
    error: (...args) => error(...args),
    warn: (...args) => warn(...args)
  }
  let sink: ((event: { data: string }) => void) | null = null
  const onMessage = (event: { data: string }): void => {
    if (sink) sink(event)
  }
  if (bridge.addEventListener) bridge.addEventListener('message', onMessage)
  else bridge.onmessage = onMessage

  let runtime: object | undefined
  let exec: ((...args: unknown[]) => unknown) | undefined
  const janitor: TransportJanitor = {
    claim: (t) => {
      if (t !== token) return undefined
      return {
        post: (message) => rawPost.call(bridge, message),
        listen: (fn) => {
          sink = fn
        },
        primordials
      }
    },
    install: (t, r, e) => {
      if (t !== token || runtime !== undefined) return false
      runtime = r
      exec = e
      return true
    }
  }
  Object.freeze(janitor)
  const reserve = (name: string, get: () => unknown): void => {
    try {
      Object.defineProperty(g, name, { get, enumerable: false, configurable: false })
    } catch {
      /* a bootstrap that ran first owns the name already */
    }
  }
  reserve('__zenExtTransport', () => janitor)
  reserve('__zenExtRuntime', () => runtime)
  reserve('__zenExtExec', () => exec)
})()
