import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation } from './_generated/server'
import { fail } from './lib/errors'
import { RETRY_ATTEMPT_GRACE_MS, RETRY_GRACE_MS } from './lib/limits'
import { rateLimiter } from './lib/rateLimits'

/**
 * Rotate a device's refresh token (HTTP `POST /auth/refresh`). The presented token must be the
 * current one; presenting the previous one means it was copied and both copies are in use, so
 * the session is revoked (refresh-token reuse detection, OAuth 2.0 Security BCP §4.14) – unless
 * it is the device retrying a rotation whose answer it never received:
 *
 * - A refresh that names its `attempt` (an id the client makes up per rotation and keeps beside
 *   the refresh token until the answer is in) is a retry when the id matches the one the
 *   rotation was made under, for `RETRY_ATTEMPT_GRACE_MS` after it – a device that went offline,
 *   or an Android app backgrounded mid-request, comes back to a new token rather than a forced
 *   sign-out. A different id with the previous token is a second party and is reuse.
 * - A refresh without an attempt id keeps the clock rule: a retry within `RETRY_GRACE_MS` of the
 *   rotation, reuse after.
 *
 * Both graces run from the first rotation, so retrying cannot extend them.
 */
export const rotate = internalMutation({
  args: {
    refreshHash: v.string(),
    nextRefreshHash: v.string(),
    attempt: v.optional(v.string())
  },
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
  handler: async (ctx, { refreshHash, nextRefreshHash, attempt }) => {
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
      if (!isRetry(replayed, attempt, now)) {
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
            rotateAttempt: attempt,
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

/** Whether the previous token presented now, under `attempt`, is the device retrying its last rotation. */
function isRetry(
  session: Doc<'deviceSessions'>,
  attempt: string | undefined,
  now: number
): boolean {
  if (session.rotatedAt === undefined) return false
  const age = now - session.rotatedAt
  if (attempt === undefined) return age <= RETRY_GRACE_MS
  return session.rotateAttempt === attempt && age <= RETRY_ATTEMPT_GRACE_MS
}
