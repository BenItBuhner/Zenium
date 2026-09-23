import { describe, expect, it } from 'vitest'
import type { Browser } from '@core/browser'
import {
  ERROR_EXCLUDE_ORIGINS,
  ERROR_NO_PERMISSION,
  ERROR_PASSWORDS
} from '@core/extensions/api/browsingData'
import { AndroidBrowsingData, ERROR_ORIGINS_ON_ANDROID } from '../extensionBrowsingData'

interface Fake {
  browser: Browser
  cleared: Array<{ containerIds: string[]; kinds: string[] }>
  dropped: string[]
  history: string[]
  removedDownloads: number[]
}

const NOW = 1_700_000_000_000

function fake(options: { granular?: boolean } = {}): Fake {
  const cleared: Fake['cleared'] = []
  const dropped: string[] = []
  const history: string[] = []
  const removedDownloads: number[] = []
  const visits = [
    { id: 1, url: 'https://a.test/one', at: NOW - 3_600_000 },
    { id: 2, url: 'https://b.test/two', at: NOW - 3_600_000 },
    { id: 3, url: 'https://a.test/three', at: NOW - 86_400_000 * 3 }
  ]
  const downloads = [
    { id: 1, url: 'https://a.test/f.zip', state: 'completed', startedAt: NOW - 60_000 },
    { id: 2, url: 'https://b.test/g.zip', state: 'completed', startedAt: NOW - 86_400_000 * 3 },
    { id: 3, url: 'https://a.test/h.zip', state: 'progressing', startedAt: NOW - 1_000 }
  ]
  const sessions: Record<string, unknown> = {
    clearContainerData: async (id: string) => {
      dropped.push(id)
    }
  }
  if (options.granular !== false) {
    sessions.clearBrowsingData = async (containerIds: string[], kinds: string[]) => {
      cleared.push({ containerIds, kinds })
    }
  }
  const browser = {
    platform: { sessions },
    state: { model: { containers: [{ id: 'work' }, { id: 'private' }] } },
    history: {
      recent: () => visits.map((v) => ({ url: v.url })),
      visits: ({ fromMs }: { fromMs: number }) => visits.filter((v) => v.at >= fromMs),
      deleteUrls: (urls: string[]) => history.push(`urls ${urls.join(' ')}`),
      deleteVisits: (ids: number[]) => history.push(`visits ${ids.join(' ')}`),
      clear: () => history.push('clear'),
      deleteRange: (from: number, to: number) => history.push(`range ${from} ${to}`)
    },
    downloads: {
      visibleTo: () => downloads,
      remove: (id: number) => removedDownloads.push(id)
    }
  } as unknown as Browser
  return { browser, cleared, dropped, history, removedDownloads }
}

function api(f: Fake): AndroidBrowsingData {
  return new AndroidBrowsingData({ browser: f.browser }, () => NOW)
}

describe('AndroidBrowsingData: chrome.browsingData over the WebView', () => {
  it("refuses everything without the permission, with Chrome's error", async () => {
    const f = fake()
    await expect(api(f).call(false, 'settings', [])).rejects.toThrow(ERROR_NO_PERMISSION)
    await expect(api(f).call(false, 'remove', [{}, { cache: true }])).rejects.toThrow(
      ERROR_NO_PERMISSION
    )
    expect(f.cleared).toEqual([])
  })

  it("answers settings() with the browser's defaults and what an extension may remove", async () => {
    const answer = (await api(fake()).call(true, 'settings', [])) as {
      options: { since: number; originTypes: Record<string, boolean> }
      dataToRemove: Record<string, boolean>
      dataRemovalPermitted: Record<string, boolean>
    }
    expect(answer.options).toEqual({
      since: 0,
      originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false }
    })
    expect(answer.dataToRemove.cache).toBe(true)
    expect(answer.dataToRemove.downloads).toBe(false)
    expect(answer.dataRemovalPermitted.passwords).toBe(false)
    expect(answer.dataRemovalPermitted.cache).toBe(true)
  })

  it("clears the cache of every persistent container for Clear Cache's Clear (since is the last day, origins deleted)", async () => {
    const f = fake()
    await api(f).call(true, 'remove', [
      {
        since: NOW - 86_400_000,
        originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false }
      },
      { cache: true }
    ])
    // The default container and the persistent ones; not the private container.
    expect(f.cleared).toEqual([{ containerIds: ['default', 'work'], kinds: ['cache'] }])
    expect(f.history).toEqual([])
    expect(f.removedDownloads).toEqual([])
  })

  it('maps the storage types to the WebView kinds (cookies apart, site storage whole) and clears them once', async () => {
    const f = fake()
    await api(f).call(true, 'remove', [
      {},
      {
        cookies: true,
        localStorage: true,
        indexedDB: true,
        serviceWorkers: true,
        cacheStorage: true,
        fileSystems: true,
        cache: true,
        appcache: true,
        webSQL: true,
        formData: false
      }
    ])
    expect(f.cleared).toEqual([
      { containerIds: ['default', 'work'], kinds: ['cookies', 'storage', 'cache'] }
    ])
    // The one-type methods stand for their type.
    await api(f).call(true, 'removeLocalStorage', [{}])
    expect(f.cleared.at(-1)).toEqual({ containerIds: ['default', 'work'], kinds: ['storage'] })
    await api(f).call(true, 'removeCookies', [{}])
    expect(f.cleared.at(-1)).toEqual({ containerIds: ['default', 'work'], kinds: ['cookies'] })
    // The empty types alone clear nothing and succeed.
    await api(f).call(true, 'removeFormData', [{}])
    await api(f).call(true, 'removePluginData', [{}])
    expect(f.cleared).toHaveLength(3)
  })

  it('drops whole containers on a host without the granular call', async () => {
    const f = fake({ granular: false })
    await api(f).call(true, 'removeCache', [{}])
    expect(f.dropped).toEqual(['default', 'work'])
  })

  it('removes history and downloads through the models, honouring since and origins', async () => {
    const f = fake()
    await api(f).call(true, 'remove', [{}, { history: true, downloads: true }])
    expect(f.history).toEqual(['clear'])
    // Finished rows since the epoch; the running transfer stays.
    expect(f.removedDownloads).toEqual([1, 2])

    const g = fake()
    const since = NOW - 86_400_000
    await api(g).call(true, 'remove', [{ since }, { history: true, downloads: true }])
    expect(g.history).toEqual([`range ${since} ${NOW + 1}`])
    expect(g.removedDownloads).toEqual([1])

    const h = fake()
    await api(h).call(true, 'remove', [
      { origins: ['https://a.test'] },
      { history: true, downloads: true }
    ])
    expect(h.history).toEqual(['urls https://a.test/one https://a.test/three'])
    expect(h.removedDownloads).toEqual([1])

    const i = fake()
    await api(i).call(true, 'removeHistory', [{ since, origins: ['https://a.test/'] }])
    expect(i.history).toEqual(['visits 1'])
    expect(i.cleared).toEqual([])
  })

  it('refuses per-origin site data and cache (the WebView clears whole), excludeOrigins, and passwords', async () => {
    const f = fake()
    await expect(
      api(f).call(true, 'remove', [{ origins: ['https://a.test'] }, { serviceWorkers: true }])
    ).rejects.toThrow(ERROR_ORIGINS_ON_ANDROID)
    await expect(
      api(f).call(true, 'removeCache', [{ origins: ['https://a.test'] }])
    ).rejects.toThrow(ERROR_ORIGINS_ON_ANDROID)
    await expect(
      api(f).call(true, 'remove', [{ excludeOrigins: ['https://a.test'] }, { cache: true }])
    ).rejects.toThrow(ERROR_EXCLUDE_ORIGINS)
    await expect(api(f).call(true, 'removePasswords', [{}])).rejects.toThrow(ERROR_PASSWORDS)
    await expect(api(f).call(true, 'remove', [{}, { cache: 'yes' }])).rejects.toThrow(
      'Invalid data type set'
    )
    await expect(api(f).call(true, 'remove', [{ since: 'now' }, { cache: true }])).rejects.toThrow(
      'Invalid removal options'
    )
    expect(f.cleared).toEqual([])
    expect(f.history).toEqual([])
  })

  it('does nothing for an originTypes that leaves out the open web', async () => {
    const f = fake()
    await api(f).call(true, 'remove', [
      { originTypes: { unprotectedWeb: false, extension: true } },
      { cache: true, history: true }
    ])
    expect(f.cleared).toEqual([])
    expect(f.history).toEqual([])
  })
})
