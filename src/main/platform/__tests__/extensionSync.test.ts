import { describe, expect, it } from 'vitest'
import type { ExtensionPackage } from '../../../core/extensions/install'
import type { StoreId } from '../../../core/extensions/store'
import type { SyncedExtensionChange } from '../../../core/platform'
import {
  ExtensionSyncApplier,
  SYNC_INSTALL_BACKOFF_MAX_MS,
  SYNC_INSTALL_BACKOFF_MIN_MS,
  approvalPrompt,
  awaitsApproval,
  syncInstallBackoffMs,
  syncedRemovalToast,
  type ExtensionSyncHost,
  type SyncedExtensionRecord
} from '../extensionSync'
import { StartupHold } from '../startupHold'

const ID_A = 'abcdefghijklmnopabcdefghijklmnop'
const ID_B = 'ppppoooonnnnmmmmllllkkkkjjjjiiii'
const ID_C = 'cccccccccccccccccccccccccccccccc'

const HOUR = 60 * 60 * 1000

function record(
  id: string,
  source: SyncedExtensionRecord['source'],
  opts: Partial<Omit<SyncedExtensionRecord, 'id' | 'source'>> = {}
): SyncedExtensionRecord {
  return {
    id,
    name: `Extension ${id.slice(0, 4)}`,
    source,
    enabled: opts.enabled ?? true,
    toolbarPinned: opts.toolbarPinned ?? false,
    pendingWarnings: opts.pendingWarnings ?? null,
    ...(opts.pendingApproval ? { pendingApproval: true } : {})
  }
}

const live = (
  id: string,
  data: { store?: StoreId; enabled?: boolean; toolbarPinned?: boolean } = {},
  from: string | null = 'Desk (Linux)'
): SyncedExtensionChange => ({
  id,
  data: {
    store: data.store ?? 'chrome-web-store',
    enabled: data.enabled ?? true,
    toolbarPinned: data.toolbarPinned ?? false
  },
  from
})
const tombstone = (id: string, from: string | null = 'Desk (Linux)'): SyncedExtensionChange => ({
  id,
  data: null,
  from
})

/** A download the test settles by hand: the store's answer, when the test says so. */
interface Download {
  id: string
  store: StoreId
  land: () => void
  fail: (message: string) => void
}

/**
 * The service's paths as a ledger: every call recorded, the registry a map, the downloads
 * promises the test settles, the clock the test's own.
 */
class FakeHost implements ExtensionSyncHost {
  readonly registry = new Map<string, SyncedExtensionRecord>()
  readonly busyIds = new Set<string>()
  readonly calls: string[] = []
  readonly errors: string[] = []
  readonly downloads: Download[] = []
  readonly toasts: Array<{ name: string; store: StoreId; from: string | null }> = []
  clock = 1_000_000
  hold: { run(fn: () => void): void } | null = null
  /** Downloads settle themselves: landed (`'ok'`), or failed with the message. */
  auto: 'ok' | 'manual' | string = 'ok'

  record(id: string): SyncedExtensionRecord | undefined {
    return this.registry.get(id)
  }

  busy(id: string): boolean {
    return this.busyIds.has(id)
  }

  download(id: string, store: StoreId): Promise<{ pkg: ExtensionPackage; store: StoreId }> {
    this.calls.push(`download ${id.slice(0, 4)} ${store}`)
    return new Promise((resolve, reject) => {
      const entry: Download = {
        id,
        store,
        land: () => resolve({ pkg: { id } as unknown as ExtensionPackage, store }),
        fail: (message) => reject(new Error(message))
      }
      this.downloads.push(entry)
      if (this.auto === 'ok') entry.land()
      else if (this.auto !== 'manual') entry.fail(this.auto)
    })
  }

  async install(
    pkg: ExtensionPackage,
    store: StoreId,
    toolbarPinned: boolean
  ): Promise<'installed' | 'in-progress'> {
    const id = (pkg as unknown as { id: string }).id
    this.calls.push(`install ${id.slice(0, 4)} ${store} ${toolbarPinned ? 'pinned' : 'unpinned'}`)
    if (this.registry.has(id) || this.busyIds.has(id)) return 'in-progress'
    // The synced landing as `ExtensionService.installPackage` writes it: off, pending, pinned
    // as the record says – never loaded.
    this.registry.set(
      id,
      record(id, store, { enabled: false, toolbarPinned, pendingApproval: true })
    )
    return 'installed'
  }

  async remove(id: string): Promise<void> {
    this.calls.push(`remove ${id.slice(0, 4)}`)
    this.registry.delete(id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.calls.push(`setEnabled ${id.slice(0, 4)} ${enabled ? 'on' : 'off'}`)
    const have = this.registry.get(id)
    if (have) this.registry.set(id, { ...have, enabled })
  }

  setToolbarPinned(id: string, pinned: boolean): void {
    this.calls.push(`setToolbarPinned ${id.slice(0, 4)} ${pinned ? 'on' : 'off'}`)
    const have = this.registry.get(id)
    if (have) this.registry.set(id, { ...have, toolbarPinned: pinned })
  }

  toastRemoved(rec: SyncedExtensionRecord, store: StoreId, from: string | null): void {
    this.calls.push(`toast ${rec.id.slice(0, 4)} from ${from ?? '?'}`)
    this.toasts.push({ name: rec.name, store, from })
  }

  error(message: string): void {
    this.errors.push(message)
  }

  now(): number {
    return this.clock
  }

  /** The user approved the landing (the Extensions page's Enable, the prompt accepted). */
  approve(id: string): void {
    const have = this.registry.get(id)!
    const { pendingApproval: _cleared, ...rest } = have
    void _cleared
    this.registry.set(id, { ...rest, enabled: true })
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('ExtensionSyncApplier – a record for an extension this device lacks', () => {
  it('downloads it from the record’s store and lands it turned off, pending approval, pinned as the record says – nothing enabled, nothing granted', async () => {
    const host = new FakeHost()
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A, { store: 'edge-add-ons', enabled: true, toolbarPinned: true })])
    await applier.settled()
    expect(host.calls).toEqual([
      `download ${ID_A.slice(0, 4)} edge-add-ons`,
      `install ${ID_A.slice(0, 4)} edge-add-ons pinned`
    ])
    expect(host.registry.get(ID_A)).toMatchObject({
      enabled: false,
      pendingApproval: true,
      toolbarPinned: true,
      source: 'edge-add-ons'
    })
    expect(host.errors).toEqual([])
    expect(applier.backoffOf(ID_A)).toBeUndefined()
    // The same record again (the engine hands it over every round until it is held): the
    // landing is present now – no second download, and `enabled: true` waits for the approval.
    applier.apply([live(ID_A, { store: 'edge-add-ons', enabled: true, toolbarPinned: true })])
    await applier.settled()
    expect(host.calls).toHaveLength(2)
    expect(host.registry.get(ID_A)!.enabled).toBe(false)
  })

  it('a failed download – the store has no such listing – leaves it uninstalled, prints ONE line naming the id and the store, and starts a back-off no re-delivery within the window gets past', async () => {
    const host = new FakeHost()
    host.auto = `No store has an extension with id ${ID_A} (Chrome Web Store: HTTP 404)`
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A)])
    await applier.settled()
    expect(host.registry.has(ID_A)).toBe(false)
    expect(host.errors).toHaveLength(1)
    expect(host.errors[0]).toContain(ID_A)
    expect(host.errors[0]).toContain('Chrome Web Store')
    expect(host.errors[0]).toContain('HTTP 404')
    expect(host.errors[0]).toMatch(/next try in 1 min$/)
    expect(applier.backoffOf(ID_A)).toEqual({
      failures: 1,
      lastAttemptAt: 1_000_000,
      nextAttemptAt: 1_000_000 + SYNC_INSTALL_BACKOFF_MIN_MS
    })
    // Re-delivered every round for the next minute: no second attempt, no second line.
    for (const later of [1, 1_000, 30_000, SYNC_INSTALL_BACKOFF_MIN_MS - 1]) {
      host.clock = 1_000_000 + later
      applier.apply([live(ID_A)])
      await applier.settled()
    }
    expect(host.calls).toEqual([`download ${ID_A.slice(0, 4)} chrome-web-store`])
    expect(host.errors).toHaveLength(1)
    // The window over: one more try; failed again, the wait doubles – 2 min, 4 min … a day.
    host.clock = 1_000_000 + SYNC_INSTALL_BACKOFF_MIN_MS
    applier.apply([live(ID_A)])
    await applier.settled()
    expect(host.calls).toHaveLength(2)
    expect(host.errors).toHaveLength(2)
    expect(host.errors[1]).toMatch(/next try in 2 min$/)
    expect(applier.backoffOf(ID_A)).toEqual({
      failures: 2,
      lastAttemptAt: host.clock,
      nextAttemptAt: host.clock + 2 * SYNC_INSTALL_BACKOFF_MIN_MS
    })
    let at = host.clock
    for (let failures = 3; failures <= 14; failures += 1) {
      at = applier.backoffOf(ID_A)!.nextAttemptAt
      host.clock = at
      applier.apply([live(ID_A)])
      await applier.settled()
      expect(applier.backoffOf(ID_A)!.failures).toBe(failures)
      expect(applier.backoffOf(ID_A)!.nextAttemptAt - at).toBe(syncInstallBackoffMs(failures))
    }
    expect(applier.backoffOf(ID_A)!.nextAttemptAt - at).toBe(SYNC_INSTALL_BACKOFF_MAX_MS)
    expect(host.errors.at(-1)).toMatch(/next try in 24 h$/)
    expect(host.registry.has(ID_A)).toBe(false)
    // A day later the store answers: the landing lands, the back-off is forgotten.
    host.clock = applier.backoffOf(ID_A)!.nextAttemptAt
    host.auto = 'ok'
    applier.apply([live(ID_A)])
    await applier.settled()
    expect(host.registry.get(ID_A)).toMatchObject({ enabled: false, pendingApproval: true })
    expect(applier.backoffOf(ID_A)).toBeUndefined()
  })

  it('a package the store hands over under another id (the CRX3 check’s `expectedId`) is the same failure: uninstalled, one line, the back-off', async () => {
    const host = new FakeHost()
    host.auto = `The package is ${ID_B}, not ${ID_A}`
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A)])
    applier.apply([live(ID_A)])
    await applier.settled()
    expect(host.registry.size).toBe(0)
    expect(host.calls).toEqual([`download ${ID_A.slice(0, 4)} chrome-web-store`])
    expect(host.errors).toEqual([
      `[zen] extensions: could not install ${ID_A} from Chrome Web Store for sync: The package is ${ID_B}, not ${ID_A}; next try in 1 min`
    ])
    expect(applier.backoffOf(ID_A)?.failures).toBe(1)
  })

  it('an id the service is busy with on another path is left to it', async () => {
    const host = new FakeHost()
    host.busyIds.add(ID_A)
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A)])
    await applier.settled()
    expect(host.calls).toEqual([])
    expect(host.errors).toEqual([])
    expect(applier.backoffOf(ID_A)).toBeUndefined()
  })

  it('a landing that ends in-progress (the id landed meanwhile on another path) is no failure', async () => {
    const host = new FakeHost()
    host.auto = 'manual'
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A)])
    await tick()
    // The user installs the same extension from the store's page while the download runs.
    host.registry.set(ID_A, record(ID_A, 'chrome-web-store', { enabled: true }))
    host.downloads[0]!.land()
    await applier.settled()
    expect(host.calls).toEqual([
      `download ${ID_A.slice(0, 4)} chrome-web-store`,
      `install ${ID_A.slice(0, 4)} chrome-web-store unpinned`
    ])
    expect(host.registry.get(ID_A)!.enabled).toBe(true)
    expect(host.errors).toEqual([])
    expect(applier.backoffOf(ID_A)).toBeUndefined()
  })
})

describe('ExtensionSyncApplier – a record for an extension this device holds', () => {
  it('`enabled: true` lands nothing while the landing waits for approval, or an update’s permissions do; the approval, then a record’s switch, enables through the ordinary path', async () => {
    const host = new FakeHost()
    host.registry.set(
      ID_A,
      record(ID_A, 'chrome-web-store', { enabled: false, pendingApproval: true })
    )
    host.registry.set(
      ID_B,
      record(ID_B, 'edge-add-ons', {
        enabled: false,
        pendingWarnings: ['Read your browsing history']
      })
    )
    const applier = new ExtensionSyncApplier(host)
    applier.apply([
      live(ID_A, { enabled: true }),
      live(ID_B, { store: 'edge-add-ons', enabled: true })
    ])
    await applier.settled()
    expect(host.calls).toEqual([])
    expect(host.registry.get(ID_A)!.enabled).toBe(false)
    expect(host.registry.get(ID_B)!.enabled).toBe(false)
    // Approved here (the prompt accepted): the landing is on. A later record saying off lands –
    // turning off is no grant – and one saying on again lands too, the approval given.
    host.approve(ID_A)
    expect(host.registry.get(ID_A)).toMatchObject({ enabled: true })
    expect(host.registry.get(ID_A)).not.toHaveProperty('pendingApproval')
    applier.apply([live(ID_A, { enabled: false })])
    await applier.settled()
    expect(host.calls).toEqual([`setEnabled ${ID_A.slice(0, 4)} off`])
    applier.apply([live(ID_A, { enabled: true })])
    await applier.settled()
    expect(host.calls).toEqual([
      `setEnabled ${ID_A.slice(0, 4)} off`,
      `setEnabled ${ID_A.slice(0, 4)} on`
    ])
    expect(host.registry.get(ID_A)!.enabled).toBe(true)
  })

  it('`enabled: false` always lands, on a pending landing too; an equal record does nothing', async () => {
    const host = new FakeHost()
    host.registry.set(ID_A, record(ID_A, 'chrome-web-store', { enabled: true }))
    host.registry.set(
      ID_B,
      record(ID_B, 'chrome-web-store', { enabled: false, pendingApproval: true })
    )
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A, { enabled: false }), live(ID_B, { enabled: false })])
    await applier.settled()
    expect(host.calls).toEqual([`setEnabled ${ID_A.slice(0, 4)} off`])
    applier.apply([live(ID_A, { enabled: false }), live(ID_B, { enabled: false })])
    await applier.settled()
    expect(host.calls).toHaveLength(1)
  })

  it('the toolbar pin lands through `setToolbarPinned`, on a pending landing as well, and never touches the update-check `pinned`', async () => {
    const host = new FakeHost()
    host.registry.set(
      ID_A,
      record(ID_A, 'chrome-web-store', { enabled: true, toolbarPinned: false })
    )
    host.registry.set(
      ID_B,
      record(ID_B, 'chrome-web-store', { enabled: false, pendingApproval: true })
    )
    const applier = new ExtensionSyncApplier(host)
    applier.apply([
      live(ID_A, { enabled: true, toolbarPinned: true }),
      live(ID_B, { enabled: true, toolbarPinned: true })
    ])
    await applier.settled()
    expect(host.calls).toEqual([
      `setToolbarPinned ${ID_A.slice(0, 4)} on`,
      `setToolbarPinned ${ID_B.slice(0, 4)} on`
    ])
    expect(host.registry.get(ID_B)).toMatchObject({
      enabled: false,
      pendingApproval: true,
      toolbarPinned: true
    })
    applier.apply([live(ID_A, { enabled: true, toolbarPinned: false })])
    await applier.settled()
    expect(host.calls.at(-1)).toBe(`setToolbarPinned ${ID_A.slice(0, 4)} off`)
  })

  it('a copy from a file or a folder under the same id is this device’s own: a record changes nothing on it, a tombstone removes nothing', async () => {
    const host = new FakeHost()
    host.registry.set(ID_A, record(ID_A, 'unpacked', { enabled: false }))
    host.registry.set(ID_B, record(ID_B, 'crx', { enabled: true }))
    host.registry.set(ID_C, record(ID_C, 'zip', { enabled: true }))
    const applier = new ExtensionSyncApplier(host)
    applier.apply([
      live(ID_A, { enabled: true, toolbarPinned: true }),
      tombstone(ID_B),
      tombstone(ID_C)
    ])
    await applier.settled()
    expect(host.calls).toEqual([])
    expect(host.registry.size).toBe(3)
    expect(host.toasts).toEqual([])
  })
})

describe('ExtensionSyncApplier – a tombstone', () => {
  it('uninstalls a store install through `remove` and shows the toast naming the device it came from; one for an extension not here is nothing', async () => {
    const host = new FakeHost()
    host.registry.set(ID_A, record(ID_A, 'edge-add-ons', { enabled: true }))
    const applier = new ExtensionSyncApplier(host)
    applier.apply([tombstone(ID_A, 'Pixel 9'), tombstone(ID_B, 'Pixel 9')])
    await applier.settled()
    expect(host.calls).toEqual([
      `remove ${ID_A.slice(0, 4)}`,
      `toast ${ID_A.slice(0, 4)} from Pixel 9`
    ])
    expect(host.registry.has(ID_A)).toBe(false)
    expect(host.toasts).toEqual([
      { name: `Extension ${ID_A.slice(0, 4)}`, store: 'edge-add-ons', from: 'Pixel 9' }
    ])
    // A landing removed on the peer before this device approved it goes the same way.
    host.registry.set(
      ID_C,
      record(ID_C, 'chrome-web-store', { enabled: false, pendingApproval: true })
    )
    applier.apply([tombstone(ID_C, null)])
    await applier.settled()
    expect(host.registry.has(ID_C)).toBe(false)
    expect(host.toasts.at(-1)).toEqual({
      name: `Extension ${ID_C.slice(0, 4)}`,
      store: 'chrome-web-store',
      from: null
    })
  })

  it('the toast’s words: the extension, then "removed on <device name>" – "another device" when the engine could not name it', () => {
    expect(syncedRemovalToast('uBlock Origin', 'Pixel 9')).toBe('uBlock Origin removed on Pixel 9')
    expect(syncedRemovalToast('uBlock Origin', null)).toBe(
      'uBlock Origin removed on another device'
    )
    expect(syncedRemovalToast('', 'Work laptop')).toBe('Extension removed on Work laptop')
  })
})

describe('ExtensionSyncApplier – the schedule', () => {
  it('serialises the records per id: a tombstone behind an install waits for the download, and lands after it; other ids run beside them', async () => {
    const host = new FakeHost()
    host.auto = 'manual'
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A), live(ID_B, { store: 'edge-add-ons' })])
    applier.apply([tombstone(ID_A, 'Pixel 9')])
    await tick()
    // Both downloads are in flight; A's tombstone has not run (A is not in the registry yet, and
    // would otherwise be "nothing to remove").
    expect(host.calls).toEqual([
      `download ${ID_A.slice(0, 4)} chrome-web-store`,
      `download ${ID_B.slice(0, 4)} edge-add-ons`
    ])
    host.downloads[1]!.land()
    await tick()
    await tick()
    expect(host.registry.has(ID_B)).toBe(true)
    expect(host.registry.has(ID_A)).toBe(false)
    host.downloads[0]!.land()
    await applier.settled()
    expect(host.calls.slice(2)).toEqual([
      `install ${ID_B.slice(0, 4)} edge-add-ons unpinned`,
      `install ${ID_A.slice(0, 4)} chrome-web-store unpinned`,
      `remove ${ID_A.slice(0, 4)}`,
      `toast ${ID_A.slice(0, 4)} from Pixel 9`
    ])
    expect(host.registry.has(ID_A)).toBe(false)
    expect(host.registry.has(ID_B)).toBe(true)
  })

  it('a failed step for one id neither stops the id’s later records nor another id’s, and is one line', async () => {
    const host = new FakeHost()
    host.remove = async () => {
      throw new Error('the files are locked')
    }
    host.registry.set(ID_A, record(ID_A, 'chrome-web-store', { enabled: true }))
    host.registry.set(ID_B, record(ID_B, 'chrome-web-store', { enabled: true }))
    const applier = new ExtensionSyncApplier(host)
    applier.apply([tombstone(ID_A), live(ID_B, { enabled: false })])
    applier.apply([live(ID_A, { enabled: false })])
    await applier.settled()
    expect(host.errors).toEqual([
      `[zen] extensions: applying a synced record for ${ID_A} failed: the files are locked`
    ])
    expect(host.calls).toEqual([
      `setEnabled ${ID_B.slice(0, 4)} off`,
      `setEnabled ${ID_A.slice(0, 4)} off`
    ])
  })

  it('applies nothing while the extension layer’s startup hold is closed: the records queue and run, in order, once it opens', async () => {
    const host = new FakeHost()
    const hold = new StartupHold()
    let release: () => void = () => undefined
    hold.until(new Promise<void>((resolve) => (release = resolve)))
    expect(hold.open).toBe(false)
    host.hold = hold
    host.registry.set(ID_B, record(ID_B, 'chrome-web-store', { enabled: true }))
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A)])
    applier.apply([live(ID_B, { enabled: false })])
    await tick()
    await tick()
    expect(host.calls).toEqual([])
    expect(host.registry.get(ID_B)!.enabled).toBe(true)
    release()
    await hold.whenOpen()
    await applier.settled()
    expect(host.calls).toEqual([
      `download ${ID_A.slice(0, 4)} chrome-web-store`,
      `setEnabled ${ID_B.slice(0, 4)} off`,
      `install ${ID_A.slice(0, 4)} chrome-web-store unpinned`
    ])
    expect(host.registry.get(ID_A)).toMatchObject({ enabled: false, pendingApproval: true })
    // Open from then on: the next round's records run at once.
    applier.apply([live(ID_B, { enabled: true })])
    await applier.settled()
    expect(host.calls.at(-1)).toBe(`setEnabled ${ID_B.slice(0, 4)} on`)
  })
})

describe('the helpers', () => {
  it('syncInstallBackoffMs: a minute, doubling per failure, capped at a day', () => {
    expect(syncInstallBackoffMs(1)).toBe(SYNC_INSTALL_BACKOFF_MIN_MS)
    expect(syncInstallBackoffMs(2)).toBe(2 * SYNC_INSTALL_BACKOFF_MIN_MS)
    expect(syncInstallBackoffMs(7)).toBe(64 * SYNC_INSTALL_BACKOFF_MIN_MS)
    expect(syncInstallBackoffMs(11)).toBe(1024 * SYNC_INSTALL_BACKOFF_MIN_MS)
    expect(syncInstallBackoffMs(12)).toBe(SYNC_INSTALL_BACKOFF_MAX_MS)
    expect(syncInstallBackoffMs(100)).toBe(SYNC_INSTALL_BACKOFF_MAX_MS)
    expect(syncInstallBackoffMs(0)).toBe(SYNC_INSTALL_BACKOFF_MIN_MS)
    expect(SYNC_INSTALL_BACKOFF_MAX_MS).toBe(24 * HOUR)
  })

  it('awaitsApproval: a synced landing not yet approved, or an update’s permissions waiting', () => {
    expect(
      awaitsApproval(record(ID_A, 'chrome-web-store', { enabled: false, pendingApproval: true }))
    ).toBe(true)
    expect(
      awaitsApproval(record(ID_A, 'chrome-web-store', { enabled: false, pendingWarnings: ['x'] }))
    ).toBe(true)
    expect(
      awaitsApproval(record(ID_A, 'chrome-web-store', { enabled: false, pendingWarnings: [] }))
    ).toBe(false)
    expect(awaitsApproval(record(ID_A, 'chrome-web-store', { enabled: false }))).toBe(false)
  })

  it('approvalPrompt: the install prompt (`kind: install`) with the manifest’s warnings, the name, the icon and the store', () => {
    expect(
      approvalPrompt(
        { name: 'uBlock Origin', source: 'chrome-web-store' },
        ['Read and change all your data on all websites'],
        'data:image/png;base64,AAAA'
      )
    ).toEqual({
      kind: 'install',
      name: 'uBlock Origin',
      icon: 'data:image/png;base64,AAAA',
      warnings: ['Read and change all your data on all websites'],
      source: 'chrome-web-store'
    })
  })
})
