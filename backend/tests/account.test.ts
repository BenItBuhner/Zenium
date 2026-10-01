import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { authMethodsOf } from '../convex/http'
import {
  asClerkUser,
  asDevice,
  linkDevice,
  makeT,
  postJson,
  refusal,
  WEBHOOK_SECRET
} from './harness'
import type { T } from './harness'

async function svixHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = Uint8Array.from(atob(WEBHOOK_SECRET.replace(/^whsec_/, '')), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const id = 'msg_test'
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  )
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`
  }
}

async function webhook(t: T, event: unknown, headers?: Record<string, string>) {
  const body = JSON.stringify(event)
  const res = await t.fetch('/webhooks/clerk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? (await svixHeaders(body))) },
    body
  })
  return res.status
}

const clerkUser = {
  id: 'user_a',
  primary_email_address_id: 'idn_2',
  email_addresses: [
    {
      id: 'idn_1',
      email_address: 'pending@example.com',
      verification: { status: 'unverified', strategy: 'email_code' }
    },
    {
      id: 'idn_2',
      email_address: 'primary@example.com',
      verification: { status: 'verified', strategy: 'admin' }
    }
  ],
  password_enabled: true
}

describe('account', () => {
  it('creates the row on first website use and reports usage', async () => {
    const t = makeT()
    const web = asClerkUser(t, 'user_a')
    expect(await web.query(api.account.me, {})).toBeNull()
    const summary = await web.mutation(api.account.ensure, {})
    expect(summary).toMatchObject({ email: 'user_a@example.com', bytesUsed: 0, documentCount: 0 })
    expect(await web.query(api.account.me, {})).toEqual(summary)
  })

  it('maps Clerk sign-in methods, ready for providers added later', () => {
    expect(authMethodsOf(clerkUser)).toEqual(['email', 'password'])
    expect(
      authMethodsOf({
        id: 'u',
        email_addresses: [
          {
            id: 'e',
            email_address: 'g@example.com',
            verification: { status: 'verified', strategy: 'from_oauth_google' }
          }
        ],
        external_accounts: [{ provider: 'oauth_google' }]
      })
    ).toEqual(['oauth_google'])
  })
})

describe('Clerk webhook', () => {
  it('mirrors created and updated users from a signed event', async () => {
    const t = makeT()
    expect(await webhook(t, { type: 'user.created', data: clerkUser })).toBe(200)
    const web = asClerkUser(t, 'user_a', 'primary@example.com')
    expect(await web.query(api.account.me, {})).toMatchObject({
      email: 'primary@example.com',
      authMethods: ['email', 'password']
    })
    expect(
      await webhook(t, { type: 'user.updated', data: { ...clerkUser, password_enabled: false } })
    ).toBe(200)
    expect(await web.query(api.account.me, {})).toMatchObject({
      authMethods: ['email']
    })
  })

  it('rejects bad and stale signatures', async () => {
    const t = makeT()
    const event = { type: 'user.created', data: clerkUser }
    expect(
      await webhook(t, event, {
        'svix-id': 'x',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,AAAA'
      })
    ).toBe(401)
    const stale = await svixHeaders(JSON.stringify(event), Math.floor(Date.now() / 1000) - 3600)
    expect(await webhook(t, event, stale)).toBe(401)
    expect(await asClerkUser(t, 'user_a').query(api.account.me, {})).toBeNull()
  })
})

describe('account deletion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('signs every device out at once and erases all data', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    const d = asDevice(t, 'user_a', linked.sessionId)
    await d.mutation(api.sync.write, { name: 'device-a.json', text: 'ciphertext' })

    expect(await webhook(t, { type: 'user.deleted', data: { id: 'user_a', deleted: true } })).toBe(
      200
    )
    expect(await refusal(d.query(api.sync.list, {}))).toBe('revoked')
    expect((await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken })).status).toBe(
      401
    )
    expect(await asClerkUser(t, 'user_a').query(api.account.me, {})).toBeNull()

    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const left = await t.run(async (ctx) => ({
      users: (await ctx.db.query('users').collect()).length,
      sessions: (await ctx.db.query('deviceSessions').collect()).length,
      links: (await ctx.db.query('deviceLinks').collect()).length,
      documents: (await ctx.db.query('syncDocuments').collect()).length,
      chunks: (await ctx.db.query('syncChunks').collect()).length,
      state: (await ctx.db.query('syncState').collect()).length
    }))
    expect(left).toEqual({ users: 0, sessions: 0, links: 0, documents: 0, chunks: 0, state: 0 })
  })

  it('is idempotent and refuses the website while deletion runs', async () => {
    const t = makeT()
    await asClerkUser(t, 'user_a').mutation(api.account.ensure, {})
    await t.mutation(internal.account.beginDeletion, { clerkUserId: 'user_a' })
    await t.mutation(internal.account.beginDeletion, { clerkUserId: 'user_a' })
    expect(await refusal(asClerkUser(t, 'user_a').mutation(api.account.ensure, {}))).toBe(
      'account-deleted'
    )
  })
})

describe('housekeeping', () => {
  it('deletes expired links and long-revoked sessions', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    await t.run(async (ctx) => {
      for (const link of await ctx.db.query('deviceLinks').collect())
        await ctx.db.patch('deviceLinks', link._id, { expiresAt: 1 })
      await ctx.db.patch('deviceSessions', linked.sessionId, { revokedAt: 1 })
    })
    expect(await t.mutation(internal.links.expire, {})).toBe(1)
    expect(await t.mutation(internal.devices.purgeRevoked, {})).toBe(1)
  })
})
