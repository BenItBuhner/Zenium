import { extensionOrigin } from '@core/extensions/runtime/plan'

/**
 * An extension-origin `fetch` of a content script under the page's Content-Security-Policy.
 *
 * A content script may fetch its own extension's web-accessible files
 * (`fetch(chrome.runtime.getURL('locales/en.json'))`, RoPro on roblox.com): in Chrome the request
 * is the isolated world's, which carries the extension's own policy, beyond the page's
 * `connect-src`. A WebView's isolated world carries no policy of its own (the document's applies
 * to it: `Refused to connect because it violates the document's Content Security Policy` from the
 * world's fetch on WebView 156), and under the `with` fallback (no worlds, Chromium < 146) the
 * request is the page's outright; either way a page whose policy names its `connect-src` refuses
 * it: the promise rejects with `TypeError: Failed to fetch` and the extension never gets the file.
 *
 * So the content scripts' `fetch` tries the page's first (a page without such a policy loads the file as
 * before, `Response.url` and all) and, when a request to an attached extension's origin is
 * refused, asks the host for the file over the bridge, which no page policy governs; the host
 * answers the web-accessible file's bytes and type (`Extensions.extensionFetch`), or the reason,
 * and then the extension gets the refusal it was already getting. Any other URL, and any other
 * failure (an abort), is the page's fetch's as it is.
 */

/** What the bootstrap lends the relay: the attached extensions, the bridge and the realm's globals. */
export interface FetchRelayHost {
  /** Ids of the extensions attached to this scope's copy at call time. */
  attachedIds(): string[]
  /** Ask the host for `url`'s bytes; it answers through `done(id, reply)`. */
  request(id: string, extId: string, url: string): void
  error(...args: unknown[]): void
}

/** The host's answer: the file's bytes (standard base64) and type, or the reason it could not. */
export interface FetchRelayReply {
  ok?: unknown
  body?: unknown
  mime?: unknown
  error?: unknown
}

export interface FetchRelay {
  /** The `fetch` the scope's `window` answers. */
  fetch: typeof globalThis.fetch
  /** The host's answer to `request`. */
  done(id: string, reply: FetchRelayReply): void
  /** Requests still waiting for the host (tests, diagnostics). */
  pending(): number
}

interface Waiting {
  url: string
  resolve(response: Response): void
  reject(reason: unknown): void
  /** The page's refusal, handed on when the host cannot answer either. */
  refusal: unknown
}

export function createFetchRelay(
  win: Window & typeof globalThis,
  host: FetchRelayHost
): FetchRelay {
  const native: typeof globalThis.fetch | undefined = win.fetch
  const waiting = new Map<string, Waiting>()
  let seq = 0

  const extensionFor = (url: string): string | null => {
    for (const id of host.attachedIds()) if (url.startsWith(extensionOrigin(id) + '/')) return id
    return null
  }

  const relayed: typeof globalThis.fetch = function fetch(input, init) {
    if (typeof native !== 'function') return Promise.reject(new win.TypeError('Failed to fetch'))
    const url = urlOf(win, input)
    const extId = extensionFor(url)
    const attempt = native.call(win, input, init)
    if (extId === null) return attempt
    return attempt.catch((refusal: unknown) => {
      // The page's policy refuses with a TypeError; an abort, or anything else, is not the policy's.
      if (!isTypeError(refusal)) throw refusal
      return new Promise<Response>((resolve, reject) => {
        const id = `f${(seq += 1)}`
        waiting.set(id, { url, resolve, reject, refusal })
        host.request(id, extId, url)
      })
    })
  }

  return {
    fetch: relayed,
    done(id, reply) {
      const entry = waiting.get(id)
      if (!entry) return
      waiting.delete(id)
      if (reply.ok !== true || typeof reply.body !== 'string') {
        host.error(
          `[Zenium] ${entry.url} could not be read for the content script: ${String(reply.error ?? 'the host refused')}`
        )
        entry.reject(entry.refusal)
        return
      }
      let response: Response
      try {
        const bytes = decodeBase64(win, reply.body)
        const headers: Record<string, string> = { 'Content-Length': String(bytes.byteLength) }
        if (typeof reply.mime === 'string' && reply.mime) headers['Content-Type'] = reply.mime
        response = new win.Response(bytes.buffer as ArrayBuffer, {
          status: 200,
          statusText: 'OK',
          headers
        })
        // Chrome's `Response.url` is the file's; a constructed Response reads '' otherwise.
        try {
          Object.defineProperty(response, 'url', { value: entry.url, configurable: true })
        } catch {
          /* a frozen Response prototype of the page's: the body and type still stand */
        }
      } catch (e) {
        host.error(`[Zenium] ${entry.url} arrived unreadable over the bridge`, e)
        entry.reject(entry.refusal)
        return
      }
      entry.resolve(response)
    },
    pending: () => waiting.size
  }
}

function isTypeError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'TypeError'
  )
}

function urlOf(win: Window & typeof globalThis, input: RequestInfo | URL): string {
  try {
    if (typeof input === 'string') return new win.URL(input, win.location.href).href
    if (input instanceof win.URL || input instanceof URL) return input.href
    return String((input as Request).url)
  } catch {
    return ''
  }
}

function decodeBase64(win: Window & typeof globalThis, text: string): Uint8Array {
  const binary = win.atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
