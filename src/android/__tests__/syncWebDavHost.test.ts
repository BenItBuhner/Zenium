import { afterEach, describe, expect, it } from 'vitest'
import type { WebDavSyncCredentials } from '../../shared/types'
import { WEBDAV_SECRET_KEY, webDavFolderUrl } from '../../core/sync/webdav'
import { isDeviceFileName } from '../../core/sync/transport'
import { FakeWebDavServer } from '../../core/sync/__tests__/fakeWebDavServer'
import {
  PASSPHRASE,
  device,
  teardown,
  unlockVault,
  type Device
} from '../../core/sync/__tests__/harness'
import type { Bridge } from '../bridge'
import { AndroidSecrets, SECRETS_UNAVAILABLE_PREFIX } from '../secrets'
import { androidSyncFetch, type HostFetchResult } from '../syncFetch'

/**
 * The phone's half of the WebDAV transport (ID-32), end to end: the core's engine on a device
 * whose sync host has the Android `fetch` and whose platform has the Android `secrets`, both over
 * a bridge that plays `Host.kt` – `sync.fetch` answered the way `SyncFetch.kt` answers it (the
 * status, the headers by lower-cased name, the body as text) from the services' own fake WebDAV
 * server, `secrets.*` answered the way `Secrets.kt` answers them (a value that opens, or `null`;
 * a refused write with `secrets-unavailable:`). What the folder transport's suite proves for the
 * SAF tree, this proves for a server: the setup runs PROPFIND / MKCOL / PUT-then-MOVE through the
 * bridge, the password lives in the secret store alone, and a Keystore that cannot be used is a
 * toast at setup and `authRefused` at a restart, never a crash.
 */

const ROOT = '/remote.php/dav/files/alice'
const URL = `https://cloud.test${ROOT}/`
const CREDENTIALS: WebDavSyncCredentials = {
  url: URL,
  username: 'alice',
  password: 'app-pass',
  folder: 'Zenium'
}
const DIR = `${ROOT}/Zenium/zenium-sync`

const dav = new FakeWebDavServer({ roots: [ROOT], users: { alice: 'app-pass' } })

/** The response headers a WebDAV round reads, as `SyncFetch.kt` hands them over: lower-cased names. */
const READ_HEADERS = ['etag', 'content-type', 'location', 'www-authenticate', 'dav', 'allow']

interface HostCall {
  method: string
  args: Record<string, unknown>
}

function hostBridge(): {
  bridge: Bridge
  calls: HostCall[]
  sealed: Map<string, string>
  keystore: { unusable: boolean }
} {
  const calls: HostCall[] = []
  const sealed = new Map<string, string>()
  const keystore = { unusable: false }
  const bridge = {
    async call(method: string, args: Record<string, unknown> = {}) {
      calls.push({ method, args })
      switch (method) {
        case 'sync.fetch': {
          // `Host.syncFetch`: the request as given goes on the wire; the answer is flattened.
          const response = await dav.fetch(args.url as string, {
            method: args.method as string,
            headers: args.headers as Record<string, string>,
            ...(typeof args.body === 'string' ? { body: args.body } : {}),
            ...(args.cache === 'no-store' ? { cache: 'no-store' as const } : {})
          })
          const headers: Record<string, string> = {}
          for (const name of READ_HEADERS) {
            const value = response.headers.get(name)
            if (value !== null) headers[name] = value
          }
          return {
            status: response.status,
            headers,
            body: await response.text()
          } satisfies HostFetchResult
        }
        case 'sync.fetchAbort':
          return false
        case 'secrets.get':
          return keystore.unusable ? null : (sealed.get(args.key as string) ?? null)
        case 'secrets.set':
          if (keystore.unusable)
            throw new Error(
              `${SECRETS_UNAVAILABLE_PREFIX} The Android Keystore is unavailable on this device, so a password cannot be kept here`
            )
          sealed.set(args.key as string, args.value as string)
          return undefined
        case 'secrets.delete':
          sealed.delete(args.key as string)
          return undefined
        default:
          throw new Error(`unknown method ${method}`)
      }
    }
  } as unknown as Bridge
  return { bridge, calls, sealed, keystore }
}

function phone(
  name: string,
  host: ReturnType<typeof hostBridge>,
  options: { io?: Device['io']; keys?: Device['keys'] } = {}
): Device {
  return device(name, {
    ...options,
    kind: 'phone',
    fetch: androidSyncFetch(host.bridge),
    secrets: new AndroidSecrets(host.bridge)
  })
}

async function setupWebDav(d: Device, credentials = CREDENTIALS): Promise<void> {
  await d.engine.setup(
    {
      folder: '',
      passphrase: PASSPHRASE,
      deviceName: d.name,
      scope: d.engine.status().scope,
      transport: 'webdav',
      webdav: credentials
    },
    d.win
  )
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  teardown()
  dav.reset()
  dav.setPassword('alice', 'app-pass')
})

describe('the engine on the phone over sync.fetch and secrets.*', () => {
  it('webdavAvailable is true with both host halves; the probe goes through the bridge', async () => {
    const host = hostBridge()
    const a = phone('Pixel 9', host)
    expect(a.engine.status().webdavAvailable).toBe(true)
    // Nothing on the host side was touched to answer that: a field read, no bridge call.
    expect(host.calls).toEqual([])

    expect(await a.engine.testWebDav(CREDENTIALS)).toEqual({ ok: true })
    expect(await a.engine.testWebDav({ ...CREDENTIALS, password: 'wrong' })).toEqual({
      ok: false,
      kind: 'auth',
      status: 401
    })
    dav.down = true
    expect(await a.engine.testWebDav(CREDENTIALS)).toEqual({
      ok: false,
      kind: 'unavailable',
      status: 0
    })
    dav.down = false
    expect(host.calls.every((c) => c.method === 'sync.fetch')).toBe(true)
  })

  it('the setup runs PROPFIND, MKCOL and PUT-then-MOVE through the bridge; every request is no-store and carries the credential; the password lives in the secret store alone', async () => {
    const host = hostBridge()
    const a = phone('Pixel 9', host)
    await unlockVault(a)
    a.browser.bookmarks.create({ title: 'Zenium', url: 'https://zenium.app/' })
    await setupWebDav(a)
    expect(a.toasts).toEqual([])
    expect(a.engine.status()).toMatchObject({
      enabled: true,
      transport: 'webdav',
      webdav: { url: URL, username: 'alice', folder: 'Zenium' },
      folder: webDavFolderUrl(CREDENTIALS),
      folderName: 'Zenium',
      authRefused: false,
      lastError: null
    })

    // The server holds the folder, the directory, this device's file and the README; no temp file.
    expect(dav.collections.has(`${ROOT}/Zenium`)).toBe(true)
    const names = [...dav.files(DIR)!.keys()]
    expect(names.filter(isDeviceFileName)).toHaveLength(1)
    expect(names).toContain('README.txt')
    expect(names.some((n) => n.includes('.tmp-'))).toBe(false)

    // What went over the bridge: the WebDAV verbs, each with the transport's shape.
    const fetches = host.calls.filter((c) => c.method === 'sync.fetch')
    const methods = new Set(fetches.map((c) => c.args.method))
    expect(methods.has('PROPFIND')).toBe(true)
    expect(methods.has('MKCOL')).toBe(true)
    expect(methods.has('PUT')).toBe(true)
    expect(methods.has('MOVE')).toBe(true)
    for (const c of fetches) {
      expect(c.args.cache).toBe('no-store')
      const headers = c.args.headers as Record<string, string>
      expect(headers.Authorization?.startsWith('Basic ')).toBe(true)
      expect(typeof c.args.id).toBe('string')
    }
    const propfind = fetches.find((c) => c.args.method === 'PROPFIND')!
    expect((propfind.args.headers as Record<string, string>).Depth).toBeDefined()
    expect(typeof propfind.args.body).toBe('string')
    const move = fetches.find((c) => c.args.method === 'MOVE')!
    expect((move.args.headers as Record<string, string>).Destination).toBeDefined()
    // The wire saw the same requests (the fake server's own log).
    expect(dav.log.some((r) => r.method === 'MOVE' && r.status < 300)).toBe(true)

    // The credential: in the store, under the core's key; nowhere else.
    expect(host.sealed.get(WEBDAV_SECRET_KEY)).toBe('app-pass')
    expect(host.calls.filter((c) => c.method === 'secrets.set')).toHaveLength(1)
    expect(JSON.stringify(a.engine.status())).not.toContain('app-pass')
    expect(JSON.stringify(a.io.files)).not.toContain('app-pass')
  }, 30_000)

  it('a restart reads the password back through secrets.get; a Keystore that lost it is authRefused until a new one comes', async () => {
    const host = hostBridge()
    const a = phone('Pixel 9', host)
    await unlockVault(a)
    await setupWebDav(a)
    const before = a.engine.status()
    a.engine.flushSync()

    host.calls.length = 0
    const again = phone('Pixel 9', host, { io: a.io, keys: a.keys })
    await tick()
    expect(again.engine.status()).toMatchObject({
      enabled: true,
      transport: 'webdav',
      deviceId: before.deviceId,
      authRefused: false
    })
    expect(host.calls[0]).toEqual({ method: 'secrets.get', args: { key: WEBDAV_SECRET_KEY } })
    again.browser.bookmarks.create({ title: 'After', url: 'https://after.example/' })
    await again.engine.syncNow()
    expect(again.engine.status().lastError).toBeNull()
    expect(again.engine.status().lastSyncAt).not.toBeNull()
    again.engine.flushSync()

    // The Keystore cannot open the value any more (Secrets.kt reads it as no value).
    host.keystore.unusable = true
    const bare = phone('Pixel 9', host, { io: a.io, keys: a.keys })
    await tick()
    expect(bare.engine.status()).toMatchObject({
      enabled: true,
      transport: 'webdav',
      authRefused: true,
      folder: webDavFolderUrl(CREDENTIALS)
    })
    dav.drain()
    await bare.engine.syncNow()
    expect(dav.log).toEqual([])

    // A new password into a Keystore still unusable is a toast's worth of words, never a crash.
    const refused = await bare.engine.setWebDavPassword('app-pass').catch((e: unknown) => e)
    expect((refused as Error).message).toBe(
      'The Android Keystore is unavailable on this device, so a password cannot be kept here'
    )
    expect(bare.engine.status().authRefused).toBe(true)

    host.keystore.unusable = false
    await bare.engine.setWebDavPassword('app-pass')
    expect(host.sealed.get(WEBDAV_SECRET_KEY)).toBe('app-pass')
    expect(bare.engine.status()).toMatchObject({ authRefused: false, lastError: null })
    expect(dav.log.some((r) => r.method === 'PROPFIND' && r.status === 207)).toBe(true)
  }, 30_000)

  it('a Keystore that cannot seal refuses the setup with its own words; nothing is configured, nothing reaches the server', async () => {
    const host = hostBridge()
    host.keystore.unusable = true
    const a = phone('Pixel 9', host)
    await unlockVault(a)
    await setupWebDav(a)
    expect(a.engine.status().enabled).toBe(false)
    expect(a.toasts.at(-1)).toContain('The Android Keystore is unavailable on this device')
    expect(a.toasts.at(-1)).not.toContain(SECRETS_UNAVAILABLE_PREFIX)
    // The engine probes the server (the directory and its README) before it keeps the password;
    // past that point nothing of this device is written and no key is kept.
    expect([...(dav.files(DIR)?.keys() ?? [])].filter(isDeviceFileName)).toEqual([])
    expect(host.sealed.size).toBe(0)
    expect(host.calls.filter((c) => c.method === 'secrets.set')).toHaveLength(1)
  })

  it('a revoked app password is authRefused with the words scrubbed; disconnecting forgets the secret through secrets.delete', async () => {
    const host = hostBridge()
    const a = phone('Pixel 9', host)
    await unlockVault(a)
    await setupWebDav(a)

    dav.setPassword('alice', 'rotated')
    a.browser.bookmarks.create({ title: 'X', url: 'https://x.example/' })
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({
      enabled: true,
      authRefused: true,
      lastError: 'WebDAV PROPFIND answered 401'
    })
    await a.engine.setWebDavPassword('rotated')
    expect(host.sealed.get(WEBDAV_SECRET_KEY)).toBe('rotated')
    expect(a.engine.status()).toMatchObject({ authRefused: false, lastError: null })

    await a.engine.disconnect(false)
    await tick()
    expect(
      host.calls.some((c) => c.method === 'secrets.delete' && c.args.key === WEBDAV_SECRET_KEY)
    ).toBe(true)
    expect(host.sealed.has(WEBDAV_SECRET_KEY)).toBe(false)
  }, 30_000)
})
