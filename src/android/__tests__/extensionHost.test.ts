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
  /** A reason to refuse a record, or null to run it. */
  refuse: (record: ExtensionRecord) => string | null = () => null

  async attach(record: ExtensionRecord): Promise<void> {
    this.events.push(`attach ${record.id} ${record.version}`)
    const reason = this.refuse(record)
    if (reason) throw new Error(reason)
  }

  async detach(id: string): Promise<void> {
    this.events.push(`detach ${id}`)
  }

  async reconfigure(record: ExtensionRecord): Promise<void> {
    this.events.push(`reconfigure ${record.id}`)
  }
}

interface Harness {
  kt: FakeKotlinStore
  ext: AndroidExtensions
  runtime: FakeRuntime
  toasts: Array<{ message: string; kind: string }>
  opened: string[]
  dialogs: string[]
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
    // start() collects the queue without waiting for the installs; let them run.
    await settle()
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
})

// ---------------------------------------------------------------------------
// Managing
// ---------------------------------------------------------------------------

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

  it('opens the options page in a tab', async () => {
    const h = await installed()
    h.ext.openOptions(ID, WIN)
    expect(h.opened).toEqual([`chrome-extension://${ID}/options.html`])
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
