import type { UserIdentity } from 'convex/server'
import { customAction, customCtx, customMutation, customQuery } from 'convex-helpers/server/customFunctions'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { action, env, mutation, query } from '../_generated/server'
import { fail } from './errors'

function sameIssuer(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (s: string): string => s.replace(/\/+$/, '')
  return norm(a) === norm(b)
}

export function isDeviceIdentity(identity: UserIdentity): boolean {
  return sameIssuer(identity.issuer, env.CONVEX_SITE_URL)
}

export function isClerkIdentity(identity: UserIdentity): boolean {
  return sameIssuer(identity.issuer, env.CLERK_JWT_ISSUER_DOMAIN)
}

async function clerkIdentity(ctx: { auth: QueryCtx['auth'] }): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity || !isClerkIdentity(identity)) fail('unauthenticated', 'Sign in to continue')
  return identity
}

async function userByClerkId(ctx: QueryCtx, clerkUserId: string): Promise<Doc<'users'> | null> {
  return await ctx.db
    .query('users')
    .withIndex('by_clerk_id', (q) => q.eq('clerkUserId', clerkUserId))
    .unique()
}

/**
 * The linked device behind a device JWT: its session must exist and not be revoked, and its
 * account must not be deleted. Checked on every call, so a revoke from the website takes effect
 * on the device's next request rather than when its access token expires.
 */
export async function deviceContext(
  ctx: QueryCtx
): Promise<{ user: Doc<'users'>; session: Doc<'deviceSessions'> }> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity || !isDeviceIdentity(identity)) fail('unauthenticated', 'Link this device first')
  const sid = identity['sid']
  const sessionId = typeof sid === 'string' ? ctx.db.normalizeId('deviceSessions', sid) : null
  const session = sessionId ? await ctx.db.get('deviceSessions', sessionId) : null
  if (!session || session.revokedAt !== undefined) fail('revoked', 'This device was signed out')
  const user = await ctx.db.get('users', session.userId)
  if (!user || user.deletedAt !== undefined || user.clerkUserId !== identity.subject)
    fail('account-deleted', 'The account no longer exists')
  return { user, session }
}

/** Device API queries: `ctx.user` and `ctx.session` are the verified device's. */
export const deviceQuery = customQuery(
  query,
  customCtx(async (ctx) => await deviceContext(ctx))
)

/** Device API mutations: `ctx.user` and `ctx.session` are the verified device's. */
export const deviceMutation = customMutation(
  mutation,
  customCtx(async (ctx) => await deviceContext(ctx))
)

/**
 * Website queries, signed in with Clerk. `ctx.user` is null until the site's first
 * `account.ensure` (or the Clerk webhook) has created the row.
 */
export const userQuery = customQuery(
  query,
  customCtx(async (ctx) => {
    const identity = await clerkIdentity(ctx)
    const user = await userByClerkId(ctx, identity.subject)
    return { identity, user: user && user.deletedAt === undefined ? user : null }
  })
)

/** Website mutations, signed in with Clerk; the user row is created on first use. */
export const userMutation = customMutation(
  mutation,
  customCtx(async (ctx) => {
    const identity = await clerkIdentity(ctx)
    const user = await ensureUser(ctx, identity)
    return { identity, user }
  })
)

/** Website actions, signed in with Clerk. */
export const userAction = customAction(
  action,
  customCtx(async (ctx) => ({ identity: await clerkIdentity(ctx) }))
)

export async function ensureUser(ctx: MutationCtx, identity: UserIdentity): Promise<Doc<'users'>> {
  const existing = await userByClerkId(ctx, identity.subject)
  if (existing) {
    if (existing.deletedAt !== undefined) fail('account-deleted', 'The account is being deleted')
    if (identity.email && identity.email !== existing.email)
      await ctx.db.patch('users', existing._id, { email: identity.email })
    return existing
  }
  const id = await ctx.db.insert('users', {
    clerkUserId: identity.subject,
    email: identity.email ?? '',
    authMethods: [],
    bytesUsed: 0,
    documentCount: 0,
    createdAt: Date.now()
  })
  await ctx.db.insert('syncState', { userId: id, version: 0 })
  const user = await ctx.db.get('users', id)
  if (!user) throw new Error('User row vanished after insert')
  return user
}
