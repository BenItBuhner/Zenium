/**
 * Moving a sign-in from one of the user's browsers to another (`zen_cookies`).
 *
 * Each browser holds an X25519 key pair in its secret store, made on first use. An agent asks
 * the receiving browser for its public key, asks the sending browser to export a site's cookies
 * sealed to that key, carries the sealed bundle across, and imports it on the receiver. The
 * cookies are in the clear only inside the two browsers: the agent, the relay and anything in
 * between see ciphertext. A bundle names its site and is refused after `BUNDLE_TTL_MS`, so a
 * copy left in an agent's context is useless soon after.
 */
import nacl from 'tweetnacl'
import type { SecretStore } from '../platform'
import type { PortableCookie } from '../../shared/portableCookie'

export const DEVICE_KEY_SECRET = 'agents.cookieKey'
export const BUNDLE_PREFIX = 'zck1.'
/** How long a sealed bundle can be imported after it was made. */
export const BUNDLE_TTL_MS = 10 * 60_000

export interface DeviceKey {
  publicKey: string
  secretKey: Uint8Array
}

export interface CookieBundle {
  site: string
  createdAt: number
  /** The sending browser's name, for the receiving side's log. */
  from: string
  cookies: PortableCookie[]
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** This browser's key pair, made and stored on first use. */
export async function deviceKey(secrets: SecretStore): Promise<DeviceKey> {
  const stored = await secrets.get(DEVICE_KEY_SECRET)
  if (stored) {
    try {
      const secretKey = unb64(stored)
      if (secretKey.length === nacl.box.secretKeyLength) {
        return { publicKey: b64(nacl.box.keyPair.fromSecretKey(secretKey).publicKey), secretKey }
      }
    } catch {
      /* unreadable: make a new one below */
    }
  }
  const pair = nacl.box.keyPair()
  await secrets.set(DEVICE_KEY_SECRET, b64(pair.secretKey))
  return { publicKey: b64(pair.publicKey), secretKey: pair.secretKey }
}

/** Whether `text` looks like a public key this module made. */
export function isPublicKey(text: string): boolean {
  try {
    return unb64(text.trim()).length === nacl.box.publicKeyLength
  } catch {
    return false
  }
}

/** Seal a bundle to the receiving browser's public key, from a fresh one-time key pair. */
export function sealBundle(bundle: CookieBundle, recipientPublicKey: string): string {
  const recipient = unb64(recipientPublicKey.trim())
  if (recipient.length !== nacl.box.publicKeyLength) throw new Error('not a device key')
  const once = nacl.box.keyPair()
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const plain = new TextEncoder().encode(JSON.stringify(bundle))
  const box = nacl.box(plain, nonce, recipient, once.secretKey)
  return `${BUNDLE_PREFIX}${b64(once.publicKey)}.${b64(nonce)}.${b64(box)}`
}

export type OpenResult =
  | { ok: true; bundle: CookieBundle }
  | { ok: false; reason: 'malformed' | 'not-for-this-device' | 'expired' }

/** Open a bundle sealed to this browser's key; refused when it is for another key or too old. */
export function openBundle(text: string, key: DeviceKey, now = Date.now()): OpenResult {
  const t = text.trim()
  if (!t.startsWith(BUNDLE_PREFIX)) return { ok: false, reason: 'malformed' }
  const parts = t.slice(BUNDLE_PREFIX.length).split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  let plain: Uint8Array | null
  try {
    const [sender, nonce, box] = parts.map(unb64)
    plain = nacl.box.open(box, nonce, sender, key.secretKey)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!plain) return { ok: false, reason: 'not-for-this-device' }
  let bundle: CookieBundle
  try {
    bundle = JSON.parse(new TextDecoder().decode(plain)) as CookieBundle
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!Array.isArray(bundle.cookies) || typeof bundle.site !== 'string')
    return { ok: false, reason: 'malformed' }
  if (!(now - bundle.createdAt <= BUNDLE_TTL_MS && bundle.createdAt <= now + 60_000))
    return { ok: false, reason: 'expired' }
  return { ok: true, bundle }
}
