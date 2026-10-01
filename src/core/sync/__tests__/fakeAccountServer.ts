import type { SyncFetch, SyncFetchInit, SyncFetchResponse } from '../../platform'
import type { AccountGrant } from '../account'

/**
 * The Zenium account service in memory: the HTTP contract the client speaks
 * (`backend/convex/http.ts`, `sync.ts`, `devices.ts`, `lib/customFunctions.ts` at the time of
 * writing), answered by path whatever the host – the engine reaches for the build's endpoints,
 * which in vitest are the production placeholders.
 *
 * - `POST /auth/device/start` → a link with a code, `interval` seconds as the server's
 *   `interval` field says (0 here unless a test sets it: the polls are the test's pace).
 * - `POST /auth/device/token` → `pending`, `approved` with a grant (once: the link is consumed),
 *   or 400 `{status:'expired'}` for a code expired, used, unknown or not this device's secret;
 *   `slowDown` answers 429 that many times first.
 * - `POST /auth/refresh` → the refresh token ROTATES: the current one is exchanged for a new
 *   one; the previous one presented again revokes the session (reuse detection) and answers 401,
 *   as does anything else not current. A malformed body is 400.
 * - `POST /api/query|mutation` with `Bearer <access>`: a token unknown or expired is HTTP 401;
 *   a revoked session is `errorData.code: 'revoked'`, a deleted account `account-deleted`, and
 *   the functions answer as the backend's do – `sync:write` refuses `bad-name`, `too-large` and
 *   `quota`, `sync:readMany` more than 64 names; `sync:version` moves once per write, once per
 *   remove of a document that existed, and once per `removeAll`.
 *
 * Documents live per account in a `Map` a test may hand in (`account(email, files)`), so the
 * harness's folder maps can be an account's documents.
 */

export interface FakeAccount {
  email: string
  docs: Map<string, string>
  version: number
  deleted: boolean
}

interface FakeSession {
  id: string
  email: string
  deviceName: string
  kind: string
  refresh: string
  previous: string | null
  revoked: boolean
}

interface FakeLink {
  id: string
  userCode: string
  secretHash: string
  deviceName: string
  kind: string
  expiresAt: number
  status: 'pending' | 'approved' | 'consumed'
  email?: string
}

const DOCUMENT_NAME = /^[A-Za-z0-9._-]{1,200}$/

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function reply(status: number, body: unknown): SyncFetchResponse {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === 'content-type'
          ? 'application/json'
          : name.toLowerCase() === 'cache-control'
            ? 'no-store'
            : null
    },
    text: async () => text
  }
}

class Refusal {
  constructor(readonly code: string) {}
}

export class FakeAccountServer {
  readonly accounts = new Map<string, FakeAccount>()
  readonly sessions = new Map<string, FakeSession>()
  readonly links = new Map<string, FakeLink>()
  /** Every request: `/auth/...` by path, the data API by function (`query sync:list`). */
  readonly log: string[] = []
  /** Every request's `Authorization` header, by the same order as `log` (undefined for none). */
  readonly authorizations: Array<string | undefined> = []
  /** The `interval` a link's start hands out, in seconds. */
  interval = 0
  linkTtlMs = 10 * 60_000
  accessTtlMs = 60 * 60_000
  now: () => number = Date.now
  limits = { maxBytes: 128 * 1024 * 1024, maxDocChars: 4 * 1024 * 1024, maxDocuments: 4096 }
  /** How many token polls answer 429 before the next real answer. */
  slowDown = 0
  /** While set, a refresh waits on it before answering (a test lines up concurrent callers). */
  refreshGate: Promise<void> | null = null
  /** While true, every request fails as a network failure would. */
  offline = false
  private readonly access = new Map<string, { sid: string; expiresAt: number }>()
  private serial = 0

  /** The account by email, made on first use (with `docs` as its documents when given). */
  account(email: string, docs?: Map<string, string>): FakeAccount {
    let account = this.accounts.get(email)
    if (!account) {
      account = { email, docs: docs ?? new Map(), version: 0, deleted: false }
      this.accounts.set(email, account)
    } else if (docs && account.docs !== docs) {
      account.docs = docs
    }
    return account
  }

  /** The user approves a code on the website, signed in as `email`. */
  approve(userCode: string, email: string): void {
    const link = [...this.links.values()].find((l) => l.userCode === userCode)
    if (!link || link.status !== 'pending' || link.expiresAt < this.now())
      throw new Error(`no pending link for ${userCode}`)
    this.account(email)
    link.status = 'approved'
    link.email = email
  }

  /** A device signed in without the link flow (what a test starts from). */
  signIn(email: string, deviceName = 'Test device', kind = 'desktop'): AccountGrant {
    this.account(email)
    const session: FakeSession = {
      id: this.id('session'),
      email,
      deviceName,
      kind,
      refresh: this.token(),
      previous: null,
      revoked: false
    }
    this.sessions.set(session.id, session)
    return this.grant(session)
  }

  /** The website signs a device out (or a test's equivalent). */
  revoke(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) session.revoked = true
  }

  deleteAccount(email: string): void {
    const account = this.accounts.get(email)
    if (account) account.deleted = true
  }

  /** Every access token handed out stops working (a key rotated at the service). */
  invalidateAccessTokens(): void {
    this.access.clear()
  }

  sessionsOf(email: string): FakeSession[] {
    return [...this.sessions.values()].filter((s) => s.email === email)
  }

  /** How many requests went to one route (`/auth/refresh`, `mutation sync:write`, …). */
  count(route: string): number {
    return this.log.filter((r) => r === route).length
  }

  /** How many data-API requests to one route a session's access tokens made. */
  countBy(sessionId: string, route: string): number {
    return this.log.filter(
      (r, i) => r === route && this.authorizations[i]?.startsWith(`Bearer at.${sessionId}.`)
    ).length
  }

  /** Back to an empty service with the default knobs (between tests). */
  reset(): void {
    this.accounts.clear()
    this.sessions.clear()
    this.links.clear()
    this.access.clear()
    this.log.length = 0
    this.authorizations.length = 0
    this.interval = 0
    this.linkTtlMs = 10 * 60_000
    this.accessTtlMs = 60 * 60_000
    this.now = Date.now
    this.limits = { maxBytes: 128 * 1024 * 1024, maxDocChars: 4 * 1024 * 1024, maxDocuments: 4096 }
    this.slowDown = 0
    this.refreshGate = null
    this.offline = false
  }

  readonly fetch: SyncFetch = async (url: string, init: SyncFetchInit) => {
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (this.offline) throw new TypeError('fetch failed')
    const path = new URL(url).pathname
    if (init.method !== 'POST') return reply(405, { error: 'method' })
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(init.body ?? '')
      body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      body = null
    }
    const authorization = Object.entries(init.headers).find(
      ([name]) => name.toLowerCase() === 'authorization'
    )?.[1]
    if (path === '/api/query' || path === '/api/mutation') {
      const kind = path === '/api/query' ? 'query' : 'mutation'
      this.log.push(`${kind} ${String(body?.['path'])}`)
      this.authorizations.push(authorization)
      return this.api(kind, body, authorization)
    }
    this.log.push(path)
    this.authorizations.push(authorization)
    switch (path) {
      case '/auth/device/start':
        return this.start(body)
      case '/auth/device/token':
        return this.poll(body)
      case '/auth/refresh': {
        const gate = this.refreshGate
        if (gate) await gate
        return this.refresh(body)
      }
      default:
        return reply(404, { error: 'not-found' })
    }
  }

  // ---------------------------------------------------------------------------

  private id(prefix: string): string {
    this.serial += 1
    return `${prefix}${this.serial}`
  }

  private token(): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Buffer.from(bytes).toString('base64url')
  }

  private grant(session: FakeSession): AccountGrant {
    const accessToken = `at.${session.id}.${this.token()}`
    const expiresAt = this.now() + this.accessTtlMs
    this.access.set(accessToken, { sid: session.id, expiresAt })
    return {
      refreshToken: session.refresh,
      accessToken,
      expiresAt,
      email: this.accounts.get(session.email)?.email ?? session.email,
      sessionId: session.id
    }
  }

  private grantBody(session: FakeSession): Record<string, unknown> {
    const grant = this.grant(session)
    return {
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      expiresAt: grant.expiresAt,
      account: { email: grant.email },
      sessionId: grant.sessionId
    }
  }

  private start(body: Record<string, unknown> | null): SyncFetchResponse {
    const secretHash = body?.['secretHash']
    const deviceName = body?.['deviceName']
    const kind = body?.['kind']
    if (
      typeof secretHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(secretHash) ||
      typeof deviceName !== 'string' ||
      typeof kind !== 'string' ||
      !['desktop', 'laptop', 'phone', 'tablet'].includes(kind)
    )
      return reply(400, { error: 'bad-request' })
    const link: FakeLink = {
      id: this.id('link'),
      userCode: `CODE${this.serial}`.padEnd(8, 'X').slice(0, 8),
      secretHash,
      deviceName,
      kind,
      expiresAt: this.now() + this.linkTtlMs,
      status: 'pending'
    }
    this.links.set(link.id, link)
    return reply(200, {
      linkId: link.id,
      userCode: link.userCode,
      expiresAt: link.expiresAt,
      verificationUri: 'https://accounts.test/link',
      verificationUriComplete: `https://accounts.test/link?code=${link.userCode}`,
      interval: this.interval
    })
  }

  private async poll(body: Record<string, unknown> | null): Promise<SyncFetchResponse> {
    const linkId = body?.['linkId']
    const secret = body?.['deviceSecret']
    if (typeof linkId !== 'string' || typeof secret !== 'string' || secret.length < 32)
      return reply(400, { error: 'bad-request' })
    if (this.slowDown > 0) {
      this.slowDown -= 1
      return reply(429, { error: 'rate-limited' })
    }
    const link = this.links.get(linkId)
    if (!link || link.secretHash !== (await sha256Hex(secret)))
      return reply(400, { status: 'expired' })
    if (link.status === 'consumed' || link.expiresAt < this.now())
      return reply(400, { status: 'expired' })
    if (link.status === 'pending' || !link.email) return reply(200, { status: 'pending' })
    link.status = 'consumed'
    const session: FakeSession = {
      id: this.id('session'),
      email: link.email,
      deviceName: link.deviceName,
      kind: link.kind,
      refresh: this.token(),
      previous: null,
      revoked: false
    }
    this.sessions.set(session.id, session)
    return reply(200, { status: 'approved', ...this.grantBody(session) })
  }

  private refresh(body: Record<string, unknown> | null): SyncFetchResponse {
    const presented = body?.['refreshToken']
    if (typeof presented !== 'string' || presented.length < 32)
      return reply(400, { error: 'bad-request' })
    const sessions = [...this.sessions.values()]
    const session = sessions.find((s) => s.refresh === presented)
    if (!session) {
      const replayed = sessions.find((s) => s.previous === presented)
      if (replayed && !replayed.revoked) {
        replayed.revoked = true
        return reply(401, { error: 'reused' })
      }
      return reply(401, { error: 'invalid' })
    }
    const account = this.accounts.get(session.email)
    if (session.revoked || !account || account.deleted) return reply(401, { error: 'invalid' })
    session.previous = session.refresh
    session.refresh = this.token()
    return reply(200, this.grantBody(session))
  }

  private api(
    kind: 'query' | 'mutation',
    body: Record<string, unknown> | null,
    authorization: string | undefined
  ): SyncFetchResponse {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null
    const access = token ? this.access.get(token) : undefined
    if (!access || access.expiresAt <= this.now())
      return reply(401, { code: 'Unauthenticated', message: 'Could not verify token' })
    const session = this.sessions.get(access.sid)
    const fn = body?.['path']
    const args = body?.['args']
    if (typeof fn !== 'string' || !args || typeof args !== 'object')
      return reply(400, { code: 'BadRequest' })
    try {
      if (!session || session.revoked) throw new Refusal('revoked')
      const account = this.accounts.get(session.email)
      if (!account || account.deleted) throw new Refusal('account-deleted')
      const value = this.run(kind, fn, args as Record<string, unknown>, account, session)
      return reply(200, { status: 'success', value, logLines: [] })
    } catch (error) {
      if (error instanceof Refusal)
        return reply(200, {
          status: 'error',
          errorMessage: `[Request ID: test] Server Error\nUncaught ConvexError: ${error.code}`,
          errorData: { code: error.code, message: error.code },
          logLines: []
        })
      throw error
    }
  }

  private run(
    kind: 'query' | 'mutation',
    fn: string,
    args: Record<string, unknown>,
    account: FakeAccount,
    session: FakeSession
  ): unknown {
    const wants = (k: 'query' | 'mutation'): void => {
      if (kind !== k) throw new Refusal('wrong-kind')
    }
    const name = (): string => {
      const value = args['name']
      if (typeof value !== 'string') throw new Refusal('bad-request')
      return value
    }
    switch (fn) {
      case 'sync:list':
        wants('query')
        return [...account.docs.keys()]
      case 'sync:read':
        wants('query')
        return account.docs.get(name()) ?? null
      case 'sync:readMany': {
        wants('query')
        const names = args['names']
        if (!Array.isArray(names)) throw new Refusal('bad-request')
        if (names.length > 64) throw new Refusal('too-large')
        return names.map((n) => (typeof n === 'string' ? (account.docs.get(n) ?? null) : null))
      }
      case 'sync:version':
        wants('query')
        return account.version
      case 'sync:write': {
        wants('mutation')
        const n = name()
        const text = args['text']
        if (typeof text !== 'string') throw new Refusal('bad-request')
        if (!DOCUMENT_NAME.test(n)) throw new Refusal('bad-name')
        if (text.length > this.limits.maxDocChars) throw new Refusal('too-large')
        const existing = account.docs.get(n)
        let bytes = 0
        for (const t of account.docs.values()) bytes += t.length
        const bytesAfter = bytes - (existing?.length ?? 0) + text.length
        const countAfter = account.docs.size + (existing === undefined ? 1 : 0)
        if (bytesAfter > this.limits.maxBytes || countAfter > this.limits.maxDocuments)
          throw new Refusal('quota')
        account.docs.set(n, text)
        account.version += 1
        return null
      }
      case 'sync:remove': {
        wants('mutation')
        if (account.docs.delete(name())) account.version += 1
        return null
      }
      case 'sync:removeAll':
        wants('mutation')
        account.docs.clear()
        account.version += 1
        return null
      case 'devices:signOut':
        wants('mutation')
        session.revoked = true
        return null
      case 'devices:rename': {
        wants('mutation')
        const value = args['name']
        const trimmed = typeof value === 'string' ? value.trim().slice(0, 100) : ''
        if (trimmed) session.deviceName = trimmed
        return null
      }
      case 'devices:current':
        wants('query')
        return { email: account.email, deviceName: session.deviceName, sessionId: session.id }
      default:
        throw new Refusal('not-found')
    }
  }
}
