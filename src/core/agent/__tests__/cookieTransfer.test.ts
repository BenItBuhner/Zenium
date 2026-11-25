import { describe, expect, it } from 'vitest'
import {
  BUNDLE_TTL_MS,
  DEVICE_KEY_SECRET,
  deviceKey,
  isPublicKey,
  openBundle,
  sealBundle,
  type CookieBundle
} from '../cookieTransfer'
import { cookieOfSite, normalizeSite } from '../../../shared/portableCookie'
import type { SecretStore } from '../../platform'

function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k)
  }
}

const bundle = (createdAt: number): CookieBundle => ({
  site: 'github.com',
  createdAt,
  from: 'Laptop',
  cookies: [
    {
      name: 'user_session',
      value: 's3cret',
      domain: 'github.com',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: true
    }
  ]
})

describe('cookie transfer', () => {
  it('keeps one device key per browser in the secret store', async () => {
    const secrets = memorySecrets()
    const a = await deviceKey(secrets)
    const b = await deviceKey(secrets)
    expect(a.publicKey).toBe(b.publicKey)
    expect(secrets.map.has(DEVICE_KEY_SECRET)).toBe(true)
    expect(isPublicKey(a.publicKey)).toBe(true)
    expect(isPublicKey('github.com')).toBe(false)
  })

  it('only the receiving browser opens a bundle, and the agent sees no cookie values', async () => {
    const receiver = await deviceKey(memorySecrets())
    const other = await deviceKey(memorySecrets())
    const now = 1_700_000_000_000
    const sealed = sealBundle(bundle(now), receiver.publicKey)
    expect(sealed.startsWith('zck1.')).toBe(true)
    expect(sealed).not.toContain('s3cret')
    expect(sealed).not.toContain('user_session')
    const opened = openBundle(sealed, receiver, now + 1000)
    expect(opened.ok && opened.bundle.cookies[0].value).toBe('s3cret')
    expect(openBundle(sealed, other, now)).toEqual({ ok: false, reason: 'not-for-this-device' })
  })

  it('refuses an old bundle, a tampered one and other text', async () => {
    const receiver = await deviceKey(memorySecrets())
    const now = 1_700_000_000_000
    const sealed = sealBundle(bundle(now), receiver.publicKey)
    expect(openBundle(sealed, receiver, now + BUNDLE_TTL_MS + 1)).toEqual({
      ok: false,
      reason: 'expired'
    })
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect(openBundle(tampered, receiver, now).ok).toBe(false)
    expect(openBundle('hello', receiver, now)).toEqual({ ok: false, reason: 'malformed' })
    expect(() => sealBundle(bundle(now), 'nope')).toThrow()
  })
})

describe('sites', () => {
  it('normalizes what an agent may type', () => {
    expect(normalizeSite('https://www.GitHub.com/login')).toBe('github.com')
    expect(normalizeSite('.github.com')).toBe('github.com')
    expect(normalizeSite('github.com:443')).toBe('github.com')
    expect(normalizeSite('localhost')).toBeNull()
    expect(normalizeSite('')).toBeNull()
  })

  it('matches a site and its subdomains, not look-alikes', () => {
    expect(cookieOfSite({ domain: '.github.com' }, 'github.com')).toBe(true)
    expect(cookieOfSite({ domain: 'api.github.com' }, 'github.com')).toBe(true)
    expect(cookieOfSite({ domain: 'notgithub.com' }, 'github.com')).toBe(false)
  })
})
