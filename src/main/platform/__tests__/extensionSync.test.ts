import { describe, expect, it } from 'vitest'
import type { ExtensionPackage } from '../../../core/extensions/install'
import type { StoreId } from '../../../core/extensions/store'
import type { SyncedExtensionChange } from '../../../core/platform'
import type { SyncedExtensionData } from '../../../core/sync/records'
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
    ...(opts.pendingApproval ? { pendingApproval: true } : {}),
    ...(opts.enabledAt !== undefined ? { enabledAt: opts.enabledAt } : {}),
    ...(opts.toolbarPinnedAt !== undefined ? { toolbarPinnedAt: opts.toolbarPinnedAt } : {})
  }
}

/**
 * A record as the engine hands it over (`syncedExtensionData`): each switch with its clock –
 * 0 here unless the test says, as old as any clock this device holds, so a record without one
 * ties with a registry record without one and its switch lands where the values differ.
 */
const live = (
  id: string,
  data: Partial<SyncedExtensionData> = {},
  from: string | null = 'Desk (Linux)'
): SyncedExtensionChange => ({
  id,
  data: {
    store: data.store ?? 'chrome-web-store',
    enabled: data.enabled ?? true,
    toolbarPinned: data.toolbarPinned ?? false,
    enabledAt: data.enabledAt ?? 0,
    toolbarPinnedAt: data.toolbarPinnedAt ?? 0
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
 * promises the test settles, the clock the test's own, the ids busy on another path a set the
 * test empties (`idle`), the startup loads a promise the test resolves (`attached`).
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
  /** The startup loads: through, unless a test replaces this with a promise it resolves later. */
  attached: Promise<void> = Promise.resolve()
  private idleWaiters: Array<() => void> = []

  record(id: string): SyncedExtensionRecord | undefined {
    return this.registry.get(id)
  }

  async whenIdle(id: string): Promise<void> {
    while (this.busyIds.has(id))
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  whenAttached(): Promise<void> {
    return this.attached
  }

  /** The other path's work on `id` is done (`BusyIds.delete`): whoever waits for it runs. */
  idle(id: string): void {
    this.busyIds.delete(id)
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const wake of waiters) wake()
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
    data: SyncedExtensionData
  ): Promise<'installed' | 'in-progress'> {
    const id = (pkg as unknown as { id: string }).id
    this.calls.push(
      `install ${id.slice(0, 4)} ${store} ${data.toolbarPinned ? 'pinned' : 'unpinned'}`
    )
    if (this.registry.has(id) || this.busyIds.has(id)) return 'in-progress'
    // The synced landing as `ExtensionService.installPackage` writes it: off, pending, pinned
    // as the record says, the switches' clocks the record's (none of 0) – never loaded.
    this.registry.set(
      id,
      record(id, store, {
        enabled: false,
        toolbarPinned: data.toolbarPinned,
        pendingApproval: true,
        ...(data.enabledAt > 0 ? { enabledAt: data.enabledAt } : {}),
        ...(data.toolbarPinnedAt > 0 ? { toolbarPinnedAt: data.toolbarPinnedAt } : {})
      })
    )
    return 'installed'
  }

  async remove(id: string): Promise<void> {
    this.calls.push(`remove ${id.slice(0, 4)}`)
    this.registry.delete(id)
  }

  async setEnabled(id: string, enabled: boolean, at: number): Promise<void> {
    this.calls.push(`setEnabled ${id.slice(0, 4)} ${enabled ? 'on' : 'off'}`)
    const have = this.registry.get(id)
    if (have) this.registry.set(id, { ...have, enabled, enabledAt: at })
  }

  setToolbarPinned(id: string, pinned: boolean, at: number): void {
    this.calls.push(`setToolbarPinned ${id.slice(0, 4)} ${pinned ? 'on' : 'off'}`)
    const have = this.registry.get(id)
    if (have) this.registry.set(id, { ...have, toolbarPinned: pinned, toolbarPinnedAt: at })
  }

  republish(id: string): void {
    this.calls.push(`republish ${id.slice(0, 4)}`)
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

  /** The user approved the landing (the Extensions page's Enable, the prompt accepted): on, the enable's clock this device's time. */
  approve(id: string): void {
    const have = this.registry.get(id)!
    const { pendingApproval: _cleared, ...rest } = have
    void _cleared
    this.registry.set(id, { ...rest, enabled: true, enabledAt: this.clock })
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

  it('every path – an install, a switch, a tombstone – waits for the id’s work on another path (an update in flight) and runs after it; a tombstone that arrives during the update lands after it instead of being undone by the update’s replace', async () => {
    const host = new FakeHost()
    // A is installed and its update runs (`installPackage` on another path); B's install from
    // the store's page is in flight; C is installed and its update runs too.
    host.registry.set(ID_A, record(ID_A, 'chrome-web-store', { enabled: true }))
    host.registry.set(ID_C, record(ID_C, 'edge-add-ons', { enabled: true, enabledAt: 5 }))
    host.busyIds.add(ID_A).add(ID_B).add(ID_C)
    const applier = new ExtensionSyncApplier(host)
    applier.apply([
      tombstone(ID_A, 'Pixel 9'),
      live(ID_B),
      live(ID_C, { store: 'edge-add-ons', enabled: false, enabledAt: 10 })
    ])
    await tick()
    await tick()
    // Nothing ran: no remove, no download, no switch – the other path's work first.
    expect(host.calls).toEqual([])
    expect(host.registry.has(ID_A)).toBe(true)
    expect(host.registry.get(ID_C)!.enabled).toBe(true)
    // A's update lands (`replace` writes the updated record) and its work is done: the tombstone
    // runs now – after the update – and the extension goes. B and C still wait.
    host.registry.set(ID_A, record(ID_A, 'chrome-web-store', { enabled: true }))
    host.idle(ID_A)
    await tick()
    await tick()
    expect(host.calls).toEqual([
      `remove ${ID_A.slice(0, 4)}`,
      `toast ${ID_A.slice(0, 4)} from Pixel 9`
    ])
    expect(host.registry.has(ID_A)).toBe(false)
    expect(host.downloads).toEqual([])
    // C's update is done: the switch lands. B's install from the page is done and landed the
    // extension: the record finds it present and hands nothing to the store – this device's
    // copy, its clock the later one, is re-published instead.
    host.idle(ID_C)
    await tick()
    await tick()
    expect(host.calls.at(-1)).toBe(`setEnabled ${ID_C.slice(0, 4)} off`)
    expect(host.registry.get(ID_C)).toMatchObject({ enabled: false, enabledAt: 10 })
    host.registry.set(ID_B, record(ID_B, 'chrome-web-store', { enabled: true, enabledAt: 20 }))
    host.idle(ID_B)
    await applier.settled()
    expect(host.downloads).toEqual([])
    expect(host.calls.filter((c) => c.includes(ID_B.slice(0, 4)))).toEqual([
      `republish ${ID_B.slice(0, 4)}`
    ])
    expect(host.errors).toEqual([])
    expect(applier.backoffOf(ID_B)).toBeUndefined()
    expect(applier.inFlight().size).toBe(0)
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
    // Withheld: not taken, and not re-published either (the peer's copy stands; the approval
    // here is the write that travels).
    expect(host.calls).toEqual([])
    expect(host.registry.get(ID_A)!.enabled).toBe(false)
    expect(host.registry.get(ID_B)!.enabled).toBe(false)
    // Approved here (the prompt accepted): the landing is on, the enable's clock this device's
    // time. A later record saying off lands – turning off is no grant – and one saying on again
    // lands too, the approval given; each under the record's clock for the switch.
    host.approve(ID_A)
    expect(host.registry.get(ID_A)).toMatchObject({ enabled: true, enabledAt: 1_000_000 })
    expect(host.registry.get(ID_A)).not.toHaveProperty('pendingApproval')
    applier.apply([live(ID_A, { enabled: false, enabledAt: 1_000_500 })])
    await applier.settled()
    expect(host.calls).toEqual([`setEnabled ${ID_A.slice(0, 4)} off`])
    expect(host.registry.get(ID_A)).toMatchObject({ enabled: false, enabledAt: 1_000_500 })
    applier.apply([live(ID_A, { enabled: true, enabledAt: 1_001_000 })])
    await applier.settled()
    expect(host.calls).toEqual([
      `setEnabled ${ID_A.slice(0, 4)} off`,
      `setEnabled ${ID_A.slice(0, 4)} on`
    ])
    expect(host.registry.get(ID_A)).toMatchObject({ enabled: true, enabledAt: 1_001_000 })
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

describe('ExtensionSyncApplier – the switch-by-switch merge under each switch’s clock (condition 4)', () => {
  const T0 = 1_000_000
  const T1 = T0 + 60_000

  /** The extension as both devices hold it after the landing was approved: on, unpinned, both clocks the approval's. */
  const held = (): SyncedExtensionRecord =>
    record(ID_A, 'chrome-web-store', {
      enabled: true,
      toolbarPinned: false,
      enabledAt: T0,
      toolbarPinnedAt: T0
    })
  /** What the registry says, the two switches and their clocks. */
  const switches = (host: FakeHost): Partial<SyncedExtensionRecord> => {
    const { enabled, enabledAt, toolbarPinned, toolbarPinnedAt } = host.registry.get(ID_A)!
    return { enabled, enabledAt, toolbarPinned, toolbarPinnedAt }
  }
  /** The record the engine would hand over for the registry's copy (`syncedExtensionData`). */
  const recordOf = (host: FakeHost, from: string): SyncedExtensionChange => {
    const have = host.registry.get(ID_A)!
    return live(
      ID_A,
      {
        enabled: have.enabled,
        toolbarPinned: have.toolbarPinned,
        enabledAt: have.enabledAt,
        toolbarPinnedAt: have.toolbarPinnedAt
      },
      from
    )
  }

  it('the desktop pins at t1, the laptop turns off at t1 + 1 s: each takes the other’s switch and keeps its own – both hold {enabled: false, toolbarPinned: true} under the two clocks, a second exchange lands nothing, and a third device lands the same', async () => {
    const desk = new FakeHost()
    const laptop = new FakeHost()
    desk.registry.set(ID_A, held())
    laptop.registry.set(ID_A, held())
    // The user's flips, each stamped with its device's time (`switchToolbarPinned`, `switchEnabled`).
    desk.setToolbarPinned(ID_A, true, T1)
    await laptop.setEnabled(ID_A, false, T1 + 1000)
    desk.calls.length = 0
    laptop.calls.length = 0

    // The exchange: each device's applier receives the other's record.
    const deskApplier = new ExtensionSyncApplier(desk)
    const laptopApplier = new ExtensionSyncApplier(laptop)
    const fromLaptop = recordOf(laptop, 'Work laptop')
    const fromDesk = recordOf(desk, 'Desk (Linux)')
    deskApplier.apply([fromLaptop])
    laptopApplier.apply([fromDesk])
    await deskApplier.settled()
    await laptopApplier.settled()
    // The desktop takes the disable (t1 + 1 s is later than the approval's clock) and keeps its
    // pin (t1 is later than the record's clock for it, the approval's); the laptop the mirror.
    expect(desk.calls).toEqual([`setEnabled ${ID_A.slice(0, 4)} off`])
    expect(laptop.calls).toEqual([`setToolbarPinned ${ID_A.slice(0, 4)} on`])
    const merged = {
      enabled: false,
      enabledAt: T1 + 1000,
      toolbarPinned: true,
      toolbarPinnedAt: T1
    }
    expect(switches(desk)).toEqual(merged)
    expect(switches(laptop)).toEqual(merged)

    // The second exchange – each commit re-published the merged record under a fresh stamp –
    // finds every switch standing under the same clock: nothing lands, nothing is re-published.
    deskApplier.apply([recordOf(laptop, 'Work laptop')])
    laptopApplier.apply([recordOf(desk, 'Desk (Linux)')])
    await deskApplier.settled()
    await laptopApplier.settled()
    expect(desk.calls).toHaveLength(1)
    expect(laptop.calls).toHaveLength(1)

    // A third device lands the merged record: off, pending approval, pinned, the two clocks the
    // record's – the same as the other two once approved.
    const studio = new FakeHost()
    const studioApplier = new ExtensionSyncApplier(studio)
    studioApplier.apply([recordOf(desk, 'Desk (Linux)')])
    await studioApplier.settled()
    expect(studio.calls).toEqual([
      `download ${ID_A.slice(0, 4)} chrome-web-store`,
      `install ${ID_A.slice(0, 4)} chrome-web-store pinned`
    ])
    expect(studio.registry.get(ID_A)).toMatchObject({ ...merged, pendingApproval: true })
  })

  it('an equal value under a later clock adopts the clock alone; a record whose clocks are both older lands nothing and is re-published; ties take the record’s; a withheld enable is neither taken nor re-published', async () => {
    const host = new FakeHost()
    host.registry.set(ID_A, held())
    const applier = new ExtensionSyncApplier(host)
    // Equal values, the record's clocks later: the clocks are adopted through the ordinary
    // paths (the switch written under the record's clock), the values unchanged.
    applier.apply([live(ID_A, { enabled: true, enabledAt: T1, toolbarPinnedAt: T1 })])
    await applier.settled()
    expect(host.calls).toEqual([
      `setToolbarPinned ${ID_A.slice(0, 4)} off`,
      `setEnabled ${ID_A.slice(0, 4)} on`
    ])
    expect(switches(host)).toEqual({
      enabled: true,
      enabledAt: T1,
      toolbarPinned: false,
      toolbarPinnedAt: T1
    })
    // Both of the record's clocks older (a peer's copy from before this device's flips): every
    // switch kept, and the record re-committed so this device's copy travels afresh.
    host.calls.length = 0
    applier.apply([
      live(ID_A, { enabled: false, toolbarPinned: true, enabledAt: T0, toolbarPinnedAt: T0 })
    ])
    await applier.settled()
    expect(host.calls).toEqual([`republish ${ID_A.slice(0, 4)}`])
    expect(switches(host)).toMatchObject({ enabled: true, toolbarPinned: false })
    // One switch older, one newer: the newer lands, the older is kept, and the commit that
    // landed the one is the re-publish – no `republish` beside it.
    host.calls.length = 0
    applier.apply([
      live(ID_A, { enabled: false, toolbarPinned: true, enabledAt: T0, toolbarPinnedAt: T1 + 1 })
    ])
    await applier.settled()
    expect(host.calls).toEqual([`setToolbarPinned ${ID_A.slice(0, 4)} on`])
    expect(switches(host)).toEqual({
      enabled: true,
      enabledAt: T1,
      toolbarPinned: true,
      toolbarPinnedAt: T1 + 1
    })
    // A tie takes the record's value.
    host.calls.length = 0
    applier.apply([
      live(ID_A, { enabled: false, toolbarPinned: true, enabledAt: T1, toolbarPinnedAt: T1 + 1 })
    ])
    await applier.settled()
    expect(host.calls).toEqual([`setEnabled ${ID_A.slice(0, 4)} off`])
    expect(switches(host)).toMatchObject({ enabled: false, enabledAt: T1 })
    // A withheld enable – the landing waits for approval here – is neither taken nor
    // re-published, whatever its clock: the peer's copy stands until the approval's own write.
    host.registry.set(
      ID_B,
      record(ID_B, 'edge-add-ons', {
        enabled: false,
        pendingApproval: true,
        enabledAt: T0,
        toolbarPinnedAt: T0
      })
    )
    host.calls.length = 0
    applier.apply([live(ID_B, { store: 'edge-add-ons', enabled: true, enabledAt: T1 })])
    await applier.settled()
    expect(host.calls).toEqual([])
    expect(host.registry.get(ID_B)).toMatchObject({ enabled: false, enabledAt: T0 })
  })

  it('a record without clocks (an older build’s, or the phone’s) is read at the engine’s fallback, the record’s `modified`; here 0 – as old as any – so it ties with an unstamped registry record and loses to a stamped one', async () => {
    const host = new FakeHost()
    host.registry.set(ID_A, record(ID_A, 'chrome-web-store', { enabled: true }))
    host.registry.set(ID_B, record(ID_B, 'chrome-web-store', { enabled: true, enabledAt: T0 }))
    const applier = new ExtensionSyncApplier(host)
    applier.apply([live(ID_A, { enabled: false }), live(ID_B, { enabled: false })])
    await applier.settled()
    expect(host.calls).toEqual([
      `setEnabled ${ID_A.slice(0, 4)} off`,
      `republish ${ID_B.slice(0, 4)}`
    ])
    expect(host.registry.get(ID_A)!.enabled).toBe(false)
    expect(host.registry.get(ID_B)!.enabled).toBe(true)
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

  it('applies nothing before the extension host’s startup loads are through (`whenAttached`), the hold open or not: every path waits, and runs once the loads are', async () => {
    const host = new FakeHost()
    let loaded: () => void = () => undefined
    host.attached = new Promise<void>((resolve) => (loaded = resolve))
    host.registry.set(ID_B, record(ID_B, 'chrome-web-store', { enabled: true }))
    host.registry.set(ID_C, record(ID_C, 'edge-add-ons', { enabled: true }))
    const applier = new ExtensionSyncApplier(host)
    // The first round's records, before a fresh session's loads are through.
    applier.apply([
      live(ID_A),
      tombstone(ID_B, 'Pixel 9'),
      live(ID_C, { store: 'edge-add-ons', enabled: false })
    ])
    await tick()
    await tick()
    expect(host.calls).toEqual([])
    expect(host.registry.get(ID_B)).toBeDefined()
    expect(host.registry.get(ID_C)!.enabled).toBe(true)
    expect(applier.inFlight()).toEqual(new Set([ID_A, ID_B, ID_C]))
    // The loads are through: each path runs, in the order the records came.
    loaded()
    await applier.settled()
    expect(host.calls.slice(0, 3)).toEqual([
      `download ${ID_A.slice(0, 4)} chrome-web-store`,
      `remove ${ID_B.slice(0, 4)}`,
      `setEnabled ${ID_C.slice(0, 4)} off`
    ])
    expect(host.calls.slice(3).sort()).toEqual(
      [
        `install ${ID_A.slice(0, 4)} chrome-web-store unpinned`,
        `toast ${ID_B.slice(0, 4)} from Pixel 9`
      ].sort()
    )
    expect(host.registry.get(ID_A)).toMatchObject({ enabled: false, pendingApproval: true })
    expect(host.registry.has(ID_B)).toBe(false)
    expect(host.registry.get(ID_C)!.enabled).toBe(false)
    expect(applier.inFlight().size).toBe(0)
    // Attached from then on: the next round's records run at once.
    applier.apply([live(ID_C, { store: 'edge-add-ons', enabled: true, enabledAt: 1 })])
    await applier.settled()
    expect(host.calls.at(-1)).toBe(`setEnabled ${ID_C.slice(0, 4)} on`)
  })

  it('an id is in flight from the moment its record is handed over – synchronously, through a closed hold, however many records for it wait – until its work is done, and released on its own', async () => {
    const host = new FakeHost()
    host.auto = 'manual'
    const hold = new StartupHold()
    let release: () => void = () => undefined
    hold.until(new Promise<void>((resolve) => (release = resolve)))
    host.hold = hold
    const applier = new ExtensionSyncApplier(host)
    expect(applier.inFlight().size).toBe(0)
    // Two rounds hand A over while the hold is closed; B's tombstone comes with the first.
    applier.apply([live(ID_A), tombstone(ID_B)])
    expect(applier.inFlight()).toEqual(new Set([ID_A, ID_B]))
    applier.apply([live(ID_A)])
    expect(applier.inFlight()).toEqual(new Set([ID_A, ID_B]))
    await tick()
    expect(host.calls).toEqual([])
    // The hold opens: B's tombstone finds nothing to remove and is done – B is released; A's
    // download runs and A stays in flight until it lands, and until its second record has run.
    release()
    await hold.whenOpen()
    await tick()
    await tick()
    expect(host.calls).toEqual([`download ${ID_A.slice(0, 4)} chrome-web-store`])
    expect(applier.inFlight()).toEqual(new Set([ID_A]))
    host.downloads[0]!.land()
    await applier.settled()
    expect(host.calls.slice(1)).toEqual([`install ${ID_A.slice(0, 4)} chrome-web-store unpinned`])
    expect(applier.inFlight().size).toBe(0)
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
