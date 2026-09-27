import { afterEach, describe, expect, it } from 'vitest'
import type { WebDavSyncCredentials } from '../../../shared/types'
import type { SecretStore, SyncFetch } from '../../platform'
import { isDeviceFileName } from '../transport'
import { WebDavTransport, webDavFolderUrl } from '../webdav'
import { PASSPHRASE, device, teardown, unlockVault } from './harness'

/**
 * The transport and the engine against REAL WebDAV servers, when `ZEN_WEBDAV_LIVE` names them:
 * `label|root URL|user name|password` entries separated by `;` (an empty user name is an
 * anonymous server). Nothing runs without it – CI has no server – and what ran, and against
 * what, is written in the PR. Each run works in a folder of its own under the root and removes
 * it after itself. The HTTP is Node's own `fetch` (undici), which carries any method token, the
 * way Electron's `net.fetch` does for the desktop.
 *
 * Verified on 2026-09-27, all on this machine: Nextcloud 35.0.1 (app password), Apache 2.4.58
 * mod_dav, sabre/dav 4.6, WsgiDAV 4.3.5.
 */

interface LiveServer {
  label: string
  url: string
  username: string
  password: string
}

const servers: LiveServer[] = (process.env.ZEN_WEBDAV_LIVE ?? '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [label = '', url = '', username = '', password = ''] = entry.split('|')
    return { label, url, username, password }
  })

const nodeFetch: SyncFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: 'manual'
  })
  return {
    status: response.status,
    headers: { get: (name) => response.headers.get(name) },
    text: () => response.text()
  }
}

/** Node's fetch with every answer's status noted (the 304s the conditional reads earn). */
function countingFetch(): { fetch: SyncFetch; statuses: Array<[string, number]> } {
  const statuses: Array<[string, number]> = []
  return {
    statuses,
    fetch: async (url, init) => {
      const reply = await nodeFetch(url, init)
      statuses.push([init.method, reply.status])
      return reply
    }
  }
}

function memorySecrets(): SecretStore {
  const values = new Map<string, string>()
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    }
  }
}

const runFolder = (label: string): string =>
  `Zenium-live-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

async function removeFolder(credentials: WebDavSyncCredentials): Promise<void> {
  const url = webDavFolderUrl(credentials).replace(/zenium-sync\/$/, '')
  await nodeFetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
    }
  }).catch(() => undefined)
}

describe.skipIf(servers.length === 0)('a real WebDAV server (ZEN_WEBDAV_LIVE)', () => {
  afterEach(teardown)

  describe.each(servers)('$label', (server) => {
    const credentials = (folder: string): WebDavSyncCredentials => ({
      url: server.url,
      username: server.username,
      password: server.password,
      folder
    })

    it('answers the probe, refuses a wrong password, and lists an absent directory as empty', async () => {
      const folder = runFolder(server.label)
      const t = new WebDavTransport(credentials(folder), nodeFetch)
      expect(await t.probe()).toEqual({ ok: true })
      if (server.username) {
        const wrong = new WebDavTransport({ ...credentials(folder), password: 'not-it' }, nodeFetch)
        expect(await wrong.probe()).toEqual({ ok: false, kind: 'auth', status: 401 })
      }
      expect(await t.list()).toEqual([])
    }, 30_000)

    it('writes atomically, reads conditionally, replaces, removes, wipes', async () => {
      const folder = runFolder(server.label)
      const counting = countingFetch()
      const t = new WebDavTransport(credentials(folder), counting.fetch)
      try {
        await t.write('one.zensync', '{"v":1,"n":1}')
        await t.write('two.zenpage', 'page one')
        expect((await t.list()).sort()).toEqual(['one.zensync', 'two.zenpage'])
        expect(t.moveRefused).toBe(false)

        expect(await t.read('one.zensync')).toBe('{"v":1,"n":1}')
        expect(await t.read('one.zensync')).toBe('{"v":1,"n":1}')
        expect(counting.statuses.filter(([m, s]) => m === 'GET' && s === 304)).toHaveLength(1)

        await t.write('one.zensync', '{"v":1,"n":2}')
        expect(await t.read('one.zensync')).toBe('{"v":1,"n":2}')
        const fresh = new WebDavTransport(credentials(folder), nodeFetch)
        expect(await fresh.read('one.zensync')).toBe('{"v":1,"n":2}')
        expect(await fresh.read('never.zensync')).toBeNull()

        await t.remove('two.zenpage')
        await t.remove('two.zenpage')
        expect(await t.list()).toEqual(['one.zensync'])
        await t.removeAll()
        expect(await t.list()).toEqual([])
        expect(await fresh.read('one.zensync')).toBeNull()
        // The temporary names never outlive a write.
        expect((await t.list()).some((n) => n.includes('.tmp-'))).toBe(false)
      } finally {
        await removeFolder(credentials(folder))
      }
    }, 60_000)

    it('carries two engines to convergence', async () => {
      const folder = runFolder(server.label)
      try {
        const a = device('Desk (Linux)', { fetch: nodeFetch, secrets: memorySecrets() })
        const b = device('Pixel 9', { fetch: nodeFetch, secrets: memorySecrets() })
        await unlockVault(a)
        await unlockVault(b)
        const bm = a.browser.bookmarks.create({ title: 'Zenium', url: 'https://zenium.app/' })!
        for (const d of [a, b]) {
          await d.engine.setup(
            {
              folder: '',
              passphrase: PASSPHRASE,
              deviceName: d.name,
              scope: d.engine.status().scope,
              transport: 'webdav',
              webdav: credentials(folder)
            },
            d.win
          )
          expect(d.toasts).toEqual([])
          expect(d.engine.status()).toMatchObject({
            enabled: true,
            transport: 'webdav',
            authRefused: false,
            lastError: null
          })
        }
        await b.engine.confirmMerge(true)
        expect(b.browser.bookmarks.get(bm.id)?.url).toBe('https://zenium.app/')
        b.browser.bookmarks.create({ title: 'Docs', url: 'https://docs.example/' })
        await b.engine.syncNow()
        await a.engine.syncNow()
        expect(a.browser.state.bookmarks.some((n) => n.url === 'https://docs.example/')).toBe(true)
        expect(a.engine.status().lastError).toBeNull()
        expect(b.engine.status().lastError).toBeNull()

        const t = new WebDavTransport(credentials(folder), nodeFetch)
        const names = await t.list()
        expect(names.filter(isDeviceFileName)).toHaveLength(2)
        expect(names).toContain('README.txt')
        await t.removeAll()
      } finally {
        await removeFolder(credentials(folder))
      }
    }, 120_000)
  })
})
