import type { Infer } from 'convex/values'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { env, internalMutation } from './_generated/server'
import { userAction, userMutation, userQuery } from './lib/customFunctions'
import { DELETE_BATCH } from './lib/limits'
import { deleteDocumentBatch } from './sync'

const accountSummary = v.object({
  email: v.string(),
  authMethods: v.array(v.string()),
  createdAt: v.number(),
  bytesUsed: v.number(),
  documentCount: v.number()
})

/** The website's first call after sign-in: the account row exists from here on. */
function summarise(user: Doc<'users'>): Infer<typeof accountSummary> {
  return {
    email: user.email,
    authMethods: user.authMethods,
    createdAt: user.createdAt,
    bytesUsed: user.bytesUsed,
    documentCount: user.documentCount
  }
}

export const ensure = userMutation({
  args: {},
  returns: accountSummary,
  handler: (ctx) => Promise.resolve(summarise(ctx.user))
})

export const me = userQuery({
  args: {},
  returns: v.union(accountSummary, v.null()),
  handler: (ctx) => Promise.resolve(ctx.user ? summarise(ctx.user) : null)
})

/**
 * Delete the account: the Clerk user first (so the email is free and no sign-in works), then
 * the data, through the same path the `user.deleted` webhook takes. Idempotent with it.
 */
export const deleteAccount = userAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const res = await fetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(ctx.identity.subject)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } }
    )
    if (!res.ok && res.status !== 404) {
      console.error('Clerk user deletion failed', { status: res.status })
      throw new Error('Could not delete the account; try again later')
    }
    await ctx.runMutation(internal.account.beginDeletion, { clerkUserId: ctx.identity.subject })
    return null
  }
})

/** Mirror Clerk's view of the user (webhook `user.created` / `user.updated`). */
export const upsertFromClerk = internalMutation({
  args: { clerkUserId: v.string(), email: v.string(), authMethods: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { clerkUserId, email, authMethods }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerk_id', (q) => q.eq('clerkUserId', clerkUserId))
      .unique()
    if (user) {
      if (user.deletedAt === undefined)
        await ctx.db.patch('users', user._id, { email, authMethods })
      return null
    }
    const id = await ctx.db.insert('users', {
      clerkUserId,
      email,
      authMethods,
      bytesUsed: 0,
      documentCount: 0,
      createdAt: Date.now()
    })
    await ctx.db.insert('syncState', { userId: id, version: 0 })
    return null
  }
})

/** Mark the account deleted, revoke every device, and start erasing its data in batches. */
export const beginDeletion = internalMutation({
  args: { clerkUserId: v.string() },
  returns: v.null(),
  handler: async (ctx, { clerkUserId }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerk_id', (q) => q.eq('clerkUserId', clerkUserId))
      .unique()
    if (!user || user.deletedAt !== undefined) return null
    const now = Date.now()
    await ctx.db.patch('users', user._id, { deletedAt: now })
    const sessions = await ctx.db
      .query('deviceSessions')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .take(200)
    for (const s of sessions)
      if (s.revokedAt === undefined) await ctx.db.patch('deviceSessions', s._id, { revokedAt: now })
    await ctx.scheduler.runAfter(0, internal.account.eraseData, { userId: user._id })
    return null
  }
})

/** Erase a deleted account's data a batch at a time, then the account row itself. */
export const eraseData = internalMutation({
  args: { userId: v.id('users') },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    if (await deleteDocumentBatch(ctx, userId)) {
      await ctx.scheduler.runAfter(0, internal.account.eraseData, { userId })
      return null
    }
    if (await deleteRows(ctx, userId)) {
      await ctx.scheduler.runAfter(0, internal.account.eraseData, { userId })
      return null
    }
    await ctx.db.delete('users', userId)
    return null
  }
})

/** Sessions, links and sync state of the account; true when some remain. */
async function deleteRows(ctx: MutationCtx, userId: Id<'users'>): Promise<boolean> {
  const sessions = await ctx.db
    .query('deviceSessions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(DELETE_BATCH + 1)
  for (const s of sessions.slice(0, DELETE_BATCH)) await ctx.db.delete('deviceSessions', s._id)
  const links = await ctx.db
    .query('deviceLinks')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(DELETE_BATCH + 1)
  for (const l of links.slice(0, DELETE_BATCH)) await ctx.db.delete('deviceLinks', l._id)
  const states = await ctx.db
    .query('syncState')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(10)
  for (const s of states) await ctx.db.delete('syncState', s._id)
  return sessions.length > DELETE_BATCH || links.length > DELETE_BATCH
}
