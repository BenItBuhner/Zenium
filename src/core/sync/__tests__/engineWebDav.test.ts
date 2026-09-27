import { afterEach, describe, expect, it } from 'vitest'
import type { SyncSetupRefusal, WebDavSyncCredentials } from '../../../shared/types'
import type { SecretStore } from '../../platform'
import { WEBDAV_CONFLICT_RETRIES } from '../engine'
import { SyncFolderLostError, isDeviceFileName } from '../transport'
import { WEBDAV_SECRET_KEY, WebDavTransport, webDavFolderUrl } from '../webdav'
import { FakeWebDavServer } from './fakeWebDavServer'
import {
  PASSPHRASE,
  device,
  devices,
  folderFiles,
  teardown,
  unlockVault,
  setTransportFactory,
  type Device,
  type HarnessTransport
} from './harness'

/**
 * The sync engine over a WebDAV server (ID-32), two ways.
 *
 * First, the whole two-device convergence suite (`engine.test.ts`, `engineDocuments.test.ts`)
 * run again with `WebDavTransport` over the fake server in the folder transport's place: the
 * harness hands every device a transport whose `zenium-sync` directory is the test's folder map,
 * mounted on the server, so the scenarios and their assertions on the folder's files hold
 * unchanged – every write goes PUT-then-MOVE, every read GET with `If-None-Match`, every listing
 * PROPFIND. The one knob the folder suite turns that a server has no word for – `lost`, the
 * host's folder gone from under it – is the harness transport's own, layered on the real one.
 *
 * Then the engine's WebDAV paths themselves: the setup with a server, the app password in the
 * secret store and its reading at a restart, the refused sign-in as `authRefused`, the quiet
 * conflict retries, the probe, the return to a folder.
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

/** One server for the file; each test's folders are mounted on it afresh, `reset` between tests. */
const dav = new FakeWebDavServer({ roots: [ROOT], users: { alice: 'app-pass' } })

class HarnessWebDavTransport extends WebDavTransport implements HarnessTransport {
  lost = false

  private gone(): void {
    if (this.lost) throw new SyncFolderLostError()
  }

  override list(): Promise<string[]> {
    this.gone()
    return super.list()
  }

  override read(name: string): Promise<string | null> {
    this.gone()
    return super.read(name)
  }

  override write(name: string, text: string): Promise<void> {
    this.gone()
    return super.write(name, text)
  }

  override remove(name: string): Promise<void> {
    this.gone()
    return super.remove(name)
  }
}

/** `/drive` → the server folder `drive` under the root. */
const folderOf = (folder: string): string => folder.replace(/^\/+/, '')

setTransportFactory((folder) => {
  dav.mount(`${ROOT}/${folderOf(folder)}/zenium-sync`, folderFiles(folder))
  return new HarnessWebDavTransport(
    { url: URL, username: 'alice', password: 'app-pass', folder: folderOf(folder) },
    dav.fetch
  )
})

afterEach(() => {
  teardown()
  dav.reset()
  dav.setPassword('alice', 'app-pass')
})

// The convergence suites, over the WebDAV transport this time.
await import('./engine.test')
await import('./engineDocuments.test')

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    }
  }
}

function webDavDevice(
  name: string,
  options: {
    io?: Device['io']
    keys?: Device['keys']
    secrets?: SecretStore
    /** The poll's period; the harness default is none (the tests call `syncNow` themselves). */
    pollMs?: number
  } = {}
): Device & { secrets: SecretStore & { values: Map<string, string> } } {
  const secrets = (options.secrets ?? memorySecrets()) as SecretStore & {
    values: Map<string, string>
  }
  const d = device(name, { ...options, fetch: dav.fetch, secrets })
  return Object.assign(d, { secrets })
}

async function setupWebDav(
  d: Device,
  credentials: WebDavSyncCredentials = CREDENTIALS,
  passphrase = PASSPHRASE
): Promise<SyncSetupRefusal | null> {
  return d.engine.setup(
    {
      folder: '',
      passphrase,
      deviceName: d.name,
      scope: d.engine.status().scope,
      transport: 'webdav',
      webdav: credentials
    },
    d.win
  )
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A secret store whose `set` fails (a keyring that refuses, a disk that is full): what the engine says. */
function refusingSecrets(): SecretStore {
  return {
    get: async () => null,
    set: async () => {
      throw new Error('Error while encrypting the text provided to safeStorage.encryptString.')
    },
    delete: async () => undefined
  }
}

describe('the engine on a WebDAV server', () => {
  it('two devices converge through the server; the settings are kept, the password only in the secret store', async () => {
    const a = webDavDevice('Desk (Linux)')
    const b = webDavDevice('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    expect(a.engine.status().webdavAvailable).toBe(true)

    const bm = a.browser.bookmarks.create({ title: 'Zenium', url: 'https://zenium.app/' })!
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
    expect(a.secrets.values.get(WEBDAV_SECRET_KEY)).toBe('app-pass')
    expect(JSON.stringify(a.engine.status())).not.toContain('app-pass')
    expect(JSON.stringify(a.io.files)).not.toContain('app-pass')
    // The server holds the folder, the directory, this device's file and the README.
    expect(dav.collections.has(`${ROOT}/Zenium`)).toBe(true)
    const names = [...dav.files(DIR)!.keys()]
    expect(names.filter(isDeviceFileName)).toHaveLength(1)
    expect(names).toContain('README.txt')
    expect(names.some((n) => n.includes('.tmp-'))).toBe(false)

    await setupWebDav(b)
    expect(b.engine.status().pendingMerge).toBe(true)
    await b.engine.confirmMerge(true)
    expect(b.browser.bookmarks.get(bm.id)?.url).toBe('https://zenium.app/')

    b.browser.bookmarks.create({ title: 'Docs', url: 'https://docs.example/' })
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.state.bookmarks.some((n) => n.url === 'https://docs.example/')).toBe(true)
    expect([...dav.files(DIR)!.keys()].filter(isDeviceFileName)).toHaveLength(2)
    // The rounds went through the protocol: listings, conditional reads, atomic writes.
    const methods = new Set(dav.log.map((r) => r.method))
    expect([...methods].sort()).toEqual(['GET', 'MKCOL', 'MOVE', 'PROPFIND', 'PUT'])
    expect(dav.log.some((r) => r.method === 'GET' && r.headers['if-none-match'])).toBe(true)
    expect(
      dav.log.filter((r) => r.method === 'MOVE').every((r) => r.headers['overwrite'] === 'T')
    ).toBe(true)
  }, 30_000)

  it('a restart connects with the password from the secret store; a store without it is authRefused until a new one comes', async () => {
    const a = webDavDevice('Desk (Linux)')
    await unlockVault(a)
    await setupWebDav(a)
    const before = a.engine.status()
    a.engine.flushSync()

    const again = webDavDevice('Desk (Linux)', { io: a.io, keys: a.keys, secrets: a.secrets })
    await tick()
    expect(again.engine.status()).toMatchObject({
      enabled: true,
      transport: 'webdav',
      deviceId: before.deviceId,
      authRefused: false
    })
    again.browser.bookmarks.create({ title: 'After', url: 'https://after.example/' })
    await again.engine.syncNow()
    expect(again.engine.status().lastError).toBeNull()
    expect(again.engine.status().lastSyncAt).not.toBeNull()
    again.engine.flushSync()

    // The same profile on a host whose store lost the secret (another machine's keystore).
    const empty = memorySecrets()
    const bare = webDavDevice('Desk (Linux)', { io: a.io, keys: a.keys, secrets: empty })
    await tick()
    expect(bare.engine.status()).toMatchObject({
      enabled: true,
      transport: 'webdav',
      authRefused: true,
      folder: webDavFolderUrl(CREDENTIALS)
    })
    dav.drain()
    await bare.engine.syncNow()
    // No transport: nothing reaches the server.
    expect(dav.log).toEqual([])

    await bare.engine.setWebDavPassword('app-pass')
    expect(empty.values.get(WEBDAV_SECRET_KEY)).toBe('app-pass')
    expect(bare.engine.status()).toMatchObject({ authRefused: false, lastError: null })
    expect(bare.engine.status().lastSyncAt).not.toBeNull()
    expect(dav.log.some((r) => r.method === 'PROPFIND' && r.status === 207)).toBe(true)
  }, 30_000)

  it('a revoked app password is authRefused with sync still configured and nothing more is sent with it; the new password recovers', async () => {
    // A poll a few milliseconds apart: what a 45 s poll and a push on every change would do with
    // a revoked password over a day, in a moment.
    const a = webDavDevice('Desk (Linux)', { pollMs: 20 })
    await unlockVault(a)
    await setupWebDav(a)
    await wait(70)
    // The poll is running: rounds go out on their own before the refusal.
    expect(
      dav.log.filter((r) => r.method === 'PROPFIND' && r.status === 207).length
    ).toBeGreaterThan(0)

    dav.setPassword('alice', 'rotated')
    a.browser.bookmarks.create({ title: 'X', url: 'https://x.example/' })
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({
      enabled: true,
      transport: 'webdav',
      authRefused: true,
      lastError: 'WebDAV PROPFIND answered 401',
      lastErrorKind: 'auth'
    })
    expect(a.engine.status().lastError).not.toContain('app-pass')

    // From here not one request carries the dead password: not the poll (Nextcloud's brute-force
    // protection counts every 401 against the address, for every client behind it), not a push on
    // a change, not Sync now.
    dav.drain()
    await wait(120)
    expect(dav.log).toEqual([])
    a.browser.bookmarks.create({ title: 'Y', url: 'https://y.example/' })
    await wait(50)
    await a.engine.syncNow()
    expect(dav.log).toEqual([])
    expect(a.engine.status().authRefused).toBe(true)

    // The new password connects again, runs a round, and the poll is back.
    expect(await a.engine.setWebDavPassword('rotated')).toBeNull()
    expect(a.secrets.values.get(WEBDAV_SECRET_KEY)).toBe('rotated')
    expect(a.engine.status()).toMatchObject({
      authRefused: false,
      lastError: null,
      lastErrorKind: null
    })
    expect(dav.log.some((r) => r.status === 401)).toBe(false)
    expect(dav.log.some((r) => r.method === 'PROPFIND' && r.status === 207)).toBe(true)
    expect(dav.files(DIR)!.size).toBeGreaterThan(1)
    dav.drain()
    await wait(70)
    expect(
      dav.log.filter((r) => r.method === 'PROPFIND' && r.status === 207).length
    ).toBeGreaterThan(0)
  }, 30_000)

  it('a 403 is the folder refused, not the password: an error of the round, sync still polling', async () => {
    const a = webDavDevice('Desk (Linux)')
    await unlockVault(a)
    await setupWebDav(a)
    dav.failNext = 403
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({
      authRefused: false,
      lastError: 'WebDAV PROPFIND answered 403',
      lastErrorKind: 'forbidden'
    })
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({ lastError: null, lastErrorKind: null })
  }, 30_000)

  it('a server refusal at the setup comes back typed, nothing toasted and nothing kept; the standing setup is left alone', async () => {
    const a = webDavDevice('Desk (Linux)')
    await unlockVault(a)
    expect(await setupWebDav(a, { ...CREDENTIALS, password: 'wrong' })).toEqual({
      reason: 'server',
      kind: 'auth',
      status: 401
    })
    expect(
      await setupWebDav(a, { ...CREDENTIALS, url: 'https://cloud.test/remote.php/dav/files/bob/' })
    ).toEqual({ reason: 'server', kind: 'missing', status: 404 })
    dav.down = true
    expect(await setupWebDav(a)).toEqual({ reason: 'server', kind: 'unavailable', status: 0 })
    dav.down = false
    expect(a.toasts).toEqual([])
    expect(a.engine.status()).toMatchObject({ enabled: false, transport: 'folder', webdav: null })
    expect(a.secrets.values.size).toBe(0)

    // A device syncing through a folder asks for a server whose store cannot keep the password:
    // the typed refusal, and the folder setup stands as it was (the store is asked before
    // anything is undone).
    const b = device('Desk (Linux)', { fetch: dav.fetch, secrets: refusingSecrets() })
    await unlockVault(b)
    await b.engine.setup(
      {
        folder: '/drive',
        passphrase: PASSPHRASE,
        deviceName: b.name,
        scope: b.engine.status().scope
      },
      b.win
    )
    expect(b.engine.status()).toMatchObject({
      enabled: true,
      transport: 'folder',
      folder: '/drive'
    })
    expect(await setupWebDav(b)).toEqual({ reason: 'secrets' })
    expect(b.toasts).toEqual([])
    expect(b.engine.status()).toMatchObject({
      enabled: true,
      transport: 'folder',
      folder: '/drive'
    })
    b.browser.bookmarks.create({ title: 'Still', url: 'https://still.example/' })
    await b.engine.syncNow()
    expect(b.engine.status().lastError).toBeNull()
  }, 30_000)

  it('a new app password the store cannot keep is the typed refusal, never a rejection; the old one stays refused', async () => {
    const store = memorySecrets()
    const a = webDavDevice('Desk (Linux)', { secrets: store })
    await unlockVault(a)
    await setupWebDav(a)
    dav.setPassword('alice', 'rotated')
    await a.engine.syncNow()
    expect(a.engine.status().authRefused).toBe(true)

    store.set = async () => {
      throw new Error('Error while encrypting the text provided to safeStorage.encryptString.')
    }
    dav.drain()
    expect(await a.engine.setWebDavPassword('rotated')).toEqual({ reason: 'secrets' })
    expect(a.engine.status()).toMatchObject({ authRefused: true, enabled: true })
    expect(store.values.get(WEBDAV_SECRET_KEY)).toBe('app-pass')
    expect(dav.log).toEqual([])
  }, 30_000)

  it('a failed precondition (412) is run again quietly like a lock, through the same retries', async () => {
    const a = webDavDevice('Desk (Linux)')
    await unlockVault(a)
    await setupWebDav(a)
    a.browser.bookmarks.create({ title: 'X', url: 'https://x.example/' })
    for (let i = 0; i < WEBDAV_CONFLICT_RETRIES; i++) {
      dav.failNext = 412
      await a.engine.syncNow()
      expect(a.engine.status()).toMatchObject({ lastError: null, lastErrorKind: null })
    }
    dav.failNext = 412
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({
      lastError: 'WebDAV PROPFIND answered 412',
      lastErrorKind: 'conflict',
      authRefused: false
    })
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({ lastError: null, lastErrorKind: null })
  }, 30_000)

  it('a lock or a failed precondition is run again quietly a few times, then shown, then cleared', async () => {
    const a = webDavDevice('Desk (Linux)')
    await unlockVault(a)
    await setupWebDav(a)

    dav.locked = true
    a.browser.bookmarks.create({ title: 'X', url: 'https://x.example/' })
    for (let i = 0; i < WEBDAV_CONFLICT_RETRIES; i++) {
      await a.engine.syncNow()
      expect(a.engine.status().lastError).toBeNull()
    }
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({
      lastError: 'WebDAV PUT answered 423',
      lastErrorKind: 'conflict',
      authRefused: false,
      enabled: true
    })

    dav.locked = false
    await a.engine.syncNow()
    expect(a.engine.status().lastError).toBeNull()
    expect(dav.files(DIR)!.size).toBeGreaterThan(1)
  }, 30_000)

  it('an unreachable server is an error of the round, not a lost folder or a refused sign-in', async () => {
    const a = webDavDevice('Desk (Linux)')
    await unlockVault(a)
    await setupWebDav(a)
    dav.down = true
    a.browser.bookmarks.create({ title: 'X', url: 'https://x.example/' })
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({
      folderLost: false,
      authRefused: false,
      lastError: 'WebDAV PROPFIND: fetch failed: <url> refused the connection',
      lastErrorKind: 'unavailable'
    })
    dav.down = false
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({ lastError: null, lastErrorKind: null })
  }, 30_000)

  it('the probe reaches the server with the credentials and makes nothing', async () => {
    const a = webDavDevice('Desk (Linux)')
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
    expect(dav.collections.has(`${ROOT}/Zenium`)).toBe(false)
    expect(a.engine.status().enabled).toBe(false)

    const phone = device('Pixel 9')
    expect(phone.engine.status().webdavAvailable).toBe(false)
    expect(await phone.engine.testWebDav(CREDENTIALS)).toEqual({
      ok: false,
      kind: 'unavailable',
      status: 0
    })
  })

  it('a host without the fetch or the secret store cannot set a server up; the folder setup is as before', async () => {
    const phone = device('Pixel 9')
    await unlockVault(phone)
    await setupWebDav(phone)
    expect(phone.engine.status().enabled).toBe(false)
    expect(phone.toasts.at(-1)).toContain('WebDAV is not available')

    const withoutSecrets = device('Desk (Linux)', { fetch: dav.fetch })
    expect(withoutSecrets.engine.status().webdavAvailable).toBe(false)

    const a = webDavDevice('Desk (Linux)')
    await unlockVault(a)
    await a.engine.setup(
      {
        folder: '/drive',
        passphrase: PASSPHRASE,
        deviceName: a.name,
        scope: a.engine.status().scope
      },
      a.win
    )
    expect(a.engine.status()).toMatchObject({ enabled: true, transport: 'folder', webdav: null })
    expect(a.secrets.values.size).toBe(0)
  })

  it('a wrong passphrase for a folder already on the server is refused and nothing is kept', async () => {
    const a = webDavDevice('Desk (Linux)')
    const b = webDavDevice('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    await setupWebDav(a)
    await setupWebDav(b, CREDENTIALS, 'a different passphrase')
    expect(b.toasts.at(-1)).toContain('does not match')
    expect(b.engine.status()).toMatchObject({ enabled: false, transport: 'folder', webdav: null })
    expect(b.secrets.values.size).toBe(0)
  }, 30_000)

  it('disconnecting forgets the password and returns to a folder; the wipe removes this device alone', async () => {
    const a = webDavDevice('Desk (Linux)')
    const b = webDavDevice('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    await setupWebDav(a)
    await setupWebDav(b)
    await b.engine.confirmMerge(true)
    expect([...dav.files(DIR)!.keys()].filter(isDeviceFileName)).toHaveLength(2)

    b.engine.disconnect(true)
    await tick()
    await tick()
    const left = [...dav.files(DIR)!.keys()].filter(isDeviceFileName)
    expect(left).toHaveLength(1)
    expect(left[0]).toContain(a.engine.status().deviceId)
    expect(b.engine.status()).toMatchObject({
      enabled: false,
      transport: 'folder',
      webdav: null,
      folder: null,
      authRefused: false
    })
    await tick()
    expect(b.secrets.values.has(WEBDAV_SECRET_KEY)).toBe(false)

    // Pointing the other device at a folder of its own leaves the server behind, password included.
    await a.engine.setFolder('/drive', a.win)
    expect(a.engine.status()).toMatchObject({ transport: 'folder', webdav: null, folder: '/drive' })
    await tick()
    expect(a.secrets.values.has(WEBDAV_SECRET_KEY)).toBe(false)
    expect(devices).toHaveLength(2)
  }, 30_000)
})
