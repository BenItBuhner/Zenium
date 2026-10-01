import { expect } from 'vitest'
import type {
  HostCapabilities,
  Platform as PlatformOs,
  SyncDeviceKind
} from '../../../shared/types'
import { Browser } from '../../browser'
import type {
  Platform,
  SecretStore,
  StoreIO,
  SyncFetch,
  SyncPlatformHost,
  SyncTransport,
  TabView,
  TabViewHost,
  WebNotificationHost,
  WindowHost
} from '../../platform'
import type { ZenWindow } from '../../window'
import { FakeKeyWrap } from '../../credentials/__tests__/fakes'
import { SyncEngine } from '../engine'
import { MemoryTransport, isDeviceFileName } from '../transport'
import { isEnvelope, decryptJson } from '../crypto'
import type { SyncRecord } from '../records'
import { parseDocument, type SyncDocumentKind } from '../documents'

/**
 * Two engines, one folder: what the desktop and the phone do once both point at the same
 * cloud-drive directory. The folder is a map shared by two in-memory transports (one per
 * device, like two `FolderTransport`s over one directory); everything else is the real
 * `Browser`, the real credential store, the real history model and the real engine.
 */

export function memoryIo(): StoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {}
  return {
    files,
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

export function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** A fixed 32-byte key per passphrase: the suite is about the engine, scrypt has its own tests. */
const fastScrypt: SyncPlatformHost['scrypt'] = async (passphrase, salt) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array([...passphrase, 0, ...salt]) as Uint8Array<ArrayBuffer>
  )
  return new Uint8Array(digest)
}

/** A transport the suite can take the folder away from (`MemoryTransport.lost`, the folder transport's SAF/path loss). */
export type HarnessTransport = SyncTransport & { lost: boolean }

/**
 * What `device()` hands the engine for a folder: the in-memory folder transport, or – when a
 * suite sets one (`engineWebDav.test.ts`) – another transport over the same folder map, so the
 * convergence scenarios run unchanged over it.
 */
let transportFactory: ((folder: string) => HarnessTransport) | null = null

export function setTransportFactory(factory: ((folder: string) => HarnessTransport) | null): void {
  transportFactory = factory
}

export interface Device {
  name: string
  browser: Browser
  engine: SyncEngine
  host: SyncPlatformHost
  transports: HarnessTransport[]
  toasts: string[]
  win: ZenWindow
  io: StoreIO & { files: Record<string, string> }
  /** The device's keystore: what wraps its vault's key (a restart hands the previous run's in). */
  keys: FakeKeyWrap
  /** What the host was asked to post (a device with a notification shade of its own). */
  notifications: Array<Record<string, unknown>>
}

/** Folders by path: a device's transport sees whatever map its folder path names. */
export const folders = new Map<string, Map<string, string>>()
export const folderFiles = (folder: string): Map<string, string> => {
  let files = folders.get(folder)
  if (!files) {
    files = new Map()
    folders.set(folder, files)
  }
  return files
}

export const devices: Device[] = []

export function device(
  name: string,
  options: {
    pollMs?: number
    /** The device's own files (a restart hands the previous run's in). */
    io?: StoreIO & { files: Record<string, string> }
    /** The device's keystore (a restart hands the previous run's in: the OS keeps it). */
    keys?: FakeKeyWrap
    /** A host that posts notifications itself (Android): what it shows is recorded. */
    notifications?: boolean
    /** What the host says the device is; absent for a host (an older build) that says nothing. */
    kind?: SyncDeviceKind
    /** The host's HTTP for a WebDAV server (ID-32); absent for a host without one (the phone today). */
    fetch?: SyncFetch
    /** The host's secret store (the app password's home); absent for a host without one. */
    secrets?: SecretStore
    /** The host's extensions (a desktop or phone with store installs, ID-44); absent for a host without any. */
    extensions?: Platform['createExtensions']
  } = {}
): Device {
  const transports: HarnessTransport[] = []
  const io = options.io ?? memoryIo()
  const keys = options.keys ?? new FakeKeyWrap()
  const notifications: Array<Record<string, unknown>> = []
  const webNotifications: WebNotificationHost | undefined = options.notifications
    ? {
        show: async (request) => {
          notifications.push(request as unknown as Record<string, unknown>)
          return true
        },
        close: () => undefined,
        forgetOrigin: () => undefined,
        ensureAllowed: async () => true
      }
    : undefined
  const kind = options.kind
  const host: SyncPlatformHost = {
    chooseFolder: async () => '/drive',
    folderName: async (folder) => folder.split('/').pop() ?? folder,
    deviceNameDefault: () => name,
    ...(kind ? { deviceKind: () => kind } : {}),
    createTransport: (folder): SyncTransport => {
      const t = transportFactory
        ? transportFactory(folder)
        : new MemoryTransport(folderFiles(folder))
      transports.push(t)
      return t
    },
    scrypt: fastScrypt,
    pollMs: options.pollMs ?? 0,
    ...(options.fetch ? { fetch: options.fetch } : {})
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({
      windows: false,
      updates: false,
      agents: false,
      sync: true,
      passwords: true
    }),
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: () => stub<TabView>({ isDestroyed: () => false, isVisible: () => false })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    passwords: {
      keys,
      reauth: { available: async () => false, verify: async () => false }
    },
    sync: host,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.extensions ? { createExtensions: options.extensions } : {}),
    readabilitySource: () => null,
    ...(webNotifications ? { webNotifications } : {})
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  const toasts: string[] = []
  const win = stub<ZenWindow>({
    send: ((name: string, payload: unknown) => {
      if (name === 'toast') toasts.push((payload as { message: string }).message)
    }) as ZenWindow['send']
  })
  browser.start()
  const engine = browser.sync as SyncEngine
  expect(engine).toBeInstanceOf(SyncEngine)
  const d: Device = {
    name,
    browser,
    engine,
    host,
    transports,
    toasts,
    win,
    io,
    keys,
    notifications
  }
  devices.push(d)
  return d
}

export async function unlockVault(d: Device): Promise<void> {
  await d.browser.passwords.whenSettled()
  expect((await d.browser.passwords.unlock()).status).toBe('ok')
}

export const PASSPHRASE = 'correct horse battery staple'

export async function setup(d: Device, folder = '/drive', passphrase = PASSPHRASE): Promise<void> {
  await d.engine.setup(
    { folder, passphrase, deviceName: d.name, scope: d.engine.status().scope },
    d.win
  )
}

/** The folder's key for `PASSPHRASE` and `salt` (what every device derives). */
export async function folderKey(salt: string): Promise<Uint8Array> {
  return fastScrypt!(new TextEncoder().encode(PASSPHRASE), Buffer.from(salt, 'base64'), {
    N: 1,
    r: 1,
    p: 1,
    dkLen: 32
  })
}

/** Decrypt a device's own file the way another device with the key would. */
export async function published(d: Device, folder = '/drive'): Promise<SyncRecord[]> {
  const files = folderFiles(folder)
  const own = [...files.entries()].find(
    ([name]) => isDeviceFileName(name) && name.includes(d.engine.status().deviceId)
  )
  expect(own).toBeDefined()
  const file = JSON.parse(own![1]) as { envelope: unknown }
  expect(isEnvelope(file.envelope)).toBe(true)
  const key = await folderKey((file.envelope as { salt: string }).salt)
  const payload = await decryptJson<{ v: 1; records: SyncRecord[] }>(
    key,
    file.envelope as Parameters<typeof decryptJson>[1]
  )
  return payload.records
}

/**
 * Every device file the folder holds NOW, decrypted, by the device id its name carries: what a
 * peer reading the folder at this moment would find on the wire. The folder is the current
 * map – a file is overwritten at each of its device's rounds – so a claim about what was ever
 * on the wire is made by calling this at each checkpoint, not once at the end.
 */
export async function publishedAll(folder = '/drive'): Promise<Map<string, SyncRecord[]>> {
  const out = new Map<string, SyncRecord[]>()
  for (const [name, text] of folderFiles(folder)) {
    if (!isDeviceFileName(name)) continue
    const file = JSON.parse(text) as { deviceId: string; envelope: unknown }
    expect(isEnvelope(file.envelope)).toBe(true)
    const key = await folderKey((file.envelope as { salt: string }).salt)
    const payload = await decryptJson<{ v: 1; records: SyncRecord[] }>(
      key,
      file.envelope as Parameters<typeof decryptJson>[1]
    )
    out.set(file.deviceId, payload.records)
  }
  return out
}

/** Every readable document of one kind a device wrote (its payload decrypted), by file name. */
export async function documents<T>(
  d: Device,
  kind: SyncDocumentKind,
  folder = '/drive'
): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  const id = d.engine.status().deviceId
  for (const [name, text] of folderFiles(folder)) {
    if (!name.endsWith('.zenpage') || !name.startsWith(id)) continue
    const doc = parseDocument(text)
    if (!doc || doc.kind !== kind) continue
    out.set(name, await decryptJson<T>(await folderKey(doc.envelope.salt), doc.envelope))
  }
  return out
}

/** Disconnect every device and empty the folders (each test's `afterEach`). */
export function teardown(): void {
  for (const d of devices.splice(0)) d.engine.disconnect(false)
  folders.clear()
}
