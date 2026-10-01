import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { deviceMutation, deviceQuery, userMutation, userQuery } from './lib/customFunctions'
import { fail } from './lib/errors'
import { REVOKED_SESSION_RETENTION_MS } from './lib/limits'
import { deviceKind } from './schema'

const deviceSummary = v.object({
  id: v.id('deviceSessions'),
  name: v.string(),
  kind: deviceKind,
  createdAt: v.number(),
  lastSeenAt: v.number()
})

/** The account's linked devices, for the website. */
export const list = userQuery({
  args: {},
  returns: v.array(deviceSummary),
  handler: async (ctx) => {
    if (!ctx.user) return []
    const userId = ctx.user._id
    const sessions = await ctx.db
      .query('deviceSessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(200)
    return sessions
      .filter((s) => s.revokedAt === undefined)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((s) => ({
        id: s._id,
        name: s.deviceName,
        kind: s.kind,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt
      }))
  }
})

/** Sign a device out from the website: its next request is refused. */
export const revoke = userMutation({
  args: { sessionId: v.id('deviceSessions') },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('deviceSessions', sessionId)
    if (!session || session.userId !== ctx.user._id) fail('forbidden', 'Not one of your devices')
    if (session.revokedAt === undefined)
      await ctx.db.patch('deviceSessions', sessionId, { revokedAt: Date.now() })
    return null
  }
})

/** Who this device is signed in as (the browser's Settings show it). */
export const current = deviceQuery({
  args: {},
  returns: v.object({
    email: v.string(),
    deviceName: v.string(),
    sessionId: v.id('deviceSessions')
  }),
  handler: (ctx) =>
    Promise.resolve({
      email: ctx.user.email,
      deviceName: ctx.session.deviceName,
      sessionId: ctx.session._id
    })
})

/** The device signs itself out. */
export const signOut = deviceMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.db.patch('deviceSessions', ctx.session._id, { revokedAt: Date.now() })
    return null
  }
})

/** The device was renamed in the browser. */
export const rename = deviceMutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, { name }) => {
    const trimmed = name.trim().slice(0, 100)
    if (trimmed) await ctx.db.patch('deviceSessions', ctx.session._id, { deviceName: trimmed })
    return null
  }
})

/** Daily: revoked sessions older than the retention window are deleted. */
export const purgeRevoked = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - REVOKED_SESSION_RETENTION_MS
    const old = await ctx.db
      .query('deviceSessions')
      .withIndex('by_revoked', (q) => q.gt('revokedAt', 0).lt('revokedAt', cutoff))
      .take(500)
    for (const s of old) await ctx.db.delete('deviceSessions', s._id)
    return old.length
  }
})
