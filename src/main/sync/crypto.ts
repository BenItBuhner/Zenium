import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * End-to-end encryption for sync files: the passphrase never leaves the device, the sync folder
 * (Dropbox, iCloud Drive, Syncthing, …) only ever sees AES-256-GCM ciphertext – the same
 * guarantee Firefox Sync gives (Mozilla holds no key).
 */

export const SYNC_SALT_BYTES = 16

export interface EncryptedEnvelope {
  v: 1
  /** Base64 salt used to derive the key (shared by every device via the first file written). */
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

export function newSalt(): string {
  return randomBytes(SYNC_SALT_BYTES).toString('base64')
}

/** scrypt(passphrase, salt) → 32-byte key. Deliberately slow to make brute force expensive. */
export function deriveKey(passphrase: string, saltB64: string): Buffer {
  const salt = Buffer.from(saltB64, 'base64')
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  })
}

export function encryptJson(key: Buffer, saltB64: string, value: unknown): EncryptedEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    v: 1,
    salt: saltB64,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

/** Throws when the key is wrong or the file was tampered with. */
export function decryptJson<T = unknown>(key: Buffer, envelope: EncryptedEnvelope): T {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ])
  return JSON.parse(plaintext.toString('utf8')) as T
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
