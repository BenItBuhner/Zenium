import { describe, expect, it } from 'vitest'
import {
  DATA_TYPES,
  EMPTY_TYPES,
  ERROR_EXCLUDE_ORIGINS,
  ERROR_INVALID_DATA_TYPES,
  ERROR_INVALID_OPTIONS,
  ERROR_NO_PERMISSION,
  ERROR_ORIGINS_BOTH,
  ERROR_PASSWORDS,
  browsingDataSettings,
  normalizeDataTypeSet,
  normalizeRemovalOptions,
  planRemoval,
  type StorageKind
} from '../api/browsingData'
import { HistoryService } from '../../history'
import type { StoreIO } from '../../platform'
import type { DownloadItem } from '../../../shared/types'
import { BrowsingDataApi, type DataClearer } from '../../../main/platform/extensionApi/browsingData'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)
const HOUR = 3_600_000

describe('chrome.browsingData, the pure part', () => {
  it('normalizes removal options: since, origin types, origins as origins', () => {
    expect(normalizeRemovalOptions(undefined)).toEqual({
      since: 0,
      originTypes: {},
      origins: null,
      excludeOrigins: null
    })
    expect(
      normalizeRemovalOptions({
        since: NOW,
        originTypes: { unprotectedWeb: true, extension: false },
        origins: ['https://a.test/path?x=1', 'https://a.test/other', 'http://b.test:8080/']
      })
    ).toEqual({
      since: NOW,
      originTypes: { unprotectedWeb: true, extension: false },
      origins: ['https://a.test', 'http://b.test:8080'],
      excludeOrigins: null
    })
    expect(normalizeRemovalOptions({ since: -5 }).since).toBe(0)
    expect(() => normalizeRemovalOptions('x')).toThrow(ERROR_INVALID_OPTIONS)
    expect(() => normalizeRemovalOptions({ since: 'yesterday' })).toThrow(ERROR_INVALID_OPTIONS)
    expect(() => normalizeRemovalOptions({ originTypes: { unprotectedWeb: 1 } })).toThrow(
      ERROR_INVALID_OPTIONS
    )
    expect(() => normalizeRemovalOptions({ origins: ['not a url'] })).toThrow(/origins/)
    expect(() => normalizeRemovalOptions({ origins: ['data:text/plain,x'] })).toThrow(/origins/)
    expect(() =>
      normalizeRemovalOptions({ origins: ['https://a.test'], excludeOrigins: ['https://b.test'] })
    ).toThrow(ERROR_ORIGINS_BOTH)
  })

  it('normalizes the data type set to the types asked for', () => {
    expect(normalizeDataTypeSet({ cookies: true, cache: false, history: true })).toEqual([
      'cookies',
      'history'
    ])
    expect(normalizeDataTypeSet({})).toEqual([])
    expect(() => normalizeDataTypeSet(null)).toThrow(ERROR_INVALID_DATA_TYPES)
    expect(() => normalizeDataTypeSet({ cookies: 'yes' })).toThrow(ERROR_INVALID_DATA_TYPES)
    expect(() => normalizeDataTypeSet({ bogus: true })).toThrow(/bogus/)
  })

  it('plans what each type comes to in Zenium', () => {
    expect(
      planRemoval(['cookies', 'localStorage', 'indexedDB', 'cache', 'history', 'downloads'])
    ).toEqual({
      storages: ['cookies', 'localstorage', 'indexdb'],
      cache: true,
      history: true,
      downloads: true,
      empty: []
    })
    expect(planRemoval(['appcache', 'formData', 'pluginData', 'webSQL'])).toEqual({
      storages: [],
      cache: false,
      history: false,
      downloads: false,
      empty: [...EMPTY_TYPES]
    })
    expect(planRemoval(['serviceWorkers', 'cacheStorage', 'fileSystems']).storages).toEqual([
      'serviceworkers',
      'cachestorage',
      'filesystem'
    ] satisfies StorageKind[])
    expect(() => planRemoval(['cookies', 'passwords'])).toThrow(ERROR_PASSWORDS)
  })

  it('reports settings: everything but passwords may go; history, cookies, storage and cache by default', () => {
    const settings = browsingDataSettings()
    expect(settings.options).toEqual({
      since: 0,
      originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false }
    })
    for (const type of DATA_TYPES) {
      expect(settings.dataRemovalPermitted[type]).toBe(type !== 'passwords')
    }
    expect(settings.dataToRemove).toMatchObject({
      history: true,
      cookies: true,
      cache: true,
      localStorage: true,
      downloads: false,
      passwords: false,
      formData: false
    })
  })
})

function fakeIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

interface Cleared {
  session: string
  storages: StorageKind[]
  origin: string | null
}

function download(over: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'd',
    url: 'https://files.test/a.zip',
    state: 'completed',
    startedAt: NOW,
    private: false,
    ...over
  } as DownloadItem
}

function harness(grants: Record<string, string[]>): {
  api: BrowsingDataApi
  history: HistoryService
  downloads: DownloadItem[]
  removedDownloads: string[]
  cleared: Cleared[]
  cacheCleared: string[]
  ctx: (id: string) => ApiContext
  clock: { now: number }
} {
  const clock = { now: NOW }
  const history = new HistoryService(fakeIo(), () => clock.now)
  const downloads: DownloadItem[] = []
  const removedDownloads: string[] = []
  const cleared: Cleared[] = []
  const cacheCleared: string[] = []
  const sessions = [
    { name: 'regular' },
    { name: 'private' }
  ] as unknown as LoadedExtension['sessions']
  const loaded = new Map<string, LoadedExtension>()
  for (const id of Object.keys(grants)) {
    loaded.set(id, { id, sessions } as unknown as LoadedExtension)
  }
  const host = {
    browser: {
      history,
      downloads: {
        visibleTo: () => [...downloads],
        remove: (id: string) => {
          removedDownloads.push(id)
          const at = downloads.findIndex((d) => d.id === id)
          if (at >= 0) downloads.splice(at, 1)
        }
      }
    },
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] })
  }
  const clearer: DataClearer = {
    clearStorage: async (ses, storages, origin) => {
      cleared.push({ session: (ses as unknown as { name: string }).name, storages, origin })
    },
    clearCache: async (ses) => {
      cacheCleared.push((ses as unknown as { name: string }).name)
    }
  }
  const api = new BrowsingDataApi(host as unknown as ApiHost, clearer, () => clock.now)
  const ctx = (id: string): ApiContext =>
    ({ extensionId: id, extension: loaded.get(id) }) as unknown as ApiContext
  return { api, history, downloads, removedDownloads, cleared, cacheCleared, ctx, clock }
}

describe('BrowsingDataApi', () => {
  it('requires the browsingData permission', async () => {
    const h = harness({ ext: ['history'] })
    expect(() => h.api.handlers.settings(h.ctx('ext'))).toThrow(ERROR_NO_PERMISSION)
    await expect(h.api.handlers.removeCache(h.ctx('ext'), {})).rejects.toThrow(ERROR_NO_PERMISSION)
  })

  it('clears site storage and the cache in every session the extension is loaded into', async () => {
    const h = harness({ ext: ['browsingData'] })
    await h.api.handlers.remove(
      h.ctx('ext'),
      {},
      { cookies: true, localStorage: true, cache: true }
    )
    expect(h.cleared).toEqual([
      { session: 'regular', storages: ['cookies', 'localstorage'], origin: null },
      { session: 'private', storages: ['cookies', 'localstorage'], origin: null }
    ])
    expect(h.cacheCleared).toEqual(['regular', 'private'])
  })

  it('clears per origin when origins are given and refuses excludeOrigins', async () => {
    const h = harness({ ext: ['browsingData'] })
    await h.api.handlers.removeCookies(h.ctx('ext'), {
      origins: ['https://a.test/x', 'https://b.test']
    })
    expect(h.cleared).toEqual([
      { session: 'regular', storages: ['cookies'], origin: 'https://a.test' },
      { session: 'regular', storages: ['cookies'], origin: 'https://b.test' },
      { session: 'private', storages: ['cookies'], origin: 'https://a.test' },
      { session: 'private', storages: ['cookies'], origin: 'https://b.test' }
    ])
    await expect(
      h.api.handlers.removeCookies(h.ctx('ext'), { excludeOrigins: ['https://a.test'] })
    ).rejects.toThrow(ERROR_EXCLUDE_ORIGINS)
  })

  it('removes history whole, since a time, or for origins', async () => {
    const h = harness({ ext: ['browsingData'] })
    const ctx = h.ctx('ext')
    h.clock.now = NOW - 3 * HOUR
    h.history.visit('https://old.test/', 'Old', null)
    h.clock.now = NOW - HOUR
    h.history.visit('https://a.test/one', 'A1', null)
    h.clock.now = NOW - 10 * 60_000
    h.history.visit('https://a.test/two', 'A2', null)
    h.history.visit('https://b.test/', 'B', null)
    h.clock.now = NOW

    await h.api.handlers.removeHistory(ctx, { since: NOW - 2 * HOUR, origins: ['https://a.test'] })
    expect(
      h.history
        .recent(10)
        .map((e) => e.url)
        .sort()
    ).toEqual(['https://b.test/', 'https://old.test/'])

    h.history.visit('https://a.test/three', 'A3', null)
    await h.api.handlers.removeHistory(ctx, { origins: ['https://a.test'] })
    expect(
      h.history
        .recent(10)
        .map((e) => e.url)
        .sort()
    ).toEqual(['https://b.test/', 'https://old.test/'])

    await h.api.handlers.removeHistory(ctx, { since: NOW - 2 * HOUR })
    expect(h.history.recent(10).map((e) => e.url)).toEqual(['https://old.test/'])

    await h.api.handlers.remove(ctx, {}, { history: true })
    expect(h.history.recent(10)).toEqual([])
    expect(h.cleared).toEqual([])
  })

  it('removes finished download rows since a time, leaving running transfers alone', async () => {
    const h = harness({ ext: ['browsingData'] })
    h.downloads.push(
      download({ id: 'old', startedAt: NOW - 3 * HOUR }),
      download({ id: 'recent', startedAt: NOW - HOUR }),
      download({ id: 'running', startedAt: NOW - HOUR, state: 'progressing' }),
      download({ id: 'other', startedAt: NOW - HOUR, url: 'https://elsewhere.test/b.zip' })
    )
    await h.api.handlers.removeDownloads(h.ctx('ext'), {
      since: NOW - 2 * HOUR,
      origins: ['https://files.test']
    })
    expect(h.removedDownloads).toEqual(['recent'])
    await h.api.handlers.removeDownloads(h.ctx('ext'), {})
    expect(h.removedDownloads).toEqual(['recent', 'old', 'other'])
    expect(h.downloads.map((d) => d.id)).toEqual(['running'])
  })

  it('refuses passwords, clears nothing for types with nothing behind them, honours originTypes', async () => {
    const h = harness({ ext: ['browsingData'] })
    const ctx = h.ctx('ext')
    await expect(h.api.handlers.removePasswords(ctx, {})).rejects.toThrow(ERROR_PASSWORDS)
    await expect(
      h.api.handlers.remove(ctx, {}, { cookies: true, passwords: true })
    ).rejects.toThrow(ERROR_PASSWORDS)
    await h.api.handlers.removeFormData(ctx, {})
    await h.api.handlers.removeWebSQL(ctx, {})
    await h.api.handlers.remove(
      ctx,
      { originTypes: { unprotectedWeb: false, extension: true } },
      {
        cookies: true
      }
    )
    expect(h.cleared).toEqual([])
    await expect(h.api.handlers.remove(ctx, {}, { nope: true })).rejects.toThrow(/nope/)
    expect(h.api.handlers.settings(ctx)).toEqual(browsingDataSettings())
  })
})
