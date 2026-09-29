import type { ExtensionPackage } from '../../core/extensions/install'
import { storeLabel, type InstallConfirmation } from '../../core/extensions/hostStore'
import type { ExtensionRecord } from '../../core/extensions/registry'
import type { StoreId } from '../../core/extensions/store'
import type { SyncedExtensionChange } from '../../core/platform'
import { extensionStoreOf, type SyncedExtensionData } from '../../core/sync/records'

/**
 * The extension records other devices published, applied to this device's registry (services
 * pass 16, ID-44; Chrome's "Extensions" sync type). The engine hands the records over
 * (`applyRemote` → `ExtensionHost.applySyncedExtensions`): the winners of a round, and every
 * round again the records it took whose install has not landed (`pendingExtensionRequests`).
 * This class is the schedule between those calls and the service's own paths:
 *
 * - An extension this device lacks is downloaded from the record's store and installed as a
 *   SYNCED LANDING: turned off, `pendingApproval`, never loaded – the user approves its
 *   permissions from the Extensions page's switch, through the same install prompt an install
 *   made here shows (`ExtensionService.setEnabled`). Nothing is granted by sync. The CRX3
 *   signature and publisher checks are the store install's (`downloadPackage` →
 *   `installFromCrx` with the record's id as `expectedId`): a package the store hands over
 *   under another id, a failed signature, a listing the store no longer has (HTTP 404) – each
 *   leaves the extension uninstalled, prints ONE console line naming the id and the store, and
 *   starts the id's back-off: the next try waits `SYNC_INSTALL_BACKOFF_MIN_MS`, doubling per
 *   failure up to `SYNC_INSTALL_BACKOFF_MAX_MS` (a day), in memory with the last attempt's time
 *   – the engine's re-delivery every round meets the back-off, not the store.
 * - An extension this device holds takes the record's switches through the ordinary paths
 *   (`setToolbarPinned`; `setEnabled`), SWITCH BY SWITCH under each switch's own clock
 *   (`ExtensionRecordData.enabledAt` / `toolbarPinnedAt`; an absent clock read as 0 by the
 *   engine, `syncedExtensionData` – older than any switch a host wrote): a switch is taken from
 *   the record when the record's clock for it is not older than this device's – ties take the
 *   record's, an equal value under a later clock adopts the clock alone – and kept otherwise,
 *   so one device's pin and another's disable both stand on both. The commit that lands a
 *   switch is this device's edit: the engine publishes the merged record under a fresh stamp,
 *   and the peer merges it the same way (`records.ts`, the extension record's doc). A record
 *   that lands nothing while this device's clocks are the later ones is re-published the same
 *   way (`republish`), so the peer takes this device's copy; one that lands nothing because
 *   its switches already stand here is adopted as it is. `enabled: true` lands only when
 *   nothing waits for the user's approval here: a synced landing not yet approved, or an
 *   update's new permissions (`pendingWarnings`), keep the extension off until the user says so
 *   on THIS device – and such a withheld switch is not re-published (the peer's copy stands;
 *   the approval here, at its own time, is the write that travels). `enabled: false` always
 *   lands: turning off is no grant.
 * - A tombstone uninstalls a store install through `remove` and shows the removal's toast –
 *   the extension named, the device it came from named, Undo reinstalling from the store (the
 *   ordinary `extension.installFromStore` path, with its prompt). An unpacked or file install
 *   under the same id is this device's own and stays.
 * - A synced landing the user REMOVES before approving it is declined, not uninstalled
 *   everywhere (the lead's ruling, round 4): the engine writes no tombstone and stops handing
 *   the peer's record to this device (`SyncEngine.sources`, `Persisted.declinedExtensions`);
 *   here, `declined` keeps a live record handed over before the decline – still queued – from
 *   putting the landing back. Only an extension the user approved (on or off) uninstalls
 *   everywhere when removed.
 *
 * Serialised per id (`chains`): two records for one extension never race the registry, and a
 * tombstone queued behind an install waits for it. Nothing runs while the extension layer's
 * startup hold is closed (`StartupHold`), nor before the hold has been handed to the service at
 * all (`StartupHoldSlot`: the applier is built before `platform/index.ts` seats the hold): the
 * calls queue and run in order once it opens. Every path – install, switch, tombstone – first
 * waits for the extension host's startup loads to be
 * through (`whenAttached`: the first round can come before a fresh session's loads are) and
 * for the id to be idle (`whenIdle`: an install or update from another path in flight finishes
 * first, so a tombstone that arrives during an update lands after it rather than being undone
 * by the update's `replace`). From the moment a record is handed over until its work is done
 * the id is IN FLIGHT (`inFlight`): the engine leaves it out of the round's re-snapshot, so
 * the copy the record found here never travels under the record's time – the commit that
 * lands the merge is what publishes, stamped fresh.
 */

/** The first wait after a failed install from the store: a minute. */
export const SYNC_INSTALL_BACKOFF_MIN_MS = 60_000
/** The longest wait between two tries: a day (Chrome's own install retries stop far sooner; a delisted extension would otherwise be asked for forever). */
export const SYNC_INSTALL_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000

/** The wait after the n-th failure in a row (n ≥ 1): a minute, doubling, capped at a day. */
export function syncInstallBackoffMs(failures: number): number {
  const doublings = Math.max(0, Math.min(failures - 1, 40))
  return Math.min(SYNC_INSTALL_BACKOFF_MIN_MS * 2 ** doublings, SYNC_INSTALL_BACKOFF_MAX_MS)
}

/** One id's failed installs: how many in a row, when the last was tried, when the next may be. */
export interface SyncInstallBackoff {
  failures: number
  lastAttemptAt: number
  nextAttemptAt: number
}

/** What the applier reads of a registry record. */
export type SyncedExtensionRecord = Pick<
  ExtensionRecord,
  | 'id'
  | 'name'
  | 'source'
  | 'enabled'
  | 'toolbarPinned'
  | 'enabledAt'
  | 'toolbarPinnedAt'
  | 'pendingApproval'
  | 'pendingWarnings'
>

/** The service's paths, as the applier drives them (`ExtensionService` wires the real ones). */
export interface ExtensionSyncHost {
  /** The registry record under `id`, or undefined when the extension is not installed. */
  record(id: string): SyncedExtensionRecord | undefined
  /**
   * Resolves once no install or update of `id` is in flight on another path
   * (`ExtensionService.busy`) – at once when none is, after the work when one is.
   */
  whenIdle(id: string): Promise<void>
  /**
   * Resolves once the extension host's startup loads are through (`ExtensionService.start`
   * and each `attachSession`) – at once afterwards.
   */
  whenAttached(): Promise<void>
  /**
   * Download the package from the store and verify it (`ExtensionService.downloadPackage`:
   * `downloadFromStores` → `installFromCrx` with `expectedId`); throws when the store will not
   * hand it over, the package is another extension's, or its signature fails.
   */
  download(id: string, store: StoreId): Promise<{ pkg: ExtensionPackage; store: StoreId }>
  /**
   * Land the package as a synced landing (`ExtensionService.installPackage` with `synced`):
   * turned off, `pendingApproval`, pinned to the toolbar as the record says, the switches'
   * clocks the record's, never loaded. `'in-progress'` when the id is busy or landed meanwhile
   * on another path.
   */
  install(
    pkg: ExtensionPackage,
    store: StoreId,
    data: SyncedExtensionData
  ): Promise<'installed' | 'in-progress'>
  remove(id: string): Promise<void>
  /** The switch written under the record's clock for it (`ExtensionService.switchEnabled`). */
  setEnabled(id: string, enabled: boolean, at: number): Promise<void>
  setToolbarPinned(id: string, pinned: boolean, at: number): void
  /**
   * Commit the registry unchanged, so the engine's next state broadcast publishes this
   * device's copy of the record under a fresh stamp (a winner that landed nothing here while
   * this device's clocks are the later ones).
   */
  republish(id: string): void
  /** The removal's toast: the device it came from, Undo reinstalling from `store`. */
  toastRemoved(record: SyncedExtensionRecord, store: StoreId, from: string | null): void
  /** The one console line per failed install. */
  error(message: string): void
  now(): number
  /**
   * The extension layer's startup hold (`platform/index.ts`), or null on a host without one.
   * `ExtensionService` seats a `StartupHoldSlot` here: the hold is handed over after the
   * service is built, and a round before the hand-over must queue, not run.
   */
  hold: SyncStartupHold | null
}

/** What the applier asks of the extension layer's startup hold: `StartupHold.run`'s shape. */
export interface SyncStartupHold {
  run(fn: () => void): void
}

/**
 * The applier's seat for the extension layer's startup hold before the hold is known
 * (Desktop's read of #715, round 4): `ExtensionService` builds its applier in its constructor
 * and `platform/index.ts` hands the hold over afterwards (`extensionService.startupHold = …`,
 * before `browser.start`). A `run` that comes BEFORE the assignment queues – nothing is applied
 * on a device whose hold is not yet known, exactly as nothing is while the hold is closed – and
 * the queue is handed to the hold's own `run` at the assignment, in order, which runs it at
 * once if the hold is open and once it opens otherwise. A host without a hold assigns null: the
 * queue runs then, and every later `run` runs at once. `whenAttached` alone is not this guard:
 * it says the startup loads are through, not that the layer's hold has been seated.
 */
export class StartupHoldSlot implements SyncStartupHold {
  /** Undefined until `assign`: the not-yet-assigned state that queues. */
  private hold: SyncStartupHold | null | undefined = undefined
  private queued: Array<() => void> = []

  /** Whether the hold has been handed over (null counts: a host without one). */
  get assigned(): boolean {
    return this.hold !== undefined
  }

  /** The hold (or null for a host without one): what queued before runs through it now, in order. */
  assign(hold: SyncStartupHold | null): void {
    this.hold = hold
    const queued = this.queued
    this.queued = []
    for (const fn of queued) this.run(fn)
  }

  run(fn: () => void): void {
    if (this.hold === undefined) {
      this.queued.push(fn)
      return
    }
    if (this.hold) this.hold.run(fn)
    else fn()
  }
}

export class ExtensionSyncApplier {
  /** The work queued per id, in the order the records came (`enqueue`). */
  private readonly chains = new Map<string, Promise<void>>()
  private readonly backoff = new Map<string, SyncInstallBackoff>()
  /** The records handed over and not done yet, by id: how many (`inFlight`). */
  private readonly holding = new Map<string, number>()
  /** One per `apply`, rising: which hand-over a queued record came from (`declined`). */
  private handovers = 0
  /** The hand-over the user's decline of the id's landing came after, by id (`declined`). */
  private readonly declines = new Map<string, number>()

  constructor(private readonly host: ExtensionSyncHost) {}

  /**
   * The records of one round: queued per id, after the startup hold if it is closed. Each id
   * is in flight from this call – synchronously, before the engine re-snapshots the round –
   * until its record's work is done.
   */
  apply(changes: readonly SyncedExtensionChange[]): void {
    this.handovers += 1
    const handover = this.handovers
    for (const change of changes)
      this.holding.set(change.id, (this.holding.get(change.id) ?? 0) + 1)
    const run = (): void => {
      for (const change of changes) this.enqueue(change.id, () => this.applyOne(change, handover))
    }
    if (this.host.hold) this.host.hold.run(run)
    else run()
  }

  /**
   * The user removed the id's synced landing before approving it (`ExtensionService.remove` on
   * a `pendingApproval` record; the lead's ruling, round 4): the decline closes the request on
   * this device alone – the engine tombstones nothing and stops re-handing the peer's record
   * (`Persisted.declinedExtensions`) – and a live record for the id handed over BEFORE this
   * call and still queued (behind the startup hold, the attach, the id's busy work) lands
   * nothing: it would put the landing back the user just declined. A record handed over after
   * it (the engine's re-offer, a fresh install on the peer) runs as any. A tombstone's removal
   * of a pending landing marks the same, harmlessly: a record from before a tombstone is stale
   * as well.
   */
  declined(id: string): void {
    this.declines.set(id, this.handovers)
  }

  /** The ids with a record handed over and not done (`ExtensionHost.syncedExtensionsInFlight`). */
  inFlight(): ReadonlySet<string> {
    return new Set(this.holding.keys())
  }

  /** Every queued record has been acted on (a test's wait; the chains empty themselves). */
  async settled(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()])
  }

  /** The back-off standing for an id, or undefined when its last install landed or none was tried. */
  backoffOf(id: string): SyncInstallBackoff | undefined {
    return this.backoff.get(id)
  }

  private enqueue(id: string, work: () => Promise<void>): void {
    const previous = this.chains.get(id) ?? Promise.resolve()
    const next: Promise<void> = previous.then(work, work).then(
      () => {
        this.release(id)
        if (this.chains.get(id) === next) this.chains.delete(id)
      },
      (error: unknown) => {
        this.release(id)
        if (this.chains.get(id) === next) this.chains.delete(id)
        this.host.error(
          `[zen] extensions: applying a synced record for ${id} failed: ${(error as Error).message}`
        )
      }
    )
    this.chains.set(id, next)
  }

  private release(id: string): void {
    const count = this.holding.get(id) ?? 0
    if (count <= 1) this.holding.delete(id)
    else this.holding.set(id, count - 1)
  }

  private async applyOne(change: SyncedExtensionChange, handover: number): Promise<void> {
    // Every path waits for the host's startup loads and for the id's own busy work; the record
    // is read after both, as the work in flight may have changed it.
    await this.host.whenAttached()
    await this.host.whenIdle(change.id)
    const record = this.host.record(change.id)
    if (change.data === null) {
      // The tombstone: a store install goes; an unpacked or file copy under the id is this
      // device's own. Nothing to remove needs no toast.
      if (!record) return
      const store = extensionStoreOf(record.source)
      if (!store) return
      await this.host.remove(change.id)
      this.host.toastRemoved(record, store, change.from)
      return
    }
    // A live record handed over before the user declined the id's landing here is stale
    // (`declined`): it lands nothing, least of all the landing again.
    const declinedAfter = this.declines.get(change.id)
    if (declinedAfter !== undefined && handover <= declinedAfter) return
    if (!record) {
      await this.installAbsent(change.id, change.data)
      return
    }
    // Present: the switches, through the ordinary paths. A copy from a file or a folder under
    // the id is not the synced extension and takes nothing.
    if (!extensionStoreOf(record.source)) return
    await this.mergeSwitches(record, change.data)
  }

  /**
   * The switch-by-switch merge: each switch from the record when the record's clock for it is
   * not older than this device's (ties take the record's; an equal value under a later clock
   * adopts the clock alone), kept otherwise. Nothing landed while a clock here is the later one
   * → `republish`, so the peer merges this device's copy. A withheld enable (approval waits
   * here) lands nothing and, on its own, re-publishes nothing – the peer's copy stands until the
   * approval's own write travels – but it is no early exit: the pin's merge stands as made,
   * and a pin clock here later than the record's still re-publishes, so the two copies do not
   * stay divergent until the next flip (a pin flipped here while the landing waits, and the
   * peer's copy still unpinned).
   */
  private async mergeSwitches(
    record: SyncedExtensionRecord,
    remote: SyncedExtensionData
  ): Promise<void> {
    let landed = false
    const pinAt = record.toolbarPinnedAt ?? 0
    const pinFromRecord = remote.toolbarPinnedAt >= pinAt
    if (
      pinFromRecord &&
      (record.toolbarPinned !== remote.toolbarPinned || remote.toolbarPinnedAt > pinAt)
    ) {
      this.host.setToolbarPinned(record.id, remote.toolbarPinned, remote.toolbarPinnedAt)
      landed = true
    }
    const enabledAt = record.enabledAt ?? 0
    const enabledFromRecord = remote.enabledAt >= enabledAt
    if (
      enabledFromRecord &&
      (record.enabled !== remote.enabled || remote.enabledAt > enabledAt) &&
      !(remote.enabled && awaitsApproval(record))
    ) {
      await this.host.setEnabled(record.id, remote.enabled, remote.enabledAt)
      landed = true
    }
    if (!landed && (!pinFromRecord || !enabledFromRecord)) this.host.republish(record.id)
  }

  private async installAbsent(id: string, data: SyncedExtensionData): Promise<void> {
    const now = this.host.now()
    const standing = this.backoff.get(id)
    if (standing && now < standing.nextAttemptAt) return
    try {
      const download = await this.host.download(id, data.store)
      const outcome = await this.host.install(download.pkg, download.store, data)
      if (outcome === 'installed') this.backoff.delete(id)
    } catch (error) {
      const failures = (standing?.failures ?? 0) + 1
      const wait = syncInstallBackoffMs(failures)
      this.backoff.set(id, { failures, lastAttemptAt: now, nextAttemptAt: now + wait })
      this.host.error(
        `[zen] extensions: could not install ${id} from ${storeLabel(data.store)} for sync: ${(error as Error).message}; next try in ${describeWait(wait)}`
      )
    }
  }
}

/**
 * The removal toast's message, the lead's words as ruled (round 4): the extension named in BOTH
 * forms, then where it went – `uBlock Origin removed on Pixel 9`, or `uBlock Origin removed on
 * another device` when the engine could not name the device (a record read before the name was
 * kept) – with Undo beside it. A registry record always carries its manifest's name; were the
 * name empty all the same, the id stands in for it, so the line still says which extension
 * went – never the bare word "Extension".
 */
export function syncedRemovalToast(
  record: Pick<ExtensionRecord, 'id' | 'name'>,
  from: string | null
): string {
  const name = record.name.trim() || record.id
  return `${name} removed on ${from ?? 'another device'}`
}

/**
 * Whether turning the extension on is the user's to do on this device – a synced landing not
 * approved yet, or an update's new permissions waiting (`pendingWarnings`) – so a record's
 * `enabled: true` lands nothing.
 */
export function awaitsApproval(record: SyncedExtensionRecord): boolean {
  return record.pendingApproval === true || (record.pendingWarnings?.length ?? 0) > 0
}

/**
 * The clock the Enabled switch is written under when a flip of it goes through
 * (`ExtensionService.switchEnabled`): a synced record's flip carries the record's own clock
 * (`at`); the user's flip (`at` null) takes the device's time when the flip COMPLETES – once
 * the prompts it may raise (`prompts`: a synced landing's approval, an update's pending
 * permission warnings) are answered – never the click's. A peer's flip that landed while the
 * prompt stood open wrote a later clock than the click's; stamped at the click, the approval
 * the user then gave would read as the older write and lose the merge (ID-44). Null when a
 * prompt was declined: nothing is written.
 */
export async function flipClock(
  at: number | null,
  prompts: () => Promise<boolean>,
  now: () => number = Date.now
): Promise<number | null> {
  if (!(await prompts())) return null
  return at ?? now()
}

/**
 * The prompt a synced landing's first enable shows (`ExtensionService.setEnabled`): the install
 * prompt an install made here would have shown – `kind: 'install'`, the extension's name and
 * icon, every permission warning of its manifest (`permissionWarningLines`), the store it came
 * from – before the extension runs for the first time. Declined, the extension stays off and
 * waiting; accepted, `pendingApproval` is cleared and the ordinary enable follows.
 */
export function approvalPrompt(
  record: Pick<ExtensionRecord, 'name' | 'source'>,
  warnings: string[],
  icon: string | null
): InstallConfirmation {
  return { kind: 'install', name: record.name, icon, warnings, source: record.source }
}

function describeWait(ms: number): string {
  if (ms >= 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))} h`
  return `${Math.round(ms / 60_000)} min`
}
