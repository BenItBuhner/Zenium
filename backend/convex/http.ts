import { httpRouter } from 'convex/server'
import { ConvexError } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { env, httpAction } from './_generated/server'
import {
  parsePrivateJwk,
  publicJwk,
  randomToken,
  randomUserCode,
  sha256Hex,
  signJwt,
  verifySvix
} from './lib/crypto'
import { ACCESS_TOKEN_TTL_S, DEVICE_AUDIENCE } from './lib/limits'

const http = httpRouter()

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function rateLimited(error: unknown): boolean {
  return (
    error instanceof ConvexError &&
    typeof error.data === 'object' &&
    error.data !== null &&
    (error.data as { code?: unknown }).code === 'rate-limited'
  )
}

const DEVICE_KINDS = new Set(['desktop', 'laptop', 'phone', 'tablet'])
type DeviceKind = 'desktop' | 'laptop' | 'phone' | 'tablet'

function siteUrl(): string {
  return env.CONVEX_SITE_URL.replace(/\/+$/, '')
}

async function accessToken(
  sessionId: Id<'deviceSessions'>,
  clerkUserId: string
): Promise<{ accessToken: string; expiresAt: number }> {
  const key = parsePrivateJwk(env.DEVICE_JWT_PRIVATE_KEY)
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ACCESS_TOKEN_TTL_S
  const token = await signJwt(key, {
    iss: siteUrl(),
    sub: clerkUserId,
    aud: DEVICE_AUDIENCE,
    sid: sessionId,
    iat,
    exp
  })
  return { accessToken: token, expiresAt: exp * 1000 }
}

http.route({
  path: '/.well-known/jwks.json',
  method: 'GET',
  handler: httpAction(() => {
    const key = parsePrivateJwk(env.DEVICE_JWT_PRIVATE_KEY)
    return Promise.resolve(
      new Response(JSON.stringify({ keys: [publicJwk(key)] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
      })
    )
  })
})

/** Step 1 of linking: the device registers its secret's hash and gets a code to show. */
http.route({
  path: '/auth/device/start',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await readJson(request)
    const secretHash = body?.['secretHash']
    const deviceName = body?.['deviceName']
    const kind = body?.['kind']
    if (
      typeof secretHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(secretHash) ||
      typeof deviceName !== 'string' ||
      typeof kind !== 'string' ||
      !DEVICE_KINDS.has(kind)
    )
      return json({ error: 'bad-request' }, 400)
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = randomUserCode()
      try {
        const link = await ctx.runMutation(internal.links.create, {
          userCode,
          secretHash,
          deviceName,
          kind: kind as DeviceKind
        })
        if (!link) continue
        const site = env.ACCOUNTS_SITE_URL.replace(/\/+$/, '')
        return json({
          linkId: link.linkId,
          userCode,
          expiresAt: link.expiresAt,
          verificationUri: `${site}/link`,
          verificationUriComplete: `${site}/link?code=${encodeURIComponent(userCode)}`,
          interval: 2
        })
      } catch (error) {
        if (rateLimited(error)) return json({ error: 'rate-limited' }, 429)
        throw error
      }
    }
    return json({ error: 'unavailable' }, 503)
  })
})

/** Step 3 of linking: the device polls with its secret until the user approved the code. */
http.route({
  path: '/auth/device/token',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await readJson(request)
    const linkId = body?.['linkId']
    const deviceSecret = body?.['deviceSecret']
    if (typeof linkId !== 'string' || typeof deviceSecret !== 'string' || deviceSecret.length < 32)
      return json({ error: 'bad-request' }, 400)
    const refreshToken = randomToken()
    let result
    try {
      result = await ctx.runMutation(internal.links.exchange, {
        linkId,
        secretHash: await sha256Hex(deviceSecret),
        refreshHash: await sha256Hex(refreshToken)
      })
    } catch (error) {
      if (rateLimited(error)) return json({ error: 'rate-limited' }, 429)
      throw error
    }
    if (result.status === 'pending') return json({ status: 'pending' })
    if (result.status === 'expired') return json({ status: 'expired' }, 400)
    return json({
      status: 'approved',
      refreshToken,
      ...(await accessToken(result.sessionId, result.clerkUserId)),
      account: { email: result.email },
      sessionId: result.sessionId
    })
  })
})

/** A fresh access token for a linked device; the refresh token rotates every time. */
http.route({
  path: '/auth/refresh',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await readJson(request)
    const presented = body?.['refreshToken']
    if (typeof presented !== 'string' || presented.length < 32)
      return json({ error: 'bad-request' }, 400)
    const next = randomToken()
    let result
    try {
      result = await ctx.runMutation(internal.tokens.rotate, {
        refreshHash: await sha256Hex(presented),
        nextRefreshHash: await sha256Hex(next)
      })
    } catch (error) {
      if (rateLimited(error)) return json({ error: 'rate-limited' }, 429)
      throw error
    }
    if (result.status !== 'ok') return json({ error: result.status }, 401)
    return json({
      refreshToken: next,
      ...(await accessToken(result.sessionId, result.clerkUserId)),
      account: { email: result.email },
      sessionId: result.sessionId
    })
  })
})

interface ClerkEmail {
  id: string
  email_address: string
  verification?: { status?: string | null; strategy?: string | null } | null
}

interface ClerkUserData {
  id: string
  primary_email_address_id?: string | null
  email_addresses?: ClerkEmail[]
  password_enabled?: boolean
  external_accounts?: { provider?: string }[]
}

/**
 * The account's sign-in methods (`email`, `password`, `oauth_google`…). A verified address signs
 * in by code or link, whichever the instance offers; how it was verified (`admin`,
 * `email_link`…) is not a method. OAuth providers arrive as external accounts.
 */
export function authMethodsOf(user: ClerkUserData): string[] {
  const methods = new Set<string>()
  if (user.password_enabled) methods.add('password')
  for (const e of user.email_addresses ?? []) {
    if (e.verification?.status !== 'verified') continue
    const strategy = e.verification.strategy ?? ''
    methods.add(strategy.startsWith('from_oauth_') ? strategy.slice('from_'.length) : 'email')
  }
  for (const a of user.external_accounts ?? []) if (a.provider) methods.add(a.provider)
  return [...methods].sort()
}

function primaryEmail(user: ClerkUserData): string {
  const emails = user.email_addresses ?? []
  return (
    emails.find((e) => e.id === user.primary_email_address_id)?.email_address ??
    emails[0]?.email_address ??
    ''
  )
}

async function handleClerkEvent(
  ctx: Pick<ActionCtx, 'runMutation'>,
  event: { type?: unknown; data?: unknown }
): Promise<void> {
  const data = event.data as Partial<ClerkUserData> | undefined
  if (!data || typeof data.id !== 'string') return
  if (event.type === 'user.created' || event.type === 'user.updated') {
    const user = data as ClerkUserData
    await ctx.runMutation(internal.account.upsertFromClerk, {
      clerkUserId: user.id,
      email: primaryEmail(user),
      authMethods: authMethodsOf(user)
    })
  } else if (event.type === 'user.deleted') {
    await ctx.runMutation(internal.account.beginDeletion, { clerkUserId: data.id })
  }
}

http.route({
  path: '/webhooks/clerk',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const secret = env.CLERK_WEBHOOK_SECRET
    if (!secret) return json({ error: 'not-configured' }, 503)
    const body = await request.text()
    const ok = await verifySvix(
      secret,
      {
        id: request.headers.get('svix-id'),
        timestamp: request.headers.get('svix-timestamp'),
        signature: request.headers.get('svix-signature')
      },
      body,
      Math.floor(Date.now() / 1000)
    )
    if (!ok) return json({ error: 'bad-signature' }, 401)
    let event: { type?: unknown; data?: unknown }
    try {
      event = JSON.parse(body) as { type?: unknown; data?: unknown }
    } catch {
      return json({ error: 'bad-request' }, 400)
    }
    await handleClerkEvent(ctx, event)
    return json({ ok: true })
  })
})

export default http
