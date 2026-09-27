import type { ImportDatabase } from '../platform'
import {
  Asn1Error,
  childAt,
  decodeDer,
  intOf,
  octetsOf,
  oidOf,
  sequenceOf,
  type Asn1Node
} from './asn1'
import type { ImportedLogin, ImportedLogins } from './types'

/**
 * Firefox's own saved logins, read the way Firefox reads them (ID-42): `logins.json` holds each
 * login with its username and password sealed as base64 DER (3DES-CBC under the profile's master
 * key), and `key4.db` (SQLite) holds that master key wrapped with the primary password. This is
 * the same first-party import Chrome and Edge offer for Firefox – the user's own profile, on the
 * same computer, opened with their own primary password (empty by default) – reimplemented from
 * Mozilla's documented NSS key-store layout, not from any GPL source.
 *
 * The wrapping has two shapes, chosen per profile and detected from the algorithm OID:
 *  - modern PBES2 (`1.2.840.113549.1.5.13`): PBKDF2-HMAC-SHA256 over `SHA1(globalSalt‖password)`
 *    with the stored salt / iteration count / 32-byte key length, then AES-256-CBC. NSS stores
 *    the 14-byte IV as an OCTET STRING and uses its DER encoding (`04 0e …`) as the 16-byte IV.
 *  - legacy `pbeWithSHA1And3-KeyTripleDES-CBC` (`1.2.840.113549.1.12.5.1.3`): NSS's SHA-1 / HMAC
 *    key-and-IV derivation from `globalSalt`, the entry salt and the password, then 3DES-CBC.
 *
 * The primary password is verified against the `password-check` value NSS keeps in `metaData`
 * before any login is touched; a wrong one fails with a message rather than yielding gibberish.
 */

const OID_PBES2 = '1.2.840.113549.1.5.13'
const OID_PBKDF2 = '1.2.840.113549.1.5.12'
const OID_HMAC_SHA256 = '1.2.840.113549.2.9'
const OID_AES256_CBC = '2.16.840.1.101.3.4.1.42'
const OID_DES_EDE3_CBC = '1.2.840.113549.3.7'
const OID_PBE_SHA1_3DES = '1.2.840.113549.1.12.5.1.3'

/** NSS's fixed object id (`CKA_ID`) for a profile's master key row in `nssPrivate`. */
const MASTER_KEY_ID = Uint8Array.from([0xf8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01])
/** The plaintext NSS seals under the primary password so it (and we) can verify it. */
const PASSWORD_CHECK = 'password-check'
/** 3DES block size, and the length of the 3DES key NSS wraps. */
const DES_BLOCK = 8
const DES3_KEY_BYTES = 24
const AES_BLOCK = 16
/**
 * The most PBKDF2 rounds a store may ask for. NSS writes 10 000 (1 for the empty password); the
 * derivation runs on the caller's thread, so a corrupt or absurd count is refused, not run.
 */
const MAX_PBKDF2_ITERATIONS = 1_000_000
/** The one iteration count NSS's legacy 3DES wrapping was ever written with. */
const LEGACY_ITERATIONS = 1

/** A `key4.db` whose sealed values are not what NSS writes: unwrapped bytes that are no key. */
const KEY_STORE_MALFORMED = 'Firefox’s key store is malformed.'

const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1)

export type FirefoxLoginsErrorKind = 'wrong-password' | 'no-key' | 'unsupported' | 'corrupt'

/** A failure of the key store the import flow turns into a message for the user. */
export class FirefoxLoginsError extends Error {
  constructor(
    readonly kind: FirefoxLoginsErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'FirefoxLoginsError'
  }
}

/** `node:crypto` fetched at run time: this source only ever runs on the desktop host, and the
 * bundler leaves `getBuiltinModule` alone so the renderer / Android bundles never pull it in. */
type NodeCrypto = typeof import('node:crypto')
function nodeCrypto(): NodeCrypto {
  const loaded = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.(
    'node:crypto'
  )
  if (!loaded)
    throw new FirefoxLoginsError(
      'unsupported',
      'This build of Zenium cannot read Firefox’s passwords.'
    )
  return loaded as NodeCrypto
}

/** The 24-byte 3DES key that unlocks a profile's logins, recovered from `key4.db`. */
export interface FirefoxMasterKey {
  key: Uint8Array
}

/** What the import reports when the primary password does not open the store. */
export const WRONG_PRIMARY_PASSWORD = 'The primary password is wrong.'
/** The same, when none was given: the profile has one set and the user has to enter it. */
export const PRIMARY_PASSWORD_NEEDED =
  'Firefox protects this profile’s passwords with a primary password. Enter it and try again.'

/**
 * Verify `primaryPassword` against the profile's `password-check` and return the master key.
 * Throws `FirefoxLoginsError('wrong-password')` when the password does not open the store.
 */
export function deriveFirefoxKey(db: ImportDatabase, primaryPassword: string): FirefoxMasterKey {
  const c = nodeCrypto()
  const meta = readPasswordMeta(db)
  // NSS compares the unwrapped verifier with `password-check` whole. A pad that does not strip,
  // or any other plaintext, is the password not opening the store.
  const check = pbeDecrypt(c, meta.item2, meta.globalSalt, primaryPassword)
  if (!check || !bytesEqual(check, utf8(PASSWORD_CHECK)))
    throw new FirefoxLoginsError(
      'wrong-password',
      primaryPassword === '' ? PRIMARY_PASSWORD_NEEDED : WRONG_PRIMARY_PASSWORD
    )
  const wrapped = readMasterKeyBlob(db)
  // The password is known right by now: what will not unwrap to a 3DES key is the store's fault.
  const cleartext = pbeDecrypt(c, wrapped, meta.globalSalt, primaryPassword)
  if (!cleartext || cleartext.length < DES3_KEY_BYTES)
    throw new FirefoxLoginsError('corrupt', KEY_STORE_MALFORMED)
  return { key: cleartext.slice(0, DES3_KEY_BYTES) }
}

/**
 * Every login in `logins.json` as import rows, the sealed usernames and passwords opened with the
 * master key. Rows without an http(s) origin or password are `invalid`; rows whose blob will not
 * decrypt (an unknown key id, a bad pad) are `unreadable`, the way the Chromium source counts them.
 */
export function firefoxLogins(
  loginsJson: string,
  master: FirefoxMasterKey,
  now: number = Date.now()
): ImportedLogins {
  const c = nodeCrypto()
  const out: ImportedLogins = { logins: [], unreadable: 0, invalid: 0 }
  let data: unknown
  try {
    data = JSON.parse(loginsJson)
  } catch {
    throw new FirefoxLoginsError('corrupt', 'logins.json is not valid JSON.')
  }
  const list = data && typeof data === 'object' ? (data as { logins?: unknown }).logins : null
  if (!Array.isArray(list)) return out
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      out.invalid += 1
      continue
    }
    const row = raw as Record<string, unknown>
    const hostname = str(row.hostname)
    if (!/^https?:\/\//i.test(hostname)) {
      out.invalid += 1
      continue
    }
    const password = decryptItem(c, master.key, str(row.encryptedPassword))
    if (password === null || password === '') {
      out[password === null ? 'unreadable' : 'invalid'] += 1
      continue
    }
    const username = decryptItem(c, master.key, str(row.encryptedUsername))
    if (username === null) {
      out.unreadable += 1
      continue
    }
    const login: ImportedLogin = { url: hostname, username, password, notes: '' }
    const httpRealm = str(row.httpRealm)
    const formSubmitURL = str(row.formSubmitURL)
    // Firefox marks an HTTP-authentication login with a realm and no form action; a form login
    // carries the action's origin instead. The realm maps to the store's HTTP-auth credential.
    if (httpRealm && !formSubmitURL) login.realm = httpRealm
    const created = epochMs(row.timeCreated, now) ?? epochMs(row.timePasswordChanged, now)
    if (created !== undefined) login.createdAt = created
    const used = epochMs(row.timeLastUsed, now)
    if (used !== undefined) login.lastUsedAt = used
    out.logins.push(login)
  }
  return out
}

// ---------------------------------------------------------------------------
// key4.db
// ---------------------------------------------------------------------------

function readPasswordMeta(db: ImportDatabase): { globalSalt: Uint8Array; item2: Uint8Array } {
  let rows: Record<string, unknown>[]
  try {
    rows = db.all('SELECT id, item1, item2 FROM metaData')
  } catch (error) {
    throw new FirefoxLoginsError('corrupt', `key4.db has no metaData table: ${messageOf(error)}`)
  }
  for (const row of rows) {
    if (asText(row.id) !== 'password') continue
    const globalSalt = asBytes(row.item1)
    const item2 = asBytes(row.item2)
    if (globalSalt && item2) return { globalSalt, item2 }
  }
  throw new FirefoxLoginsError('corrupt', 'key4.db has no password metadata.')
}

function readMasterKeyBlob(db: ImportDatabase): Uint8Array {
  let rows: Record<string, unknown>[]
  try {
    rows = db.all('SELECT a11, a102 FROM nssPrivate')
  } catch (error) {
    throw new FirefoxLoginsError('no-key', `key4.db has no nssPrivate table: ${messageOf(error)}`)
  }
  for (const row of rows) {
    const id = asBytes(row.a102)
    if (id && bytesEqual(id, MASTER_KEY_ID)) {
      const blob = asBytes(row.a11)
      if (blob) return blob
    }
  }
  throw new FirefoxLoginsError('no-key', 'Firefox has no key store in this profile.')
}

// ---------------------------------------------------------------------------
// The PBE that wraps the master key and the password-check
// ---------------------------------------------------------------------------

/**
 * Unwrap one sealed `key4.db` value (`SEQUENCE { AlgorithmIdentifier, OCTET STRING }`) with the
 * primary password and strip its PKCS#7 pad. Returns null when the pad does not strip – with the
 * verifier that is a wrong password, with the key it is corruption; the caller knows which. A
 * shape NSS does not write is `unsupported`; a ciphertext that is not whole blocks is `corrupt`
 * whatever the password.
 */
function pbeDecrypt(
  c: NodeCrypto,
  blob: Uint8Array,
  globalSalt: Uint8Array,
  password: string
): Uint8Array | null {
  const outer = decode(blob)
  sequenceOf(outer)
  const algId = childAt(outer, 0)
  sequenceOf(algId)
  const cipherText = octetsOf(childAt(outer, 1))
  const oid = oidOf(childAt(algId, 0))
  const pwd = utf8(password)
  if (oid === OID_PBES2) return pbes2Decrypt(c, algId, cipherText, globalSalt, pwd)
  if (oid === OID_PBE_SHA1_3DES) return legacy3desDecrypt(c, algId, cipherText, globalSalt, pwd)
  throw new FirefoxLoginsError('unsupported', `Unsupported key4.db algorithm ${oid}.`)
}

function pbes2Decrypt(
  c: NodeCrypto,
  algId: Asn1Node,
  cipherText: Uint8Array,
  globalSalt: Uint8Array,
  password: Uint8Array
): Uint8Array | null {
  const params = childAt(algId, 1)
  sequenceOf(params)
  const kdf = childAt(params, 0)
  sequenceOf(kdf)
  if (oidOf(childAt(kdf, 0)) !== OID_PBKDF2)
    throw new FirefoxLoginsError('unsupported', 'key4.db uses an unknown key-derivation function.')
  const kdfParams = childAt(kdf, 1)
  sequenceOf(kdfParams)
  const entrySalt = octetsOf(childAt(kdfParams, 0))
  const iterations = intOf(childAt(kdfParams, 1))
  const keyLength = intOf(childAt(kdfParams, 2))
  if (iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS || keyLength !== 32)
    throw new FirefoxLoginsError('unsupported', 'key4.db has unexpected PBKDF2 parameters.')
  // PKCS#5 lets the PRF be left out (HMAC-SHA1 then); NSS always names HMAC-SHA256, the one
  // derivation this reader has. Anything else would derive a wrong key and read as a wrong
  // password, so it is refused as what it is.
  const prf = kdfParams.children.length > 3 ? childAt(kdfParams, 3) : null
  if (!prf || oidOf(childAt(prf, 0)) !== OID_HMAC_SHA256)
    throw new FirefoxLoginsError('unsupported', 'key4.db uses an unknown key-derivation function.')
  const enc = childAt(params, 1)
  sequenceOf(enc)
  if (oidOf(childAt(enc, 0)) !== OID_AES256_CBC)
    throw new FirefoxLoginsError('unsupported', 'key4.db uses an unknown cipher.')
  const iv = aesIv(octetsOf(childAt(enc, 1)))
  const prehash = new Uint8Array(c.createHash('sha1').update(globalSalt).update(password).digest())
  const key = new Uint8Array(c.pbkdf2Sync(prehash, entrySalt, iterations, keyLength, 'sha256'))
  return pkcs7Strip(keyStoreDecrypt(c, 'aes-256-cbc', key, iv, cipherText, AES_BLOCK), AES_BLOCK)
}

function legacy3desDecrypt(
  c: NodeCrypto,
  algId: Asn1Node,
  cipherText: Uint8Array,
  globalSalt: Uint8Array,
  password: Uint8Array
): Uint8Array | null {
  const params = childAt(algId, 1)
  sequenceOf(params)
  const entrySalt = octetsOf(childAt(params, 0))
  // The derivation below is the count-1 one NSS wrote; another count is a derivation this reader
  // does not have, not a wrong password.
  if (intOf(childAt(params, 1)) !== LEGACY_ITERATIONS)
    throw new FirefoxLoginsError('unsupported', 'key4.db uses an unknown key-derivation function.')
  const { key, iv } = legacyKeyIv(c, globalSalt, password, entrySalt)
  return pkcs7Strip(keyStoreDecrypt(c, 'des-ede3-cbc', key, iv, cipherText, DES_BLOCK), DES_BLOCK)
}

/**
 * CBC-decrypt a `key4.db` value. A ciphertext that is not whole blocks (or that the cipher
 * refuses for any other reason) is the store's corruption, reported as such rather than as the
 * cipher's own words.
 */
function keyStoreDecrypt(
  c: NodeCrypto,
  algorithm: 'aes-256-cbc' | 'des-ede3-cbc',
  key: Uint8Array,
  iv: Uint8Array,
  cipherText: Uint8Array,
  block: number
): Uint8Array {
  if (cipherText.length === 0 || cipherText.length % block !== 0)
    throw new FirefoxLoginsError('corrupt', KEY_STORE_MALFORMED)
  try {
    return cbcDecrypt(c, algorithm, key, iv, cipherText)
  } catch {
    throw new FirefoxLoginsError('corrupt', KEY_STORE_MALFORMED)
  }
}

/**
 * NSS's `pbeWithSHA1And3-KeyTripleDES-CBC` key/IV derivation: a SHA-1 pre-hash of the salt and
 * password, then three HMAC-SHA1 rounds over the (zero-padded) entry salt to produce 40 bytes –
 * the first 24 are the 3DES key, the last 8 the IV.
 */
function legacyKeyIv(
  c: NodeCrypto,
  globalSalt: Uint8Array,
  password: Uint8Array,
  entrySalt: Uint8Array
): { key: Uint8Array; iv: Uint8Array } {
  const hp = new Uint8Array(c.createHash('sha1').update(globalSalt).update(password).digest())
  const pes = new Uint8Array(20)
  pes.set(entrySalt.length >= 20 ? entrySalt.subarray(0, 20) : entrySalt)
  const chp = new Uint8Array(c.createHash('sha1').update(hp).update(entrySalt).digest())
  const k1 = hmacSha1(c, chp, concat(pes, entrySalt))
  const tk = hmacSha1(c, chp, pes)
  const k2 = hmacSha1(c, chp, concat(tk, entrySalt))
  const k = concat(k1, k2)
  return { key: k.subarray(0, DES3_KEY_BYTES), iv: k.subarray(k.length - DES_BLOCK) }
}

/** The 16-byte AES IV NSS stores as a 14-byte OCTET STRING plus its own `04 0e` DER header. */
function aesIv(inner: Uint8Array): Uint8Array {
  if (inner.length === 16) return inner
  if (inner.length === 14) return concat(Uint8Array.of(0x04, 0x0e), inner)
  throw new FirefoxLoginsError('unsupported', 'key4.db has an unexpected AES IV.')
}

// ---------------------------------------------------------------------------
// A single logins.json blob
// ---------------------------------------------------------------------------

/** Decrypt one base64 login field, or null when it cannot be opened with this key. */
function decryptItem(c: NodeCrypto, masterKey: Uint8Array, b64: string): string | null {
  if (b64 === '') return ''
  let node: Asn1Node
  try {
    node = decode(fromBase64(b64))
  } catch {
    return null
  }
  let iv: Uint8Array
  let cipherText: Uint8Array
  try {
    sequenceOf(node)
    // The blob names the key it was sealed with; Firefox looks it up by that id, and a field
    // sealed under some other key is not one this store can open.
    if (!bytesEqual(octetsOf(childAt(node, 0)), MASTER_KEY_ID)) return null
    const alg = childAt(node, 1)
    sequenceOf(alg)
    if (oidOf(childAt(alg, 0)) !== OID_DES_EDE3_CBC) return null
    iv = octetsOf(childAt(alg, 1))
    cipherText = octetsOf(childAt(node, 2))
  } catch (error) {
    if (error instanceof Asn1Error) return null
    throw error
  }
  let plain: Uint8Array
  try {
    plain = cbcDecrypt(c, 'des-ede3-cbc', masterKey, iv, cipherText)
  } catch {
    return null
  }
  const stripped = pkcs7Strip(plain, DES_BLOCK)
  if (!stripped) return null
  return new TextDecoder().decode(stripped)
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Decrypt with padding off (NSS pads with PKCS#7, but callers strip or slice it themselves). */
function cbcDecrypt(
  c: NodeCrypto,
  algorithm: 'aes-256-cbc' | 'des-ede3-cbc',
  key: Uint8Array,
  iv: Uint8Array,
  cipherText: Uint8Array
): Uint8Array {
  const decipher = c.createDecipheriv(algorithm, key, iv)
  decipher.setAutoPadding(false)
  return new Uint8Array(Buffer.concat([decipher.update(cipherText), decipher.final()]))
}

function hmacSha1(c: NodeCrypto, key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(c.createHmac('sha1', key).update(data).digest())
}

function decode(blob: Uint8Array): Asn1Node {
  try {
    return decodeDer(blob)
  } catch (error) {
    if (error instanceof Asn1Error)
      throw new FirefoxLoginsError('corrupt', `key4.db: ${error.message}`)
    throw error
  }
}

function pkcs7Strip(data: Uint8Array, block: number): Uint8Array | null {
  if (data.length === 0 || data.length % block !== 0) return null
  const pad = data[data.length - 1]
  if (pad < 1 || pad > block || pad > data.length) return null
  for (let i = data.length - pad; i < data.length; i++) if (data[i] !== pad) return null
  return data.subarray(0, data.length - pad)
}

function epochMs(value: unknown, now: number): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint'
        ? Number(value)
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n < MIN_PLAUSIBLE_MS || n > now + 86_400_000) return undefined
  return Math.round(n)
}

function fromBase64(b64: string): Uint8Array {
  const buffer = Buffer.from(b64, 'base64')
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
