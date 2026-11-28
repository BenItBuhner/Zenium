/**
 * Token checks for the two kinds of caller:
 *
 * - Browsers present the device access token the Zenium account service (Convex) already gives
 *   every signed-in browser: an ES256 JWT, audience `zenium-device`, issuer the deployment's
 *   site URL, `sub` the Clerk user id, `sid` the device's session id (`backend/convex/http.ts`).
 * - Agents present an OAuth access token from the account's Clerk instance (the authorization
 *   server the relay's protected-resource metadata names). A JWT is checked against Clerk's
 *   JWKS; an opaque token is checked with Clerk's Backend API when a secret key is configured.
 *
 * Either way the account is the Clerk user id, so an agent and a browser of the same person meet
 * in the same `AccountRelay`.
 */

export interface JwtClaims {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  iat?: number
  sid?: string
  client_id?: string
  azp?: string
  scope?: string
  [claim: string]: unknown
}

interface Jwk extends JsonWebKey {
  kid?: string
}

const JWKS_TTL_MS = 5 * 60 * 1000
/** Clock skew tolerated on `exp` / `nbf`. */
const LEEWAY_S = 60

const jwksCache = new Map<string, { at: number; keys: Jwk[] }>()

/** For tests: forget every cached key set. */
export function clearJwksCache(): void {
  jwksCache.clear()
}

async function jwks(url: string, fetcher: typeof fetch, fresh = false): Promise<Jwk[]> {
  const cached = jwksCache.get(url)
  if (!fresh && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys
  const res = await fetcher(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`JWKS ${url} answered ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache.set(url, { at: Date.now(), keys })
  return keys
}

function b64urlBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64urlJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(text)))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function looksLikeJwt(token: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)
}

const ALGORITHMS: Record<
  string,
  { import: SubtleCryptoImportKeyAlgorithm; verify: SubtleCryptoSignAlgorithm }
> = {
  ES256: {
    import: { name: 'ECDSA', namedCurve: 'P-256' },
    verify: { name: 'ECDSA', hash: 'SHA-256' }
  },
  RS256: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verify: { name: 'RSASSA-PKCS1-v1_5' }
  }
}

export interface VerifyOptions {
  issuer: string
  jwksUrl: string
  /** When set, `aud` must contain it. */
  audience?: string
  fetcher?: typeof fetch
  now?: number
}

/**
 * Verify a JWT's signature against the issuer's JWKS and its registered claims. Null for any
 * token that does not pass, whatever the reason – callers answer 401 either way.
 */
export async function verifyJwt(token: string, opts: VerifyOptions): Promise<JwtClaims | null> {
  if (!looksLikeJwt(token)) return null
  const [h, p, s] = token.split('.')
  const header = b64urlJson(h)
  const claims = b64urlJson(p) as JwtClaims | null
  if (!header || !claims) return null
  const alg = typeof header.alg === 'string' ? ALGORITHMS[header.alg] : undefined
  if (!alg) return null
  const fetcher = opts.fetcher ?? fetch
  const kid = typeof header.kid === 'string' ? header.kid : undefined
  const pick = (keys: Jwk[]): Jwk | undefined =>
    keys.find((k) => (kid ? k.kid === kid : true) && (k.alg === undefined || k.alg === header.alg))
  let jwk: Jwk | undefined
  try {
    jwk = pick(await jwks(opts.jwksUrl, fetcher))
    // A key id we have not seen: the issuer may have rotated since the cache was filled.
    if (!jwk && kid) jwk = pick(await jwks(opts.jwksUrl, fetcher, true))
  } catch {
    return null
  }
  if (!jwk) return null
  let ok = false
  try {
    const { kid: _kid, ...material } = jwk
    void _kid
    const key = await crypto.subtle.importKey('jwk', material, alg.import, false, ['verify'])
    ok = await crypto.subtle.verify(
      alg.verify,
      key,
      b64urlBytes(s),
      new TextEncoder().encode(`${h}.${p}`)
    )
  } catch {
    return null
  }
  if (!ok) return null
  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  if (trimSlash(claims.iss ?? '') !== trimSlash(opts.issuer)) return null
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < now) return null
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > now) return null
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
    if (!aud.includes(opts.audience)) return null
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return null
  return claims
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

// --- the two callers ---------------------------------------------------------------------

export interface RelayEnv {
  ACCOUNT: DurableObjectNamespace
  /** Convex site URL: issuer of device tokens. */
  DEVICE_JWT_ISSUER: string
  /** Clerk Frontend API URL: issuer of agents' OAuth tokens (and their authorization server). */
  AGENT_JWT_ISSUER?: string
  /** When set, agents' JWTs must carry this audience (the relay's MCP URL, RFC 8707). */
  AGENT_AUDIENCE?: string
  /** Clerk Backend API key: verifies opaque OAuth access tokens. */
  CLERK_SECRET_KEY?: string
  /** Local testing only: an agent presenting this is let in without OAuth (see README). */
  DEV_AGENT_TOKEN?: string
  /** Comma-separated scopes advertised in the protected-resource metadata. */
  AGENT_SCOPES?: string
}

export const DEVICE_AUDIENCE = 'zenium-device'

export interface DeviceIdentity {
  userId: string
  deviceId: string
  /** Seconds since the epoch. */
  exp: number
}

export async function verifyDeviceToken(
  token: string,
  env: Pick<RelayEnv, 'DEVICE_JWT_ISSUER'>,
  fetcher?: typeof fetch
): Promise<DeviceIdentity | null> {
  const issuer = trimSlash(env.DEVICE_JWT_ISSUER)
  const claims = await verifyJwt(token, {
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    audience: DEVICE_AUDIENCE,
    fetcher
  })
  if (!claims || typeof claims.sid !== 'string' || !claims.sid) return null
  return { userId: claims.sub!, deviceId: claims.sid, exp: claims.exp! }
}

export interface AgentIdentity {
  /** The Clerk user id; `dev` marks the local-testing token, whose account the relay picks. */
  userId: string
  /** The OAuth client the token was issued to: what browsers remember an approval by. */
  clientId: string
  scopes: string[]
}

/** The token's scopes; a token that names none may do everything its account allows. */
function scopesOf(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : []
}

export async function verifyAgentToken(
  token: string,
  env: RelayEnv,
  fetcher: typeof fetch = fetch
): Promise<AgentIdentity | null> {
  if (env.DEV_AGENT_TOKEN && env.DEV_AGENT_TOKEN.length >= 16 && token === env.DEV_AGENT_TOKEN)
    return { userId: 'dev', clientId: 'dev', scopes: [] }
  const issuer = env.AGENT_JWT_ISSUER ? trimSlash(env.AGENT_JWT_ISSUER) : ''
  if (!issuer) return null
  if (looksLikeJwt(token)) {
    const claims = await verifyJwt(token, {
      issuer,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      audience: env.AGENT_AUDIENCE || undefined,
      fetcher
    })
    // A Clerk session token (the website's) is also a JWT from this issuer, and must not pass
    // for an OAuth grant: those always name the client they were issued to.
    const clientId = claims?.client_id
    if (!claims || typeof clientId !== 'string' || !clientId) return null
    return { userId: claims.sub!, clientId, scopes: scopesOf(claims.scope) }
  }
  if (!env.CLERK_SECRET_KEY) return null
  // Opaque token: Clerk's Backend API says whose it is.
  let res: Response
  try {
    res = await fetcher('https://api.clerk.com/v1/oauth_applications/access_tokens/verify', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ access_token: token })
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const userId = typeof body?.subject === 'string' ? body.subject : undefined
  const clientId = typeof body?.client_id === 'string' ? body.client_id : undefined
  if (!userId || !clientId || body?.revoked === true || body?.expired === true) return null
  return {
    userId,
    clientId,
    scopes: Array.isArray(body?.scopes)
      ? (body.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
      : scopesOf(body?.scope)
  }
}
