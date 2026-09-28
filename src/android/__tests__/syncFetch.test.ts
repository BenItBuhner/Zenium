import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidSecrets, SECRETS_UNAVAILABLE_PREFIX } from '../secrets'
import {
  FETCH_ABORTED,
  FETCH_REJECTION_PREFIX,
  SyncFetchError,
  androidSyncFetch,
  toError,
  toResponse
} from '../syncFetch'

const repo = join(__dirname, '..', '..', '..')

/**
 * The Kotlin side as the bridge sees it: `Host.syncFetch` answering `sync.fetch` with `{ status,
 * headers, body }` (the headers by lower-cased name, as `SyncFetch.kt` joins them) or rejecting
 * `fetch-<kind>: <words>`, `sync.fetchAbort` cutting a request in flight, and `Secrets.kt` behind
 * `secrets.*` – a map here, with the switch that makes the Keystore unusable.
 */
function fakeBridge(answer: (args: Record<string, unknown>) => Promise<unknown> | unknown): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> }>
  secrets: Map<string, string>
  keystore: { unusable: boolean }
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const secrets = new Map<string, string>()
  const keystore = { unusable: false }
  const bridge = {
    async call(method: string, args: Record<string, unknown> = {}) {
      calls.push({ method, args })
      switch (method) {
        case 'sync.fetch':
          return answer(args)
        case 'sync.fetchAbort':
          return true
        case 'secrets.get':
          return keystore.unusable ? null : (secrets.get(args.key as string) ?? null)
        case 'secrets.set':
          if (keystore.unusable)
            throw new Error(
              `${SECRETS_UNAVAILABLE_PREFIX} The Android Keystore is unavailable on this device, so a password cannot be kept here`
            )
          secrets.set(args.key as string, args.value as string)
          return undefined
        case 'secrets.delete':
          secrets.delete(args.key as string)
          return undefined
        default:
          throw new Error(`unknown method ${method}`)
      }
    }
  } as unknown as Bridge
  return { bridge, calls, secrets, keystore }
}

describe('androidSyncFetch', () => {
  it('sends sync.fetch with the id, url, method, headers, body and cache, and reads the answer as the transport does', async () => {
    const { bridge, calls } = fakeBridge(() => ({
      status: 207,
      headers: { etag: '"abc"', 'content-type': 'application/xml; charset=utf-8', dav: '1, 2' },
      body: '<d:multistatus/>'
    }))
    const fetch = androidSyncFetch(bridge)
    const response = await fetch(
      'https://cloud.test/remote.php/dav/files/alice/Zenium/zenium-sync/',
      {
        method: 'PROPFIND',
        headers: {
          Authorization: 'Basic YWxpY2U6YXBwLXBhc3M=',
          Depth: '1',
          'Content-Type': 'application/xml; charset=utf-8'
        },
        body: '<d:propfind/>',
        cache: 'no-store'
      }
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('sync.fetch')
    expect(calls[0]!.args).toEqual({
      id: 'f1',
      url: 'https://cloud.test/remote.php/dav/files/alice/Zenium/zenium-sync/',
      method: 'PROPFIND',
      headers: {
        Authorization: 'Basic YWxpY2U6YXBwLXBhc3M=',
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body: '<d:propfind/>',
      cache: 'no-store'
    })
    expect(response.status).toBe(207)
    // The transport asks by the lower-case name; a caller asking by any case reads the same.
    expect(response.headers.get('etag')).toBe('"abc"')
    expect(response.headers.get('ETag')).toBe('"abc"')
    expect(response.headers.get('DAV')).toBe('1, 2')
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toBe('<d:multistatus/>')
  })

  it('omits the body and cache keys when the transport gives none, and numbers each request on its own', async () => {
    const { bridge, calls } = fakeBridge(() => ({ status: 204, headers: {}, body: '' }))
    const fetch = androidSyncFetch(bridge)
    await fetch('https://cloud.test/a', { method: 'DELETE', headers: {} })
    await fetch('https://cloud.test/b', { method: 'MKCOL', headers: {} })
    expect(calls.map((c) => c.args.id)).toEqual(['f1', 'f2'])
    expect('body' in calls[0]!.args).toBe(false)
    expect('cache' in calls[0]!.args).toBe(false)
  })

  it('lower-cases header names a host answers in any case, and reads a missing body as empty text', async () => {
    const response = toResponse({ status: 412, headers: { ETag: '"v2"', 'Content-Length': '0' } })
    expect(response.status).toBe(412)
    expect(response.headers.get('etag')).toBe('"v2"')
    expect(response.headers.get('content-length')).toBe('0')
    expect(await response.text()).toBe('')
  })

  it('a host answer without a status is a malformed answer, thrown, never a response', () => {
    expect(() => toResponse(null)).toThrow(SyncFetchError)
    expect(() => toResponse({ headers: {} })).toThrow(/without a status/)
    expect(() => toResponse('207')).toThrow(SyncFetchError)
  })

  it("the transport's abort cuts the request: sync.fetchAbort with the same id, and the rejection is an AbortError", async () => {
    let cut: (() => void) | null = null
    const { bridge, calls } = fakeBridge(
      () =>
        new Promise((_, reject) => {
          cut = () => reject(new Error(`${FETCH_REJECTION_PREFIX}${FETCH_ABORTED}: Canceled`))
        })
    )
    const controller = new AbortController()
    const pending = androidSyncFetch(bridge)('https://cloud.test/slow', {
      method: 'PROPFIND',
      headers: {},
      signal: controller.signal
    })
    await Promise.resolve()
    controller.abort()
    await Promise.resolve()
    expect(calls.map((c) => c.method)).toEqual(['sync.fetch', 'sync.fetchAbort'])
    expect(calls[1]!.args).toEqual({ id: calls[0]!.args.id })
    cut!()
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SyncFetchError)
    expect((error as SyncFetchError).name).toBe('AbortError')
    expect((error as SyncFetchError).kind).toBe('aborted')
    expect((error as Error).message).toBe('Canceled')
  })

  it('a signal already aborted throws before any bridge call', async () => {
    const { bridge, calls } = fakeBridge(() => ({ status: 200, headers: {}, body: '' }))
    const controller = new AbortController()
    controller.abort()
    const error = await androidSyncFetch(bridge)('https://cloud.test/', {
      method: 'GET',
      headers: {},
      signal: controller.signal
    }).catch((e: unknown) => e)
    expect((error as Error).name).toBe('AbortError')
    expect(calls).toEqual([])
  })

  it("maps Kotlin's fetch-<kind> rejections to typed errors and keeps any other failure's words", async () => {
    const network = toError(
      new Error('fetch-network: UnknownHostException: Unable to resolve host')
    )
    expect(network).toBeInstanceOf(SyncFetchError)
    expect((network as SyncFetchError).kind).toBe('network')
    expect(network.name).toBe('SyncFetchError')
    expect(network.message).toBe('UnknownHostException: Unable to resolve host')
    expect(
      (toError(new Error('fetch-timeout: SocketTimeoutException: timeout')) as SyncFetchError).kind
    ).toBe('timeout')
    expect(
      (toError(new Error('fetch-too-large: response body over 16777216 bytes')) as SyncFetchError)
        .kind
    ).toBe('too-large')
    expect(
      (toError(new Error('fetch-bad-url: not an absolute http(s) URL')) as SyncFetchError).kind
    ).toBe('bad-url')
    const bare = toError(new Error('fetch-network'))
    expect((bare as SyncFetchError).kind).toBe('network')
    expect(bare.message).toBe('the request failed (network)')
    const other = toError(new Error('the bridge is gone'))
    expect((other as SyncFetchError).kind).toBe('network')
    expect(other.message).toBe('the bridge is gone')
    expect(toError('boom').message).toBe('boom')
    const kept = new SyncFetchError('aborted', 'Canceled')
    expect(toError(kept)).toBe(kept)

    const { bridge } = fakeBridge(() => {
      throw new Error('fetch-network: ConnectException: Failed to connect')
    })
    const error = await androidSyncFetch(bridge)('https://cloud.test/', {
      method: 'PROPFIND',
      headers: {}
    }).catch((e: unknown) => e)
    expect((error as SyncFetchError).kind).toBe('network')
    expect((error as Error).message).toBe('ConnectException: Failed to connect')
  })
})

describe('AndroidSecrets', () => {
  it('reads, writes and deletes by key over secrets.*; a missing value is null', async () => {
    const { bridge, calls, secrets } = fakeBridge(() => null)
    const store = new AndroidSecrets(bridge)
    expect(await store.get('sync.webdav.password')).toBeNull()
    await store.set('sync.webdav.password', 'app-pass')
    expect(secrets.get('sync.webdav.password')).toBe('app-pass')
    expect(await store.get('sync.webdav.password')).toBe('app-pass')
    await store.delete('sync.webdav.password')
    expect(await store.get('sync.webdav.password')).toBeNull()
    expect(calls.map((c) => c.method)).toEqual([
      'secrets.get',
      'secrets.set',
      'secrets.get',
      'secrets.delete',
      'secrets.get'
    ])
    expect(calls[1]!.args).toEqual({ key: 'sync.webdav.password', value: 'app-pass' })
  })

  it("an unusable Keystore reads as no value and refuses a write with Kotlin's words, the prefix taken off", async () => {
    const { bridge, keystore } = fakeBridge(() => null)
    const store = new AndroidSecrets(bridge)
    await store.set('k', 'v')
    keystore.unusable = true
    expect(await store.get('k')).toBeNull()
    const error = await store.set('k', 'v2').catch((e: unknown) => e)
    expect((error as Error).message).toBe(
      'The Android Keystore is unavailable on this device, so a password cannot be kept here'
    )
    expect((error as Error).message.startsWith(SECRETS_UNAVAILABLE_PREFIX)).toBe(false)
    // Deleting needs no key: it always goes through.
    await expect(store.delete('k')).resolves.toBeUndefined()
  })
})

describe('the Kotlin side these speak to', () => {
  const host = readFileSync(
    join(repo, 'android/app/src/main/kotlin/app/zen/chromium/Host.kt'),
    'utf8'
  )
  const syncFetch = readFileSync(
    join(repo, 'android/app/src/main/kotlin/app/zen/chromium/SyncFetch.kt'),
    'utf8'
  )
  const secrets = readFileSync(
    join(repo, 'android/app/src/main/kotlin/app/zen/chromium/Secrets.kt'),
    'utf8'
  )

  it('Host.kt dispatches the five verbs and builds both objects on the first call, never at boot', () => {
    for (const verb of [
      '"sync.fetch"',
      '"sync.fetchAbort"',
      '"secrets.get"',
      '"secrets.set"',
      '"secrets.delete"'
    ])
      expect(host).toContain(`${verb} ->`)
    expect(host).toContain('private var syncFetch: SyncFetch? = null')
    expect(host).toContain('private var secrets: Secrets? = null')
    expect(host).toContain('val fetch = syncFetch ?: SyncFetch().also { syncFetch = it }')
    expect(host).toContain(
      'val store = secrets ?: Secrets.onDevice(activity).also { secrets = it }'
    )
    // An abort with nothing in flight builds nothing.
    expect(host).toContain('"sync.fetchAbort" -> reply(syncFetch?.abort(args.str("id")) == true)')
  })

  it('SyncFetch.kt names the rejection prefix and the aborted kind these constants read, and follows no redirect', () => {
    expect(syncFetch).toContain(`const val REJECTION_PREFIX = "${FETCH_REJECTION_PREFIX}"`)
    expect(syncFetch).toContain(`const val ABORTED = "${FETCH_ABORTED}"`)
    expect(syncFetch).toContain('.followRedirects(false)')
    expect(syncFetch).toContain('.followSslRedirects(false)')
    expect(syncFetch).toContain('.cookieJar(CookieJar.NO_COOKIES)')
    expect(syncFetch).not.toContain('.cache(')
    expect(syncFetch).toContain('private val client: OkHttpClient by lazy')
    expect(syncFetch).toContain('response.headers.name(i).lowercase()')
  })

  it("Secrets.kt names the refusal prefix this store strips and seals under the platform's Keystore", () => {
    expect(secrets).toContain(`const val UNAVAILABLE_PREFIX = "${SECRETS_UNAVAILABLE_PREFIX}"`)
    expect(secrets).toContain('"AndroidKeyStore"')
    expect(secrets).toContain('"AES/GCM/NoPadding"')
    expect(secrets).not.toMatch(/Log\.[dwei]\(/)
    expect(syncFetch).not.toMatch(/Log\.[dwei]\(/)
  })
})
