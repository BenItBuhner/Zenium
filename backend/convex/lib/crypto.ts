import { USER_CODE_ALPHABET } from './limits'

const encoder = new TextEncoder()

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (const b of view) out += b.toString(16).padStart(2, '0')
  return out
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array | string): string {
  const view =
    typeof bytes === 'string'
      ? encoder.encode(bytes)
      : bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes)
  let binary = ''
  for (const b of view) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64Decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

/** 32 random bytes, base64url: a refresh token or a device secret. */
export function randomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
}

/** `XXXX-XXXX` from an unambiguous alphabet (~40 bits; codes live 10 minutes and are rate limited). */
export function randomUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let code = ''
  bytes.forEach((byte, i) => {
    code += USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length)
    if (i === 3) code += '-'
  })
  return code
}

/** A user code as typed: upper-cased, separators normalised. */
export function normaliseUserCode(raw: string): string {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact
}

export interface PublicJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
  kid: string
  alg: 'ES256'
  use: 'sig'
}

export interface PrivateJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
  d: string
  kid: string
}

export function parsePrivateJwk(raw: string | undefined): PrivateJwk {
  if (!raw) throw new Error('DEVICE_JWT_PRIVATE_KEY is not set')
  const jwk = JSON.parse(raw) as Partial<PrivateJwk>
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string' ||
    typeof jwk.d !== 'string' ||
    typeof jwk.kid !== 'string'
  )
    throw new Error('DEVICE_JWT_PRIVATE_KEY is not a P-256 private JWK with a kid')
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid: jwk.kid }
}

export function publicJwk(key: PrivateJwk): PublicJwk {
  return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, kid: key.kid, alg: 'ES256', use: 'sig' }
}

/** An ES256 JWS. Web Crypto's ECDSA signature is already the raw r‖s form JWS wants. */
export async function signJwt(
  key: PrivateJwk,
  claims: Record<string, string | number>
): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: key.kid }))
  const payload = base64UrlEncode(JSON.stringify(claims))
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    encoder.encode(`${header}.${payload}`)
  )
  return `${header}.${payload}.${base64UrlEncode(signature)}`
}

/** Svix (Clerk webhooks): HMAC-SHA256 over `id.timestamp.body` with the `whsec_` secret. */
export async function verifySvix(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds: number
): Promise<boolean> {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 5 * 60) return false
  const key = await crypto.subtle.importKey(
    'raw',
    base64Decode(secret.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${timestamp}.${body}`))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
  return signature
    .split(' ')
    .map((part) => part.split(',', 2))
    .some(
      ([version, value]) =>
        version === 'v1' && value !== undefined && timingSafeEqual(value, expected)
    )
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
