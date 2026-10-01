import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { fail } from './lib/errors'
import { rateLimiter } from './lib/rateLimits'

/**
 * Rotate a device's refresh token (HTTP `POST /auth/refresh`). The presented token must be the
 * current one; presenting the previous one means it was copied and both copies are in use, so
 * the session is revoked (refresh-token reuse detection, OAuth 2.0 Security BCP §4.14).
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
    const session = await ctx.db
      .query('deviceSessions')
      .withIndex('by_refresh', (q) => q.eq('refreshHash', refreshHash))
      .unique()
    if (!session) {
      const replayed = await ctx.db
        .query('deviceSessions')
        .withIndex('by_prev_refresh', (q) => q.eq('prevRefreshHash', refreshHash))
        .unique()
      if (replayed && replayed.revokedAt === undefined) {
        await ctx.db.patch('deviceSessions', replayed._id, { revokedAt: Date.now() })
        return { status: 'reused' as const }
      }
      return { status: 'invalid' as const }
    }
    if (session.revokedAt !== undefined) return { status: 'invalid' as const }
    const user = await ctx.db.get('users', session.userId)
    if (!user || user.deletedAt !== undefined) return { status: 'invalid' as const }
    const limit = await rateLimiter.limit(ctx, 'refresh', { key: session._id })
    if (!limit.ok) fail('rate-limited', 'Refreshing too often')
    await ctx.db.patch('deviceSessions', session._id, {
      refreshHash: nextRefreshHash,
      prevRefreshHash: refreshHash,
      lastSeenAt: Date.now()
    })
    return {
      status: 'ok' as const,
      sessionId: session._id,
      clerkUserId: user.clerkUserId,
      email: user.email
    }
  }
})
