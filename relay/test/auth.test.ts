import { beforeEach, describe, expect, it } from 'vitest'
import { clearJwksCache, verifyAgentToken, verifyDeviceToken, verifyJwt } from '../src/auth'

const enc = (v: unknown) =>
  btoa(typeof v === 'string' ? v : JSON.stringify(v))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function keypair(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  return { pair, jwk: { ...pub, kid, alg: 'ES256' } }
}

async function sign(key: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const head = enc({ alg: 'ES256', kid, typ: 'JWT' })
  const body = enc(claims)
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${head}.${body}`)
  )
  let bin = ''
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b)
  return `${head}.${body}.${enc(bin)}`
}

const ISSUER = 'https://deploy.convex.site'
const now = () => Math.floor(Date.now() / 1000)

describe('token checks', () => {
  beforeEach(() => clearJwksCache())

  it('takes a device token signed by the account service and reads the device off it', async () => {
    const { pair, jwk } = await keypair('k1')
    const fetcher = (async () =>
      new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch
    const token = await sign(pair.privateKey, 'k1', {
      iss: ISSUER,
      sub: 'user_1',
      aud: 'zenium-device',
      sid: 'dev_1',
      exp: now() + 3600
    })
    expect(await verifyDeviceToken(token, { DEVICE_JWT_ISSUER: ISSUER }, fetcher)).toEqual({
      userId: 'user_1',
      deviceId: 'dev_1',
      exp: expect.any(Number)
    })
  })

  it('refuses a wrong issuer, audience, expiry or signature', async () => {
    const { pair, jwk } = await keypair('k1')
    const other = await keypair('k1')
    const fetcher = (async () =>
      new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch
    const base = { iss: ISSUER, sub: 'u', aud: 'zenium-device', sid: 's', exp: now() + 3600 }
    const opts = { issuer: ISSUER, jwksUrl: 'x', audience: 'zenium-device', fetcher }
    expect(await verifyJwt(await sign(pair.privateKey, 'k1', base), opts)).not.toBeNull()
    expect(
      await verifyJwt(await sign(pair.privateKey, 'k1', { ...base, iss: 'https://evil' }), opts)
    ).toBeNull()
    expect(
      await verifyJwt(await sign(pair.privateKey, 'k1', { ...base, aud: 'other' }), opts)
    ).toBeNull()
    expect(
      await verifyJwt(await sign(pair.privateKey, 'k1', { ...base, exp: now() - 3600 }), opts)
    ).toBeNull()
    expect(await verifyJwt(await sign(other.pair.privateKey, 'k1', base), opts)).toBeNull()
  })

  it('takes an agent OAuth token only when it names its client', async () => {
    const { pair, jwk } = await keypair('c1')
    const fetcher = (async () =>
      new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch
    const env = {
      ACCOUNT: null as never,
      DEVICE_JWT_ISSUER: ISSUER,
      AGENT_JWT_ISSUER: 'https://clerk.example.com'
    }
    const grant = await sign(pair.privateKey, 'c1', {
      iss: 'https://clerk.example.com',
      sub: 'user_1',
      client_id: 'https://claude.ai/mcp',
      scope: 'openid email',
      exp: now() + 600
    })
    expect(await verifyAgentToken(grant, env, fetcher)).toEqual({
      userId: 'user_1',
      clientId: 'https://claude.ai/mcp',
      scopes: ['openid', 'email']
    })
    // The accounts website's session token, from the same issuer: not an OAuth grant.
    const session = await sign(pair.privateKey, 'c1', {
      iss: 'https://clerk.example.com',
      sub: 'user_1',
      azp: 'https://site',
      exp: now() + 600
    })
    expect(await verifyAgentToken(session, env, fetcher)).toBeNull()
  })

  it('lets the development token in only when it is configured and long enough', async () => {
    const env = { ACCOUNT: null as never, DEVICE_JWT_ISSUER: ISSUER }
    expect(await verifyAgentToken('local-dev-token-123456', env)).toBeNull()
    expect(
      await verifyAgentToken('local-dev-token-123456', {
        ...env,
        DEV_AGENT_TOKEN: 'local-dev-token-123456'
      })
    ).toEqual({ userId: 'dev', clientId: 'dev', scopes: [] })
    expect(await verifyAgentToken('short', { ...env, DEV_AGENT_TOKEN: 'short' })).toBeNull()
  })
})
