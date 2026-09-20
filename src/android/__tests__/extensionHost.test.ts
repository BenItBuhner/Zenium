import { beforeAll, describe, expect, it } from 'vitest'
import type { Browser } from '@core/browser'
import type { StoreIO } from '@core/platform'
import { sha256, toHex, utf8Encode } from '@core/extensions/bytes'
import { parseCrxHeader } from '@core/extensions/crx'
import type { InstallConfirmation } from '@core/extensions/hostStore'
import { installFromCrx } from '@core/extensions/install'
import { permissionWarningLines } from '@core/extensions/permissionMessages'
import type { ExtensionRecord } from '@core/extensions/registry'
import { CHROME_WEB_STORE_UPDATE_URL, EDGE_ADD_ONS_UPDATE_URL } from '@core/extensions/store'
import type { ZenWindow } from '@core/window'
import {
  buildCrx,
  buildZip,
  generateRsaKey,
  sampleExtensionZip
} from '@core/extensions/__tests__/helpers'
import type { Bridge } from '../bridge'
import {
  AndroidExtensions,
  REQUEST_UPDATE_CHECK_THROTTLE_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_STARTUP_DELAY_MS,
  idForUnpackedPath,
  packageFileName,
  storeChromiumVersion
} from '../extensionHost'
import type { ExtensionRuntimeHooks } from '../extensionRuntimeHooks'
import {
  AndroidExtensionStoreIo,
  type PackageHandle,
  type UnpackRequest
} from '../extensionStoreIo'

// ---------------------------------------------------------------------------
// A Kotlin side in memory: what ext/ExtensionStore.kt does, minus the disk and the network
// ---------------------------------------------------------------------------

type Answer = { status: number; body?: Uint8Array | string }
type Route = (url: URL) => Answer | undefined

class FakeKotlinStore {
  readonly root = '/data/user/0/app.zen.chromium/files/zen/extensions'
  /** Package files under cache/ext-packages, by token. */
  readonly packages = new Map<string, Uint8Array>()
  /** Version directories that were "unpacked", by path, with the request that wrote them. */
  readonly installed = new Map<string, UnpackRequest>()
  readonly calls: Array<{ method: string; args: unknown }> = []
  /** Every URL the fetcher was asked for, in order. */
  readonly requests: string[] = []
  /** Packages other apps sent (the VIEW / SEND intents) waiting for `takeSideloads`. */
  readonly sideloads: PackageHandle[] = []
  /** What the document picker answers, one handle per call. */
  readonly picked: Array<PackageHandle | null> = []
  route: Route = () => undefined
  private seq = 0

  readonly bridge = {
    call: (method: string, args: unknown) => this.dispatch(method, args),
    send: (method: string, args: unknown) => {
      void this.dispatch(method, args)
    }
  } as unknown as Bridge

  io(): AndroidExtensionStoreIo {
    return new AndroidExtensionStoreIo(this.bridge, this.root, {
      readPackage: async (token) => {
        const bytes = this.packages.get(token)
        if (!bytes) throw new Error(`no package file ${token}`)
        return bytes
      },
      readFile: async (relative) => this.readFile(relative)
    })
  }

  /** A package file as the picker or a sending app leaves it: a handle the host can read. */
  hold(name: string, bytes: Uint8Array): PackageHandle {
    const token = this.newToken()
    this.packages.set(token, bytes)
    return { token, name, size: bytes.length }
  }

  dirsOf(id: string): string[] {
    return [...this.installed.keys()].filter((dir) => dir.startsWith(`${this.root}/${id}/`))
  }

  calledWith(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args)
  }

  private async dispatch(method: string, args: unknown): Promise<unknown> {
    this.calls.push({ method, args })
    switch (method) {
      case 'extStore.fetch':
        return this.fetch(args as { url: string; maxBytes: number })
      case 'extStore.unpack':
        return this.unpack(args as UnpackRequest)
      case 'extStore.discard':
        this.packages.delete((args as { token: string }).token)
        return undefined
      case 'extStore.remove':
        for (const dir of this.dirsOf((args as { id: string }).id)) this.installed.delete(dir)
        return undefined
      case 'extStore.prune': {
        const { id, keep } = args as { id: string; keep: string }
        const removed = this.dirsOf(id).filter((dir) => dir !== keep)
        for (const dir of removed) this.installed.delete(dir)
        return removed
      }
      case 'extStore.sweep':
        return { staging: [], packages: 0 }
      case 'extStore.pick':
        return this.picked.shift() ?? null
      case 'extStore.takeSideloads':
        return this.sideloads.splice(0)
      default:
        throw new Error(`no such bridge method ${method}`)
    }
  }

  private fetch({ url, maxBytes }: { url: string; maxBytes: number }): {
    status: number
    url: string
    size: number
    token: string | null
  } {
    this.requests.push(url)
    const answer = this.route(new URL(url)) ?? { status: 404 }
    const body = typeof answer.body === 'string' ? utf8Encode(answer.body) : answer.body
    if (!body || body.length === 0) return { status: answer.status, url, size: 0, token: null }
    if (body.length > maxBytes)
      throw new Error(`the download passed the limit of ${maxBytes} bytes`)
    const token = this.newToken()
    this.packages.set(token, body)
    return { status: answer.status, url, size: body.length, token }
  }

  private unpack(request: UnpackRequest): { dir: string } {
    if (!this.packages.has(request.token)) throw new Error('the package file is gone')
    const base = `${this.root}/${request.id}/${request.version}`
    let dir = base
    for (let n = 1; this.installed.has(dir); n++) dir = `${base}_${n}`
    this.installed.set(dir, request)
    return { dir }
  }

  private readFile(relative: string): Uint8Array | null {
    const slash = relative.lastIndexOf('/')
    const request = this.installed.get(`${this.root}/${relative.slice(0, slash)}`)
    if (!request) return null
    const name = relative.slice(slash + 1)
    return name === 'manifest.json' && request.manifest !== null
      ? utf8Encode(request.manifest)
      : null
  }

  private newToken(): string {
    return (++this.seq).toString(16).padStart(32, '0')
  }
}

class FakeRuntime implements ExtensionRuntimeHooks {
  readonly events: string[] = []
  /** Every hook in order, `expect` included (the `events` above leave it out for the older tests). */
  readonly timeline: string[] = []
  /** A reason to refuse a record, or null to run it. */
  refuse: (record: ExtensionRecord) => string | null = () => null
  /** Set, an attach waits for it before it finishes (the Kotlin side opening and configuring). */
  attaching: Promise<void> | null = null
  /**
   * Extensions whose update the runtime would delay (Chrome's `ShouldDelayExtensionUpdate`: a
   * worker running, a page open); a detach makes one idle.
   */
  readonly busy = new Set<string>()
  /** The `runtime.onUpdateAvailable` events raised: extension id and the version offered. */
  readonly updatesAvailable: Array<{ id: string; version: string }> = []

  async attach(record: ExtensionRecord): Promise<void> {
    this.events.push(`attach ${record.id} ${record.version}`)
    this.timeline.push(`attach ${record.id}`)
    if (this.attaching) await this.attaching
    const reason = this.refuse(record)
    if (reason) throw new Error(reason)
  }

  async detach(id: string): Promise<void> {
    this.events.push(`detach ${id}`)
    this.timeline.push(`detach ${id}`)
    this.busy.delete(id)
  }

  delaysUpdate(id: string): boolean {
    return this.busy.has(id)
  }

  updateAvailable(id: string, details: Record<string, unknown>): void {
    this.updatesAvailable.push({ id, version: String(details.version) })
    this.timeline.push(`updateAvailable ${id} ${String(details.version)}`)
  }

  async reconfigure(record: ExtensionRecord): Promise<void> {
    this.events.push(`reconfigure ${record.id}`)
    this.timeline.push(`reconfigure ${record.id}`)
  }

  expect(ids: string[]): void {
    this.timeline.push(`expect ${ids.join(',')}`)
  }
}

interface Harness {
  kt: FakeKotlinStore
  ext: AndroidExtensions
  runtime: FakeRuntime
  toasts: Array<{ message: string; kind: string }>
  opened: string[]
  dialogs: string[]
  /** Events sent to the chrome (the prompts `confirmInstall` raises through its sheet). */
  emitted: Array<{ name: string; payload: { requestId: string; kind: string; name: string } }>
  prompts: InstallConfirmation[]
  answer: (ok: boolean) => void
  files: Map<string, string>
  clock: { now: number }
  timeouts: Array<{ fn: () => void; ms: number }>
  intervals: Array<{ fn: () => void; ms: number }>
  registry: () => { version: number; extensions: ExtensionRecord[]; lastUpdateCheck: number | null }
}

function harness(options: { registry?: string; nativeConfirm?: boolean } = {}): Harness {
  const kt = new FakeKotlinStore()
  const files = new Map<string, string>()
  if (options.registry) files.set('extensions.json', options.registry)
  const storeIo: StoreIO = {
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    }
  }
  const toasts: Harness['toasts'] = []
  const opened: string[] = []
  const dialogs: string[] = []
  const emitted: Harness['emitted'] = []
  const browser = {
    platform: {
      io: storeIo,
      dialogs: {
        confirm: async (opts: { message: string; detail?: string }) => {
          dialogs.push(`${opts.message}\n${opts.detail ?? ''}`)
          return true
        }
      }
    },
    state: { commitVolatile: () => undefined },
    toast: (message: string, kind: string) => {
      toasts.push({ message, kind })
    },
    emit: (name: string, payload: Harness['emitted'][number]['payload']) => {
      emitted.push({ name, payload })
    },
    tabs: {
      createTab: (opts: { url: string }) => {
        opened.push(opts.url)
      }
    }
  } as unknown as Browser
  const runtime = new FakeRuntime()
  const clock = { now: 1_700_000_000_000 }
  const timeouts: Harness['timeouts'] = []
  const intervals: Harness['intervals'] = []
  const ext = new AndroidExtensions(browser, kt.io(), {
    hooks: runtime,
    chromiumVersion: '152.0.0.0',
    locale: null,
    now: () => clock.now,
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return timeouts.length
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms })
      return intervals.length
    },
    clearInterval: () => undefined
  })
  const prompts: InstallConfirmation[] = []
  let ok = true
  if (!options.nativeConfirm)
    ext.confirmInstall = async (request) => {
      prompts.push(request)
      return ok
    }
  return {
    kt,
    ext,
    runtime,
    toasts,
    opened,
    dialogs,
    emitted,
    prompts,
    answer: (value) => {
      ok = value
    },
    files,
    clock,
    timeouts,
    intervals,
    registry: () => {
      ext.flushSync()
      return JSON.parse(files.get('extensions.json') ?? 'null') as ReturnType<Harness['registry']>
    }
  }
}

// ---------------------------------------------------------------------------
// Packages and store fronts
// ---------------------------------------------------------------------------

const key = generateRsaKey()
let crx1: Uint8Array
let crx2: Uint8Array
let crx2WithTabs: Uint8Array
let ID: string
let ZIP_OFFSET: number

beforeAll(async () => {
  crx1 = await buildCrx({
    zip: sampleExtensionZip({ name: 'Sample', version: '1.0.0', options_page: 'options.html' }),
    rsaKeys: [key]
  })
  crx2 = await buildCrx({
    zip: sampleExtensionZip({ name: 'Sample', version: '1.1.0' }),
    rsaKeys: [key]
  })
  crx2WithTabs = await buildCrx({
    zip: sampleExtensionZip({ name: 'Sample', version: '1.1.0', permissions: ['tabs'] }),
    rsaKeys: [key]
  })
  ID = (await installFromCrx(crx1)).id
  ZIP_OFFSET = parseCrxHeader(crx1).zipOffset
})

const CWS_HOST = 'clients2.google.com'
const EDGE_HOST = 'edge.microsoft.com'
const CDN_HOST = 'cdn.example.test'

interface StoreFront {
  /** A package for the store's download URL, or the status it answers without one. */
  cws?: Uint8Array | number
  edge?: Uint8Array | number
  /** What the update check says: a newer package (with its hash unless told otherwise), or nothing new. */
  update?: { crx: Uint8Array; version: string; sha256?: string | null } | 'noupdate'
}

async function storeFront(kt: FakeKotlinStore, front: StoreFront): Promise<void> {
  const update = front.update
  const hash =
    update && update !== 'noupdate'
      ? update.sha256 === undefined
        ? toHex(await sha256(update.crx))
        : update.sha256
      : null
  kt.route = (url) => {
    const response = url.searchParams.get('response')
    if (response === 'redirect') {
      const answer =
        url.hostname === CWS_HOST ? front.cws : url.hostname === EDGE_HOST ? front.edge : undefined
      if (answer === undefined) return { status: 404 }
      return typeof answer === 'number' ? { status: answer } : { status: 200, body: answer }
    }
    if (response === 'updatecheck' && update) {
      const ids = url.searchParams.getAll('x').map((x) => new URLSearchParams(x).get('id') ?? '')
      const apps = ids.map((id) =>
        update === 'noupdate'
          ? `<app appid="${id}" status="ok"><updatecheck status="noupdate"/></app>`
          : `<app appid="${id}" status="ok"><updatecheck status="ok" codebase="https://${CDN_HOST}/${id}.crx" version="${update.version}"${hash ? ` hash_sha256="${hash}"` : ''}/></app>`
      )
      return {
        status: 200,
        body: `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">${apps.join('')}</gupdate>`
      }
    }
    if (url.hostname === CDN_HOST && update && update !== 'noupdate')
      return { status: 200, body: update.crx }
    return undefined
  }
}

const updateChecks = (kt: FakeKotlinStore): string[] =>
  kt.requests.filter((url) => url.includes('response=updatecheck'))

/** A window for the calls the user makes (those report through toasts). */
const WIN = {} as unknown as ZenWindow

/** Lets the promise chains of the fake bridge run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

describe('AndroidExtensions: installing from a store', () => {
  it('downloads by id, confirms, has Kotlin unpack the package and records it', async () => {
    const h = harness()
    await storeFront(h.kt, { cws: crx1 })
    await h.ext.installFromStore(ID, null)

    // One download from the Chrome Web Store, with the desktop's Chromium version.
    expect(h.kt.requests).toHaveLength(1)
    const request = new URL(h.kt.requests[0])
    expect(request.hostname).toBe(CWS_HOST)
    expect(request.searchParams.get('response')).toBe('redirect')
    expect(request.searchParams.get('prodversion')).toBe('152.0.0.0')
    expect(request.searchParams.get('x')).toContain(`id=${ID}`)

    // The install prompt saw the package's name and where it came from.
    expect(h.prompts).toEqual([
      { kind: 'install', name: 'Sample', icon: null, warnings: [], source: 'chrome-web-store' }
    ])

    // Kotlin unpacked the listed files from the CRX at its zip offset, with the manifest carrying the key.
    const dir = `${h.kt.root}/${ID}/1.0.0`
    const unpack = h.kt.installed.get(dir)
    expect(unpack).toBeDefined()
    expect(unpack?.id).toBe(ID)
    expect(unpack?.version).toBe('1.0.0')
    expect(unpack?.zipOffset).toBe(ZIP_OFFSET)
    expect(unpack?.rootPrefix).toBe('')
    expect(unpack?.files).toEqual(['manifest.json', 'background.js'])
    expect(JSON.parse(unpack?.manifest ?? '{}')).toMatchObject({ name: 'Sample', version: '1.0.0' })
    expect(typeof JSON.parse(unpack?.manifest ?? '{}').key).toBe('string')
    expect(unpack?.totalSize).toBeGreaterThan(0)

    // The runtime got the record, the package file went, the list shows the extension.
    expect(h.runtime.events).toEqual([`attach ${ID} 1.0.0`])
    expect(h.kt.packages.size).toBe(0)
    expect(h.toasts).toEqual([{ message: 'Added Sample 1.0.0', kind: 'info' }])
    const [info] = h.ext.list()
    expect(info).toMatchObject({
      id: ID,
      name: 'Sample',
      version: '1.0.0',
      path: dir,
      enabled: true,
      source: 'chrome-web-store',
      publisher: 'unknown',
      updateUrl: CHROME_WEB_STORE_UPDATE_URL,
      installedAt: h.clock.now,
      updatedAt: h.clock.now,
      pinned: false,
      manifestVersion: 3,
      optionsPage: 'options.html',
      pendingWarnings: null,
      updateState: 'unknown',
      error: null
    })

    // The registry is the desktop's schema.
    const registry = h.registry()
    expect(registry.version).toBe(2)
    expect(registry.lastUpdateCheck).toBeNull()
    expect(registry.extensions).toHaveLength(1)
    expect(registry.extensions[0]).toMatchObject({
      id: ID,
      source: 'chrome-web-store',
      path: dir,
      version: '1.0.0',
      publisher: 'unknown',
      updateUrl: CHROME_WEB_STORE_UPDATE_URL,
      enabled: true,
      pinned: false,
      allowFileAccess: false,
      manifestVersion: 3,
      name: 'Sample',
      permissions: [],
      hostPermissions: [],
      optionsPage: 'options.html',
      popup: null,
      pendingWarnings: null
    })
  })

  it('falls back to Edge Add-ons when the Chrome Web Store has no package', async () => {
    const h = harness()
    await storeFront(h.kt, { cws: 204, edge: crx1 })
    await h.ext.installFromStore(ID, null)
    expect(h.kt.requests.map((url) => new URL(url).hostname)).toEqual([CWS_HOST, EDGE_HOST])
    expect(h.ext.record(ID)).toMatchObject({
      source: 'edge-add-ons',
      updateUrl: EDGE_ADD_ONS_UPDATE_URL
    })
    expect(h.prompts[0].source).toBe('edge-add-ons')
  })

  it('starts with the store a listing URL names', async () => {
    const h = harness()
    await storeFront(h.kt, { edge: crx1 })
    await h.ext.installFromStore(
      `https://microsoftedge.microsoft.com/addons/detail/sample/${ID}`,
      null
    )
    expect(new URL(h.kt.requests[0]).hostname).toBe(EDGE_HOST)
    expect(h.ext.record(ID)?.source).toBe('edge-add-ons')
  })

  it('reports when no store has the extension and leaves nothing behind', async () => {
    const h = harness()
    await storeFront(h.kt, { cws: 204, edge: 404 })
    await h.ext.installFromStore(ID, null)
    expect(h.ext.list()).toEqual([])
    expect(h.kt.installed.size).toBe(0)
    expect(h.kt.packages.size).toBe(0)
    expect(h.toasts[0].kind).toBe('error')
    expect(h.toasts[0].message).toContain('Chrome Web Store: HTTP 204')
    expect(h.toasts[0].message).toContain('Edge Add-ons: HTTP 404')
  })

  it('refuses a package whose id is not the one asked for', async () => {
    const h = harness()
    const other = await buildCrx({ zip: sampleExtensionZip(), rsaKeys: [generateRsaKey(1024)] })
    await storeFront(h.kt, { cws: other })
    await h.ext.installFromStore(ID, null)
    expect(h.ext.list()).toEqual([])
    expect(h.prompts).toEqual([])
    expect(h.toasts[0].message).toContain(`${ID} was requested`)
    expect(h.kt.packages.size).toBe(0)
  })

  it('does nothing when the user declines the prompt, and frees the download', async () => {
    const h = harness()
    h.answer(false)
    await storeFront(h.kt, { cws: crx1 })
    await h.ext.installFromStore(ID, null)
    expect(h.prompts).toHaveLength(1)
    expect(h.kt.calledWith('extStore.unpack')).toEqual([])
    expect(h.ext.list()).toEqual([])
    expect(h.runtime.events).toEqual([])
    expect(h.kt.packages.size).toBe(0)
    expect(h.toasts).toEqual([])
  })

  it('rejects what is neither an id nor a listing URL, and an id already installed', async () => {
    const h = harness()
    await storeFront(h.kt, { cws: crx1 })
    await h.ext.installFromStore('not an extension', null)
    expect(h.toasts).toEqual([
      { message: 'Enter an extension id or a store listing URL.', kind: 'error' }
    ])
    expect(h.kt.requests).toEqual([])
    await h.ext.installFromStore(ID, null)
    await h.ext.installFromStore(ID, null)
    expect(h.kt.requests).toHaveLength(1)
    expect(h.toasts.at(-1)).toEqual({ message: 'Sample is already installed.', kind: 'info' })
  })

  it('uses the native confirm dialog unless the chrome replaces the prompt', async () => {
    const h = harness({ nativeConfirm: true })
    await storeFront(h.kt, { cws: crx1 })
    await h.ext.installFromStore(ID, null)
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0]).toContain('Sample')
    expect(h.ext.record(ID)).toBeDefined()
  })

  it("puts the prompt to the chrome's sheet when a live window can show it", async () => {
    const h = harness({ nativeConfirm: true })
    await storeFront(h.kt, { cws: crx1 })
    const live = { alive: true } as unknown as ZenWindow
    const install = h.ext.installFromStore(ID, null, live)
    while (h.emitted.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.emitted[0].name).toBe('extensionInstallRequest')
    expect(h.emitted[0].payload).toMatchObject({ kind: 'install', name: 'Sample' })
    expect(h.dialogs).toEqual([])
    // An answer to a prompt nobody asked is ignored; the real one completes the install.
    h.ext.respondPrompt('extensionInstallRequest:stale', true)
    h.ext.respondPrompt(h.emitted[0].payload.requestId, true)
    await install
    expect(h.ext.record(ID)).toBeDefined()
    expect(h.emitted).toHaveLength(1)
  })

  it('keeps the install when the runtime cannot load it, and says so', async () => {
    const h = harness()
    h.runtime.refuse = () => 'manifest version 3 is not supported yet'
    await storeFront(h.kt, { cws: crx1 })
    await h.ext.installFromStore(ID, null)
    expect(h.ext.record(ID)?.enabled).toBe(true)
    expect(h.ext.list()[0].error).toBe('manifest version 3 is not supported yet')
    expect(h.toasts[0]).toEqual({
      message:
        'Installed Sample, but it could not be loaded: manifest version 3 is not supported yet',
      kind: 'error'
    })
  })
})

describe('AndroidExtensions: installing from files', () => {
  it('installs a picked .crx and remembers it as a crx install without an update source', async () => {
    const h = harness()
    h.kt.picked.push(h.kt.hold('sample.crx', crx1))
    await h.ext.installFromFileDialog(WIN)
    expect(h.prompts).toEqual([
      { kind: 'install', name: 'Sample', icon: null, warnings: [], source: 'crx' }
    ])
    expect(h.ext.record(ID)).toMatchObject({
      source: 'crx',
      publisher: 'unknown',
      updateUrl: null,
      version: '1.0.0'
    })
    expect(h.kt.installed.get(`${h.kt.root}/${ID}/1.0.0`)?.zipOffset).toBe(ZIP_OFFSET)
    expect(h.kt.packages.size).toBe(0)
  })

  it('does nothing when the picker is dismissed', async () => {
    const h = harness()
    h.kt.picked.push(null)
    await h.ext.installFromFileDialog(WIN)
    expect(h.ext.list()).toEqual([])
    expect(h.toasts).toEqual([])
  })

  it('installs a sideloaded .zip with a folder root, giving it a stable id and a manifest key', async () => {
    const h = harness()
    const manifest = { manifest_version: 3, name: 'Zipped Blocker', version: '2.3.4' }
    const zip = buildZip([
      { name: 'blocker.chromium/' },
      { name: 'blocker.chromium/manifest.json', data: JSON.stringify(manifest) },
      { name: 'blocker.chromium/js/background.js', data: 'self.onmessage = () => {}' }
    ])
    await h.ext.installHandle(h.kt.hold('blocker.chromium.zip', zip))
    const [record] = h.ext.records()
    expect(record.id).toMatch(/^[a-p]{32}$/)
    expect(record).toMatchObject({
      source: 'zip',
      publisher: null,
      updateUrl: null,
      name: 'Zipped Blocker',
      version: '2.3.4',
      path: `${h.kt.root}/${record.id}/2.3.4`
    })
    const unpack = h.kt.installed.get(record.path)
    expect(unpack?.rootPrefix).toBe('blocker.chromium/')
    expect(unpack?.files).toEqual(['manifest.json', 'js/background.js'])
    expect(JSON.parse(unpack?.manifest ?? '{}')).toMatchObject({
      ...manifest,
      key: expect.stringMatching(/^[A-Za-z0-9+/=]+$/) as string
    })
    expect(h.toasts).toEqual([{ message: 'Added Zipped Blocker 2.3.4', kind: 'info' }])

    // The same extension zipped again lands on the same id: an update, not a twin.
    const again = buildZip([
      { name: 'manifest.json', data: JSON.stringify({ ...manifest, version: '2.4.0' }) }
    ])
    await h.ext.installHandle(h.kt.hold('blocker.zip', again))
    expect(h.ext.records()).toHaveLength(1)
    expect(h.ext.record(record.id)?.version).toBe('2.4.0')
    expect(h.prompts[1].kind).toBe('update')
    expect(h.kt.dirsOf(record.id)).toEqual([`${h.kt.root}/${record.id}/2.4.0`])

    // Zips have no update source.
    await h.ext.update(record.id, WIN)
    expect(h.toasts.at(-1)?.message).toBe('Zipped Blocker has no update source.')
  })

  it('names a package by its bytes when the sending app did not', () => {
    expect(packageFileName('download', crx1)).toBe('download.crx')
    expect(packageFileName('archive.bin', buildZip([{ name: 'a', data: 'x' }]))).toBe('archive.zip')
    expect(packageFileName('Sample.CRX', new Uint8Array(0))).toBe('Sample.CRX')
    expect(packageFileName('notes.txt', utf8Encode('hello'))).toBe('notes.txt')
  })

  it('refuses a file that is not a package and frees Kotlin of it', async () => {
    const h = harness()
    const handle = h.kt.hold('notes.txt', utf8Encode('hello'))
    await h.ext.installHandle(handle)
    expect(h.ext.list()).toEqual([])
    expect(h.toasts[0]).toEqual({
      message: 'Could not install notes.txt: Choose a .crx or .zip file',
      kind: 'error'
    })
    expect(h.kt.packages.has(handle.token)).toBe(false)
  })

  it('collects the packages other apps sent while the chrome was starting', async () => {
    const h = harness()
    h.kt.sideloads.push(h.kt.hold('sample.crx', crx1))
    await h.ext.start()
    // start() collects the queue without waiting for the installs (the prompt must not hold up
    // the boot); the host says when they are done.
    await h.ext.whenPendingInstalled()
    expect(h.kt.calledWith('extStore.takeSideloads')).toHaveLength(1)
    expect(h.kt.sideloads).toEqual([])
    expect(h.ext.record(ID)?.source).toBe('crx')
    expect(h.prompts[0].source).toBe('crx')

    // The host event for a later sideload does the same through installPending.
    h.kt.sideloads.push(h.kt.hold('sample-again.crx', crx1))
    await h.ext.installPending()
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1].kind).toBe('update')
    expect(h.ext.records()).toHaveLength(1)
  })

  it('installs sideloads one batch at a time: a package sent while a prompt is up waits for the answer', async () => {
    const h = harness()
    const shown: Array<() => void> = []
    const answers: Array<(ok: boolean) => void> = []
    /** Resolves once the next prompt is on screen. */
    const nextPrompt = (): Promise<void> => new Promise((resolve) => shown.push(resolve))
    h.ext.confirmInstall = (request) => {
      h.prompts.push(request)
      shown.shift()?.()
      return new Promise<boolean>((resolve) => answers.push(resolve))
    }

    h.kt.sideloads.push(h.kt.hold('sample.crx', crx1))
    let prompt = nextPrompt()
    const first = h.ext.installPending()
    await prompt

    // A second package arrives while the first prompt is up: its batch stays queued in Kotlin.
    h.kt.sideloads.push(h.kt.hold('sample-again.crx', crx1))
    prompt = nextPrompt()
    const second = h.ext.installPending()
    await settle()
    expect(h.kt.calledWith('extStore.takeSideloads')).toHaveLength(1)
    expect(h.prompts).toHaveLength(1)
    expect(h.kt.sideloads).toHaveLength(1)

    // The answer lets the first install finish and the second batch begin, as an update prompt.
    answers[0](true)
    await first
    expect(h.ext.record(ID)?.version).toBe('1.0.0')
    await prompt
    expect(h.kt.calledWith('extStore.takeSideloads')).toHaveLength(2)
    expect(h.kt.sideloads).toEqual([])
    expect(h.prompts[1].kind).toBe('update')
    answers[1](false)
    await second
    await h.ext.whenPendingInstalled()
    expect(h.ext.records()).toHaveLength(1)
    expect(h.kt.packages.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Managing
// ---------------------------------------------------------------------------

/** A turn of the event loop: every microtask queued so far has run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('AndroidExtensions: managing installs', () => {
  async function installed(): Promise<Harness> {
    const h = harness()
    await storeFront(h.kt, { cws: crx1 })
    await h.ext.installFromStore(ID, null)
    h.runtime.events.length = 0
    h.toasts.length = 0
    return h
  }

  it('disables and enables through the runtime and the registry', async () => {
    const h = await installed()
    await h.ext.setEnabled(ID, false)
    expect(h.runtime.events).toEqual([`detach ${ID}`])
    expect(h.ext.list()[0].enabled).toBe(false)
    expect(h.registry().extensions[0].enabled).toBe(false)
    await h.ext.setEnabled(ID, false)
    expect(h.runtime.events).toHaveLength(1)
    await h.ext.setEnabled(ID, true)
    expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.0.0`])
    expect(h.registry().extensions[0].enabled).toBe(true)
  })

  it('removes the files, the record and the runtime instance', async () => {
    const h = await installed()
    await h.ext.remove(ID)
    expect(h.runtime.events).toEqual([`detach ${ID}`])
    expect(h.kt.calledWith('extStore.remove')).toEqual([{ id: ID }])
    expect(h.kt.dirsOf(ID)).toEqual([])
    expect(h.ext.list()).toEqual([])
    expect(h.registry().extensions).toEqual([])
    await h.ext.remove(ID)
    expect(h.runtime.events).toHaveLength(1)
  })

  it('reloads by detaching and attaching again', async () => {
    const h = await installed()
    await h.ext.reload(ID)
    expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.0.0`])
  })

  it('a disable arriving while the extension reloads itself waits for the reload and leaves it off', async () => {
    // uBlock Origin calls chrome.runtime.reload() on its first start; the chrome's toggle (or
    // the sweep's cleanup) flipping the extension off while that reload's attach is on its way
    // to Kotlin left the extension running with its record disabled.
    const h = await installed()
    let opened!: () => void
    h.runtime.attaching = new Promise<void>((resolve) => {
      opened = resolve
    })
    const reload = h.ext.reload(ID)
    await tick()
    expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.0.0`])
    const disable = h.ext.setEnabled(ID, false)
    await tick()
    // The disable has not detached: the reload's attach is still in flight.
    expect(h.runtime.events).toHaveLength(2)
    expect(h.ext.record(ID)?.enabled).toBe(true)
    opened()
    await reload
    await disable
    expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.0.0`, `detach ${ID}`])
    expect(h.ext.list()[0].enabled).toBe(false)
    expect(h.registry().extensions[0].enabled).toBe(false)
    // Off, a reload keeps it off; on again, one attach.
    h.runtime.attaching = null
    await h.ext.reload(ID)
    expect(h.runtime.events).toHaveLength(3)
    await h.ext.setEnabled(ID, true)
    expect(h.runtime.events.at(-1)).toBe(`attach ${ID} 1.0.0`)
  })

  it('a reload arriving during a disable does not bring the extension back', async () => {
    const h = await installed()
    // The disable's detach is instant here; the reload queued behind it reads the record as off.
    const disable = h.ext.setEnabled(ID, false)
    const reload = h.ext.reload(ID)
    await Promise.all([disable, reload])
    expect(h.runtime.events).toEqual([`detach ${ID}`])
    expect(h.ext.list()[0].enabled).toBe(false)
  })

  it('a remove queued behind a reload takes the reloaded instance down', async () => {
    const h = await installed()
    let opened!: () => void
    h.runtime.attaching = new Promise<void>((resolve) => {
      opened = resolve
    })
    const reload = h.ext.reload(ID)
    const remove = h.ext.remove(ID)
    await tick()
    opened()
    await Promise.all([reload, remove])
    expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.0.0`, `detach ${ID}`])
    expect(h.ext.list()).toEqual([])
  })

  it('pins through reconfigure and leaves pinned extensions out of update checks', async () => {
    const h = await installed()
    await storeFront(h.kt, { update: { crx: crx2, version: '1.1.0' } })
    h.ext.setPinned(ID, true)
    expect(h.runtime.events).toEqual([`reconfigure ${ID}`])
    expect(h.registry().extensions[0].pinned).toBe(true)
    await h.ext.checkForUpdates()
    expect(updateChecks(h.kt)).toEqual([])
    expect(h.ext.record(ID)?.version).toBe('1.0.0')
    await h.ext.update(ID, WIN)
    expect(h.toasts.at(-1)?.message).toBe('Sample is pinned to version 1.0.0.')
  })

  it('shows on the toolbar through the registry alone: the runtime is not told', async () => {
    const h = await installed()
    expect(h.ext.list()[0].toolbarPinned).toBe(false)
    h.ext.setToolbarPinned(ID, true)
    expect(h.runtime.events).toEqual([])
    expect(h.ext.list()[0].toolbarPinned).toBe(true)
    expect(h.registry().extensions[0].toolbarPinned).toBe(true)
    h.ext.setToolbarPinned(ID, true)
    h.ext.setToolbarPinned('not-installed', true)
    expect(h.registry().extensions[0].toolbarPinned).toBe(true)
  })

  it('applies the file-URL toggle through reconfigure', async () => {
    const h = await installed()
    await h.ext.setAllowFileAccess(ID, true)
    expect(h.runtime.events).toEqual([`reconfigure ${ID}`])
    expect(h.ext.list()[0].allowFileAccess).toBe(true)
    expect(h.registry().extensions[0].allowFileAccess).toBe(true)
    await h.ext.setAllowFileAccess(ID, true)
    expect(h.runtime.events).toHaveLength(1)
  })

  it('reports the last update check for the management page', async () => {
    const h = await installed()
    expect(h.ext.updateCheck()).toEqual({ lastCheckedAt: null, checking: false })
    await storeFront(h.kt, { update: { crx: crx2, version: '1.1.0' } })
    const check = h.ext.checkForUpdates()
    expect(h.ext.updateCheck().checking).toBe(true)
    await check
    expect(h.ext.updateCheck()).toEqual({ lastCheckedAt: h.clock.now, checking: false })
  })

  it('points a drop at the file picker: Android hands over content, not paths', async () => {
    const h = await installed()
    const requests = h.kt.requests.length
    await h.ext.installFromDrop(['/sdcard/Download/sample.crx'], WIN)
    expect(h.toasts.at(-1)).toEqual({
      message: 'Use "Install from file" to add a .crx or .zip here.',
      kind: 'info'
    })
    expect(h.kt.requests).toHaveLength(requests)
    expect(h.ext.list()).toHaveLength(1)
  })

  it('opens the options page in a tab', async () => {
    const h = await installed()
    h.ext.openOptions(ID, WIN)
    expect(h.opened).toEqual([`chrome-extension://${ID}/options.html`])
  })

  it('routes new tabs to the override page once opted in, on the origin a tab serves', async () => {
    const h = harness()
    const crx = await buildCrx({
      zip: sampleExtensionZip({
        name: 'New Tab',
        version: '1.0.0',
        chrome_url_overrides: { newtab: 'newtab.html' }
      }),
      rsaKeys: [key]
    })
    await storeFront(h.kt, { cws: crx })
    await h.ext.installFromStore(ID, null)
    // Declared is not opted in: the record carries the page, the browser keeps its own new tab.
    expect(h.ext.list()[0].newTabPage).toBe('newtab.html')
    expect(h.ext.newTabUrl()).toBeNull()
    h.ext.setNewTabOverride(ID, true)
    expect(h.ext.newTabUrl()).toBe(`https://${ID}.ext.zenium.invalid/newtab.html`)
    expect(h.registry().extensions[0].newTabOverride).toBe(true)
    // Disabled, the page is not served: back to the browser's own.
    await h.ext.setEnabled(ID, false)
    expect(h.ext.newTabUrl()).toBeNull()
    await h.ext.setEnabled(ID, true)
    expect(h.ext.newTabUrl()).toBe(`https://${ID}.ext.zenium.invalid/newtab.html`)
    h.ext.setNewTabOverride(ID, false)
    expect(h.ext.newTabUrl()).toBeNull()
  })

  it('shows the browser new tab while the override extension failed to attach', async () => {
    const h = harness()
    const crx = await buildCrx({
      zip: sampleExtensionZip({
        name: 'New Tab',
        version: '1.0.0',
        chrome_url_overrides: { newtab: 'newtab.html' }
      }),
      rsaKeys: [key]
    })
    await storeFront(h.kt, { cws: crx })
    h.runtime.refuse = () => 'no worker'
    await h.ext.installFromStore(ID, null)
    h.ext.setNewTabOverride(ID, true)
    expect(h.ext.list()[0].error).toBe('no worker')
    expect(h.ext.newTabUrl()).toBeNull()
  })

  it('comes back from the registry on the next start and attaches what is enabled', async () => {
    const h = await installed()
    await h.ext.setEnabled(ID, false)
    h.ext.flushSync()
    const document = h.files.get('extensions.json')
    const next = harness({ registry: document })
    // The files Kotlin unpacked are still there for the next process.
    for (const [dir, request] of h.kt.installed) next.kt.installed.set(dir, request)
    expect(next.ext.list()[0]).toMatchObject({ id: ID, enabled: false, version: '1.0.0' })
    await next.ext.start()
    expect(next.runtime.events).toEqual([])
    await next.ext.setEnabled(ID, true)
    expect(next.runtime.events).toEqual([`attach ${ID} 1.0.0`])
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The manifest on disk was read back for the list.
    expect(next.ext.list()[0].name).toBe('Sample')
  })

  it('names the enabled extensions to the runtime at construction and closes the list when the start is over', async () => {
    const h = await installed()
    h.ext.flushSync()
    const document = JSON.parse(h.files.get('extensions.json') ?? '{}') as {
      extensions: ExtensionRecord[]
    }
    const [first] = document.extensions
    const OTHER = 'b'.repeat(32)
    const DISABLED = 'c'.repeat(32)
    document.extensions.push(
      { ...first, id: OTHER, path: first.path.replace(ID, OTHER) },
      { ...first, id: DISABLED, path: first.path.replace(ID, DISABLED), enabled: false }
    )
    const next = harness({ registry: JSON.stringify(document) })
    for (const [dir, request] of h.kt.installed) next.kt.installed.set(dir, request)
    // The constructor runs before the browser restores its windows: the runtime hears which
    // origins to hold a restored tab's page for before any tab can ask, and before any attach.
    expect(next.runtime.timeline).toEqual([`expect ${ID},${OTHER}`])
    next.runtime.refuse = (record) => (record.id === OTHER ? 'no worker' : null)
    await next.ext.start()
    // Once every attach settled, the failed one included, nothing more is coming: a page still
    // held for the extension that did not come up fails.
    expect(next.runtime.timeline).toEqual([
      `expect ${ID},${OTHER}`,
      `attach ${ID}`,
      `attach ${OTHER}`,
      'expect '
    ])
    expect(next.ext.list().find((info) => info.id === OTHER)?.error).toBe('no worker')
  })

  it('ignores a registry that is not one', () => {
    expect(harness({ registry: 'not json' }).ext.list()).toEqual([])
    expect(harness({ registry: '{"version":7,"extensions":"x"}' }).ext.list()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

describe('AndroidExtensions: updates', () => {
  async function installed(front: StoreFront): Promise<Harness> {
    const h = harness()
    await storeFront(h.kt, { cws: crx1 })
    await h.ext.installFromStore(ID, null)
    await storeFront(h.kt, front)
    h.runtime.events.length = 0
    h.toasts.length = 0
    h.prompts.length = 0
    h.kt.requests.length = 0
    return h
  }

  it('asks the store with the installed version and installs what it offers, hash verified', async () => {
    const h = await installed({ update: { crx: crx2, version: '1.1.0' } })
    const oldDir = `${h.kt.root}/${ID}/1.0.0`
    h.clock.now += 60_000
    await h.ext.checkForUpdates()

    const [check] = updateChecks(h.kt)
    const url = new URL(check)
    expect(url.hostname).toBe(CWS_HOST)
    expect(url.searchParams.get('prodversion')).toBe('152.0.0.0')
    expect(url.searchParams.get('x')).toContain(`id=${ID}&v=1.0.0`)
    expect(h.kt.requests.some((u) => u.startsWith(`https://${CDN_HOST}/${ID}.crx`))).toBe(true)

    // Silent: no prompt, the runtime swapped versions, the old directory went.
    expect(h.prompts).toEqual([])
    expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`])
    expect(h.kt.dirsOf(ID)).toEqual([`${h.kt.root}/${ID}/1.1.0`])
    expect(h.kt.calledWith('extStore.prune')).toEqual([
      { id: ID, keep: `${h.kt.root}/${ID}/1.1.0` }
    ])
    expect(h.kt.installed.has(oldDir)).toBe(false)
    expect(h.kt.packages.size).toBe(0)

    const [info] = h.ext.list()
    expect(info).toMatchObject({
      version: '1.1.0',
      enabled: true,
      updateState: 'up-to-date',
      availableVersion: null,
      updateError: null,
      updateCheckedAt: h.clock.now,
      installedAt: h.clock.now - 60_000,
      updatedAt: h.clock.now
    })
    const registry = h.registry()
    expect(registry.lastUpdateCheck).toBe(h.clock.now)
    expect(registry.extensions[0].version).toBe('1.1.0')
    expect(h.toasts).toEqual([])
  })

  it('reports up to date when the store has nothing newer', async () => {
    const h = await installed({ update: 'noupdate' })
    await h.ext.checkForUpdates(WIN)
    expect(h.ext.list()[0]).toMatchObject({ version: '1.0.0', updateState: 'up-to-date' })
    expect(h.runtime.events).toEqual([])
    expect(h.toasts).toEqual([{ message: 'All extensions are up to date.', kind: 'info' }])
  })

  it('refuses a package that does not match the announced hash', async () => {
    const h = await installed({
      update: { crx: crx2, version: '1.1.0', sha256: '0'.repeat(64) }
    })
    await h.ext.checkForUpdates(WIN)
    expect(h.ext.list()[0]).toMatchObject({
      version: '1.0.0',
      updateState: 'error',
      availableVersion: '1.1.0'
    })
    expect(h.ext.list()[0].updateError).toContain('does not match the hash')
    expect(h.runtime.events).toEqual([])
    expect(h.kt.dirsOf(ID)).toEqual([`${h.kt.root}/${ID}/1.0.0`])
    expect(h.kt.packages.size).toBe(0)
    expect(h.toasts).toEqual([{ message: 'An extension update failed.', kind: 'error' }])
  })

  it('records a store that does not answer as an error and tries again later', async () => {
    const h = await installed({})
    await h.ext.checkForUpdates()
    expect(h.ext.list()[0]).toMatchObject({ updateState: 'error', updateError: 'http' })
    expect(h.registry().lastUpdateCheck).toBe(h.clock.now)
  })

  it('installs an update that asks for more, but leaves it disabled until approved', async () => {
    const h = await installed({ update: { crx: crx2WithTabs, version: '1.1.0' } })
    await h.ext.checkForUpdates()
    const added = permissionWarningLines({ manifest_version: 3, permissions: ['tabs'] }, 'other')
    expect(added.length).toBeGreaterThan(0)
    const [info] = h.ext.list()
    expect(info).toMatchObject({
      version: '1.1.0',
      enabled: false,
      pendingWarnings: added,
      updateState: 'up-to-date'
    })
    // The new version was attached as the old one's replacement and then taken down again.
    expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`, `detach ${ID}`])
    expect(h.registry().extensions[0]).toMatchObject({ enabled: false, pendingWarnings: added })

    // Enabling asks about the new permissions first; declining changes nothing.
    h.answer(false)
    await h.ext.setEnabled(ID, true)
    expect(h.prompts).toEqual([
      {
        kind: 'permissions',
        name: 'Sample',
        icon: null,
        warnings: added,
        source: 'chrome-web-store'
      }
    ])
    expect(h.ext.list()[0]).toMatchObject({ enabled: false, pendingWarnings: added })

    h.answer(true)
    await h.ext.setEnabled(ID, true)
    expect(h.ext.list()[0]).toMatchObject({ enabled: true, pendingWarnings: null })
    expect(h.runtime.events.at(-1)).toBe(`attach ${ID} 1.1.0`)
    expect(h.registry().extensions[0].pendingWarnings).toBeNull()
  })

  it('keeps the running version when the runtime refuses the update', async () => {
    const h = await installed({ update: { crx: crx2, version: '1.1.0' } })
    h.runtime.refuse = (record) => (record.version === '1.1.0' ? 'runtime refused 1.1.0' : null)
    await h.ext.checkForUpdates()
    expect(h.ext.record(ID)?.version).toBe('1.0.0')
    expect(h.ext.record(ID)?.path).toBe(`${h.kt.root}/${ID}/1.0.0`)
    expect(h.ext.list()[0]).toMatchObject({
      updateState: 'error',
      availableVersion: '1.1.0',
      updateError: 'runtime refused 1.1.0',
      error: null
    })
    expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`, `attach ${ID} 1.0.0`])
    expect(h.kt.dirsOf(ID)).toEqual([`${h.kt.root}/${ID}/1.0.0`])
    expect(h.registry().extensions[0].version).toBe('1.0.0')
  })

  it('checks one extension on request and says what happened', async () => {
    const h = await installed({ update: { crx: crx2, version: '1.1.0' } })
    await h.ext.update(ID, WIN)
    expect(h.ext.record(ID)?.version).toBe('1.1.0')
    expect(h.toasts).toEqual([{ message: 'Updated 1 extension.', kind: 'info' }])
  })

  it('runs one check at a time', async () => {
    const h = await installed({ update: 'noupdate' })
    await Promise.all([h.ext.checkForUpdates(), h.ext.checkForUpdates()])
    expect(updateChecks(h.kt)).toHaveLength(1)
  })

  describe('runtime.requestUpdateCheck', () => {
    it('installs the update it finds and says so with the version; the found update resets the throttle', async () => {
      const h = await installed({ update: { crx: crx2, version: '1.1.0' } })
      await expect(h.ext.requestUpdateCheck(ID)).resolves.toEqual({
        status: 'update_available',
        version: '1.1.0'
      })
      expect(h.ext.record(ID)?.version).toBe('1.1.0')
      expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`])
      // An extension's ask about itself is not the chrome's "checked for updates" stamp.
      expect(h.registry().lastUpdateCheck).toBeNull()
      expect(h.ext.updateCheck()).toEqual({ lastCheckedAt: null, checking: false })
      expect(h.toasts).toEqual([])
      // Straight after an update the next ask reaches the server again (Chrome resets its backoff).
      await expect(h.ext.requestUpdateCheck(ID)).resolves.toEqual({ status: 'no_update' })
      expect(updateChecks(h.kt)).toHaveLength(2)
    })

    it('answers no_update from the server and throttles the next ask for five hours', async () => {
      const h = await installed({ update: 'noupdate' })
      await expect(h.ext.requestUpdateCheck(ID)).resolves.toEqual({ status: 'no_update' })
      expect(updateChecks(h.kt)).toHaveLength(1)
      h.clock.now += REQUEST_UPDATE_CHECK_THROTTLE_MS - 1
      await expect(h.ext.requestUpdateCheck(ID)).resolves.toEqual({ status: 'throttled' })
      expect(updateChecks(h.kt)).toHaveLength(1)
      h.clock.now += 1
      await expect(h.ext.requestUpdateCheck(ID)).resolves.toEqual({ status: 'no_update' })
      expect(updateChecks(h.kt)).toHaveLength(2)
    })

    it('is no_update when the server does not answer, and for an extension with nothing to update from', async () => {
      const h = await installed({})
      await expect(h.ext.requestUpdateCheck(ID)).resolves.toEqual({ status: 'no_update' })
      expect(updateChecks(h.kt)).toHaveLength(1)
      const pinned = await installed({ update: { crx: crx2, version: '1.1.0' } })
      pinned.ext.setPinned(ID, true)
      await expect(pinned.ext.requestUpdateCheck(ID)).resolves.toEqual({ status: 'no_update' })
      expect(updateChecks(pinned.kt)).toEqual([])
      expect(pinned.ext.record(ID)?.version).toBe('1.0.0')
      await expect(pinned.ext.requestUpdateCheck('not-installed')).resolves.toEqual({
        status: 'no_update'
      })
    })

    it('joins an ask in flight and a registry-wide check that covers the extension: one request', async () => {
      const h = await installed({ update: 'noupdate' })
      const asks = await Promise.all([h.ext.requestUpdateCheck(ID), h.ext.requestUpdateCheck(ID)])
      expect(asks).toEqual([{ status: 'no_update' }, { status: 'no_update' }])
      expect(updateChecks(h.kt)).toHaveLength(1)

      const later = await installed({ update: { crx: crx2, version: '1.1.0' } })
      const all = later.ext.checkForUpdates()
      await expect(later.ext.requestUpdateCheck(ID)).resolves.toEqual({
        status: 'update_available',
        version: '1.1.0'
      })
      await all
      expect(updateChecks(later.kt)).toHaveLength(1)
      expect(later.ext.record(ID)?.version).toBe('1.1.0')
      // The other way round, the registry-wide check waits for the extension's own ask (no two
      // installs of one extension side by side), then asks about everything.
      const own = await installed({ update: 'noupdate' })
      const ask = own.ext.requestUpdateCheck(ID)
      await own.ext.checkForUpdates(WIN)
      await expect(ask).resolves.toEqual({ status: 'no_update' })
      expect(updateChecks(own.kt)).toHaveLength(2)
      expect(own.toasts).toEqual([{ message: 'All extensions are up to date.', kind: 'info' }])
    })
  })

  describe('an update the runtime would delay (runtime.onUpdateAvailable)', () => {
    /** Installed 1.0.0 and busy; the store offers 1.1.0 (or the package given). */
    async function busy(crx: Uint8Array = crx2): Promise<Harness> {
      const h = await installed({ update: { crx, version: '1.1.0' } })
      h.runtime.busy.add(ID)
      return h
    }

    it('stages the download next to the running version, raises onUpdateAvailable and answers requestUpdateCheck from the staged version', async () => {
      const h = await busy()
      await h.ext.checkForUpdates()
      // Downloaded and unpacked, but nothing swapped: the running version runs on.
      expect(h.runtime.events).toEqual([])
      expect(h.runtime.updatesAvailable).toEqual([{ id: ID, version: '1.1.0' }])
      expect(h.kt.dirsOf(ID).sort()).toEqual([
        `${h.kt.root}/${ID}/1.0.0`,
        `${h.kt.root}/${ID}/1.1.0`
      ])
      expect(h.kt.packages.size).toBe(0)
      expect(h.ext.record(ID)).toMatchObject({
        version: '1.0.0',
        path: `${h.kt.root}/${ID}/1.0.0`,
        staged: {
          version: '1.1.0',
          path: `${h.kt.root}/${ID}/1.1.0`,
          // The package's signer, as an update installed at once records it.
          publisher: 'unknown',
          fields: { version: '1.1.0', name: 'Sample' },
          addedWarnings: [],
          stagedAt: h.clock.now
        }
      })
      expect(h.ext.list()[0]).toMatchObject({
        version: '1.0.0',
        updateState: 'available',
        availableVersion: '1.1.0',
        updateError: null
      })
      expect(h.registry().extensions[0].staged).toMatchObject({ version: '1.1.0' })
      // The extension asking about itself hears of the pending version without a request.
      const checks = updateChecks(h.kt).length
      await expect(h.ext.requestUpdateCheck(ID)).resolves.toEqual({
        status: 'update_available',
        version: '1.1.0'
      })
      expect(updateChecks(h.kt)).toHaveLength(checks)
      // Another scheduled check does not download the staged version again.
      h.kt.requests.length = 0
      await h.ext.checkForUpdates()
      expect(h.kt.requests.filter((u) => u.startsWith(`https://${CDN_HOST}/`))).toEqual([])
      expect(h.ext.list()[0]).toMatchObject({ updateState: 'available', availableVersion: '1.1.0' })
      expect(h.runtime.updatesAvailable).toHaveLength(1)
    })

    it('lands when the extension goes idle, unless the runtime still delays it', async () => {
      const h = await busy()
      await h.ext.checkForUpdates()
      // Idle said while the runtime would still delay (a page reopened meanwhile): nothing.
      h.ext.idle(ID)
      await settle()
      expect(h.runtime.events).toEqual([])
      expect(h.ext.record(ID)?.version).toBe('1.0.0')

      h.runtime.busy.delete(ID)
      h.ext.idle(ID)
      await settle()
      expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`])
      expect(h.ext.record(ID)).toMatchObject({
        version: '1.1.0',
        path: `${h.kt.root}/${ID}/1.1.0`,
        enabled: true,
        pendingWarnings: null
      })
      expect(h.ext.record(ID)?.staged).toBeUndefined()
      expect(h.kt.calledWith('extStore.prune')).toEqual([
        { id: ID, keep: `${h.kt.root}/${ID}/1.1.0` }
      ])
      expect(h.kt.dirsOf(ID)).toEqual([`${h.kt.root}/${ID}/1.1.0`])
      expect(h.ext.list()[0]).toMatchObject({
        version: '1.1.0',
        updateState: 'up-to-date',
        availableVersion: null
      })
      expect(h.registry().extensions[0]).toMatchObject({ version: '1.1.0' })
      expect(h.registry().extensions[0].staged).toBeUndefined()
    })

    it("lands at runtime.reload(), the extension's answer to onUpdateAvailable", async () => {
      const h = await busy()
      await h.ext.checkForUpdates()
      await h.ext.reload(ID)
      // The reload is the swap: one detach of the old version, one attach of the new.
      expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`])
      expect(h.ext.record(ID)?.version).toBe('1.1.0')
      expect(h.kt.dirsOf(ID)).toEqual([`${h.kt.root}/${ID}/1.1.0`])
    })

    it('lands when the user disables the extension, and when the user asks for the update', async () => {
      const h = await busy()
      await h.ext.checkForUpdates()
      await h.ext.setEnabled(ID, false)
      await settle()
      // The disable made it idle: the new version is the record's, and stays off as asked.
      expect(h.runtime.events).toEqual([`detach ${ID}`])
      expect(h.ext.record(ID)).toMatchObject({ version: '1.1.0', enabled: false })
      expect(h.ext.record(ID)?.staged).toBeUndefined()

      const asked = await busy()
      await asked.ext.checkForUpdates()
      asked.kt.requests.length = 0
      await asked.ext.update(ID, WIN)
      expect(asked.ext.record(ID)?.version).toBe('1.1.0')
      expect(asked.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`])
      expect(asked.kt.requests).toEqual([])
      expect(asked.toasts).toEqual([{ message: 'Updated 1 extension.', kind: 'info' }])
    })

    it('lands at the next start, before the extension is attached', async () => {
      const h = await busy()
      await h.ext.checkForUpdates()
      const document = h.files.get('extensions.json')
      h.ext.flushSync()
      const next = harness({ registry: h.files.get('extensions.json') ?? document })
      for (const [dir, request] of h.kt.installed) next.kt.installed.set(dir, request)
      await next.ext.start()
      expect(next.runtime.events).toEqual([`attach ${ID} 1.1.0`])
      expect(next.ext.record(ID)).toMatchObject({
        version: '1.1.0',
        path: `${next.kt.root}/${ID}/1.1.0`
      })
      expect(next.ext.record(ID)?.staged).toBeUndefined()
      expect(next.kt.calledWith('extStore.prune')).toEqual([
        { id: ID, keep: `${next.kt.root}/${ID}/1.1.0` }
      ])
      expect(next.ext.list()[0]).toMatchObject({ version: '1.1.0', updateState: 'unknown' })
    })

    it("the user's own check installs at once, busy or not", async () => {
      const h = await busy()
      await h.ext.checkForUpdates(WIN)
      expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`])
      expect(h.runtime.updatesAvailable).toEqual([])
      expect(h.ext.record(ID)?.staged).toBeUndefined()
      expect(h.toasts).toEqual([{ message: 'Updated 1 extension.', kind: 'info' }])
    })

    it('a staged update that asks for more lands disabled with the warnings pending', async () => {
      const h = await busy(crx2WithTabs)
      await h.ext.checkForUpdates()
      const added = permissionWarningLines({ manifest_version: 3, permissions: ['tabs'] }, 'other')
      expect(h.ext.record(ID)?.staged).toMatchObject({ version: '1.1.0', addedWarnings: added })
      h.runtime.busy.delete(ID)
      h.ext.idle(ID)
      await settle()
      // Never attached: Chrome installs a delayed permission increase disabled.
      expect(h.runtime.events).toEqual([`detach ${ID}`])
      expect(h.ext.record(ID)).toMatchObject({
        version: '1.1.0',
        enabled: false,
        pendingWarnings: added
      })
      expect(h.ext.list()[0]).toMatchObject({ enabled: false, pendingWarnings: added })
      h.answer(true)
      await h.ext.setEnabled(ID, true)
      expect(h.runtime.events.at(-1)).toBe(`attach ${ID} 1.1.0`)
      expect(h.ext.record(ID)?.pendingWarnings).toBeNull()
    })

    it('keeps the running version when the runtime refuses the staged one as it lands', async () => {
      const h = await busy()
      await h.ext.checkForUpdates()
      h.runtime.refuse = (record) => (record.version === '1.1.0' ? 'runtime refused 1.1.0' : null)
      h.runtime.busy.delete(ID)
      h.ext.idle(ID)
      await settle()
      expect(h.runtime.events).toEqual([`detach ${ID}`, `attach ${ID} 1.1.0`, `attach ${ID} 1.0.0`])
      expect(h.ext.record(ID)).toMatchObject({ version: '1.0.0', path: `${h.kt.root}/${ID}/1.0.0` })
      expect(h.ext.record(ID)?.staged).toBeUndefined()
      expect(h.kt.dirsOf(ID)).toEqual([`${h.kt.root}/${ID}/1.0.0`])
      expect(h.ext.list()[0]).toMatchObject({
        updateState: 'error',
        availableVersion: '1.1.0',
        updateError: 'runtime refused 1.1.0',
        error: null
      })
    })

    it('an install over the staged update supersedes it', async () => {
      const h = await busy()
      await h.ext.checkForUpdates()
      await h.ext.installHandle(h.kt.hold('sample.crx', crx2))
      expect(h.ext.record(ID)?.staged).toBeUndefined()
      expect(h.ext.record(ID)?.version).toBe('1.1.0')
      expect(h.kt.dirsOf(ID)).toHaveLength(1)
    })
  })

  it('follows the schedule only while the app is in the foreground', async () => {
    const h = await installed({ update: 'noupdate' })
    await h.ext.start()
    expect(h.timeouts.map((t) => t.ms)).toEqual([UPDATE_CHECK_STARTUP_DELAY_MS])
    expect(h.intervals.map((t) => t.ms)).toEqual([UPDATE_CHECK_INTERVAL_MS])

    h.timeouts[0].fn()
    await settle()
    expect(updateChecks(h.kt)).toHaveLength(1)

    // In the background the interval only notes that a check is due.
    h.ext.setForeground(false)
    h.intervals[0].fn()
    await settle()
    expect(updateChecks(h.kt)).toHaveLength(1)

    // Coming back runs the missed check once.
    h.ext.setForeground(true)
    await settle()
    expect(updateChecks(h.kt)).toHaveLength(2)
    h.ext.setForeground(true)
    await settle()
    expect(updateChecks(h.kt)).toHaveLength(2)

    // In the foreground the interval checks straight away.
    h.intervals[0].fn()
    await settle()
    expect(updateChecks(h.kt)).toHaveLength(3)
  })

  it('has nothing to check for a registry of pinned and sideloaded extensions', async () => {
    const h = harness()
    await h.ext.installHandle(
      h.kt.hold(
        'a.zip',
        buildZip([
          { name: 'manifest.json', data: '{"manifest_version":3,"name":"A","version":"1"}' }
        ])
      )
    )
    await h.ext.checkForUpdates(WIN)
    expect(h.toasts.at(-1)).toEqual({
      message: 'No installed extension can be updated.',
      kind: 'info'
    })
    expect(h.kt.requests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The bridge half and the helpers
// ---------------------------------------------------------------------------

describe('AndroidExtensionStoreIo', () => {
  it('reads update responses through a temporary file that goes at once', async () => {
    const kt = new FakeKotlinStore()
    kt.route = () => ({ status: 200, body: '<gupdate/>' })
    const io = kt.io()
    const response = await io.fetchText('https://example.test/update')
    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(response.bytes)).toBe('<gupdate/>')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(kt.packages.size).toBe(0)
    expect(kt.calledWith('extStore.fetch')).toEqual([
      { url: 'https://example.test/update', maxBytes: 256 * 1024 * 1024 }
    ])
  })

  it('keeps a downloaded package until it is released', async () => {
    const kt = new FakeKotlinStore()
    kt.route = () => ({ status: 200, body: new Uint8Array([1, 2, 3]) })
    const io = kt.io()
    const response = await io.fetchPackage('https://example.test/p.crx')
    expect(kt.packages.size).toBe(1)
    const token = io.tokenOf(response.bytes)
    expect(token).toBeDefined()
    io.release(response.bytes)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(kt.packages.size).toBe(0)
    expect(io.tokenOf(response.bytes)).toBeUndefined()
    io.release(response.bytes)
  })

  it('answers a status without a body with empty bytes', async () => {
    const kt = new FakeKotlinStore()
    kt.route = () => ({ status: 204 })
    const response = await kt.io().fetchPackage('https://example.test/none')
    expect(response).toEqual({
      status: 204,
      url: 'https://example.test/none',
      bytes: new Uint8Array(0)
    })
  })

  it('only reads installed files under the root', async () => {
    const kt = new FakeKotlinStore()
    const io = kt.io()
    kt.installed.set(`${kt.root}/${'a'.repeat(32)}/1.0`, {
      token: 'x',
      zipOffset: 0,
      id: 'a'.repeat(32),
      version: '1.0',
      rootPrefix: '',
      files: ['manifest.json'],
      directories: [],
      manifest: '{"name":"A"}',
      totalSize: 12
    })
    const bytes = await io.readInstalledFile(`${kt.root}/${'a'.repeat(32)}/1.0`, 'manifest.json')
    expect(bytes && new TextDecoder().decode(bytes)).toBe('{"name":"A"}')
    expect(await io.readInstalledFile('/sdcard/Download/ext', 'manifest.json')).toBeNull()
    expect(await io.readInstalledFile(`${kt.root}/${'a'.repeat(32)}/1.0`, 'icon.png')).toBeNull()
  })

  it('refuses to unpack bytes it did not hand out', async () => {
    const kt = new FakeKotlinStore()
    const pkg = await installFromCrx(crx1)
    await expect(kt.io().unpack(crx1, pkg, ZIP_OFFSET, null)).rejects.toThrow(
      'The package file is no longer available'
    )
  })
})

describe('the version the stores are told about', () => {
  it('is the WebView Chromium when newer than the floor, else the floor', () => {
    expect(
      storeChromiumVersion(
        'Mozilla/5.0 (Linux; Android 14) Chrome/113.0.5672.136 Mobile Safari/537.36'
      )
    ).toBe('152.0.0.0')
    expect(storeChromiumVersion('Mozilla/5.0 Chrome/160.0.7000.12 Mobile Safari/537.36')).toBe(
      '160.0.7000.12'
    )
    expect(storeChromiumVersion('Chrome/152.0.1.0')).toBe('152.0.1.0')
    expect(storeChromiumVersion('Chrome/152')).toBe('152.0.0.0')
    expect(storeChromiumVersion('Chrome/153')).toBe('153.0.0.0')
    expect(storeChromiumVersion('Node.js/22')).toBe('152.0.0.0')
    expect(storeChromiumVersion('Chrome/113', '100.0.0.0')).toBe('113.0.0.0')
  })
})

describe('ids for records without one', () => {
  it('are stable extension ids that differ by path', () => {
    const a = idForUnpackedPath('/data/user/0/app/files/zen/extensions/legacy')
    expect(a).toMatch(/^[a-p]{32}$/)
    expect(idForUnpackedPath('/data/user/0/app/files/zen/extensions/legacy')).toBe(a)
    expect(idForUnpackedPath('/data/user/0/app/files/zen/extensions/other')).not.toBe(a)
  })
})
