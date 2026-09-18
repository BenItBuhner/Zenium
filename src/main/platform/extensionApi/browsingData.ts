import type { Session } from 'electron'
import { isInFlight } from '../../../core/downloads'
import {
  BrowsingDataError,
  ERROR_EXCLUDE_ORIGINS,
  ERROR_NO_PERMISSION,
  browsingDataSettings,
  normalizeDataTypeSet,
  normalizeRemovalOptions,
  planRemoval,
  type DataType,
  type RemovalOptions,
  type StorageKind
} from '../../../core/extensions/api/browsingData'
import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/** The engine-side clearing, so the API module stays testable without Electron sessions. */
export interface DataClearer {
  clearStorage(ses: Session, storages: StorageKind[], origin: string | null): Promise<void>
  clearCache(ses: Session): Promise<void>
}

export const electronDataClearer: DataClearer = {
  clearStorage: (ses, storages, origin) =>
    ses.clearStorageData(origin ? { origin, storages } : { storages }),
  clearCache: (ses) => ses.clearCache()
}

const REMOVE_ONE: ReadonlyArray<[method: string, type: DataType]> = [
  ['removeAppcache', 'appcache'],
  ['removeCache', 'cache'],
  ['removeCacheStorage', 'cacheStorage'],
  ['removeCookies', 'cookies'],
  ['removeDownloads', 'downloads'],
  ['removeFileSystems', 'fileSystems'],
  ['removeFormData', 'formData'],
  ['removeHistory', 'history'],
  ['removeIndexedDB', 'indexedDB'],
  ['removeLocalStorage', 'localStorage'],
  ['removePasswords', 'passwords'],
  ['removePluginData', 'pluginData'],
  ['removeServiceWorkers', 'serviceWorkers'],
  ['removeWebSQL', 'webSQL']
]

/**
 * `chrome.browsingData` over the engine's sessions and Zenium's models: site storage and the
 * cache go through `session.clearStorageData` / `clearCache` in every session the extension is
 * loaded into (whole, or per origin for `origins`), history through the history model's range
 * delete, downloads through the downloads list (rows since `since`; files stay). `since` is
 * honoured for history and downloads; Chromium's storage clearing has no time filter, so
 * storage and cache always go whole. Saved passwords are refused; form and plugin data have no
 * store here and clear as a no-op.
 */
export class BrowsingDataApi {
  constructor(
    private readonly host: ApiHost,
    private readonly clearer: DataClearer,
    private readonly now: () => number = Date.now
  ) {}

  readonly handlers: NamespaceHandlers = {
    settings: (ctx) => this.settings(ctx),
    remove: (ctx, options, types) => this.remove(ctx, options, types),
    ...Object.fromEntries(
      REMOVE_ONE.map(([method, type]) => [
        method,
        (ctx: ApiContext, options: unknown) => this.remove(ctx, options, { [type]: true })
      ])
    )
  }

  private requirePermission(ctx: ApiContext): void {
    if (!this.host.grants(ctx.extensionId).permissions.includes('browsingData')) {
      throw new ApiError(ERROR_NO_PERMISSION)
    }
  }

  private settings(ctx: ApiContext): ReturnType<typeof browsingDataSettings> {
    this.requirePermission(ctx)
    return browsingDataSettings()
  }

  private async remove(ctx: ApiContext, rawOptions: unknown, rawTypes: unknown): Promise<void> {
    this.requirePermission(ctx)
    const options = checked(() => normalizeRemovalOptions(rawOptions))
    const types = checked(() => normalizeDataTypeSet(rawTypes))
    const plan = checked(() => planRemoval(types))
    if (options.excludeOrigins) throw new ApiError(ERROR_EXCLUDE_ORIGINS)
    // Only the open web's data is Zenium's to clear; extension storage and protected web
    // (hosted apps) are not separate here, so an `originTypes` asking for just those is a no-op.
    if (options.originTypes.unprotectedWeb === false) return
    const sessions = ctx.extension.sessions
    const work: Promise<void>[] = []
    if (plan.storages.length > 0) {
      for (const ses of sessions) {
        const origins = options.origins ?? [null]
        for (const origin of origins) {
          work.push(this.clearer.clearStorage(ses, plan.storages, origin))
        }
      }
    }
    if (plan.cache) for (const ses of sessions) work.push(this.clearer.clearCache(ses))
    await Promise.all(work)
    if (plan.history) this.removeHistory(options)
    if (plan.downloads) this.removeDownloads(options)
  }

  private removeHistory(options: RemovalOptions): void {
    const history = this.host.browser.history
    if (options.origins) {
      const origins = new Set(options.origins)
      const ofOrigin = (url: string): boolean => origins.has(originOf(url))
      if (options.since <= 0) {
        // Whole pages: the aggregate goes with its visits.
        const urls = history
          .recent(Number.MAX_SAFE_INTEGER)
          .map((entry) => entry.url)
          .filter(ofOrigin)
        if (urls.length > 0) history.deleteUrls(urls)
      } else {
        const ids = history
          .visits({ fromMs: options.since, limit: Infinity })
          .filter((visit) => ofOrigin(visit.url))
          .map((visit) => visit.id)
        if (ids.length > 0) history.deleteVisits(ids)
      }
      return
    }
    if (options.since <= 0) history.clear()
    else history.deleteRange(options.since, this.now() + 1)
  }

  /** Finished rows started since `since`; a running transfer is not history yet (as in Chromium). */
  private removeDownloads(options: RemovalOptions): void {
    const downloads = this.host.browser.downloads
    const origins = options.origins ? new Set(options.origins) : null
    for (const item of downloads.visibleTo(true)) {
      if (isInFlight(item.state)) continue
      if (item.startedAt < options.since) continue
      if (origins && !origins.has(originOf(item.url))) continue
      downloads.remove(item.id)
    }
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof BrowsingDataError) throw new ApiError(error.message)
    throw error
  }
}
