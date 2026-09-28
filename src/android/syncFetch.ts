import type { SyncFetch, SyncFetchInit, SyncFetchResponse } from '../core/platform'
import type { Bridge } from './bridge'

/** Kotlin's rejection prefix for a request that got no response (`SyncFetch.kt`, `REJECTION_PREFIX`): `fetch-<kind>: <words>`. */
export const FETCH_REJECTION_PREFIX = 'fetch-'
/** The kind Kotlin names for a request cut by `sync.fetchAbort` (`SyncFetch.ABORTED`). */
export const FETCH_ABORTED = 'aborted'

/** What `sync.fetch` resolves with (`Host.syncFetch`): the status, the headers by lower-cased name, the body as text. */
export interface HostFetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * A request that got no response, in the words Kotlin gave (never a URL or a header: the
 * transport scrubs and shows them). An abort is named `AbortError` the way the standard fetch
 * names its rejection, so whoever checks `error.name` reads both platforms alike; the transport
 * itself decides by its own signal and classes anything thrown `unavailable`.
 */
export class SyncFetchError extends Error {
  constructor(
    readonly kind: string,
    message: string
  ) {
    super(message)
    this.name = kind === FETCH_ABORTED ? 'AbortError' : 'SyncFetchError'
  }
}

/**
 * The WebDAV transport's fetch on Android (`SyncPlatformHost.fetch`): `sync.fetch { id, url,
 * method, headers, body?, cache? }` over the bridge, answered by `SyncFetch.kt` through OkHttp –
 * the WebView's own `fetch` binds to the chrome's origin and knows no PROPFIND. The transport's
 * `AbortSignal` becomes `sync.fetchAbort { id }`: the request in flight is cancelled and the
 * pending call rejects `fetch-aborted:`. Headers travel as given; the response's come back by
 * lower-cased name (`headers.get` lower-cases the name asked for), repeats joined with `, `.
 */
export function androidSyncFetch(bridge: Bridge): SyncFetch {
  let seq = 0
  return async (url: string, init: SyncFetchInit): Promise<SyncFetchResponse> => {
    if (init.signal?.aborted) throw new SyncFetchError(FETCH_ABORTED, 'aborted before it was sent')
    const id = `f${++seq}`
    const onAbort = (): void => {
      void bridge.call('sync.fetchAbort', { id }).catch(() => undefined)
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const args: Record<string, unknown> = { id, url, method: init.method, headers: init.headers }
      if (init.body !== undefined) args.body = init.body
      if (init.cache !== undefined) args.cache = init.cache
      return toResponse(await bridge.call<unknown>('sync.fetch', args))
    } catch (error) {
      throw toError(error)
    } finally {
      init.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** The host's `{ status, headers, body }` as the transport reads a response; anything else is a malformed answer. */
export function toResponse(result: unknown): SyncFetchResponse {
  const record = result as Partial<HostFetchResult> | null
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.status !== 'number' ||
    !record.headers ||
    typeof record.headers !== 'object'
  )
    throw new SyncFetchError('malformed', 'the host answered without a status')
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(record.headers))
    if (typeof value === 'string') headers[name.toLowerCase()] = value
  const body = typeof record.body === 'string' ? record.body : ''
  return {
    status: record.status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body
  }
}

/** Kotlin's `fetch-<kind>: <words>` rejection as a typed error; any other failure keeps its words under `SyncFetchError`. */
export function toError(error: unknown): Error {
  if (error instanceof SyncFetchError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith(FETCH_REJECTION_PREFIX)) {
    const colon = message.indexOf(':')
    const kind =
      colon > 0
        ? message.slice(FETCH_REJECTION_PREFIX.length, colon)
        : message.slice(FETCH_REJECTION_PREFIX.length)
    const words = colon > 0 ? message.slice(colon + 1).trim() : ''
    return new SyncFetchError(kind, words || `the request failed (${kind})`)
  }
  return new SyncFetchError('network', message || 'the request failed')
}
