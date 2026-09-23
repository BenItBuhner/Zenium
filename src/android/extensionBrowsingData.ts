import type { Browser } from '@core/browser'
import type { EngineDataKind } from '@core/platform'
import { isInFlight } from '@core/downloads'
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
} from '@core/extensions/api/browsingData'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'

export const BROWSING_DATA_PERMISSION = 'browsingData'

export const ERROR_ORIGINS_ON_ANDROID =
  'browsingData: per-origin removal of site data is not supported on Zenium for Android (the WebView clears its site storage and cache whole); `origins` applies to history and downloads.'

/** `removeX(options)`: the one type each stands for. */
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
 * The WebView's share of each storage kind: cookies apart (`CookieManager`), everything else a
 * site stored together (`WebStorage` / the one-shot `deleteBrowsingData`; `BrowsingData.kt`).
 */
const ENGINE_KIND_OF: Record<StorageKind, EngineDataKind> = {
  cookies: 'cookies',
  cachestorage: 'storage',
  filesystem: 'storage',
  indexdb: 'storage',
  localstorage: 'storage',
  serviceworkers: 'storage',
  shadercache: 'storage'
}

/** What the browsing-data module needs of the host; the core browser's models and its engine. */
export interface BrowsingDataHost {
  browser: Browser
}

/**
 * `chrome.browsingData` on the phone, the desktop's `BrowsingDataApi` over the WebView: site
 * storage and the cache go through the engine's `clearBrowsingData` (Kotlin's `BrowsingData.clear`
 * on every persistent container's profile: whole, since the WebView has no per-origin or timed
 * clearing), history through the history model's range delete, downloads through the downloads
 * list (rows since `since`; files stay). `origins` is honoured for history and downloads and
 * refused for site data and the cache (clearing everything in an origin's name would over-reach;
 * `deleteBrowsingDataForSite` is the round-12 candidate). Saved passwords are refused; form and
 * plugin data have no store here and clear as a no-op. Clear Cache's Clear (round 11, row 11) is
 * `remove({since, originTypes: {unprotectedWeb: true, …}}, {cache: true})` and a reload.
 */
export class AndroidBrowsingData {
  constructor(
    private readonly host: BrowsingDataHost,
    private readonly now: () => number = Date.now
  ) {}

  /** Handles `chrome.browsingData.<method>`; `holds` says whether the extension has the permission. */
  async call(holds: boolean, method: string, args: unknown[]): Promise<unknown> {
    if (!holds) throw new Error(ERROR_NO_PERMISSION)
    if (method === 'settings') return browsingDataSettings()
    if (method === 'remove') return this.remove(args[0], args[1])
    const one = REMOVE_ONE.find(([name]) => name === method)
    if (one) return this.remove(args[0], { [one[1]]: true })
    return undefined
  }

  private async remove(rawOptions: unknown, rawTypes: unknown): Promise<void> {
    const options = checked(() => normalizeRemovalOptions(rawOptions))
    const types = checked(() => normalizeDataTypeSet(rawTypes))
    const plan = checked(() => planRemoval(types))
    if (options.excludeOrigins) throw new Error(ERROR_EXCLUDE_ORIGINS)
    // Only the open web's data is Zenium's to clear; extension storage and protected web
    // (hosted apps) are not separate here, so an `originTypes` asking for just those is a no-op.
    if (options.originTypes.unprotectedWeb === false) return
    const kinds: EngineDataKind[] = []
    for (const storage of plan.storages) {
      const kind = ENGINE_KIND_OF[storage]
      if (!kinds.includes(kind)) kinds.push(kind)
    }
    if (plan.cache) kinds.push('cache')
    if (kinds.length > 0) {
      if (options.origins) throw new Error(ERROR_ORIGINS_ON_ANDROID)
      const sessions = this.host.browser.platform.sessions
      if (sessions.clearBrowsingData) {
        await sessions.clearBrowsingData(this.containerIds(), kinds)
      } else {
        // A host without the granular call (the preview) drops everything of every container.
        for (const id of this.containerIds()) await sessions.clearContainerData(id)
      }
    }
    if (plan.history) this.removeHistory(options)
    if (plan.downloads) this.removeDownloads(options)
  }

  /** Every persistent container, as the browser's own Clear browsing data reads them (`Privacy`). */
  private containerIds(): string[] {
    const ids = new Set<string>([DEFAULT_CONTAINER_ID])
    for (const container of this.host.browser.state.model.containers) ids.add(container.id)
    ids.delete(PRIVATE_CONTAINER_ID)
    return [...ids]
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
    if (error instanceof BrowsingDataError) throw new Error(error.message)
    throw error
  }
}
