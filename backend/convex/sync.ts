import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { deviceMutation, deviceQuery } from './lib/customFunctions'
import { fail } from './lib/errors'
import {
  CHUNK_CHARS,
  DELETE_BATCH,
  DOCUMENT_NAME,
  MAX_BYTES,
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENTS
} from './lib/limits'

async function findDocument(
  ctx: QueryCtx,
  userId: Id<'users'>,
  name: string
): Promise<Doc<'syncDocuments'> | null> {
  return await ctx.db
    .query('syncDocuments')
    .withIndex('by_user_name', (q) => q.eq('userId', userId).eq('name', name))
    .unique()
}

async function readText(ctx: QueryCtx, doc: Doc<'syncDocuments'>): Promise<string> {
  const chunks = await ctx.db
    .query('syncChunks')
    .withIndex('by_document', (q) => q.eq('documentId', doc._id))
    .take(doc.chunkCount)
  return chunks.map((c) => c.text).join('')
}

async function deleteChunks(ctx: MutationCtx, doc: Doc<'syncDocuments'>): Promise<void> {
  const chunks = await ctx.db
    .query('syncChunks')
    .withIndex('by_document', (q) => q.eq('documentId', doc._id))
    .take(doc.chunkCount)
  for (const chunk of chunks) await ctx.db.delete('syncChunks', chunk._id)
}

export async function bumpVersion(ctx: MutationCtx, userId: Id<'users'>): Promise<void> {
  const state = await ctx.db
    .query('syncState')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique()
  if (state) await ctx.db.patch('syncState', state._id, { version: state.version + 1 })
  else await ctx.db.insert('syncState', { userId, version: 1 })
}

/** Names of the account's documents (a sync folder's listing). */
export const list = deviceQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('syncDocuments')
      .withIndex('by_user_name', (q) => q.eq('userId', ctx.user._id))
      .take(MAX_DOCUMENTS)
    return docs.map((d) => d.name)
  }
})

/** A document's text, or null when it does not exist. */
export const read = deviceQuery({
  args: { name: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { name }) => {
    const doc = await findDocument(ctx, ctx.user._id, name)
    return doc ? await readText(ctx, doc) : null
  }
})

/** Several documents at once (a device reading every other device's file in one round trip). */
export const readMany = deviceQuery({
  args: { names: v.array(v.string()) },
  returns: v.array(v.union(v.string(), v.null())),
  handler: async (ctx, { names }) => {
    if (names.length > 64) fail('too-large', 'Read at most 64 documents at once')
    const out: (string | null)[] = []
    for (const name of names) {
      const doc = await findDocument(ctx, ctx.user._id, name)
      out.push(doc ? await readText(ctx, doc) : null)
    }
    return out
  }
})

/** The account's change counter: a device reads again when it moved. */
export const version = deviceQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const state = await ctx.db
      .query('syncState')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user._id))
      .unique()
    return state?.version ?? 0
  }
})

/** Create or replace a document. Atomic: a reader never sees a half-written one. */
export const write = deviceMutation({
  args: { name: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { name, text }) => {
    if (!DOCUMENT_NAME.test(name)) fail('bad-name', 'Document names are letters, digits, . _ -')
    if (text.length > MAX_DOCUMENT_CHARS) fail('too-large', 'The document is too large to sync')
    const existing = await findDocument(ctx, ctx.user._id, name)
    const bytesAfter = ctx.user.bytesUsed - (existing?.size ?? 0) + text.length
    const countAfter = ctx.user.documentCount + (existing ? 0 : 1)
    if (bytesAfter > MAX_BYTES) fail('quota', 'The account’s sync storage is full')
    if (countAfter > MAX_DOCUMENTS) fail('quota', 'The account has too many sync documents')

    const chunkCount = Math.max(1, Math.ceil(text.length / CHUNK_CHARS))
    let documentId: Id<'syncDocuments'>
    if (existing) {
      await deleteChunks(ctx, existing)
      await ctx.db.patch('syncDocuments', existing._id, {
        size: text.length,
        chunkCount,
        updatedAt: Date.now()
      })
      documentId = existing._id
    } else {
      documentId = await ctx.db.insert('syncDocuments', {
        userId: ctx.user._id,
        name,
        size: text.length,
        chunkCount,
        updatedAt: Date.now()
      })
    }
    for (let i = 0; i < chunkCount; i++)
      await ctx.db.insert('syncChunks', {
        documentId,
        index: i,
        text: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)
      })
    await ctx.db.patch('users', ctx.user._id, { bytesUsed: bytesAfter, documentCount: countAfter })
    await bumpVersion(ctx, ctx.user._id)
    return null
  }
})

/** Delete a document; a missing one is not an error. */
export const remove = deviceMutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, { name }) => {
    const doc = await findDocument(ctx, ctx.user._id, name)
    if (!doc) return null
    await deleteChunks(ctx, doc)
    await ctx.db.delete('syncDocuments', doc._id)
    await ctx.db.patch('users', ctx.user._id, {
      bytesUsed: Math.max(0, ctx.user.bytesUsed - doc.size),
      documentCount: Math.max(0, ctx.user.documentCount - 1)
    })
    await bumpVersion(ctx, ctx.user._id)
    return null
  }
})

/**
 * Delete every document (the user disconnects and wipes the shared copy). A first batch goes
 * now; anything left is deleted by a scheduled continuation within moments.
 */
export const removeAll = deviceMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const more = await deleteDocumentBatch(ctx, ctx.user._id)
    await bumpVersion(ctx, ctx.user._id)
    if (more)
      await ctx.scheduler.runAfter(0, internal.sync.removeAllContinue, { userId: ctx.user._id })
    return null
  }
})

export const removeAllContinue = internalMutation({
  args: { userId: v.id('users') },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const more = await deleteDocumentBatch(ctx, userId)
    await bumpVersion(ctx, userId)
    if (more) await ctx.scheduler.runAfter(0, internal.sync.removeAllContinue, { userId })
    return null
  }
})

/** Delete up to `DELETE_BATCH` documents with their chunks; true when some remain. */
export async function deleteDocumentBatch(ctx: MutationCtx, userId: Id<'users'>): Promise<boolean> {
  const docs = await ctx.db
    .query('syncDocuments')
    .withIndex('by_user_name', (q) => q.eq('userId', userId))
    .take(DELETE_BATCH + 1)
  let bytes = 0
  const batch = docs.slice(0, DELETE_BATCH)
  for (const doc of batch) {
    await deleteChunks(ctx, doc)
    await ctx.db.delete('syncDocuments', doc._id)
    bytes += doc.size
  }
  const user = await ctx.db.get('users', userId)
  if (user)
    await ctx.db.patch('users', userId, {
      bytesUsed: Math.max(0, user.bytesUsed - bytes),
      documentCount: Math.max(0, user.documentCount - batch.length)
    })
  return docs.length > DELETE_BATCH
}
