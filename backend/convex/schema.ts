import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const deviceKind = v.union(
  v.literal('desktop'),
  v.literal('laptop'),
  v.literal('phone'),
  v.literal('tablet')
)

export const linkStatus = v.union(
  v.literal('pending'),
  v.literal('approved'),
  v.literal('consumed')
)

export default defineSchema({
  /** One row per Clerk user. Keyed by the Clerk user id, never by email (§3: sign-in methods can be added later). */
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    /** Clerk's verification strategies on the account, as the webhook last saw them. */
    authMethods: v.array(v.string()),
    bytesUsed: v.number(),
    documentCount: v.number(),
    createdAt: v.number(),
    /** Set when deletion starts; every function treats the account as gone from then on. */
    deletedAt: v.optional(v.number())
  }).index('by_clerk_id', ['clerkUserId']),

  /** A device waiting to be linked to an account (RFC 8628-style device authorisation). */
  deviceLinks: defineTable({
    userCode: v.string(),
    secretHash: v.string(),
    deviceName: v.string(),
    kind: deviceKind,
    status: linkStatus,
    userId: v.optional(v.id('users')),
    /** The session the approved link became, and when: a poll whose answer was lost can collect it again. */
    sessionId: v.optional(v.id('deviceSessions')),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number()
  })
    .index('by_code', ['userCode'])
    .index('by_expires', ['expiresAt'])
    .index('by_user', ['userId']),

  /** A linked device. The refresh token is only ever stored hashed, and rotates on every use. */
  deviceSessions: defineTable({
    userId: v.id('users'),
    refreshHash: v.string(),
    prevRefreshHash: v.optional(v.string()),
    /** When `prevRefreshHash` stopped being current: the start of its retry grace. */
    rotatedAt: v.optional(v.number()),
    /**
     * The client's id for the attempt that rotated `prevRefreshHash` away: a refresh presenting
     * that token with the same id is the device retrying, not a copy (`tokens.rotate`).
     */
    rotateAttempt: v.optional(v.string()),
    deviceName: v.string(),
    kind: deviceKind,
    createdAt: v.number(),
    lastSeenAt: v.number(),
    revokedAt: v.optional(v.number())
  })
    .index('by_user', ['userId'])
    .index('by_refresh', ['refreshHash'])
    .index('by_prev_refresh', ['prevRefreshHash'])
    .index('by_revoked', ['revokedAt']),

  /** One encrypted sync document (what a device would write as a file in a sync folder). */
  syncDocuments: defineTable({
    userId: v.id('users'),
    name: v.string(),
    size: v.number(),
    chunkCount: v.number(),
    updatedAt: v.number()
  }).index('by_user_name', ['userId', 'name']),

  /** The document's text in order; chunked to stay well under the 1 MiB document limit. */
  syncChunks: defineTable({
    documentId: v.id('syncDocuments'),
    index: v.number(),
    text: v.string()
  }).index('by_document', ['documentId', 'index']),

  /** Bumped on every write or removal: what a device polls (or subscribes to) to know it should read. */
  syncState: defineTable({
    userId: v.id('users'),
    version: v.number()
  }).index('by_user', ['userId'])
})
