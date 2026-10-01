import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SecretStore, SyncFetch } from '../../platform'
import {
  ACCOUNT_READ_MANY_MAX,
  ACCOUNT_REFRESH_MARGIN_MS,
  ACCOUNT_SECRET_KEY,
  AccountClient,
  AccountError,
  AccountSession,
  AccountTransport,
  isSignedOut,
  linkDevice,
  sha256Hex,
  type AccountGrant,
  type AccountLinkResult
} from '../account'
import { ACCOUNT_ENDPOINTS, accountEndpoints, buildAccountsEnv } from '../accountEndpoints'
import { README, README_NAME } from '../transport'
import { FakeAccountServer } from './fakeAccountServer'

/**
 * The account client on its own (`account.ts`), over the fake service: the HTTP's typed
 * answers, the session's serialised refresh rotation and its retry, the device sign-in's three
 * ends, and the transport – its README, its batched reads and its version watch that does not
 * report its own writes.
 */

function memorySecrets(): SecretStore & { values: Map<string, string>; calls: string[] } {
  const values = new Map<string, string>()
  const calls: string[] = []
  return {
    values,
    calls,
    get: async (key) => {
      calls.push('get')
      return values.get(key) ?? null
    },
    set: async (key, value) => {
      calls.push('set')
      values.set(key, value)
    },
    delete: async (key) => {
      calls.push('delete')
      values.delete(key)
    }
  }
}

const EMAIL = 'ada@example.com'
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** The `AccountError` a call is expected to fail with. */
async function failure(call: Promise<unknown>): Promise<AccountError> {
  const error = await call.then(
    () => null,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AccountError)
  return error as AccountError
}

interface SignedIn {
  server: FakeAccountServer
  grant: AccountGrant
  secrets: ReturnType<typeof memorySecrets>
  client: AccountClient
  session: AccountSession
}

function signedIn(
  server = new FakeAccountServer(),
  options: { now?: () => number } = {}
): SignedIn {
  const grant = server.signIn(EMAIL)
  const secrets = memorySecrets()
  secrets.values.set(ACCOUNT_SECRET_KEY, grant.refreshToken)
  const client = new AccountClient(accountEndpoints('dev'), server.fetch)
  const session = new AccountSession(client, secrets, options)
  return { server, grant, secrets, client, session }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the account endpoints', () => {
  it('default to production; dev is the build-time choice, and the production placeholders sit in one table', () => {
    expect(buildAccountsEnv()).toBe('prod')
    expect(accountEndpoints().env).toBe('prod')
    expect(accountEndpoints('dev')).toBe(ACCOUNT_ENDPOINTS.dev)
    for (const env of ['dev', 'prod'] as const) {
      const e = ACCOUNT_ENDPOINTS[env]
      expect(e.cloudUrl).toMatch(/^https:\/\/[^/]+\.convex\.cloud$/)
      expect(e.siteUrl).toMatch(/^https:\/\/[^/]+\.convex\.site$/)
      expect(e.websiteUrl).toMatch(/^https:\/\//)
    }
  })
})

describe('the account client', () => {
  it('posts JSON with the bearer token to the data API and takes the value out of the answer', async () => {
    const { server, grant, client } = signedIn()
    server.account(EMAIL).docs.set('a.zensync', 'text')
    expect(await client.call('query', 'sync:list', {}, grant.accessToken)).toEqual(['a.zensync'])
    expect(server.log).toEqual(['query sync:list'])
    expect(server.authorizations).toEqual([`Bearer ${grant.accessToken}`])
  })

  it('types the service’s refusals; no message carries a token or a URL', async () => {
    const { server, grant, client } = signedIn()
    server.limits.maxBytes = 3
    const write = client.call(
      'mutation',
      'sync:write',
      { name: 'a', text: 'four' },
      grant.accessToken
    )
    await expect(write).rejects.toMatchObject({ kind: 'quota', code: 'quota' })
    server.limits.maxDocChars = 2
    await expect(
      client.call('mutation', 'sync:write', { name: 'a', text: 'abc' }, grant.accessToken)
    ).rejects.toMatchObject({ kind: 'too-large' })
    const unauth = await failure(client.call('query', 'sync:list', {}, 'not-a-token'))
    expect(unauth).toMatchObject({ kind: 'refused', code: 'unauthenticated' })
    server.revoke(grant.sessionId)
    const revoked = await failure(client.call('query', 'sync:list', {}, grant.accessToken))
    expect(revoked).toMatchObject({ kind: 'signed-out', code: 'revoked' })
    for (const error of [unauth, revoked]) {
      expect(error.message).not.toContain(grant.accessToken)
      expect(error.message).not.toContain('convex')
    }
  })

  it('reports an account deleted as signed out, a network failure as unavailable, a timeout likewise', async () => {
    const { server, grant, client } = signedIn()
    server.deleteAccount(EMAIL)
    await expect(client.call('query', 'sync:version', {}, grant.accessToken)).rejects.toMatchObject(
      { kind: 'signed-out', code: 'account-deleted' }
    )
    server.offline = true
    await expect(client.refresh(grant.refreshToken)).rejects.toMatchObject({ kind: 'unavailable' })
    const hanging: SyncFetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      )
    const slow = new AccountClient(accountEndpoints('dev'), hanging, 5)
    const error = await failure(
      slow.startLink({ secretHash: 'a'.repeat(64), deviceName: 'x', kind: 'desktop' })
    )
    expect(error).toMatchObject({ kind: 'unavailable' })
    expect(error.message).toContain('no response within 5 ms')
  })

  it('a refresh the service refuses (401) or cannot read (400) is the sign-in gone', async () => {
    const { client } = signedIn()
    await expect(client.refresh('x'.repeat(43))).rejects.toMatchObject({ kind: 'signed-out' })
    await expect(client.refresh('short')).rejects.toMatchObject({ kind: 'signed-out' })
  })
})

describe('the account session', () => {
  it('refreshes before the first call, keeps the rotated token in the store before using the access token', async () => {
    const { server, grant, secrets, session } = signedIn()
    const order: string[] = []
    const set = secrets.set
    secrets.set = async (key, value) => {
      order.push(`set ${server.log.length}`)
      await set(key, value)
    }
    expect(await session.query('sync:version')).toBe(0)
    expect(server.log).toEqual(['/auth/refresh', 'query sync:version'])
    // Stored after the refresh answered and before the data call went out.
    expect(order).toEqual(['set 1'])
    const stored = secrets.values.get(ACCOUNT_SECRET_KEY)!
    expect(stored).not.toBe(grant.refreshToken)
    expect(server.sessionsOf(EMAIL)[0]!.refresh).toBe(stored)
    expect(session.email).toBe(EMAIL)
    // A second call reuses the access token.
    await session.query('sync:list')
    expect(server.count('/auth/refresh')).toBe(1)
  })

  it('concurrent callers share one rotation: the spent token is never presented twice', async () => {
    const { server, session } = signedIn()
    let open = (): void => undefined
    server.refreshGate = new Promise<void>((resolve) => (open = resolve))
    const calls = Promise.all([
      session.query('sync:version'),
      session.query('sync:list'),
      session.mutation('sync:write', { name: 'a', text: 'x' }),
      session.query('sync:read', { name: 'a' })
    ])
    await tick()
    open()
    await calls
    expect(server.count('/auth/refresh')).toBe(1)
    expect(server.sessionsOf(EMAIL)[0]!.revoked).toBe(false)

    // Every access token refused at once (a key rotated): the callers refused together still
    // rotate once between them, and each is sent again.
    server.invalidateAccessTokens()
    server.refreshGate = null
    await Promise.all([session.query('sync:version'), session.query('sync:list')])
    expect(server.count('/auth/refresh')).toBe(2)
    expect(server.sessionsOf(EMAIL)[0]!.revoked).toBe(false)
  })

  it('refreshes ahead of the expiry margin, and retries a refused call once', async () => {
    let now = 1_000_000
    const server = new FakeAccountServer()
    server.now = () => now
    const { session } = signedIn(server, { now: () => now })
    await session.query('sync:version')
    expect(server.count('/auth/refresh')).toBe(1)
    now += server.accessTtlMs - ACCOUNT_REFRESH_MARGIN_MS + 1
    await session.query('sync:version')
    expect(server.count('/auth/refresh')).toBe(2)

    server.invalidateAccessTokens()
    expect(await session.query('sync:version')).toBe(0)
    expect(server.log.slice(-3)).toEqual([
      'query sync:version',
      '/auth/refresh',
      'query sync:version'
    ])
  })

  it('a revoked sign-in ends the session; nothing is sent after it', async () => {
    const { server, grant, session } = signedIn()
    await session.query('sync:version')
    server.revoke(grant.sessionId)
    const error = await session.query('sync:list').catch((e: unknown) => e)
    expect(isSignedOut(error)).toBe(true)
    expect(session.signedOut).toBe(true)
    const sent = server.log.length
    await expect(session.query('sync:list')).rejects.toMatchObject({ kind: 'signed-out' })
    expect(server.log.length).toBe(sent)
  })

  it('a refresh token presented again is reuse: the service revokes the sign-in and the session ends', async () => {
    const { server, grant, session } = signedIn()
    // Another copy of the token (a restored backup) rotated it first.
    await new AccountClient(accountEndpoints('dev'), server.fetch).refresh(grant.refreshToken)
    const error = await session.query('sync:version').catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'signed-out' })
    expect(session.signedOut).toBe(true)
  })

  it('a store without a token is signed out at once; a store that fails keeps the token in memory', async () => {
    const server = new FakeAccountServer()
    const client = new AccountClient(accountEndpoints('dev'), server.fetch)
    const empty = new AccountSession(client, memorySecrets())
    await expect(empty.query('sync:version')).rejects.toMatchObject({ kind: 'signed-out' })
    expect(server.log).toEqual([])

    const grant = server.signIn(EMAIL)
    const failing: SecretStore = {
      get: async () => grant.refreshToken,
      set: async () => {
        throw new Error('keyring locked')
      },
      delete: async () => undefined
    }
    const session = new AccountSession(client, failing)
    await session.query('sync:version')
    server.invalidateAccessTokens()
    await session.query('sync:version')
    expect(server.count('/auth/refresh')).toBe(2)
    expect(server.sessionsOf(EMAIL)[0]!.revoked).toBe(false)
  })

  it('signs out at the service and ends', async () => {
    const { server, grant, session } = signedIn()
    await session.signOut()
    expect(server.sessions.get(grant.sessionId)!.revoked).toBe(true)
    expect(session.signedOut).toBe(true)
  })
})

describe('signing a device in', () => {
  function link(
    server: FakeAccountServer,
    secrets = memorySecrets()
  ): {
    codes: string[]
    controller: AbortController
    done: Promise<AccountLinkResult>
    secrets: ReturnType<typeof memorySecrets>
    sleeps: number[]
  } {
    const client = new AccountClient(accountEndpoints('dev'), server.fetch)
    const codes: string[] = []
    const controller = new AbortController()
    const sleeps: number[] = []
    const done = linkDevice(client, secrets, {
      deviceName: '  Desk  ',
      kind: 'laptop',
      onCode: (start) => codes.push(start.userCode),
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms)
        await tick()
      }
    })
    return { codes, controller, done, secrets, sleeps }
  }

  it('pending, then approved: the refresh token is in the store before the grant is handed back', async () => {
    const server = new FakeAccountServer()
    server.interval = 2
    const { codes, done, secrets, sleeps } = link(server)
    await vi.waitFor(() => expect(server.count('/auth/device/token')).toBeGreaterThan(1))
    const started = [...server.links.values()][0]!
    expect(started.deviceName).toBe('Desk')
    expect(started.kind).toBe('laptop')
    expect(codes).toEqual([started.userCode])
    server.approve(started.userCode, EMAIL)
    const result = await done
    expect(result.status).toBe('approved')
    if (result.status !== 'approved') return
    expect(result.grant.email).toBe(EMAIL)
    expect(secrets.values.get(ACCOUNT_SECRET_KEY)).toBe(result.grant.refreshToken)
    expect(sleeps.every((ms) => ms === 2000)).toBe(true)
    // The service kept the secret's hash, never the secret.
    expect(started.secretHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('slows down on a 429 and keeps polling through a network failure', async () => {
    const server = new FakeAccountServer()
    server.interval = 1
    server.slowDown = 2
    const { done, sleeps } = link(server)
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThan(3))
    server.offline = true
    const polls = sleeps.length
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThan(polls + 2))
    server.offline = false
    server.approve([...server.links.values()][0]!.userCode, EMAIL)
    expect((await done).status).toBe('approved')
    expect(sleeps.slice(0, 3)).toEqual([1000, 2000, 4000])
  })

  it('an expired code ends the sign-in', async () => {
    let now = 0
    const server = new FakeAccountServer()
    server.now = () => now
    const client = new AccountClient(accountEndpoints('dev'), server.fetch)
    const done = linkDevice(client, memorySecrets(), {
      deviceName: 'Desk',
      kind: 'desktop',
      onCode: () => undefined,
      now: () => now,
      sleep: async () => {
        now += 60_000
        await tick()
      }
    })
    expect(await done).toEqual({ status: 'expired' })
    // The service's own expiry answers the same.
    now = 0
    const late = linkDevice(client, memorySecrets(), {
      deviceName: 'Desk',
      kind: 'desktop',
      onCode: () => {
        now = server.linkTtlMs + 1
      },
      sleep: tick
    })
    expect(await late).toEqual({ status: 'expired' })
  })

  it('cancelled: no token is kept, and an approval that lands after the cancel is signed out again', async () => {
    const server = new FakeAccountServer()
    const { controller, done, secrets } = link(server)
    await vi.waitFor(() => expect(server.count('/auth/device/token')).toBeGreaterThan(0))
    controller.abort()
    expect(await done).toEqual({ status: 'cancelled' })
    expect(secrets.values.size).toBe(0)

    // The approval and the cancel cross: the user cancels while the poll that brings the grant
    // is on its way back.
    const racing = new FakeAccountServer()
    const abort = new AbortController()
    const crossingFetch: SyncFetch = async (url, init) => {
      const response = await racing.fetch(url, init)
      if (url.endsWith('/auth/device/token')) abort.abort()
      return response
    }
    const store = memorySecrets()
    const result = await linkDevice(
      new AccountClient(accountEndpoints('dev'), crossingFetch),
      store,
      {
        deviceName: 'Desk',
        kind: 'desktop',
        signal: abort.signal,
        onCode: (start) => racing.approve(start.userCode, EMAIL),
        sleep: tick
      }
    )
    expect(result.status).toBe('cancelled')
    expect(store.values.size).toBe(0)
    expect([...racing.sessions.values()].map((s) => s.revoked)).toEqual([true])
  })

  it('a store that will not keep the approval signs it out again', async () => {
    const server = new FakeAccountServer()
    const client = new AccountClient(accountEndpoints('dev'), server.fetch)
    const result = await linkDevice(
      client,
      {
        get: async () => null,
        set: async () => {
          throw new Error('keyring locked')
        },
        delete: async () => undefined
      },
      {
        deviceName: 'Desk',
        kind: 'desktop',
        onCode: (start) => server.approve(start.userCode, EMAIL),
        sleep: tick
      }
    )
    expect(result).toEqual({ status: 'secrets' })
    expect([...server.sessions.values()].map((s) => s.revoked)).toEqual([true])
  })

  it('a start the service refuses is a typed error', async () => {
    const server = new FakeAccountServer()
    server.offline = true
    const client = new AccountClient(accountEndpoints('dev'), server.fetch)
    await expect(
      linkDevice(client, memorySecrets(), {
        deviceName: 'Desk',
        kind: 'desktop',
        onCode: () => undefined
      })
    ).rejects.toBeInstanceOf(AccountError)
  })

  it('hashes the secret as the service expects (lowercase hex SHA-256)', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('the account transport', () => {
  function transport(
    options: ConstructorParameters<typeof AccountTransport>[1] = {}
  ): SignedIn & { transport: AccountTransport } {
    const ctx = signedIn()
    return { ...ctx, transport: new AccountTransport(ctx.session, options) }
  }

  it('lists, reads, writes and removes documents; the README is reported, never stored', async () => {
    const { server, transport: t } = transport()
    expect(await t.list()).toEqual([README_NAME])
    await t.write(README_NAME, README)
    await t.write('dev-1.zensync', 'one')
    expect(await t.list()).toEqual(['dev-1.zensync', README_NAME])
    expect(await t.read('dev-1.zensync')).toBe('one')
    expect(await t.read(README_NAME)).toBe(README)
    expect(await t.read('missing')).toBeNull()
    expect([...server.account(EMAIL).docs.keys()]).toEqual(['dev-1.zensync'])
    await t.remove(README_NAME)
    await t.remove('dev-1.zensync')
    expect(server.account(EMAIL).docs.size).toBe(0)
    await t.write('a', '1')
    await t.removeAll()
    expect(server.account(EMAIL).docs.size).toBe(0)
    await expect(t.read('../escape')).rejects.toThrow('invalid sync document name')
  })

  it('reads many in batches of 64, in the order asked', async () => {
    const { server, transport: t } = transport()
    const docs = server.account(EMAIL).docs
    const names = Array.from({ length: ACCOUNT_READ_MANY_MAX + 6 }, (_, i) => `d${i}`)
    for (const name of names) docs.set(name, `text ${name}`)
    const asked = [README_NAME, ...names, 'missing']
    const texts = await t.readMany(asked)
    expect(texts).toEqual([README, ...names.map((n) => `text ${n}`), null])
    expect(server.count('query sync:readMany')).toBe(2)
  })

  it('asks again for what a budget-limited answer left out', async () => {
    const { server, transport: t } = transport()
    server.limits.readManyChars = 10
    const docs = server.account(EMAIL).docs
    for (const name of ['a', 'b', 'c']) docs.set(name, name.repeat(6))
    expect(await t.readMany(['a', 'missing', 'b', 'c'])).toEqual([
      'aaaaaa',
      null,
      'bbbbbb',
      'cccccc'
    ])
    expect(server.count('query sync:readMany')).toBe(3)
  })

  it('surfaces the quota refusal typed', async () => {
    const { server, transport: t } = transport()
    server.limits.maxDocuments = 1
    await t.write('a', '1')
    await expect(t.write('b', '2')).rejects.toMatchObject({ kind: 'quota' })
  })

  it('reports another device’s writes and not its own', async () => {
    const { server, transport: t } = transport()
    const other = server.signIn(EMAIL, 'Phone')
    const otherClient = new AccountClient(accountEndpoints('dev'), server.fetch)
    expect(await t.changed()).toBe(false)
    await t.write('mine', '1')
    await t.write('mine', '2')
    expect(await t.changed()).toBe(false)
    await otherClient.call(
      'mutation',
      'sync:write',
      { name: 'theirs', text: 'x' },
      other.accessToken
    )
    expect(await t.changed()).toBe(true)
    expect(await t.changed()).toBe(false)
    await t.write('mine', '3')
    await otherClient.call(
      'mutation',
      'sync:write',
      { name: 'theirs', text: 'y' },
      other.accessToken
    )
    expect(await t.changed()).toBe(true)
  })

  it('a look that overlaps its own write says nothing and the next look still sees the change', async () => {
    const { server, transport: t } = transport()
    const other = server.signIn(EMAIL, 'Phone')
    const otherClient = new AccountClient(accountEndpoints('dev'), server.fetch)
    await t.changed()
    await otherClient.call(
      'mutation',
      'sync:write',
      { name: 'theirs', text: 'x' },
      other.accessToken
    )
    const writing = t.write('mine', '1')
    expect(await t.changed()).toBe(false)
    await writing
    expect(await t.changed()).toBe(true)
  })

  it('watch polls the version on its period, skips it in the background and asks on a return to the front', async () => {
    let foreground = true
    const listeners = new Set<() => void>()
    const { server, transport: t } = transport({
      versionPollMs: 40,
      foreground: () => foreground,
      onForeground: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      }
    })
    const other = server.signIn(EMAIL, 'Phone')
    const otherClient = new AccountClient(accountEndpoints('dev'), server.fetch)
    const changes: number[] = []
    const stop = t.watch(() => changes.push(server.account(EMAIL).version))
    await vi.waitFor(() => expect(server.count('query sync:version')).toBeGreaterThan(0))
    await otherClient.call(
      'mutation',
      'sync:write',
      { name: 'theirs', text: 'x' },
      other.accessToken
    )
    await vi.waitFor(() => expect(changes).toEqual([1]))

    foreground = false
    const asked = server.count('query sync:version')
    await new Promise((r) => setTimeout(r, 120))
    expect(server.count('query sync:version')).toBe(asked)
    await otherClient.call(
      'mutation',
      'sync:write',
      { name: 'theirs', text: 'y' },
      other.accessToken
    )
    foreground = true
    for (const l of listeners) l()
    await vi.waitFor(() => expect(changes).toEqual([1, 2]))

    stop()
    expect(listeners.size).toBe(0)
    const after = server.count('query sync:version')
    await new Promise((r) => setTimeout(r, 100))
    expect(server.count('query sync:version')).toBe(after)
  })

  it('watch stops asking once the session is signed out', async () => {
    const { server, grant, transport: t } = transport({ versionPollMs: 20 })
    const stop = t.watch(() => undefined)
    await vi.waitFor(() => expect(server.count('query sync:version')).toBeGreaterThan(0))
    server.revoke(grant.sessionId)
    await vi.waitFor(() => expect(t.session.signedOut).toBe(true))
    const asked = server.log.length
    await new Promise((r) => setTimeout(r, 80))
    expect(server.log.length).toBe(asked)
    stop()
  })
})
