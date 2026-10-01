import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SITE = process.env['ZENIUM_SITE'] ?? ''
const CLOUD = process.env['ZENIUM_CLOUD'] ?? ''
const CLERK_SECRET = process.env['ZENIUM_CLERK_SECRET_KEY'] ?? ''
const live = Boolean(SITE && CLOUD && CLERK_SECRET.startsWith('sk_test_'))

type Result = { status: 'success'; value: unknown } | { status: 'error'; errorMessage: string; errorData?: { code?: string } }

async function convex(kind: 'query' | 'mutation' | 'action', path: string, args: object, token?: string) {
  const res = await fetch(`${CLOUD}/api/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args, format: 'json' })
  })
  return (await res.json()) as Result
}

function value(result: Result): unknown {
  if (result.status !== 'success') throw new Error(`${result.errorMessage} ${JSON.stringify(result.errorData)}`)
  return result.value
}

function code(result: Result): string | undefined {
  return result.status === 'error' ? result.errorData?.code : undefined
}

async function post(path: string, body: object) {
  const res = await fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function clerk(method: string, path: string, body?: object) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${CLERK_SECRET}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  if (!res.ok && res.status !== 404) throw new Error(`Clerk ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

interface Device {
  refreshToken: string
  accessToken: string
  sessionId: string
}

async function linkDevice(webToken: string, deviceName: string): Promise<Device> {
  const secret = randomBytes(32).toString('hex')
  const start = await post('/auth/device/start', {
    secretHash: createHash('sha256').update(secret).digest('hex'),
    deviceName,
    kind: 'desktop'
  })
  expect(start.status).toBe(200)
  const userCode = String(start.body['userCode'])
  const poll = { linkId: start.body['linkId'], deviceSecret: secret }
  expect((await post('/auth/device/token', poll)).body).toEqual({ status: 'pending' })
  expect(value(await convex('query', 'links:describe', { userCode }, webToken))).toMatchObject({
    deviceName,
    status: 'pending'
  })
  value(await convex('mutation', 'links:approve', { userCode }, webToken))
  const token = await post('/auth/device/token', poll)
  expect(token.body['status']).toBe('approved')
  return {
    refreshToken: String(token.body['refreshToken']),
    accessToken: String(token.body['accessToken']),
    sessionId: String(token.body['sessionId'])
  }
}

describe.skipIf(!live)('live deployment', () => {
  const email = `zenium-it-${randomBytes(4).toString('hex')}+clerk_test@example.com`
  let userId = ''
  let webToken = ''
  let deleted = false

  beforeAll(async () => {
    const user = await clerk('POST', '/users', { email_address: [email], skip_password_requirement: true })
    userId = String(user['id'])
    const session = await clerk('POST', '/sessions', { user_id: userId })
    const token = await clerk('POST', `/sessions/${String(session['id'])}/tokens/convex`)
    webToken = String(token['jwt'])
  })

  afterAll(async () => {
    if (userId && !deleted) await clerk('DELETE', `/users/${userId}`)
  })

  it('serves the device signing key', async () => {
    const res = await fetch(`${SITE}/.well-known/jwks.json`)
    const { keys } = (await res.json()) as { keys: { alg: string; d?: string }[] }
    expect(keys[0]?.alg).toBe('ES256')
    expect(keys[0]?.d).toBeUndefined()
  })

  it('links two devices, syncs between them, rotates and revokes', async () => {
    expect(value(await convex('mutation', 'account:ensure', {}, webToken))).toMatchObject({ email })

    const a = await linkDevice(webToken, 'Integration A')
    const b = await linkDevice(webToken, 'Integration B')
    expect(value(await convex('query', 'devices:current', {}, a.accessToken))).toMatchObject({ email })

    const v0 = value(await convex('query', 'sync:version', {}, b.accessToken)) as number
    value(await convex('mutation', 'sync:write', { name: 'device-a.json', text: 'ciphertext-a' }, a.accessToken))
    expect(value(await convex('query', 'sync:version', {}, b.accessToken))).toBeGreaterThan(v0)
    expect(value(await convex('query', 'sync:list', {}, b.accessToken))).toEqual(['device-a.json'])
    expect(value(await convex('query', 'sync:read', { name: 'device-a.json' }, b.accessToken))).toBe('ciphertext-a')
    const big = 'x'.repeat(700_000)
    value(await convex('mutation', 'sync:write', { name: 'big.json', text: big }, a.accessToken))
    expect(value(await convex('query', 'sync:read', { name: 'big.json' }, b.accessToken))).toBe(big)
    expect(code(await convex('mutation', 'sync:write', { name: '../x', text: 'x' }, a.accessToken))).toBe('bad-name')

    const devices = value(await convex('query', 'devices:list', {}, webToken)) as { name: string }[]
    expect(devices.map((d) => d.name).sort()).toEqual(['Integration A', 'Integration B'])

    // A web token is no device token, and the reverse.
    expect(code(await convex('query', 'sync:list', {}, webToken))).toBe('unauthenticated')
    expect(code(await convex('query', 'devices:list', {}, a.accessToken))).toBe('unauthenticated')

    const rotated = await post('/auth/refresh', { refreshToken: a.refreshToken })
    expect(rotated.status).toBe(200)
    const fresh = String(rotated.body['accessToken'])
    expect(value(await convex('query', 'sync:list', {}, fresh))).toHaveLength(2)
    expect(await post('/auth/refresh', { refreshToken: a.refreshToken })).toEqual({
      status: 401,
      body: { error: 'reused' }
    })
    expect(code(await convex('query', 'sync:list', {}, fresh))).toBe('revoked')

    value(await convex('mutation', 'devices:revoke', { sessionId: b.sessionId }, webToken))
    expect(code(await convex('query', 'sync:list', {}, b.accessToken))).toBe('revoked')
  })

  it('deletes the account and its data', async () => {
    const c = await linkDevice(webToken, 'Integration C')
    value(await convex('mutation', 'sync:write', { name: 'device-c.json', text: 'c' }, c.accessToken))
    value(await convex('action', 'account:deleteAccount', {}, webToken))
    deleted = true
    expect(code(await convex('query', 'sync:list', {}, c.accessToken))).toBe('revoked')
    expect((await post('/auth/refresh', { refreshToken: c.refreshToken })).status).toBe(401)
    expect(await clerk('GET', `/users/${userId}`)).toHaveProperty('errors')
  })
})
