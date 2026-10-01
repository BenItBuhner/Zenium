import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { MAX_ATTEMPT_ID, RETRY_ATTEMPT_GRACE_MS, RETRY_GRACE_MS } from '../convex/lib/limits'
import {
  ACCOUNTS_SITE,
  asClerkUser,
  asDevice,
  linkDevice,
  makeT,
  postJson,
  randomSecret,
  refusal,
  sha256Hex,
  SITE_URL
} from './harness'

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
}

describe('device linking', () => {
  it('serves the public signing key without the private part', async () => {
    const t = makeT()
    const res = await t.fetch('/.well-known/jwks.json')
    const { keys } = (await res.json()) as { keys: Record<string, unknown>[] }
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'test-key' })
    expect(keys[0]).not.toHaveProperty('d')
  })

  it('links a device end to end and mints a device token for the session', async () => {
    const t = makeT()
    const secret = randomSecret()
    const start = await postJson(t, '/auth/device/start', {
      secretHash: await sha256Hex(secret),
      deviceName: 'Work laptop',
      kind: 'laptop'
    })
    expect(start.status).toBe(200)
    const userCode = String(start.body['userCode'])
    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(start.body['verificationUriComplete']).toBe(
      `${ACCOUNTS_SITE}/link?code=${encodeURIComponent(userCode)}`
    )

    const poll = { linkId: start.body['linkId'], deviceSecret: secret }
    expect((await postJson(t, '/auth/device/token', poll)).body).toEqual({ status: 'pending' })

    const web = asClerkUser(t, 'user_a')
    expect(await web.query(api.links.describe, { userCode: userCode.toLowerCase() })).toMatchObject(
      {
        deviceName: 'Work laptop',
        kind: 'laptop',
        status: 'pending',
        approvedHere: false
      }
    )
    await web.mutation(api.links.approve, { userCode })

    const token = await postJson(t, '/auth/device/token', poll)
    expect(token.status).toBe(200)
    expect(token.body['status']).toBe('approved')
    expect(token.body['account']).toEqual({ email: 'user_a@example.com' })
    const [header, payload] = String(token.body['accessToken']).split('.')
    expect(decodeJwtPart(header ?? '')).toMatchObject({ alg: 'ES256', kid: 'test-key' })
    expect(decodeJwtPart(payload ?? '')).toMatchObject({
      iss: SITE_URL,
      sub: 'user_a',
      aud: 'zenium-device',
      sid: token.body['sessionId']
    })

    // A device that lost the answer polls again and collects the same session; the first
    // refresh token is replaced, not added to.
    const again = await postJson(t, '/auth/device/token', poll)
    expect(again.body).toMatchObject({ status: 'approved', sessionId: token.body['sessionId'] })
    expect(
      await postJson(t, '/auth/refresh', { refreshToken: token.body['refreshToken'] })
    ).toEqual({ status: 401, body: { error: 'invalid' } })
    expect(
      (await postJson(t, '/auth/refresh', { refreshToken: again.body['refreshToken'] })).status
    ).toBe(200)
    expect((await web.query(api.devices.list, {})).length).toBe(1)

    // Once the session has refreshed, the link cannot be collected again.
    expect((await postJson(t, '/auth/device/token', poll)).body).toEqual({ status: 'expired' })
  })

  it('stops re-issuing a consumed link after the grace window', async () => {
    const t = makeT()
    const secret = randomSecret()
    const start = await postJson(t, '/auth/device/start', {
      secretHash: await sha256Hex(secret),
      deviceName: 'Phone',
      kind: 'phone'
    })
    await asClerkUser(t, 'user_a').mutation(api.links.approve, {
      userCode: String(start.body['userCode'])
    })
    const poll = { linkId: start.body['linkId'], deviceSecret: secret }
    expect((await postJson(t, '/auth/device/token', poll)).body['status']).toBe('approved')
    await t.run(async (ctx) => {
      for (const link of await ctx.db.query('deviceLinks').collect()) {
        await ctx.db.patch('deviceLinks', link._id, {
          consumedAt: Date.now() - RETRY_GRACE_MS - 1
        })
      }
    })
    expect((await postJson(t, '/auth/device/token', poll)).body).toEqual({ status: 'expired' })
  })

  it('refuses an exchange with the wrong secret', async () => {
    const t = makeT()
    const start = await postJson(t, '/auth/device/start', {
      secretHash: await sha256Hex(randomSecret()),
      deviceName: 'Phone',
      kind: 'phone'
    })
    await asClerkUser(t, 'user_a').mutation(api.links.approve, {
      userCode: String(start.body['userCode'])
    })
    const res = await postJson(t, '/auth/device/token', {
      linkId: start.body['linkId'],
      deviceSecret: randomSecret()
    })
    expect(res.body).toEqual({ status: 'expired' })
  })

  it('rejects malformed start requests', async () => {
    const t = makeT()
    const res = await postJson(t, '/auth/device/start', {
      secretHash: 'nope',
      deviceName: 'x',
      kind: 'car'
    })
    expect(res.status).toBe(400)
  })

  it('refuses unknown, used and expired codes', async () => {
    const t = makeT()
    expect(
      await refusal(asClerkUser(t, 'user_a').mutation(api.links.approve, { userCode: 'AAAA-BBBB' }))
    ).toBe('link-not-found')

    const start = await postJson(t, '/auth/device/start', {
      secretHash: await sha256Hex(randomSecret()),
      deviceName: 'Phone',
      kind: 'phone'
    })
    const userCode = String(start.body['userCode'])
    await asClerkUser(t, 'user_a').mutation(api.links.approve, { userCode })
    // Approving again from the same account is harmless; from another it is refused.
    await asClerkUser(t, 'user_a').mutation(api.links.approve, { userCode })
    expect(await refusal(asClerkUser(t, 'user_b').mutation(api.links.approve, { userCode }))).toBe(
      'link-used'
    )
    // Another account cannot even see which device asked.
    expect(await asClerkUser(t, 'user_b').query(api.links.describe, { userCode })).toBeNull()

    const late = await postJson(t, '/auth/device/start', {
      secretHash: await sha256Hex(randomSecret()),
      deviceName: 'Tablet',
      kind: 'tablet'
    })
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query('deviceLinks')
        .withIndex('by_code', (q) => q.eq('userCode', String(late.body['userCode'])))
        .unique()
      if (link) await ctx.db.patch('deviceLinks', link._id, { expiresAt: 0 })
    })
    expect(
      await refusal(
        asClerkUser(t, 'user_a').mutation(api.links.approve, {
          userCode: String(late.body['userCode'])
        })
      )
    ).toBe('link-expired')
  })
})

describe('refresh tokens', () => {
  it('rotates on every use and the old token stops working', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    const first = await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken })
    expect(first.status).toBe(200)
    const next = String(first.body['refreshToken'])
    expect(next).not.toBe(linked.refreshToken)
    const second = await postJson(t, '/auth/refresh', { refreshToken: next })
    expect(second.status).toBe(200)
  })

  it('re-issues a token to a device that retries within the grace window', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    const lost = await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken })
    const retry = await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken })
    expect(retry.status).toBe(200)
    expect(retry.body['sessionId']).toBe(linked.sessionId)
    expect(await postJson(t, '/auth/refresh', { refreshToken: lost.body['refreshToken'] })).toEqual(
      { status: 401, body: { error: 'invalid' } }
    )
    expect(
      (await postJson(t, '/auth/refresh', { refreshToken: retry.body['refreshToken'] })).status
    ).toBe(200)
  })

  it('revokes the session when a superseded token is presented after the grace window', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    const rotated = await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken })
    await t.run(async (ctx) => {
      await ctx.db.patch('deviceSessions', linked.sessionId, {
        rotatedAt: Date.now() - RETRY_GRACE_MS - 1
      })
    })
    const replay = await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken })
    expect(replay).toEqual({ status: 401, body: { error: 'reused' } })
    // Both copies are now dead, including the legitimate latest one.
    const latest = await postJson(t, '/auth/refresh', {
      refreshToken: rotated.body['refreshToken']
    })
    expect(latest).toEqual({ status: 401, body: { error: 'invalid' } })
    expect(await refusal(asDevice(t, 'user_a', linked.sessionId).query(api.sync.list, {}))).toBe(
      'revoked'
    )
  })

  it('refuses unknown tokens', async () => {
    const t = makeT()
    const res = await postJson(t, '/auth/refresh', { refreshToken: randomSecret() })
    expect(res).toEqual({ status: 401, body: { error: 'invalid' } })
  })

  it('takes a retry that names its attempt long after the clock grace, and a different attempt as reuse', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    const lost = await postJson(t, '/auth/refresh', {
      refreshToken: linked.refreshToken,
      attempt: 'attempt-1'
    })
    expect(lost.status).toBe(200)
    // The device was offline (or backgrounded) for a day before it could retry.
    await t.run(async (ctx) => {
      await ctx.db.patch('deviceSessions', linked.sessionId, {
        rotatedAt: Date.now() - 24 * 60 * 60 * 1000
      })
    })
    const retry = await postJson(t, '/auth/refresh', {
      refreshToken: linked.refreshToken,
      attempt: 'attempt-1'
    })
    expect(retry.status).toBe(200)
    expect(retry.body['sessionId']).toBe(linked.sessionId)
    // The answer it never saw is dead; the one it has works.
    expect(await postJson(t, '/auth/refresh', { refreshToken: lost.body['refreshToken'] })).toEqual(
      { status: 401, body: { error: 'invalid' } }
    )
    const onward = await postJson(t, '/auth/refresh', {
      refreshToken: retry.body['refreshToken'],
      attempt: 'attempt-2'
    })
    expect(onward.status).toBe(200)
    // The previous token under another attempt id is a second party: both copies die.
    const other = await postJson(t, '/auth/refresh', {
      refreshToken: retry.body['refreshToken'],
      attempt: 'attempt-3'
    })
    expect(other).toEqual({ status: 401, body: { error: 'reused' } })
    expect(
      await postJson(t, '/auth/refresh', {
        refreshToken: onward.body['refreshToken'],
        attempt: 'attempt-4'
      })
    ).toEqual({ status: 401, body: { error: 'invalid' } })
  })

  it('caps the named retry, and treats a retry without the id by the clock alone', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    expect(
      (
        await postJson(t, '/auth/refresh', {
          refreshToken: linked.refreshToken,
          attempt: 'attempt-1'
        })
      ).status
    ).toBe(200)
    // Within the clock grace a retry needs no id.
    const bare = await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken })
    expect(bare.status).toBe(200)
    // Past the attempt cap the id no longer helps.
    const again = await postJson(t, '/auth/refresh', {
      refreshToken: bare.body['refreshToken'],
      attempt: 'attempt-2'
    })
    expect(again.status).toBe(200)
    await t.run(async (ctx) => {
      await ctx.db.patch('deviceSessions', linked.sessionId, {
        rotatedAt: Date.now() - RETRY_ATTEMPT_GRACE_MS - 1
      })
    })
    expect(
      await postJson(t, '/auth/refresh', {
        refreshToken: bare.body['refreshToken'],
        attempt: 'attempt-2'
      })
    ).toEqual({ status: 401, body: { error: 'reused' } })
  })

  it('refuses an attempt id it cannot read', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    expect(
      (await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken, attempt: 42 }))
        .status
    ).toBe(400)
    expect(
      (
        await postJson(t, '/auth/refresh', {
          refreshToken: linked.refreshToken,
          attempt: 'x'.repeat(MAX_ATTEMPT_ID + 1)
        })
      ).status
    ).toBe(400)
    // Neither refusal spent the token.
    expect((await postJson(t, '/auth/refresh', { refreshToken: linked.refreshToken })).status).toBe(
      200
    )
  })
})

describe('identity separation', () => {
  it('keeps Clerk and device identities to their own APIs', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    expect(await refusal(asClerkUser(t, 'user_a').query(api.sync.list, {}))).toBe('unauthenticated')
    expect(await refusal(asDevice(t, 'user_a', linked.sessionId).query(api.devices.list, {}))).toBe(
      'unauthenticated'
    )
    expect(await refusal(t.query(api.sync.list, {}))).toBe('unauthenticated')
  })

  it('refuses a device token whose subject does not own the session', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    expect(await refusal(asDevice(t, 'user_b', linked.sessionId).query(api.sync.list, {}))).toBe(
      'account-deleted'
    )
  })
})

describe('devices', () => {
  it('lists, renames and revokes devices; a revoke takes effect on the next call', async () => {
    const t = makeT()
    const laptop = await linkDevice(t, 'user_a', 'Laptop')
    const phone = await linkDevice(t, 'user_a', 'Phone')
    const web = asClerkUser(t, 'user_a')
    expect((await web.query(api.devices.list, {})).map((d) => d.name).sort()).toEqual([
      'Laptop',
      'Phone'
    ])

    await asDevice(t, 'user_a', phone.sessionId).mutation(api.devices.rename, { name: '  Pixel  ' })
    expect(await asDevice(t, 'user_a', phone.sessionId).query(api.devices.current, {})).toEqual({
      email: 'user_a@example.com',
      deviceName: 'Pixel',
      sessionId: phone.sessionId
    })

    await web.mutation(api.devices.revoke, { sessionId: laptop.sessionId })
    expect(await refusal(asDevice(t, 'user_a', laptop.sessionId).query(api.sync.version, {}))).toBe(
      'revoked'
    )
    expect((await web.query(api.devices.list, {})).map((d) => d.name)).toEqual(['Pixel'])
    const refresh = await postJson(t, '/auth/refresh', { refreshToken: laptop.refreshToken })
    expect(refresh.status).toBe(401)
  })

  it('refuses revoking another account’s device', async () => {
    const t = makeT()
    const theirs = await linkDevice(t, 'user_a')
    await asClerkUser(t, 'user_b').mutation(api.account.ensure, {})
    expect(
      await refusal(
        asClerkUser(t, 'user_b').mutation(api.devices.revoke, { sessionId: theirs.sessionId })
      )
    ).toBe('forbidden')
  })

  it('lets a device sign itself out', async () => {
    const t = makeT()
    const linked = await linkDevice(t, 'user_a')
    const device = asDevice(t, 'user_a', linked.sessionId)
    await device.mutation(api.devices.signOut, {})
    expect(await refusal(device.query(api.sync.list, {}))).toBe('revoked')
  })
})
