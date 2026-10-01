// eslint-disable-next-line no-restricted-imports -- a live run leaves the rotated token for the next one
import { writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import type { SecretStore, SyncFetch } from '../../platform'
import { ACCOUNT_SECRET_KEY, AccountClient, AccountSession, AccountTransport } from '../account'
import { accountEndpoints } from '../accountEndpoints'
import { README_NAME } from '../transport'

/**
 * The account client against the REAL account service, when `ZENIUM_ACCOUNT_LIVE=1` and
 * `ZENIUM_ACCOUNT_REFRESH` holds a device's refresh token (sign a device in once – the desktop's
 * Settings › Sync, a dev build – and copy the token out of its secret store). Nothing runs
 * without them: CI has no account. The deployment is the dev one unless
 * `ZENIUM_ACCOUNTS_ENV=prod`.
 *
 * The service rotates the refresh token at every refresh and revokes the sign-in when a spent
 * one comes back, so the token a run is given is spent by it: `ZENIUM_ACCOUNT_REFRESH_OUT`
 * names a file the run writes the token that replaced it to, for the next run. The run never
 * signs the device out and never removes what it did not write – the account may hold a
 * profile's real (encrypted) data; it writes one document of its own and removes it again.
 */

const live = process.env.ZENIUM_ACCOUNT_LIVE === '1' && Boolean(process.env.ZENIUM_ACCOUNT_REFRESH)

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

describe.skipIf(!live)('the account client against the live service', () => {
  const values = new Map<string, string>([
    [ACCOUNT_SECRET_KEY, process.env.ZENIUM_ACCOUNT_REFRESH ?? '']
  ])
  const secrets: SecretStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    }
  }
  const routes: string[] = []
  const counting: SyncFetch = async (url, init) => {
    routes.push(new URL(url).pathname)
    return nodeFetch(url, init)
  }
  const env = process.env.ZENIUM_ACCOUNTS_ENV === 'prod' ? 'prod' : 'dev'
  const session = new AccountSession(new AccountClient(accountEndpoints(env), counting), secrets)
  const transport = new AccountTransport(session, { versionPollMs: 0 })
  const name = `zenium-live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.tmp`

  afterAll(async () => {
    await transport.remove(name).catch(() => undefined)
    const token = values.get(ACCOUNT_SECRET_KEY)
    const out = process.env.ZENIUM_ACCOUNT_REFRESH_OUT
    if (out && token) writeFileSync(out, token)
  })

  it('refreshes once for concurrent first calls and says who the device is', async () => {
    const [current, version] = await Promise.all([
      session.query('devices:current'),
      session.query('sync:version'),
      session.query('sync:list')
    ])
    expect(routes.filter((r) => r === '/auth/refresh')).toHaveLength(1)
    expect(values.get(ACCOUNT_SECRET_KEY)).not.toBe(process.env.ZENIUM_ACCOUNT_REFRESH)
    expect(current).toMatchObject({ email: expect.stringContaining('@') })
    expect(typeof version).toBe('number')
  }, 30_000)

  it('writes, lists, reads (one and many) and removes a document; the version moves with each', async () => {
    const before = (await session.query('sync:version')) as number
    await transport.write(name, 'live text')
    expect(await transport.list()).toEqual(expect.arrayContaining([name, README_NAME]))
    expect(await transport.read(name)).toBe('live text')
    expect(await transport.readMany([name, README_NAME, 'zenium-live-missing.tmp'])).toEqual([
      'live text',
      expect.stringContaining('Zenium'),
      null
    ])
    // Its own write is not a change to report.
    await transport.changed()
    expect(await transport.changed()).toBe(false)
    await transport.remove(name)
    expect(await transport.read(name)).toBeNull()
    expect((await session.query('sync:version')) as number).toBe(before + 2)
  }, 30_000)
})
