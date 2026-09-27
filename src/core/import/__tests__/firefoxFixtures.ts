// Firefox key-store fixtures built from the documented NSS format with the same primitives the
// source reads them back with (node:crypto + node:sqlite), so the tests round-trip real DER and
// real PBES2 / legacy-3DES wrapping rather than a canned blob.
// eslint-disable-next-line no-restricted-imports
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { SqlBuilder } from './helpers'

const OID_PBES2 = '1.2.840.113549.1.5.13'
const OID_PBKDF2 = '1.2.840.113549.1.5.12'
const OID_HMAC_SHA256 = '1.2.840.113549.2.9'
const OID_AES256_CBC = '2.16.840.1.101.3.4.1.42'
const OID_DES_EDE3_CBC = '1.2.840.113549.3.7'
const OID_PBE_SHA1_3DES = '1.2.840.113549.1.12.5.1.3'

const MASTER_KEY_ID = Uint8Array.from([0xf8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01])
const PASSWORD_CHECK = 'password-check'
const DEFAULT_GLOBAL_SALT = Uint8Array.from(Array.from({ length: 20 }, (_v, i) => (i * 7 + 3) & 0xff))

// ---------------------------------------------------------------------------
// A tiny DER encoder (the inverse of asn1.ts, for building fixtures)
// ---------------------------------------------------------------------------

function encodeLength(length: number): number[] {
  if (length < 0x80) return [length]
  const out: number[] = []
  let value = length
  while (value > 0) {
    out.unshift(value & 0xff)
    value = Math.floor(value / 256)
  }
  return [0x80 | out.length, ...out]
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function derBytes(tag: number, content: Uint8Array): Uint8Array {
  const length = encodeLength(content.length)
  const out = new Uint8Array(1 + length.length + content.length)
  out[0] = tag
  out.set(length, 1)
  out.set(content, 1 + length.length)
  return out
}

export function derSeq(...parts: Uint8Array[]): Uint8Array {
  return derBytes(0x30, concatAll(parts))
}

export function derOctet(bytes: Uint8Array): Uint8Array {
  return derBytes(0x04, bytes)
}

export function derNull(): Uint8Array {
  return derBytes(0x05, new Uint8Array(0))
}

export function derInt(value: number): Uint8Array {
  const bytes: number[] = []
  let v = value
  do {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  } while (v > 0)
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  return derBytes(0x02, Uint8Array.from(bytes))
}

export function derOid(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map((a) => Number.parseInt(a, 10))
  const body: number[] = [arcs[0] * 40 + arcs[1]]
  for (let i = 2; i < arcs.length; i++) {
    let value = arcs[i]
    const stack = [value & 0x7f]
    value = Math.floor(value / 128)
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80)
      value = Math.floor(value / 128)
    }
    body.push(...stack)
  }
  return derBytes(0x06, Uint8Array.from(body))
}

// ---------------------------------------------------------------------------
// The two PBE wrappings NSS uses for the master key and the password-check
// ---------------------------------------------------------------------------

function buf(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function wrapPbes2(plain: Uint8Array, globalSalt: Uint8Array, password: Buffer): Uint8Array {
  const entrySalt = randomBytes(16)
  const iterations = 10000
  const keyLength = 32
  const ivInner = randomBytes(14)
  const iv = Buffer.concat([Buffer.from([0x04, 0x0e]), ivInner])
  const prehash = createHash('sha1').update(buf(globalSalt)).update(password).digest()
  const key = pbkdf2Sync(prehash, entrySalt, iterations, keyLength, 'sha256')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(buf(plain)), cipher.final()])
  const algId = derSeq(
    derOid(OID_PBES2),
    derSeq(
      derSeq(
        derOid(OID_PBKDF2),
        derSeq(
          derOctet(entrySalt),
          derInt(iterations),
          derInt(keyLength),
          derSeq(derOid(OID_HMAC_SHA256), derNull())
        )
      ),
      derSeq(derOid(OID_AES256_CBC), derOctet(ivInner))
    )
  )
  return derSeq(algId, derOctet(ct))
}

function legacyKeyIv(
  globalSalt: Uint8Array,
  password: Buffer,
  entrySalt: Buffer
): { key: Buffer; iv: Buffer } {
  const hp = createHash('sha1').update(buf(globalSalt)).update(password).digest()
  const pes = Buffer.alloc(20)
  entrySalt.copy(pes, 0, 0, Math.min(20, entrySalt.length))
  const chp = createHash('sha1').update(hp).update(entrySalt).digest()
  const k1 = createHmac('sha1', chp).update(Buffer.concat([pes, entrySalt])).digest()
  const tk = createHmac('sha1', chp).update(pes).digest()
  const k2 = createHmac('sha1', chp).update(Buffer.concat([tk, entrySalt])).digest()
  const k = Buffer.concat([k1, k2])
  return { key: k.subarray(0, 24), iv: k.subarray(k.length - 8) }
}

function wrapLegacy3des(plain: Uint8Array, globalSalt: Uint8Array, password: Buffer): Uint8Array {
  const entrySalt = randomBytes(20)
  const { key, iv } = legacyKeyIv(globalSalt, password, entrySalt)
  const cipher = createCipheriv('des-ede3-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(buf(plain)), cipher.final()])
  const algId = derSeq(derOid(OID_PBE_SHA1_3DES), derSeq(derOctet(entrySalt), derInt(1)))
  return derSeq(algId, derOctet(ct))
}

function sealLogin(masterKey: Uint8Array, text: string): string {
  const iv = randomBytes(8)
  const cipher = createCipheriv('des-ede3-cbc', buf(masterKey), iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()])
  const blob = derSeq(
    derOctet(MASTER_KEY_ID),
    derSeq(derOid(OID_DES_EDE3_CBC), derOctet(iv)),
    derOctet(ct)
  )
  return buf(blob).toString('base64')
}

// ---------------------------------------------------------------------------
// A whole vault: key4.db builder + a sealer that uses its master key
// ---------------------------------------------------------------------------

export interface FirefoxVaultOptions {
  password?: string
  algo?: 'pbes2' | '3des'
  globalSalt?: Uint8Array
  masterKey?: Uint8Array
}

export interface FirefoxVault {
  /** Builds `metaData` and `nssPrivate` the way the source reads them. */
  key4: SqlBuilder
  masterKey: Uint8Array
  globalSalt: Uint8Array
  /** Seal one field (username / password) into a logins.json base64 blob. */
  seal(text: string): string
}

export function firefoxVault(options: FirefoxVaultOptions = {}): FirefoxVault {
  const password = Buffer.from(options.password ?? '', 'utf8')
  const globalSalt = options.globalSalt ?? DEFAULT_GLOBAL_SALT
  const masterKey = options.masterKey ?? new Uint8Array(randomBytes(24))
  const wrap = (options.algo ?? 'pbes2') === '3des' ? wrapLegacy3des : wrapPbes2
  const item2 = wrap(new TextEncoder().encode(PASSWORD_CHECK), globalSalt, password)
  const a11 = wrap(masterKey, globalSalt, password)
  const key4: SqlBuilder = (db) => {
    db.exec(
      `CREATE TABLE metaData (id TEXT PRIMARY KEY, item1 BLOB, item2 BLOB);
       CREATE TABLE nssPrivate (id INTEGER PRIMARY KEY, a11 BLOB, a102 BLOB);`
    )
    db.prepare('INSERT INTO metaData (id, item1, item2) VALUES (?, ?, ?)').run(
      'password',
      buf(globalSalt),
      buf(item2)
    )
    // A decoy key row (a different CKA_ID) proves the source selects the master key by its id.
    db.prepare('INSERT INTO nssPrivate (id, a11, a102) VALUES (?, ?, ?)').run(
      1,
      randomBytes(40),
      Buffer.from([0x01, 0x02, 0x03])
    )
    db.prepare('INSERT INTO nssPrivate (id, a11, a102) VALUES (?, ?, ?)').run(
      2,
      buf(a11),
      buf(MASTER_KEY_ID)
    )
  }
  return { key4, masterKey, globalSalt, seal: (text) => sealLogin(masterKey, text) }
}

export interface FirefoxLoginEntry {
  hostname: string
  encryptedUsername: string
  encryptedPassword: string
  httpRealm?: string | null
  formSubmitURL?: string | null
  timeCreated?: number
  timeLastUsed?: number
  timePasswordChanged?: number
}

export function firefoxLoginsJson(logins: FirefoxLoginEntry[]): string {
  return JSON.stringify({
    nextId: logins.length + 1,
    logins: logins.map((login, index) => ({
      id: index + 1,
      guid: `{guid-${index}}`,
      httpRealm: null,
      formSubmitURL: null,
      usernameField: '',
      passwordField: '',
      encType: 1,
      timesUsed: 1,
      ...login
    })),
    potentiallyVulnerablePasswords: [],
    dismissedBreachAlertsByLoginGUID: {},
    version: 3
  })
}
