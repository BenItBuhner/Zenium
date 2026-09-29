import { extensionOrigin } from '@core/extensions/runtime/plan'
import { toServedUrl } from '@core/extensions/runtime/extensionUrls'

/**
 * A content script's `fetch` of its own extension's file, answered by the host.
 *
 * A content script fetches its extension's web-accessible files
 * (`fetch(chrome.runtime.getURL('locales/en.json'))`, RoPro on roblox.com; RoValra's locale
 * index): in Chrome the request is the isolated world's, which carries the extension's origin,
 * so the page's Content-Security-Policy (`connect-src`) never sees it and the file answers as a
 * same-origin response (`type: "basic"`, whatever `mode` asked – a request to one's own origin
 * is never a CORS one). A WebView's isolated world carries no origin of its own (the document's
 * policy applies to it: `Refused to connect because it violates the document's Content Security
 * Policy` from the world's fetch on WebView 156), and under the `with` fallback (no worlds,
 * Chromium < 146) the request is the page's outright; a page whose policy names its
 * `connect-src` refuses it with `TypeError: Failed to fetch`, and a permissive page at least
 * logs nothing but sends the request through the page's network stack.
 *
 * So a request for an attached extension's own file – the served spelling
 * `https://<id>.ext.zenium.invalid/…` or Chrome's `chrome-extension://<id>/…`, which an
 * extension writes out by hand and only the served origin loads – goes to the host FIRST, over
 * the bridge, which no page policy governs: the host reads the web-accessible file and answers
 * its bytes and type (`Extensions.extensionFetch`, `ExtensionFileAnswer`), rebuilt here as a
 * `Response` with the file's URL and type. When the host cannot (not web-accessible, missing,
 * past the bridge's size), the request goes the page's way after all, and the page's answer –
 * the served origin's 404, or the policy's refusal – is the extension's, as it was before the
 * relay. Any other URL is the page's fetch's as it is. The `XMLHttpRequest` of the same files
 * rides on this `fetch` (`extensionXhrRelay.ts`).
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
  /** Whether `url` (as written, either spelling) is an attached extension's own file. */
  owns(url: string): boolean
  /** The host's answer to `request`. */
  done(id: string, reply: FetchRelayReply): void
  /** Requests still waiting for the host (tests, diagnostics). */
  pending(): number
}

interface Waiting {
  url: string
  method: string
  resolve(response: Response): void
  reject(reason: unknown): void
  /** The page's own fetch of the same request, when the host cannot answer. */
  page(): Promise<Response>
  /** Stops listening for an abort once the request is settled. */
  settle(): void
}

export function createFetchRelay(
  win: Window & typeof globalThis,
  host: FetchRelayHost
): FetchRelay {
  const native: typeof globalThis.fetch | undefined = win.fetch
  const waiting = new Map<string, Waiting>()
  let seq = 0

  const extensionFor = (served: string): string | null => {
    for (const id of host.attachedIds()) if (served.startsWith(extensionOrigin(id) + '/')) return id
    return null
  }

  const relayed: typeof globalThis.fetch = function fetch(input, init) {
    if (typeof native !== 'function') return Promise.reject(new win.TypeError('Failed to fetch'))
    const asked = urlOf(win, input)
    const served = toServedUrl(asked)
    const extId = extensionFor(served)
    if (extId === null) return native.call(win, input, init)
    // Chrome's spelling of the extension's own file loads from the served origin, the page's
    // way included (the CORS proxy does the same for an extension page's own fetch).
    const pageInput = served === asked ? input : respelled(win, input, served)
    const request = isRequest(win, input) ? input : null
    const signal = init?.signal ?? request?.signal ?? null
    if (signal?.aborted) return Promise.reject(abortReason(win, signal))
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase()
    return new Promise<Response>((resolve, reject) => {
      const id = `f${(seq += 1)}`
      const onAbort = (): void => {
        const entry = waiting.get(id)
        if (!entry) return
        waiting.delete(id)
        entry.settle()
        reject(abortReason(win, signal as AbortSignal))
      }
      waiting.set(id, {
        url: served,
        method,
        resolve,
        reject,
        page: () => native.call(win, pageInput, init),
        settle: () => signal?.removeEventListener('abort', onAbort)
      })
      signal?.addEventListener('abort', onAbort)
      host.request(id, extId, served)
    })
  }

  return {
    fetch: relayed,
    owns: (url) => extensionFor(toServedUrl(url)) !== null,
    done(id, reply) {
      const entry = waiting.get(id)
      if (!entry) return
      waiting.delete(id)
      entry.settle()
      if (reply.ok !== true || typeof reply.body !== 'string') {
        host.error(
          `[Zenium] ${entry.url} could not be read for the content script: ${String(reply.error ?? 'the host refused')}; the page's fetch answers it`
        )
        entry.page().then(entry.resolve, entry.reject)
        return
      }
      let response: Response
      try {
        const bytes = decodeBase64(win, reply.body)
        const headers: Record<string, string> = { 'Content-Length': String(bytes.byteLength) }
        if (typeof reply.mime === 'string' && reply.mime) headers['Content-Type'] = reply.mime
        // A HEAD answers the headers alone, as the origin would.
        response = new win.Response(entry.method === 'HEAD' ? null : (bytes.buffer as ArrayBuffer), {
          status: 200,
          statusText: 'OK',
          headers
        })
        // Chrome's `Response.url` is the file's and its `type` "basic" – a same-origin answer;
        // a constructed Response reads '' and "default" otherwise.
        for (const [name, value] of [
          ['url', entry.url],
          ['type', 'basic']
        ]) {
          try {
            Object.defineProperty(response, name, { value, configurable: true })
          } catch {
            /* a frozen Response of the page's: the body and headers still stand */
          }
        }
      } catch (e) {
        host.error(`[Zenium] ${entry.url} arrived unreadable over the bridge`, e)
        entry.page().then(entry.resolve, entry.reject)
        return
      }
      entry.resolve(response)
    },
    pending: () => waiting.size
  }
}

function isRequest(win: Window & typeof globalThis, input: RequestInfo | URL): input is Request {
  return (
    typeof input === 'object' &&
    input !== null &&
    ((typeof win.Request === 'function' && input instanceof win.Request) ||
      (typeof Request === 'function' && input instanceof Request))
  )
}

/** `input` with its URL in the served spelling: a string or URL as the string, a Request rebuilt on it. */
function respelled(
  win: Window & typeof globalThis,
  input: RequestInfo | URL,
  served: string
): RequestInfo | URL {
  if (!isRequest(win, input)) return served
  try {
    return new win.Request(served, input)
  } catch {
    return served
  }
}

/** What an aborted fetch rejects with: the signal's reason, or an AbortError as fetch's own. */
function abortReason(win: Window & typeof globalThis, signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason
  if (reason !== undefined) return reason
  if (typeof win.DOMException === 'function')
    return new win.DOMException('The user aborted a request.', 'AbortError')
  const error = new win.Error('The user aborted a request.')
  error.name = 'AbortError'
  return error
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
