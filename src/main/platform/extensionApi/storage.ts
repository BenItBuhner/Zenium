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

/**
 * `chrome.storage` backends the engine lacks: `sync` (a per-extension JSON store shared by every
 * container partition) and `managed` (read-only policy files), plus the `onChanged` fan-out for
 * every area – the engine never delivers storage events to MV3 workers, so the shim reports
 * `local` / `session` writes here and this module tells every context of the extension.
 */
export class StorageApi {
  /** Write timestamps per extension, for the `sync` rate limits. */
  private readonly syncWrites = new Map<string, number[]>()
  /** In-memory fallback for `local` / `session` in a context whose engine bindings are missing. */
  private readonly fallback = new Map<string, StorageItems>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx, area, keys) => this.get(ctx, area, keys),
    set: (ctx, area, items) => this.set(ctx, area, items),
    remove: (ctx, area, keys) => this.remove(ctx, area, keys),
    clear: (ctx, area) => this.clear(ctx, area),
    getBytesInUse: (ctx, area, keys) => this.getBytesInUse(ctx, area, keys),
    getKeys: (ctx, area) => Object.keys(this.items(ctx, area)),
    setAccessLevel: (_ctx, area) => {
      this.areaOf(area)
    }
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

  private commit(ctx: ApiContext, area: StorageArea, next: StorageItems, changes: StorageChanges): void {
    if (area === 'sync') this.host.store.setSyncItems(ctx.extensionId, next)
    else this.fallback.set(`${ctx.extensionId}:${area}`, next)
    if (Object.keys(changes).length > 0) {
      this.fanOut(ctx.extensionId, area, changes, area === 'sync' ? null : ctx.session)
    }
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

  private set(ctx: ApiContext, area: unknown, items: unknown): void {
    const name = this.areaOf(area)
    if (name === 'managed') throw new ApiError('This is a read-only store.')
    if (!isRecord(items)) throw new ApiError('Invalid items')
    if (name === 'sync') this.checkSyncRate(ctx.extensionId)
    const result = applySet(this.items(ctx, area), items, name === 'sync' ? SYNC_QUOTA : null)
    if (result.error) throw new ApiError(result.error)
    this.commit(ctx, name, result.next, result.changes)
  }

  private remove(ctx: ApiContext, area: unknown, keys: unknown): void {
    const name = this.areaOf(area)
    if (name === 'managed') throw new ApiError('This is a read-only store.')
    if (typeof keys !== 'string' && !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))) {
      throw new ApiError('Invalid keys')
    }
    if (name === 'sync') this.checkSyncRate(ctx.extensionId)
    const result = applyRemove(this.items(ctx, area), keys as string | string[])
    this.commit(ctx, name, result.next, result.changes)
  }

  private clear(ctx: ApiContext, area: unknown): void {
    const name = this.areaOf(area)
    if (name === 'managed') throw new ApiError('This is a read-only store.')
    if (name === 'sync') this.checkSyncRate(ctx.extensionId)
    const result = applyClear(this.items(ctx, area))
    this.commit(ctx, name, result.next, result.changes)
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
