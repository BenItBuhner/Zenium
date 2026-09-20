import { scrypt as scryptJs } from 'scrypt-js'
import { fromBase64, randomBytes, toBase64 } from '../credentials/crypto'

/**
 * End-to-end encryption for sync files: the passphrase never leaves the device, the sync folder
 * (Dropbox, iCloud Drive, Syncthing, …) only ever sees AES-256-GCM ciphertext – the same
 * guarantee Firefox Sync gives (Mozilla holds no key).
 *
 * Everything here runs on Web Crypto so the one implementation serves Electron's main process
 * (Node's `globalThis.crypto`) and the Android chrome WebView. The envelope is the one the
 * Electron-only engine wrote (`iv`, `tag` and `ciphertext` as separate base64 fields; the tag is
 * the last 16 bytes of Web Crypto's output), and the key is scrypt with the same parameters, so
 * a folder written before the move keeps decrypting (`__tests__/compat.test.ts`).
 */

export const SYNC_SALT_BYTES = 16
export const SYNC_KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** scrypt parameters every device derives with; changing them would orphan existing folders. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, dkLen: SYNC_KEY_BYTES } as const
export type ScryptParams = typeof SCRYPT_PARAMS

/** A host's own scrypt (Node's, quicker than the shared JavaScript one); same output required. */
export type ScryptFn = (
  passphrase: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams
) => Promise<Uint8Array>

export interface EncryptedEnvelope {
  v: 1
  /** Base64 salt used to derive the key (shared by every device via the first file written). */
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('Web Crypto is not available in this runtime')
  return c.subtle
}

/** Copy into a fresh ArrayBuffer-backed view (Web Crypto rejects views over shared buffers). */
function plain(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

export function newSalt(): string {
  return toBase64(randomBytes(SYNC_SALT_BYTES))
}

/** The bytes scrypt hashes: the passphrase NFKC-normalised (composed and decomposed input agree), UTF-8. */
export function passphraseBytes(passphrase: string): Uint8Array {
  return encoder.encode(passphrase.normalize('NFKC'))
}

/**
 * scrypt(passphrase, salt) → 32-byte key. Deliberately slow to make brute force expensive; the
 * shared JavaScript implementation takes a few seconds on a phone, which is why the key is
 * derived once at setup and kept. A host may pass its native scrypt.
 */
export async function deriveKey(
  passphrase: string,
  saltB64: string,
  scrypt?: ScryptFn
): Promise<Uint8Array> {
  const salt = fromBase64(saltB64)
  const password = passphraseBytes(passphrase)
  if (scrypt) return scrypt(password, salt, SCRYPT_PARAMS)
  return deriveWithScryptJs(password, salt, SCRYPT_PARAMS)
}

/** The shared implementation (scrypt-js), the one the Android chrome runs. */
export function deriveWithScryptJs(
  password: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams
): Promise<Uint8Array> {
  return scryptJs(password, salt, params.N, params.r, params.p, params.dkLen)
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== SYNC_KEY_BYTES) throw new Error('AES-256 needs a 32-byte key')
  return subtle().importKey('raw', plain(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptJson(
  key: Uint8Array,
  saltB64: string,
  value: unknown
): Promise<EncryptedEnvelope> {
  const iv = randomBytes(IV_BYTES)
  const sealed = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: plain(iv), tagLength: TAG_BYTES * 8 },
      await importKey(key),
      plain(encoder.encode(JSON.stringify(value)))
    )
  )
  const split = sealed.length - TAG_BYTES
  return {
    v: 1,
    salt: saltB64,
    iv: toBase64(iv),
    tag: toBase64(sealed.subarray(split)),
    ciphertext: toBase64(sealed.subarray(0, split))
  }
}

/** Rejects when the key is wrong or the file was tampered with. */
export async function decryptJson<T = unknown>(
  key: Uint8Array,
  envelope: EncryptedEnvelope
): Promise<T> {
  const iv = fromBase64(envelope.iv)
  const tag = fromBase64(envelope.tag)
  const ciphertext = fromBase64(envelope.ciphertext)
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed envelope')
  const sealed = new Uint8Array(ciphertext.length + tag.length)
  sealed.set(ciphertext)
  sealed.set(tag, ciphertext.length)
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: plain(iv), tagLength: TAG_BYTES * 8 },
    await importKey(key),
    plain(sealed)
  )
  return JSON.parse(decoder.decode(plaintext)) as T
}

export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    typeof v.salt === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.ciphertext === 'string'
  )
}
