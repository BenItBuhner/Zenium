import type { Platform as PlatformOs } from '../../shared/types'
import type { ImportDatabase } from '../platform'
import { webkitToEpochMs } from './time'
import type { ImportedLogin, ImportedLogins } from './types'

/**
 * Chrome's and Edge's `Login Data`: the `logins` table with the password sealed by `OSCrypt`.
 * On Linux and macOS that is AES-128-CBC with a key PBKDF2-SHA1 derives from a secret: the
 * fixed `peanuts` for `v10` rows saved without a keyring (1 iteration), the keyring's "Chrome
 * Safe Storage" entry for Linux `v11` rows (1 iteration) and for every macOS `v10` row (1003
 * iterations). Windows seals with DPAPI (and, since Chrome 127, app-bound `v20`), which no
 * other process can undo: those profiles offer no passwords and point at Chrome's CSV export.
 */

export const CHROMIUM_LOGINS_SQL = `SELECT * FROM logins ORDER BY rowid`

const SALT = 'saltysalt'
const KEY_BITS = 128
/** OSCrypt's IV: sixteen spaces. */
const IV = new Uint8Array(16).fill(0x20)
export const V10_SECRET = 'peanuts'
export const LINUX_ITERATIONS = 1
export const MAC_ITERATIONS = 1003

export interface ChromiumKeys {
  v10: CryptoKey | null
  v11: CryptoKey | null
}

export async function deriveChromiumKey(secret: string, iterations: number): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle
  const material = await subtle.importKey('raw', bytesOf(secret), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-1', salt: bytesOf(SALT), iterations },
    material,
    KEY_BITS
  )
  return subtle.importKey('raw', bits, { name: 'AES-CBC' }, false, ['decrypt'])
}

/**
 * The keys a profile's rows may be sealed with on this OS. `secret` is the keyring entry the host
 * looked up (null: none available), so on Linux `v10` still opens and `v11` rows are counted
 * unreadable; on macOS nothing opens without it.
 */
export async function chromiumKeys(os: PlatformOs, secret: string | null): Promise<ChromiumKeys> {
  if (os === 'linux')
    return {
      v10: await deriveChromiumKey(V10_SECRET, LINUX_ITERATIONS),
      v11: secret ? await deriveChromiumKey(secret, LINUX_ITERATIONS) : null
    }
  if (os === 'darwin')
    return { v10: secret ? await deriveChromiumKey(secret, MAC_ITERATIONS) : null, v11: null }
  return { v10: null, v11: null }
}

/** The password of one row, or null when it cannot be opened here. */
export async function decryptChromiumPassword(
  blob: Uint8Array,
  keys: ChromiumKeys
): Promise<string | null> {
  if (blob.length === 0) return ''
  const prefix = String.fromCharCode(blob[0], blob[1], blob[2])
  const key = prefix === 'v10' ? keys.v10 : prefix === 'v11' ? keys.v11 : null
  if (!key) {
    // Neither prefix: a DPAPI blob (Windows), app-bound `v20`, or a plaintext row from a very
    // old profile that had no encryption at all (Chrome kept those readable).
    if (prefix !== 'v10' && prefix !== 'v11' && prefix !== 'v20' && isPrintableUtf8(blob))
      return new TextDecoder().decode(blob)
    return null
  }
  const ciphertext = blob.subarray(3)
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return null
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: IV },
      key,
      copy(ciphertext)
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/** `PasswordForm::Scheme`: 0 HTML form, 1 HTTP Basic, 2 HTTP Digest, 3 other, 4 username-only. */
const SCHEME_BASIC = 1
const SCHEME_DIGEST = 2

/**
 * Every login of the database as import rows, the sealed passwords opened with `keys`. Rows the
 * user asked never to save for, and rows without an origin, are `invalid`; rows whose password
 * would not open are `unreadable`.
 */
export async function chromiumLogins(
  db: ImportDatabase,
  keys: ChromiumKeys,
  now: number = Date.now()
): Promise<ImportedLogins> {
  const out: ImportedLogins = { logins: [], unreadable: 0, invalid: 0 }
  for (const row of db.all(CHROMIUM_LOGINS_SQL)) {
    if (Number(row.blacklisted_by_user) === 1) {
      out.invalid += 1
      continue
    }
    const origin = typeof row.origin_url === 'string' ? row.origin_url.trim() : ''
    if (!/^https?:\/\//i.test(origin)) {
      out.invalid += 1
      continue
    }
    const sealed = row.password_value
    const blob =
      sealed instanceof Uint8Array
        ? sealed
        : sealed instanceof ArrayBuffer
          ? new Uint8Array(sealed)
          : typeof sealed === 'string'
            ? new TextEncoder().encode(sealed)
            : null
    if (!blob) {
      out.invalid += 1
      continue
    }
    const password = await decryptChromiumPassword(blob, keys)
    if (password === null) {
      out.unreadable += 1
      continue
    }
    if (password === '') {
      out.invalid += 1
      continue
    }
    const login: ImportedLogin = {
      url: origin,
      username: typeof row.username_value === 'string' ? row.username_value : '',
      password,
      notes: ''
    }
    const scheme = Number(row.scheme)
    if (scheme === SCHEME_BASIC || scheme === SCHEME_DIGEST) {
      // The realm is stored after the origin in `signon_realm` (`https://host/realm`).
      const realm = typeof row.signon_realm === 'string' ? row.signon_realm : ''
      const slash = realm.indexOf('/', realm.indexOf('//') + 2)
      const name = slash === -1 ? '' : realm.slice(slash + 1)
      if (name) login.realm = name
    }
    const created = webkitToEpochMs(row.date_created, now)
    if (created) login.createdAt = created
    const used = webkitToEpochMs(row.date_last_used, now)
    if (used) login.lastUsedAt = used
    out.logins.push(login)
  }
  return out
}

function isPrintableUtf8(bytes: Uint8Array): boolean {
  if (bytes.length > 1024) return false
  for (const b of bytes) if (b < 0x09 || (b > 0x0d && b < 0x20)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return copy(new TextEncoder().encode(text))
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  out.set(bytes)
  return out
}
