import type { Session } from 'electron'
import {
  SYNC_QUOTA,
  applyClear,
  applyRemove,
  applySet,
  bytesInUse,
  selectItems,
  type StorageArea,
  type StorageChanges,
  type StorageItems
} from '../../../core/extensions/api/storage'
import { ApiError, isRecord, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

const AREAS: readonly StorageArea[] = ['local', 'sync', 'session', 'managed']

/** The `sync` writes a content script's prelude proxies through the shim (`syncWrite`). */
const SYNC_WRITE_OPS = ['set', 'remove', 'clear'] as const
type SyncWriteOp = (typeof SYNC_WRITE_OPS)[number]

/**
 * A change to the extension's `sync` (or `managed`) items, numbered: what every context's shim
 * writes into its partition's native `local` under the content-script prelude's reserved keys
 * (`__zen.sync-mirror`), and what `syncWrite` answers with. `seq` counts the extension's changes
 * in this process; a context that sees a gap takes the snapshot (`syncMirror`) again.
 */
export interface SyncMirrorChange {
  seq: number
  sync?: StorageChanges
  managed?: StorageChanges
}

/** The snapshot a context starts its partition's mirror from. */
export interface SyncMirrorSnapshot {
  seq: number
  sync: StorageItems
  managed: StorageItems
}

/**
 * `chrome.storage` backends the engine lacks: `sync` (a per-extension JSON store shared by every
 * container partition) and `managed` (read-only policy files), plus the `onChanged` fan-out for
 * every area – the engine never delivers storage events to MV3 workers, so the shim reports
 * `local` / `session` writes here and this module tells every context of the extension.
 *
 * Content scripts have neither area natively; their prelude (`contentScriptStorage.ts`) reads a
 * mirror of both from reserved keys of the partition's `local` and sends its writes to the
 * extension's own worker or background page, whose shim calls `syncWrite` here. This module is
 * the single writer of `sync`: every change is numbered and pushed to every live context
 * (`__zen.sync-mirror`), and a partition with no live context gets its worker started so the
 * mirror there catches up.
 */
export class StorageApi {
  /** Write timestamps per extension, for the `sync` rate limits. */
  private readonly syncWrites = new Map<string, number[]>()
  /** In-memory fallback for `local` / `session` in a context whose engine bindings are missing. */
  private readonly fallback = new Map<string, StorageItems>()
  /** The sequence number of the last `sync` / `managed` change per extension (this process). */
  private readonly syncSeq = new Map<string, number>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx, area, keys) => this.get(ctx, area, keys),
    set: (ctx, area, items) => {
      this.set(ctx, area, items)
    },
    remove: (ctx, area, keys) => {
      this.remove(ctx, area, keys)
    },
    clear: (ctx, area) => {
      this.clear(ctx, area)
    },
    getBytesInUse: (ctx, area, keys) => this.getBytesInUse(ctx, area, keys),
    getKeys: (ctx, area) => Object.keys(this.items(ctx, area)),
    setAccessLevel: (_ctx, area) => {
      this.areaOf(area)
    },
    syncWrite: (ctx, op, args) => this.syncWrite(ctx, op, args),
    syncMirror: (ctx) => this.syncMirror(ctx)
  }

  private areaOf(area: unknown): StorageArea {
    if (typeof area !== 'string' || !AREAS.includes(area as StorageArea)) {
      throw new ApiError('Unknown storage area')
    }
    return area as StorageArea
  }

  private items(ctx: ApiContext, area: unknown): StorageItems {
    const name = this.areaOf(area)
    switch (name) {
      case 'sync':
        return this.host.store.syncItems(ctx.extensionId)
      case 'managed':
        return this.host.store.managedItems(ctx.extensionId)
      default:
        return this.fallback.get(`${ctx.extensionId}:${name}`) ?? {}
    }
  }

  /** Commits, and for `sync` numbers the change and pushes it to the contexts' mirrors. */
  private commit(
    ctx: ApiContext,
    area: StorageArea,
    next: StorageItems,
    changes: StorageChanges
  ): SyncMirrorChange {
    if (area === 'sync') this.host.store.setSyncItems(ctx.extensionId, next)
    else this.fallback.set(`${ctx.extensionId}:${area}`, next)
    const changed = Object.keys(changes).length > 0
    if (changed) this.fanOut(ctx.extensionId, area, changes, area === 'sync' ? null : ctx.session)
    if (area !== 'sync' || !changed) return { seq: this.syncSeq.get(ctx.extensionId) ?? 0 }
    const seq = (this.syncSeq.get(ctx.extensionId) ?? 0) + 1
    this.syncSeq.set(ctx.extensionId, seq)
    const change: SyncMirrorChange = { seq, sync: changes }
    this.host.dispatch(ctx.extensionId, '__zen', 'sync-mirror', [change])
    void this.wakeIdlePartitions(ctx.extensionId)
    return change
  }

  /**
   * A content script's `sync` write, relayed by the shim of the extension's worker or background
   * page: committed like the context's own, answered with the numbered change so the relaying
   * shim writes it into its partition's mirror before it replies to the content script.
   */
  private syncWrite(ctx: ApiContext, op: unknown, args: unknown): SyncMirrorChange {
    if (typeof op !== 'string' || !(SYNC_WRITE_OPS as readonly string[]).includes(op)) {
      throw new ApiError('Invalid sync write')
    }
    const list = Array.isArray(args) ? args : []
    switch (op as SyncWriteOp) {
      case 'set':
        return this.set(ctx, 'sync', list[0])
      case 'remove':
        return this.remove(ctx, 'sync', list[0])
      case 'clear':
        return this.clear(ctx, 'sync')
    }
  }

  private syncMirror(ctx: ApiContext): SyncMirrorSnapshot {
    return {
      seq: this.syncSeq.get(ctx.extensionId) ?? 0,
      sync: this.host.store.syncItems(ctx.extensionId),
      managed: this.host.store.managedItems(ctx.extensionId)
    }
  }

  /**
   * The mirror of a partition is written by the extension's contexts in that partition; where
   * none is alive the worker is started through the registry (which wires the wrapper the start
   * resolves with), and its shim takes the snapshot. The primary partition's worker is woken by
   * the dispatch itself when it registered the event before it stopped; a partition with no
   * registration yet is left to its next context.
   */
  private async wakeIdlePartitions(extensionId: string): Promise<void> {
    const loaded = this.host.loaded(extensionId)
    if (!loaded || loaded.manifest.manifest_version !== 3) return
    const live = new Set<Session>()
    for (const frame of this.host.registry.framesOf(extensionId)) live.add(frame.session)
    for (const worker of this.host.registry.workersOf(extensionId)) live.add(worker.session)
    const idle = loaded.sessions.filter((session) => !live.has(session))
    await Promise.all(idle.map((session) => this.host.registry.wakeIn(extensionId, session)))
  }

  private get(ctx: ApiContext, area: unknown, keys: unknown): StorageItems {
    if (
      keys !== undefined &&
      keys !== null &&
      typeof keys !== 'string' &&
      !Array.isArray(keys) &&
      !isRecord(keys)
    ) {
      throw new ApiError('Invalid keys')
    }
    return selectItems(this.items(ctx, area), keys as null | string | string[] | StorageItems)
  }

  private set(ctx: ApiContext, area: unknown, items: unknown): SyncMirrorChange {
    const name = this.areaOf(area)
    if (name === 'managed') throw new ApiError('This is a read-only store.')
    if (!isRecord(items)) throw new ApiError('Invalid items')
    if (name === 'sync') this.checkSyncRate(ctx.extensionId)
    const result = applySet(this.items(ctx, area), items, name === 'sync' ? SYNC_QUOTA : null)
    if (result.error) throw new ApiError(result.error)
    return this.commit(ctx, name, result.next, result.changes)
  }

  private remove(ctx: ApiContext, area: unknown, keys: unknown): SyncMirrorChange {
    const name = this.areaOf(area)
    if (name === 'managed') throw new ApiError('This is a read-only store.')
    if (
      typeof keys !== 'string' &&
      !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))
    ) {
      throw new ApiError('Invalid keys')
    }
    if (name === 'sync') this.checkSyncRate(ctx.extensionId)
    const result = applyRemove(this.items(ctx, area), keys as string | string[])
    return this.commit(ctx, name, result.next, result.changes)
  }

  private clear(ctx: ApiContext, area: unknown): SyncMirrorChange {
    const name = this.areaOf(area)
    if (name === 'managed') throw new ApiError('This is a read-only store.')
    if (name === 'sync') this.checkSyncRate(ctx.extensionId)
    const result = applyClear(this.items(ctx, area))
    return this.commit(ctx, name, result.next, result.changes)
  }

  private getBytesInUse(ctx: ApiContext, area: unknown, keys: unknown): number {
    if (keys !== undefined && keys !== null && typeof keys !== 'string' && !Array.isArray(keys)) {
      throw new ApiError('Invalid keys')
    }
    return bytesInUse(this.items(ctx, area), keys as null | string | string[])
  }

  private checkSyncRate(extensionId: string): void {
    const now = Date.now()
    const writes = (this.syncWrites.get(extensionId) ?? []).filter((t) => now - t < 3_600_000)
    const lastMinute = writes.filter((t) => now - t < 60_000).length
    if (lastMinute >= SYNC_QUOTA.MAX_WRITE_OPERATIONS_PER_MINUTE) {
      throw new ApiError('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded')
    }
    if (writes.length >= SYNC_QUOTA.MAX_WRITE_OPERATIONS_PER_HOUR) {
      throw new ApiError('MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded')
    }
    writes.push(now)
    this.syncWrites.set(extensionId, writes)
  }

  // ---------------------------------------------------------------------------
  // Change fan-out
  // ---------------------------------------------------------------------------

  /**
   * A context reports a `local` / `session` write it made through the engine's own bindings.
   * Those areas belong to one container partition, so only the extension's contexts in the same
   * session hear about it (documents in that session also get the engine's native event; the
   * shim drops the duplicate).
   */
  changed(ctx: ApiContext, payload: unknown): void {
    if (!isRecord(payload) || !isRecord(payload.changes)) return
    const area = payload.area
    if (area !== 'local' && area !== 'session') return
    this.fanOut(ctx.extensionId, area, payload.changes as StorageChanges, ctx.session)
  }

  private fanOut(
    extensionId: string,
    area: StorageArea,
    changes: StorageChanges,
    onlySession: Session | null
  ): void {
    const filter = onlySession ? (session: Session) => session === onlySession : undefined
    this.host.dispatch(extensionId, 'storage', 'onChanged', [changes, area], { session: filter })
    this.host.dispatch(extensionId, `storage.${area}`, 'onChanged', [changes], { session: filter })
  }

  forget(extensionId: string): void {
    this.syncWrites.delete(extensionId)
    for (const key of [...this.fallback.keys()]) {
      if (key.startsWith(`${extensionId}:`)) this.fallback.delete(key)
    }
  }
}
