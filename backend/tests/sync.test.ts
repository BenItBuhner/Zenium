import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import { CHUNK_CHARS, DELETE_BATCH, MAX_BYTES, MAX_DOCUMENTS } from '../convex/lib/limits'
import { asDevice, linkDevice, makeT, refusal } from './harness'
import type { T } from './harness'

async function device(t: T, clerkUserId = 'user_a') {
  const linked = await linkDevice(t, clerkUserId)
  return asDevice(t, clerkUserId, linked.sessionId)
}

async function usage(t: T, clerkUserId = 'user_a') {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerk_id', (q) => q.eq('clerkUserId', clerkUserId))
      .unique()
    return { bytesUsed: user?.bytesUsed, documentCount: user?.documentCount }
  })
}

describe('documents', () => {
  it('writes, reads, lists and replaces documents', async () => {
    const t = makeT()
    const d = await device(t)
    expect(await d.query(api.sync.list, {})).toEqual([])
    expect(await d.query(api.sync.read, { name: 'zenium-sync.json' })).toBeNull()

    await d.mutation(api.sync.write, { name: 'zenium-sync.json', text: '{"v":1}' })
    await d.mutation(api.sync.write, { name: 'device-abc.json', text: 'ciphertext' })
    expect((await d.query(api.sync.list, {})).sort()).toEqual([
      'device-abc.json',
      'zenium-sync.json'
    ])
    expect(
      await d.query(api.sync.readMany, { names: ['device-abc.json', 'missing.json'] })
    ).toEqual(['ciphertext', null])

    await d.mutation(api.sync.write, { name: 'device-abc.json', text: 'newer' })
    expect(await d.query(api.sync.read, { name: 'device-abc.json' })).toBe('newer')
    expect(await usage(t)).toEqual({
      bytesUsed: '{"v":1}'.length + 'newer'.length,
      documentCount: 2
    })
  })

  it('round-trips a document larger than one chunk exactly', async () => {
    const t = makeT()
    const d = await device(t)
    const text = 'ab€'.repeat(Math.ceil((CHUNK_CHARS * 2.5) / 3))
    await d.mutation(api.sync.write, { name: 'big.json', text })
    expect(await d.query(api.sync.read, { name: 'big.json' })).toBe(text)
    // Shrinking it leaves no stale chunks behind.
    await d.mutation(api.sync.write, { name: 'big.json', text: 'small' })
    expect(await d.query(api.sync.read, { name: 'big.json' })).toBe('small')
    const chunks = await t.run(async (ctx) => (await ctx.db.query('syncChunks').collect()).length)
    expect(chunks).toBe(1)
  })

  it('keeps accounts apart', async () => {
    const t = makeT()
    const a = await device(t, 'user_a')
    const b = await device(t, 'user_b')
    await a.mutation(api.sync.write, { name: 'device-a.json', text: 'secret' })
    expect(await b.query(api.sync.list, {})).toEqual([])
    expect(await b.query(api.sync.read, { name: 'device-a.json' })).toBeNull()
  })

  it('refuses bad names and oversized reads', async () => {
    const t = makeT()
    const d = await device(t)
    expect(await refusal(d.mutation(api.sync.write, { name: '../escape', text: 'x' }))).toBe(
      'bad-name'
    )
    expect(await refusal(d.mutation(api.sync.write, { name: '', text: 'x' }))).toBe('bad-name')
    const names = Array.from({ length: 65 }, (_, i) => `d${i}.json`)
    expect(await refusal(d.query(api.sync.readMany, { names }))).toBe('too-large')
  })

  it('enforces the storage and document quotas', async () => {
    const t = makeT()
    const d = await device(t)
    await d.mutation(api.sync.write, { name: 'a.json', text: 'hello' })
    await t.run(async (ctx) => {
      const user = await ctx.db.query('users').first()
      if (user) await ctx.db.patch('users', user._id, { bytesUsed: MAX_BYTES - 2 })
    })
    expect(await refusal(d.mutation(api.sync.write, { name: 'b.json', text: 'too much' }))).toBe(
      'quota'
    )
    // Replacing a document counts only the difference.
    await d.mutation(api.sync.write, { name: 'a.json', text: 'hi' })

    await t.run(async (ctx) => {
      const user = await ctx.db.query('users').first()
      if (user)
        await ctx.db.patch('users', user._id, { bytesUsed: 0, documentCount: MAX_DOCUMENTS })
    })
    expect(await refusal(d.mutation(api.sync.write, { name: 'c.json', text: 'x' }))).toBe('quota')
  })

  it('bumps the version on every change', async () => {
    const t = makeT()
    const d = await device(t)
    const v0 = await d.query(api.sync.version, {})
    await d.mutation(api.sync.write, { name: 'a.json', text: '1' })
    const v1 = await d.query(api.sync.version, {})
    await d.mutation(api.sync.remove, { name: 'a.json' })
    const v2 = await d.query(api.sync.version, {})
    expect(v1).toBeGreaterThan(v0)
    expect(v2).toBeGreaterThan(v1)
    expect(await usage(t)).toEqual({ bytesUsed: 0, documentCount: 0 })
    // Removing a missing document is not an error and changes nothing.
    await d.mutation(api.sync.remove, { name: 'a.json' })
    expect(await d.query(api.sync.version, {})).toBe(v2)
  })
})

describe('removeAll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('deletes more than one batch through scheduled continuations', async () => {
    const t = makeT()
    const d = await device(t)
    const total = DELETE_BATCH + 25
    await t.run(async (ctx) => {
      const user = await ctx.db.query('users').first()
      if (!user) throw new Error('no user')
      for (let i = 0; i < total; i++) {
        const documentId = await ctx.db.insert('syncDocuments', {
          userId: user._id,
          name: `d${i}.json`,
          size: 1,
          chunkCount: 1,
          updatedAt: 0
        })
        await ctx.db.insert('syncChunks', { documentId, index: 0, text: 'x' })
      }
      await ctx.db.patch('users', user._id, { bytesUsed: total, documentCount: total })
    })
    await d.mutation(api.sync.removeAll, {})
    expect((await d.query(api.sync.list, {})).length).toBe(25)
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await d.query(api.sync.list, {})).toEqual([])
    expect(await usage(t)).toEqual({ bytesUsed: 0, documentCount: 0 })
    const chunks = await t.run(async (ctx) => (await ctx.db.query('syncChunks').collect()).length)
    expect(chunks).toBe(0)
  })
})
