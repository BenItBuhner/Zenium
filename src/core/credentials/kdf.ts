import type { KdfParams } from '../platform'
import { DATA_KEY_BYTES, utf8 } from './crypto'

/**
 * PBKDF2-HMAC-SHA256 on Web Crypto: the passphrase key derivation every host can do (the Android
 * WebView has no scrypt). 600 000 iterations follows OWASP's current guidance. Desktop hosts use
 * `node:crypto` scrypt instead; the vault records which one wrapped the key.
 */
export const PBKDF2_ITERATIONS = 600_000

export const PBKDF2_PARAMS: KdfParams = { kdf: 'pbkdf2-sha256', iterations: PBKDF2_ITERATIONS }

export async function pbkdf2Sha256(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle
  const material = await subtle.importKey('raw', copy(utf8(passphrase)), 'PBKDF2', false, [
    'deriveBits'
  ])
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: copy(salt), iterations },
    material,
    DATA_KEY_BYTES * 8
  )
  return new Uint8Array(bits)
}

/** Derive with whatever `params` the vault recorded; hosts without scrypt reject scrypt vaults. */
export async function deriveWithWebCrypto(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams
): Promise<Uint8Array> {
  if (params.kdf !== 'pbkdf2-sha256')
    throw new Error(
      `This device cannot derive ${params.kdf} keys; the vault was created elsewhere.`
    )
  return pbkdf2Sha256(passphrase, salt, params.iterations)
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  out.set(bytes)
  return out
}
