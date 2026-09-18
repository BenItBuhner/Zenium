/**
 * `chrome.browsingData`, the pure part: Chrome's `RemovalOptions` and `DataTypeSet`, what each
 * data type maps to (a session storage kind, the cache, the history model, the downloads list,
 * or nothing Zenium keeps), and the `settings()` answer.
 */

export const DATA_TYPES = [
  'appcache',
  'cache',
  'cacheStorage',
  'cookies',
  'downloads',
  'fileSystems',
  'formData',
  'history',
  'indexedDB',
  'localStorage',
  'passwords',
  'pluginData',
  'serviceWorkers',
  'webSQL'
] as const

export type DataType = (typeof DATA_TYPES)[number]

export type DataTypeSet = Partial<Record<DataType, boolean>>

export interface OriginTypes {
  unprotectedWeb?: boolean
  protectedWeb?: boolean
  extension?: boolean
}

export interface RemovalOptions {
  /** Milliseconds since the epoch; 0 (the default) means everything. */
  since: number
  originTypes: OriginTypes
  origins: string[] | null
  excludeOrigins: string[] | null
}

/** The storage kinds `session.clearStorageData` knows, as Electron names them. */
export type StorageKind =
  | 'cookies'
  | 'filesystem'
  | 'indexdb'
  | 'localstorage'
  | 'shadercache'
  | 'serviceworkers'
  | 'cachestorage'

/**
 * Types with nothing behind them in this engine (no application cache, form-data store, plugin
 * data or WebSQL): removing them succeeds with nothing to do.
 */
export const EMPTY_TYPES: readonly DataType[] = ['appcache', 'formData', 'pluginData', 'webSQL']

/** What removing a data type means in Zenium. */
export interface RemovalPlan {
  storages: StorageKind[]
  cache: boolean
  history: boolean
  downloads: boolean
  /** The `EMPTY_TYPES` asked for, for the record. */
  empty: DataType[]
}

export const ERROR_INVALID_OPTIONS = 'Invalid removal options'
export const ERROR_INVALID_DATA_TYPES = 'Invalid data type set'
export const ERROR_ORIGINS_BOTH = 'Only one of `origins` and `excludeOrigins` may be specified.'
export const ERROR_EXCLUDE_ORIGINS =
  'browsingData: `excludeOrigins` is not supported in Zenium (its storage is cleared whole or per origin).'
export const ERROR_PASSWORDS =
  "browsingData: saved passwords are the user's; extensions cannot remove them."
export const ERROR_NO_PERMISSION = "The extension does not have the 'browsingData' permission."

export class BrowsingDataError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function originList(raw: unknown, key: string): string[] | null {
  if (raw === undefined) return null
  if (!Array.isArray(raw) || !raw.every((o) => typeof o === 'string')) {
    throw new BrowsingDataError(`${ERROR_INVALID_OPTIONS}: ${key}`)
  }
  const origins: string[] = []
  for (const value of raw as string[]) {
    let origin: string
    try {
      origin = new URL(value).origin
    } catch {
      throw new BrowsingDataError(`${ERROR_INVALID_OPTIONS}: ${key}`)
    }
    if (origin === 'null') throw new BrowsingDataError(`${ERROR_INVALID_OPTIONS}: ${key}`)
    if (!origins.includes(origin)) origins.push(origin)
  }
  return origins
}

export function normalizeRemovalOptions(raw: unknown): RemovalOptions {
  if (raw === undefined || raw === null) {
    return { since: 0, originTypes: {}, origins: null, excludeOrigins: null }
  }
  if (!isRecord(raw)) throw new BrowsingDataError(ERROR_INVALID_OPTIONS)
  let since = 0
  if (raw.since !== undefined) {
    if (typeof raw.since !== 'number' || !Number.isFinite(raw.since)) {
      throw new BrowsingDataError(ERROR_INVALID_OPTIONS)
    }
    since = Math.max(0, raw.since)
  }
  const originTypes: OriginTypes = {}
  if (raw.originTypes !== undefined) {
    if (!isRecord(raw.originTypes)) throw new BrowsingDataError(ERROR_INVALID_OPTIONS)
    for (const key of ['unprotectedWeb', 'protectedWeb', 'extension'] as const) {
      const value = raw.originTypes[key]
      if (value === undefined) continue
      if (typeof value !== 'boolean') throw new BrowsingDataError(ERROR_INVALID_OPTIONS)
      originTypes[key] = value
    }
  }
  const origins = originList(raw.origins, 'origins')
  const excludeOrigins = originList(raw.excludeOrigins, 'excludeOrigins')
  if (origins && excludeOrigins) throw new BrowsingDataError(ERROR_ORIGINS_BOTH)
  return { since, originTypes, origins, excludeOrigins }
}

export function normalizeDataTypeSet(raw: unknown): DataType[] {
  if (!isRecord(raw)) throw new BrowsingDataError(ERROR_INVALID_DATA_TYPES)
  const types: DataType[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new BrowsingDataError(ERROR_INVALID_DATA_TYPES)
    if (!value) continue
    if (!(DATA_TYPES as readonly string[]).includes(key)) {
      throw new BrowsingDataError(`${ERROR_INVALID_DATA_TYPES}: ${key}`)
    }
    types.push(key as DataType)
  }
  return types
}

const STORAGE_OF: Partial<Record<DataType, StorageKind>> = {
  cacheStorage: 'cachestorage',
  cookies: 'cookies',
  fileSystems: 'filesystem',
  indexedDB: 'indexdb',
  localStorage: 'localstorage',
  serviceWorkers: 'serviceworkers'
}

/** What each requested type comes to; `passwords` is refused outright. */
export function planRemoval(types: readonly DataType[]): RemovalPlan {
  const plan: RemovalPlan = {
    storages: [],
    cache: false,
    history: false,
    downloads: false,
    empty: []
  }
  for (const type of types) {
    const storage = STORAGE_OF[type]
    if (storage) {
      if (!plan.storages.includes(storage)) plan.storages.push(storage)
      continue
    }
    if (EMPTY_TYPES.includes(type)) {
      plan.empty.push(type)
      continue
    }
    switch (type) {
      case 'cache':
        plan.cache = true
        break
      case 'history':
        plan.history = true
        break
      case 'downloads':
        plan.downloads = true
        break
      case 'passwords':
        throw new BrowsingDataError(ERROR_PASSWORDS)
    }
  }
  return plan
}

/**
 * `browsingData.settings()`: what the browser's own "clear browsing data" clears by default
 * (history, cookies and site data, the cache) and what an extension may remove (everything but
 * saved passwords).
 */
export function browsingDataSettings(): {
  options: { since: number; originTypes: Required<OriginTypes> }
  dataToRemove: DataTypeSet
  dataRemovalPermitted: DataTypeSet
} {
  const permitted: DataTypeSet = {}
  const remove: DataTypeSet = {}
  for (const type of DATA_TYPES) {
    permitted[type] = type !== 'passwords'
    remove[type] = type === 'history' || type === 'cache' || Boolean(STORAGE_OF[type])
  }
  return {
    options: {
      since: 0,
      originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false }
    },
    dataToRemove: remove,
    dataRemovalPermitted: permitted
  }
}
