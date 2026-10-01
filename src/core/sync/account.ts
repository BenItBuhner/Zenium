import type { AccountErrorKind, SyncDeviceKind } from '../../shared/types'
import type { SecretStore, SyncFetch } from '../platform'
import { toBase64 } from '../credentials/crypto'
import type { AccountEndpoints } from './accountEndpoints'
import { README, README_NAME, type SyncTransport } from './transport'

/**
 * The sync folder in the user's Zenium account: the same end-to-end encrypted documents the
 * folder and WebDAV transports carry, kept by the account service (a Convex deployment) instead
 * of a drive. The passphrase and the key never leave the device; the service stores ciphertext
 * by name and knows the account's email, the device's name and nothing else.
 *
 * Three pieces, all over the host's fetch (`SyncPlatformHost.fetch` – Electron's `net.fetch`,
 * Kotlin's OkHttp on Android, where the WebView's own fetch is bound by the chrome's origin and
 * CORS):
 *
 * - `AccountClient`, the HTTP: the device sign-in and the token refresh (the deployment's HTTP
 *   actions) and the data API (`/api/query`, `/api/mutation` with the access token). Every answer
 *   is a typed `AccountError` for the engine (`AccountErrorKind`); no message carries a token, a
 *   URL or a body.
 * - `AccountSession`, the device's sign-in: a refresh token in the host's secret store
 *   (`ACCOUNT_SECRET_KEY`), an access token in memory only. The refresh token ROTATES on every
 *   refresh and the service revokes the whole sign-in when a spent one is presented again by
 *   anyone but this device retrying (`ACCOUNT_ATTEMPT_KEY`), so refreshes are serialised –
 *   concurrent callers share the one in flight – and the new token is in the store before the
 *   access token it came with is used. A call refused as `unauthenticated` is refreshed and sent
 *   once more; `revoked`, `account-deleted` and a refresh the service answers 401 end the
 *   session (`signed-out`); any other refusal of a refresh keeps the token for the next try.
 * - `AccountTransport`, the `SyncTransport` over the session, and `linkDevice`, the sign-in.
 */

/** The one key the engine keeps the device's refresh token under in the host's secret store. */
export const ACCOUNT_SECRET_KEY = 'sync.account.refresh'
/**
 * Beside it, the id of the rotation attempt in flight: made up before a refresh is sent and
 * kept until its answer is in, so the previous token presented again under the same id is this
 * device retrying – after a lost answer, however long it was offline or backgrounded – and not
 * a copy. The service revokes a sign-in whose previous token comes back under another id.
 */
export const ACCOUNT_ATTEMPT_KEY = 'sync.account.attempt'

/** Forget this device's sign-in in the host's secret store, best effort: the token and the attempt beside it. */
export async function forgetAccountSecrets(secrets: SecretStore | undefined): Promise<void> {
  if (!secrets) return
  await secrets.delete(ACCOUNT_SECRET_KEY).catch(() => undefined)
  await secrets.delete(ACCOUNT_ATTEMPT_KEY).catch(() => undefined)
}
/** One request's whole time: a device file is a few hundred kilobytes at most. */
export const ACCOUNT_TIMEOUT_MS = 30_000
/** The access token is refreshed this long before it expires, not at the edge. */
export const ACCOUNT_REFRESH_MARGIN_MS = 5 * 60_000
/** How often the desktop asks whether the account changed (`sync:version`). */
export const ACCOUNT_VERSION_POLL_MS = 15_000
/** The most documents `sync:readMany` takes at once. */
export const ACCOUNT_READ_MANY_MAX = 64
/** The service's alphabet for a document name; every name the engine writes is in it. */
const DOCUMENT_NAME = /^[A-Za-z0-9._-]{1,200}$/

export class AccountError extends Error {
  constructor(
    readonly kind: AccountErrorKind,
    message: string,
    /** The service's `errorData.code`, or `unauthenticated` for an HTTP 401; undefined for none. */
    readonly code?: string
  ) {
    super(message)
    this.name = 'AccountError'
  }
}

export function isAccountError(error: unknown): error is AccountError {
  return (
    error instanceof AccountError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AccountError' &&
      typeof (error as { kind?: unknown }).kind === 'string')
  )
}

/** The service no longer takes this device's sign-in: the user has to sign in again. */
export function isSignedOut(error: unknown): boolean {
  return isAccountError(error) && error.kind === 'signed-out'
}

/** The access token was not accepted (a 401, or the service's `unauthenticated`): refresh and send once more. */
function isUnauthenticated(error: unknown): boolean {
  return isAccountError(error) && error.code === 'unauthenticated'
}

/** What a sign-in or a refresh hands the device: the tokens, the access token's expiry (ms), who it is. */
export interface AccountGrant {
  refreshToken: string
  accessToken: string
  expiresAt: number
  email: string
  sessionId: string
}

/** The service's answer to the start of a sign-in (`POST /auth/device/start`). */
export interface AccountLinkStart {
  linkId: string
  userCode: string
  expiresAt: number
  verificationUri: string
  /** The sign-in page with the code filled in: what the new tab opens. */
  verificationUriComplete: string
  /** Seconds between two polls of the token endpoint. */
  interval: number
}

export type AccountLinkPoll =
  | { status: 'pending' }
  | { status: 'slow-down' }
  | { status: 'expired' }
  | { status: 'approved'; grant: AccountGrant }

/** A JSON object's field as a string, or undefined. */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A grant's fields as the service sends them (`approved` from the token endpoint, a refresh's 200). */
function readGrant(body: unknown): AccountGrant | null {
  const record = asRecord(body)
  if (!record) return null
  const refreshToken = str(record, 'refreshToken')
  const accessToken = str(record, 'accessToken')
  const expiresAt = record['expiresAt']
  const email = str(asRecord(record['account']) ?? {}, 'email')
  if (!refreshToken || !accessToken || typeof expiresAt !== 'number' || email === undefined)
    return null
  return { refreshToken, accessToken, expiresAt, email, sessionId: str(record, 'sessionId') ?? '' }
}

/** The kind a service error code is, as the engine acts on it. */
function kindOfCode(code: string | undefined): AccountErrorKind {
  switch (code) {
    case 'revoked':
    case 'account-deleted':
      return 'signed-out'
    case 'quota':
      return 'quota'
    case 'too-large':
      return 'too-large'
    case 'rate-limited':
      return 'rate-limited'
    default:
      return 'refused'
  }
}

/** The kind an HTTP status is when the body says nothing more. */
function kindOfStatus(status: number): AccountErrorKind {
  if (status === 429) return 'rate-limited'
  if (status === 0 || status >= 500) return 'unavailable'
  return 'refused'
}

interface Reply {
  status: number
  body: unknown
}

/** The account service's HTTP: JSON in and out, one timeout per request, the answers typed. */
export class AccountClient {
  constructor(
    readonly endpoints: AccountEndpoints,
    private readonly fetch: SyncFetch,
    private readonly timeoutMs = ACCOUNT_TIMEOUT_MS
  ) {}

  /** Step 1 of a sign-in: the device's secret, by its hash, registered for a code to show. */
  async startLink(request: {
    secretHash: string
    deviceName: string
    kind: SyncDeviceKind
  }): Promise<AccountLinkStart> {
    const reply = await this.post(`${this.endpoints.siteUrl}/auth/device/start`, request)
    const record = asRecord(reply.body)
    if (reply.status !== 200 || !record) throw this.error('sign-in', reply.status)
    const linkId = str(record, 'linkId')
    const userCode = str(record, 'userCode')
    const verificationUri = str(record, 'verificationUri')
    const expiresAt = record['expiresAt']
    const interval = record['interval']
    if (!linkId || !userCode || !verificationUri || typeof expiresAt !== 'number')
      throw new AccountError('refused', 'Account sign-in answered without a code')
    return {
      linkId,
      userCode,
      expiresAt,
      verificationUri,
      verificationUriComplete: str(record, 'verificationUriComplete') ?? verificationUri,
      interval: typeof interval === 'number' && interval >= 0 ? interval : 2
    }
  }

  /** Step 3: whether the user has approved the code yet (a 429 asks the device to poll more slowly). */
  async pollLink(linkId: string, deviceSecret: string): Promise<AccountLinkPoll> {
    const reply = await this.post(`${this.endpoints.siteUrl}/auth/device/token`, {
      linkId,
      deviceSecret
    })
    if (reply.status === 429) return { status: 'slow-down' }
    // 400 is the link expired, used or unknown (`{status:'expired'}`), or a request the service
    // could not read – either way this code is done with.
    if (reply.status === 400) return { status: 'expired' }
    const record = asRecord(reply.body)
    if (reply.status !== 200 || !record) throw this.error('sign-in', reply.status)
    if (record['status'] === 'pending') return { status: 'pending' }
    if (record['status'] === 'expired') return { status: 'expired' }
    const grant = record['status'] === 'approved' ? readGrant(record) : null
    if (!grant) throw new AccountError('refused', 'Account sign-in answered without a sign-in')
    return { status: 'approved', grant }
  }

  /**
   * A new access token for the refresh token, and the refresh token that replaces it. A 401 is
   * the sign-in gone (revoked, the account deleted, a spent token presented again) and is never
   * going to work again: `signed-out`. A 400 is a request the service could not read – a client
   * at fault, or a service that changed its mind about the body – and says nothing about the
   * token, so it is `refused` and the token is kept: the sign-in stays until the service refuses
   * the token itself.
   */
  async refresh(refreshToken: string, attempt?: string): Promise<AccountGrant> {
    const reply = await this.post(`${this.endpoints.siteUrl}/auth/refresh`, {
      refreshToken,
      ...(attempt !== undefined ? { attempt } : {})
    })
    if (reply.status === 401)
      throw new AccountError('signed-out', `Account refresh answered ${reply.status}`)
    if (reply.status !== 200) throw this.error('refresh', reply.status)
    const grant = readGrant(reply.body)
    if (!grant) throw new AccountError('refused', 'Account refresh answered without tokens')
    return grant
  }

  /**
   * One function of the data API with the access token. The service answers 200 with a
   * `status` of `success` or `error` (`errorData.code` saying which); an HTTP 401 is the token
   * refused before the function ran – `unauthenticated` either way, the session's to refresh.
   */
  async call(
    kind: 'query' | 'mutation',
    path: string,
    args: Record<string, unknown>,
    accessToken: string
  ): Promise<unknown> {
    const reply = await this.post(
      `${this.endpoints.cloudUrl}/api/${kind}`,
      { path, args, format: 'json' },
      { Authorization: `Bearer ${accessToken}` }
    )
    if (reply.status === 401)
      throw new AccountError('refused', `Account ${path} answered 401`, 'unauthenticated')
    const record = asRecord(reply.body)
    if (reply.status !== 200 || !record) throw this.error(path, reply.status)
    if (record['status'] === 'success') return record['value']
    const code = str(asRecord(record['errorData']) ?? {}, 'code')
    throw new AccountError(kindOfCode(code), `Account ${path} refused (${code ?? 'error'})`, code)
  }

  /**
   * One POST with a JSON body, its whole exchange under one timeout; the answer's body parsed as
   * JSON (null when it is not). A request that got no response is `unavailable`, its message the
   * failure's class alone – never the URL, a header or the body.
   */
  private async post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<Reply> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store'
      })
      const text = await response.text()
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      return { status: response.status, body: parsed }
    } catch (error) {
      throw new AccountError(
        'unavailable',
        controller.signal.aborted
          ? `Account request: no response within ${this.timeoutMs} ms`
          : `Account request: ${error instanceof Error ? error.name : 'network failure'}`
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private error(what: string, status: number): AccountError {
    return new AccountError(kindOfStatus(status), `Account ${what} answered ${status}`)
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface AccountSessionOptions {
  now?: () => number
  /** Every grant the session takes (a refresh's): the account's email may have changed. */
  onGrant?: (grant: AccountGrant) => void
}

/**
 * This device's sign-in. The refresh token is read from the secret store once and kept in
 * memory from then on, so a store that is emptied (the user signs out) cannot pull it from
 * under a call already running; the access token lives in memory alone.
 */
export class AccountSession {
  /** Undefined until the store was read; null when it holds none, or the session ended. */
  private refreshToken: string | null | undefined = undefined
  /** The rotation attempt in flight (`ACCOUNT_ATTEMPT_KEY`): undefined until the store was read, null between rotations. */
  private attemptId: string | null | undefined = undefined
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<void> | null = null
  private ended = false
  private readonly now: () => number
  email: string | null = null

  constructor(
    readonly client: AccountClient,
    private readonly secrets: SecretStore,
    private readonly options: AccountSessionOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  /** The service ended this sign-in (or the device signed out): every call fails without a request. */
  get signedOut(): boolean {
    return this.ended
  }

  /** A sign-in just approved: its tokens taken as they are (the refresh token is in the store already). */
  adopt(grant: AccountGrant): void {
    this.refreshToken = grant.refreshToken
    this.access = { token: grant.accessToken, expiresAt: grant.expiresAt }
    this.email = grant.email
    this.ended = false
  }

  /** The refresh token, read from the store the first time; null when there is none. */
  async load(): Promise<string | null> {
    if (this.refreshToken === undefined) {
      let stored: string | null
      try {
        stored = await this.secrets.get(ACCOUNT_SECRET_KEY)
      } catch {
        stored = null
      }
      // A refresh may have taken a token while the store was being read.
      if (this.refreshToken === undefined) this.refreshToken = stored || null
    }
    return this.refreshToken
  }

  query(path: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.call('query', path, args)
  }

  mutation(path: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.call('mutation', path, args)
  }

  /** Sign this device out at the service, best effort; the session is over either way. */
  async signOut(): Promise<void> {
    try {
      if (!this.ended) await this.mutation('devices:signOut')
    } finally {
      this.end()
    }
  }

  private async call(
    kind: 'query' | 'mutation',
    path: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const token = await this.token()
    try {
      return await this.client.call(kind, path, args, token)
    } catch (error) {
      if (!isUnauthenticated(error)) throw this.settle(error)
    }
    // The token was refused before its time (a key rotated at the service, a clock off): a new
    // one, once. A second refusal is the service's answer and is reported as it is.
    await this.refresh(token)
    try {
      return await this.client.call(kind, path, args, this.access!.token)
    } catch (error) {
      throw this.settle(error)
    }
  }

  /** An error out of a call: a sign-in the service ended ends the session too. */
  private settle(error: unknown): unknown {
    if (isSignedOut(error)) this.end()
    return error
  }

  private fresh(): boolean {
    return this.access !== null && this.access.expiresAt - ACCOUNT_REFRESH_MARGIN_MS > this.now()
  }

  private async token(): Promise<string> {
    if (this.ended) throw new AccountError('signed-out', 'Account sign-in ended')
    if (!this.fresh()) await this.refresh(this.access?.token ?? null)
    return this.access!.token
  }

  /**
   * Refresh, serialised: a refresh in flight is joined, and a caller whose token was refused
   * after another caller already replaced it takes the new one without a second rotation – a
   * spent refresh token presented twice revokes the whole sign-in.
   */
  private refresh(stale: string | null): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (this.access && this.access.token !== stale && this.fresh()) return Promise.resolve()
    this.refreshing = this.rotate().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async rotate(): Promise<void> {
    if (this.ended) throw new AccountError('signed-out', 'Account sign-in ended')
    const presented = await this.load()
    if (!presented) {
      this.end()
      throw new AccountError('signed-out', 'No account sign-in on this device')
    }
    const attempt = await this.attempt()
    let grant: AccountGrant
    try {
      grant = await this.client.refresh(presented, attempt)
    } catch (error) {
      throw this.settle(error)
    }
    // The presented token is spent at the service from here: the new one goes to the store
    // before the access token is used, so a restart never presents the spent one. A store that
    // refuses leaves it in memory: this run keeps syncing, and the next start presents the
    // spent token under the attempt id still in the store, which the service takes as the retry
    // it is – or, with that lost too, is signed out: the one way left to say the store failed.
    this.refreshToken = grant.refreshToken
    try {
      await this.secrets.set(ACCOUNT_SECRET_KEY, grant.refreshToken)
    } catch {
      // See above.
    }
    // The attempt is answered: the next rotation is a new one. Removed after the token is kept,
    // so a store that fails between the two leaves the pair a retry still needs.
    this.attemptId = null
    await this.secrets.delete(ACCOUNT_ATTEMPT_KEY).catch(() => undefined)
    if (this.ended) throw new AccountError('signed-out', 'Account sign-in ended')
    this.access = { token: grant.accessToken, expiresAt: grant.expiresAt }
    this.email = grant.email
    this.options.onGrant?.(grant)
  }

  /**
   * The id this rotation is attempted under: the one a lost answer left in the store (a retry
   * after a restart), else a new one, kept before the request goes out so a crash mid-request
   * retries under it. A store that will not keep it still gets the in-memory id: a retry in this
   * run is covered, and after a restart the clock rule is all that is left either way.
   */
  private async attempt(): Promise<string> {
    if (this.attemptId === undefined) {
      try {
        this.attemptId = (await this.secrets.get(ACCOUNT_ATTEMPT_KEY)) || null
      } catch {
        this.attemptId = null
      }
    }
    if (this.attemptId === null) {
      this.attemptId = newAttemptId()
      await this.secrets.set(ACCOUNT_ATTEMPT_KEY, this.attemptId).catch(() => undefined)
    }
    return this.attemptId
  }

  private end(): void {
    this.ended = true
    this.access = null
    this.refreshToken = null
    this.attemptId = null
  }
}

/** A rotation attempt's id: 16 random bytes, base64url without padding (22 characters). */
export function newAttemptId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Signing a device in
// ---------------------------------------------------------------------------

export type AccountLinkResult =
  | { status: 'approved'; grant: AccountGrant }
  | { status: 'expired' }
  | { status: 'cancelled' }
  /** Approved, but the host's secret store would not keep the sign-in (it was signed out again). */
  | { status: 'secrets' }

/** A random device secret: 32 bytes, base64url without padding (43 characters). */
export function newDeviceSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The lowercase hex SHA-256 of a string's UTF-8 bytes (the service's `secretHash`). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Sign this device in (the device authorisation flow, RFC 8628's shape): a fresh secret is
 * registered by its hash, `onCode` shows the code and opens the sign-in page, and the token
 * endpoint is polled every `interval` seconds – twice as slowly after a 429, through a network
 * failure – until the user approves, the code expires, or `signal` cancels. An approval's
 * refresh token is in the secret store before this returns; one the store will not take, or one
 * that lands after a cancel, is signed out at the service again rather than left behind.
 * Throws an `AccountError` when the sign-in cannot even start.
 */
export async function linkDevice(
  client: AccountClient,
  secrets: SecretStore,
  options: {
    deviceName: string
    kind: SyncDeviceKind
    onCode: (start: AccountLinkStart) => void
    signal?: AbortSignal
    now?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  }
): Promise<AccountLinkResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? sleepFor
  const signal = options.signal
  const deviceSecret = newDeviceSecret()
  const start = await client.startLink({
    secretHash: await sha256Hex(deviceSecret),
    deviceName: options.deviceName.trim().slice(0, 100) || 'Zenium',
    kind: options.kind
  })
  if (signal?.aborted) return { status: 'cancelled' }
  options.onCode(start)
  let interval = start.interval * 1000
  for (;;) {
    await sleep(interval, signal)
    if (signal?.aborted) return { status: 'cancelled' }
    if (now() >= start.expiresAt) return { status: 'expired' }
    let poll: AccountLinkPoll
    try {
      poll = await client.pollLink(start.linkId, deviceSecret)
    } catch (error) {
      if (signal?.aborted) return { status: 'cancelled' }
      // Unreachable for a moment: the code is still good until it expires.
      if (isAccountError(error) && error.kind === 'unavailable') continue
      throw error
    }
    if (poll.status === 'slow-down') {
      interval = Math.max(interval * 2, 1000)
      continue
    }
    if (poll.status === 'pending') continue
    if (poll.status === 'expired') return { status: 'expired' }
    const { grant } = poll
    const revoke = (): Promise<unknown> =>
      client.call('mutation', 'devices:signOut', {}, grant.accessToken).catch(() => undefined)
    if (signal?.aborted) {
      await revoke()
      return { status: 'cancelled' }
    }
    try {
      await secrets.set(ACCOUNT_SECRET_KEY, grant.refreshToken)
    } catch {
      await revoke()
      return { status: 'secrets' }
    }
    return { status: 'approved', grant }
  }
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

export interface AccountTransportOptions {
  /** How often `watch` asks for the account's version; 0 asks only on a return to the foreground. */
  versionPollMs?: number
  /** False while the app is in the background: the version poll skips its turn (Android). */
  foreground?: () => boolean
  /** The app's return to the foreground (Android): the version is asked right then. */
  onForeground?: (listener: () => void) => () => void
}

/**
 * The documents in the account. `README.txt` is the folder transports' note for whoever opens
 * the folder in a file manager; nobody browses the account, so it is not stored – `list`
 * reports it (the engine's `ensureReadme` stays quiet), `read` answers its text, and writing or
 * removing it does nothing.
 *
 * `watch` polls `sync:version`, the account's change counter (bumped once per document written
 * or removed). The transport counts its own writes – each bumps it exactly once – so a change it
 * made itself is not reported back to the engine, which would otherwise answer every round with
 * another; its removes (a remove of a missing document bumps nothing) and the writes whose
 * answer never came are not counted, so the error is always a change reported too many, never
 * one missed. A version read while a write of its own is in flight says nothing either way and
 * is asked again at the next turn.
 */
export class AccountTransport implements SyncTransport {
  /** The version as last read, with how many of its own writes had landed by then. */
  private known: { version: number; own: number } | null = null
  /** Writes of this transport that the service answered (each bumped the version once). */
  private ownWrites = 0
  private inFlight = 0
  private readonly versionPollMs: number

  constructor(
    readonly session: AccountSession,
    private readonly options: AccountTransportOptions = {}
  ) {
    this.versionPollMs = options.versionPollMs ?? ACCOUNT_VERSION_POLL_MS
  }

  async list(): Promise<string[]> {
    const value = await this.session.query('sync:list')
    const names = Array.isArray(value)
      ? value.filter((n): n is string => typeof n === 'string')
      : []
    return names.includes(README_NAME) ? names : [...names, README_NAME]
  }

  async read(name: string): Promise<string | null> {
    checkName(name)
    if (name === README_NAME) return README
    const value = await this.session.query('sync:read', { name })
    return typeof value === 'string' ? value : null
  }

  /**
   * Several documents per request (`sync:readMany`, up to 64 names), in the order asked. The
   * service answers the in-order prefix that fits its read budget, so the rest is asked again.
   */
  async readMany(names: string[]): Promise<(string | null)[]> {
    for (const name of names) checkName(name)
    const out: (string | null)[] = names.map((name) => (name === README_NAME ? README : null))
    const wanted = names.flatMap((name, i) => (name === README_NAME ? [] : [i]))
    for (let at = 0; at < wanted.length;) {
      const batch = wanted.slice(at, at + ACCOUNT_READ_MANY_MAX)
      const value = await this.session.query('sync:readMany', { names: batch.map((i) => names[i]) })
      const texts: unknown[] = Array.isArray(value) ? value.slice(0, batch.length) : []
      if (texts.length === 0)
        throw new AccountError('refused', 'Account sync:readMany answered no documents')
      texts.forEach((text, j) => {
        out[batch[j]] = typeof text === 'string' ? text : null
      })
      at += texts.length
    }
    return out
  }

  async write(name: string, text: string): Promise<void> {
    checkName(name)
    if (name === README_NAME) return
    this.inFlight += 1
    try {
      await this.session.mutation('sync:write', { name, text })
      this.ownWrites += 1
    } finally {
      this.inFlight -= 1
    }
  }

  async remove(name: string): Promise<void> {
    checkName(name)
    if (name === README_NAME) return
    await this.mutate('sync:remove', { name })
  }

  async removeAll(): Promise<void> {
    await this.mutate('sync:removeAll', {})
  }

  private async mutate(path: string, args: Record<string, unknown>): Promise<void> {
    this.inFlight += 1
    try {
      await this.session.mutation(path, args)
    } finally {
      this.inFlight -= 1
    }
  }

  /**
   * Whether the account changed since the last look by anything but this transport's writes.
   * The first look only takes the version in; a look that overlapped a write of its own
   * answers false and leaves the last version standing, so the next look still sees the change.
   */
  async changed(): Promise<boolean> {
    const own = this.ownWrites
    const quiet = this.inFlight === 0
    const value = await this.session.query('sync:version')
    if (typeof value !== 'number') return false
    if (!quiet || this.inFlight > 0 || this.ownWrites !== own) return false
    const known = this.known
    this.known = { version: value, own }
    if (!known) return false
    return value - known.version > own - known.own
  }

  watch(onChange: () => void): () => void {
    let stopped = false
    let checking = false
    const check = (): void => {
      if (stopped || checking || this.session.signedOut) return
      checking = true
      this.changed()
        .then((changed) => {
          if (changed && !stopped) onChange()
        })
        // A failure here is the round's to report; the next turn asks again.
        .catch(() => undefined)
        .finally(() => {
          checking = false
        })
    }
    check()
    const timer =
      this.versionPollMs > 0
        ? setInterval(() => {
            if (this.options.foreground?.() === false) return
            check()
          }, this.versionPollMs)
        : null
    const unsubscribe = this.options.onForeground?.(check)
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      unsubscribe?.()
    }
  }
}

function checkName(name: string): void {
  if (!DOCUMENT_NAME.test(name)) throw new Error(`invalid sync document name: ${name}`)
}
