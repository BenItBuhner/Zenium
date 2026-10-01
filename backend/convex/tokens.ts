import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { fail } from './lib/errors'
import { RETRY_GRACE_MS } from './lib/limits'
import { rateLimiter } from './lib/rateLimits'

/**
 * Rotate a device's refresh token (HTTP `POST /auth/refresh`). The presented token must be the
 * current one; presenting the previous one means it was copied and both copies are in use, so
 * the session is revoked (refresh-token reuse detection, OAuth 2.0 Security BCP §4.14) – unless
 * it comes back within `RETRY_GRACE_MS` of the rotation, which is a device that never received
 * the answer: it gets a new token in place of the one it lost. The grace runs from the first
 * rotation, so retrying cannot extend it.
 */
export const rotate = internalMutation({
  args: { refreshHash: v.string(), nextRefreshHash: v.string() },
  returns: v.union(
    v.object({
      status: v.literal('ok'),
      sessionId: v.id('deviceSessions'),
      clerkUserId: v.string(),
      email: v.string()
    }),
    v.object({ status: v.literal('invalid') }),
    v.object({ status: v.literal('reused') })
  ),
  handler: async (ctx, { refreshHash, nextRefreshHash }) => {
    const now = Date.now()
    const current = await ctx.db
      .query('deviceSessions')
      .withIndex('by_refresh', (q) => q.eq('refreshHash', refreshHash))
      .unique()
    let retried = false
    let session = current
    if (!session) {
      const replayed = await ctx.db
        .query('deviceSessions')
        .withIndex('by_prev_refresh', (q) => q.eq('prevRefreshHash', refreshHash))
        .unique()
      if (!replayed || replayed.revokedAt !== undefined) return { status: 'invalid' as const }
      if (replayed.rotatedAt === undefined || now - replayed.rotatedAt > RETRY_GRACE_MS) {
        await ctx.db.patch('deviceSessions', replayed._id, { revokedAt: now })
        return { status: 'reused' as const }
      }
      session = replayed
      retried = true
    }
    if (session.revokedAt !== undefined) return { status: 'invalid' as const }
    const user = await ctx.db.get('users', session.userId)
    if (!user || user.deletedAt !== undefined) return { status: 'invalid' as const }
    const limit = await rateLimiter.limit(ctx, 'refresh', { key: session._id })
    if (!limit.ok) fail('rate-limited', 'Refreshing too often')
    await ctx.db.patch(
      'deviceSessions',
      session._id,
      retried
        ? { refreshHash: nextRefreshHash, lastSeenAt: now }
        : {
            refreshHash: nextRefreshHash,
            prevRefreshHash: refreshHash,
            rotatedAt: now,
            lastSeenAt: now
          }
    )
    return {
      status: 'ok' as const,
      sessionId: session._id,
      clerkUserId: user.clerkUserId,
      email: user.email
    }
  }
})
