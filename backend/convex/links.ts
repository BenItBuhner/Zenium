import { v, type Infer } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { userMutation, userQuery } from './lib/customFunctions'
import { fail } from './lib/errors'
import { normaliseUserCode } from './lib/crypto'
import { LINK_TTL_MS, MAX_DEVICE_NAME, RETRY_GRACE_MS } from './lib/limits'
import { rateLimiter } from './lib/rateLimits'
import { deviceKind, linkStatus } from './schema'

/** A device asks to be linked (HTTP `POST /auth/device/start`). Null when the code collides. */
export const create = internalMutation({
  args: {
    userCode: v.string(),
    secretHash: v.string(),
    deviceName: v.string(),
    kind: deviceKind
  },
  returns: v.union(v.object({ linkId: v.id('deviceLinks'), expiresAt: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const limit = await rateLimiter.limit(ctx, 'linkStart')
    if (!limit.ok) fail('rate-limited', 'Too many sign-in requests; try again in a minute')
    const clash = await ctx.db
      .query('deviceLinks')
      .withIndex('by_code', (q) => q.eq('userCode', args.userCode))
      .first()
    if (clash) return null
    const now = Date.now()
    const expiresAt = now + LINK_TTL_MS
    const linkId = await ctx.db.insert('deviceLinks', {
      userCode: args.userCode,
      secretHash: args.secretHash,
      deviceName: args.deviceName.trim().slice(0, MAX_DEVICE_NAME) || 'Zenium',
      kind: args.kind,
      status: 'pending',
      createdAt: now,
      expiresAt
    })
    return { linkId, expiresAt }
  }
})

const exchangeResult = v.union(
  v.object({ status: v.literal('pending') }),
  v.object({ status: v.literal('expired') }),
  v.object({
    status: v.literal('approved'),
    sessionId: v.id('deviceSessions'),
    clerkUserId: v.string(),
    email: v.string()
  })
)

/**
 * The device polls with its secret (HTTP `POST /auth/device/token`). Once the link is approved
 * the first exchange creates the device session and consumes the link; the secret proves it is
 * the device that asked, and the refresh token's hash arrives from the action that minted it.
 * A device that never received that answer polls again: within `RETRY_GRACE_MS`, and while the
 * session has not refreshed (so no token from it is in use), the same session takes the new hash.
 */
export const exchange = internalMutation({
  args: { linkId: v.string(), secretHash: v.string(), refreshHash: v.string() },
  returns: exchangeResult,
  handler: async (ctx, args) => {
    const linkId = ctx.db.normalizeId('deviceLinks', args.linkId)
    const link = linkId ? await ctx.db.get('deviceLinks', linkId) : null
    if (!link || link.secretHash !== args.secretHash) return { status: 'expired' as const }
    const limit = await rateLimiter.limit(ctx, 'linkPoll', { key: link._id })
    if (!limit.ok) fail('rate-limited', 'Polling too fast')
    const now = Date.now()
    if (link.status === 'consumed') return await recollect(ctx, link, args.refreshHash, now)
    if (link.expiresAt < now) return { status: 'expired' as const }
    if (link.status === 'pending' || !link.userId) return { status: 'pending' as const }
    const user = await ctx.db.get('users', link.userId)
    if (!user || user.deletedAt !== undefined) return { status: 'expired' as const }
    const sessionId = await ctx.db.insert('deviceSessions', {
      userId: user._id,
      refreshHash: args.refreshHash,
      deviceName: link.deviceName,
      kind: link.kind,
      createdAt: now,
      lastSeenAt: now
    })
    await ctx.db.patch('deviceLinks', link._id, { status: 'consumed', sessionId, consumedAt: now })
    return {
      status: 'approved' as const,
      sessionId,
      clerkUserId: user.clerkUserId,
      email: user.email
    }
  }
})

async function recollect(
  ctx: MutationCtx,
  link: Doc<'deviceLinks'>,
  refreshHash: string,
  now: number
): Promise<Infer<typeof exchangeResult>> {
  if (!link.sessionId || link.consumedAt === undefined || now - link.consumedAt > RETRY_GRACE_MS)
    return { status: 'expired' }
  const session = await ctx.db.get('deviceSessions', link.sessionId)
  if (!session || session.revokedAt !== undefined || session.prevRefreshHash !== undefined)
    return { status: 'expired' }
  const user = await ctx.db.get('users', session.userId)
  if (!user || user.deletedAt !== undefined) return { status: 'expired' }
  await ctx.db.patch('deviceSessions', session._id, { refreshHash })
  return {
    status: 'approved',
    sessionId: session._id,
    clerkUserId: user.clerkUserId,
    email: user.email
  }
}

/** What the website shows before the user approves a code: which device is asking. */
export const describe = userQuery({
  args: { userCode: v.string() },
  returns: v.union(
    v.object({
      deviceName: v.string(),
      kind: deviceKind,
      status: linkStatus,
      expiresAt: v.number(),
      approvedHere: v.boolean()
    }),
    v.null()
  ),
  handler: async (ctx, { userCode }) => {
    const link = await ctx.db
      .query('deviceLinks')
      .withIndex('by_code', (q) => q.eq('userCode', normaliseUserCode(userCode)))
      .first()
    if (!link) return null
    if (link.status !== 'pending' && (!ctx.user || link.userId !== ctx.user._id)) return null
    return {
      deviceName: link.deviceName,
      kind: link.kind,
      status: link.status,
      expiresAt: link.expiresAt,
      approvedHere: Boolean(ctx.user && link.userId === ctx.user._id)
    }
  }
})

/** The signed-in user links the device showing this code to their account. */
export const approve = userMutation({
  args: { userCode: v.string() },
  returns: v.null(),
  handler: async (ctx, { userCode }) => {
    const limit = await rateLimiter.limit(ctx, 'linkApprove', { key: ctx.user._id })
    if (!limit.ok) fail('rate-limited', 'Too many attempts; wait a minute')
    const link = await ctx.db
      .query('deviceLinks')
      .withIndex('by_code', (q) => q.eq('userCode', normaliseUserCode(userCode)))
      .first()
    if (!link) fail('link-not-found', 'That code is not valid')
    if (link.status !== 'pending') {
      if (link.userId === ctx.user._id) return null
      fail('link-used', 'That code was already used')
    }
    if (link.expiresAt < Date.now()) fail('link-expired', 'That code has expired')
    await ctx.db.patch('deviceLinks', link._id, { status: 'approved', userId: ctx.user._id })
    return null
  }
})

/** Hourly: links past their expiry are deleted (a consumed link is kept until then too). */
export const expire = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const stale = await ctx.db
      .query('deviceLinks')
      .withIndex('by_expires', (q) => q.lt('expiresAt', Date.now()))
      .take(500)
    for (const link of stale) await ctx.db.delete('deviceLinks', link._id)
    return stale.length
  }
})
