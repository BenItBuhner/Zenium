import type { AddressEntry, Credential, PasskeyEntry, PaymentCard } from '../../shared/types'
import type { KdfParams, KeyWrapHost } from '../platform'
import {
  DATA_KEY_BYTES,
  fromBase64,
  open,
  openJson,
  randomBytes,
  seal,
  sealJson,
  toBase64,
  type SealedBox
} from './crypto'

/**
 * The vault file. Every entry (a login, an address, a payment card, a passkey record) is a
 * separate AES-256-GCM box under one random data key, with a fresh nonce per write and the entry
 * id as additional authenticated data, so a box cannot be moved to another id or another vault.
 * An encrypted manifest lists the ids (and the never-save domains), so a removed, duplicated or
 * foreign entry is noticed as tampering rather than silently accepted. The data key itself is
 * stored wrapped: by the OS keystore, by a key derived from the passphrase, or both.
 *
 * Entries carry a `kind` inside the box; a box without one is a login (vaults written before
 * addresses and cards existed).
 */

export const VAULT_FORMAT = 'zenium-passwords'
export const VAULT_VERSION = 1
/** Document name under the profile's store directory (the Android host only ships `*.json`). */
export const VAULT_DOCUMENT = 'passwords.json'
export const PASSPHRASE_SALT_BYTES = 16

export interface PassphraseWrap {
  salt: string
  params: KdfParams
  box: SealedBox
}

export interface KeyWrapRecord {
  /** Data key wrapped by the OS keystore (host-specific blob), when available. */
  os: string | null
  /** Data key wrapped by a key derived from the passphrase. */
  passphrase: PassphraseWrap | null
}

export interface VaultEntry extends SealedBox {
  id: string
}

export interface VaultFile {
  format: typeof VAULT_FORMAT
  version: typeof VAULT_VERSION
  vaultId: string
  createdAt: number
  updatedAt: number
  keyWrap: KeyWrapRecord
  manifest: SealedBox
  entries: VaultEntry[]
}

interface LoginPayload {
  kind?: 'login'
  origin: string
  url: string
  username: string
  password: string
  realm: string | null
  notes: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  /** The breach state of the password value (ID-31); absent in vaults written before it existed. */
  breached?: number | null
  checkedAt?: number | null
  leakWarnedAt?: number | null
  leakIgnoredAt?: number | null
}

type AddressPayload = { kind: 'address' } & Omit<AddressEntry, 'id'>
type CardPayload = { kind: 'card' } & Omit<PaymentCard, 'id'>
type PasskeyPayload = { kind: 'passkey' } & Omit<PasskeyEntry, 'id'>

type EntryPayload = LoginPayload | AddressPayload | CardPayload | PasskeyPayload

/** One decrypted entry of any kind. */
export type VaultRecord =
  | { kind: 'login'; value: Credential }
  | { kind: 'address'; value: AddressEntry }
  | { kind: 'card'; value: PaymentCard }
  | { kind: 'passkey'; value: PasskeyEntry }

interface ManifestPayload {
  ids: string[]
  neverSave: string[]
  updatedAt: number
}

export type VaultErrorCode = 'corrupt' | 'tampered' | 'wrong-key' | 'locked'

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

export function newVaultId(): string {
  return toBase64(randomBytes(12)).replace(/[+/=]/g, '')
}

const entryAad = (vaultId: string, id: string): string => `${vaultId}:entry:${id}`
const manifestAad = (vaultId: string): string => `${vaultId}:manifest`
const keyAad = (vaultId: string): string => `${vaultId}:key`

function isSealedBox(value: unknown): value is SealedBox {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.nonce === 'string' && typeof v.data === 'string'
}

function isKdfParams(value: unknown): value is KdfParams {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.kdf === 'scrypt')
    return typeof v.n === 'number' && typeof v.r === 'number' && typeof v.p === 'number'
  if (v.kdf === 'pbkdf2-sha256') return typeof v.iterations === 'number'
  return false
}

/** Structural check of a parsed document; throws `VaultError('corrupt')` when it is not a vault. */
export function parseVaultFile(text: string): VaultFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new VaultError('corrupt', 'The password vault is not valid JSON.')
  }
  if (!raw || typeof raw !== 'object')
    throw new VaultError('corrupt', 'The vault is not an object.')
  const v = raw as Record<string, unknown>
  if (v.format !== VAULT_FORMAT) throw new VaultError('corrupt', 'Not a Zenium password vault.')
  if (v.version !== VAULT_VERSION)
    throw new VaultError('corrupt', `Unsupported vault version ${String(v.version)}.`)
  if (typeof v.vaultId !== 'string' || !v.vaultId)
    throw new VaultError('corrupt', 'The vault has no id.')
  const keyWrap = v.keyWrap as Record<string, unknown> | undefined
  if (!keyWrap || typeof keyWrap !== 'object')
    throw new VaultError('corrupt', 'The vault has no key wrapping.')
  const os = keyWrap.os
  const passphrase = keyWrap.passphrase as Record<string, unknown> | null | undefined
  if (os !== null && typeof os !== 'string')
    throw new VaultError('corrupt', 'The OS key wrapping is malformed.')
  if (passphrase !== null && passphrase !== undefined) {
    if (
      typeof passphrase !== 'object' ||
      typeof passphrase.salt !== 'string' ||
      !isKdfParams(passphrase.params) ||
      !isSealedBox(passphrase.box)
    )
      throw new VaultError('corrupt', 'The passphrase key wrapping is malformed.')
  }
  if (!os && !passphrase) throw new VaultError('corrupt', 'The vault key is not wrapped at all.')
  if (!isSealedBox(v.manifest)) throw new VaultError('corrupt', 'The vault manifest is missing.')
  if (!Array.isArray(v.entries)) throw new VaultError('corrupt', 'The vault entries are missing.')
  for (const entry of v.entries) {
    if (!isSealedBox(entry) || typeof (entry as VaultEntry).id !== 'string')
      throw new VaultError('corrupt', 'A vault entry is malformed.')
  }
  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    vaultId: v.vaultId,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
    keyWrap: {
      os: typeof os === 'string' ? os : null,
      passphrase: (passphrase as PassphraseWrap | null | undefined) ?? null
    },
    manifest: v.manifest,
    entries: v.entries as VaultEntry[]
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const nullableNum = (v: unknown): number | null => (typeof v === 'number' ? v : null)

function payloadOf(record: VaultRecord): EntryPayload {
  switch (record.kind) {
    case 'login': {
      const c = record.value
      return {
        kind: 'login',
        origin: c.origin,
        url: c.url,
        username: c.username,
        password: c.password,
        realm: c.realm,
        notes: c.notes,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        lastUsedAt: c.lastUsedAt,
        breached: c.breached,
        checkedAt: c.checkedAt,
        leakWarnedAt: c.leakWarnedAt,
        leakIgnoredAt: c.leakIgnoredAt
      }
    }
    case 'address':
      return { kind: 'address', ...withoutId(record.value) }
    case 'card':
      return { kind: 'card', ...withoutId(record.value) }
    case 'passkey':
      return { kind: 'passkey', ...withoutId(record.value) }
  }
}

/** The id lives in the entry envelope, not in the encrypted payload. */
function withoutId<T extends { id: string }>(value: T): Omit<T, 'id'> {
  const copy: Partial<T> = { ...value }
  delete copy.id
  return copy as Omit<T, 'id'>
}

function recordOf(id: string, payload: EntryPayload): VaultRecord {
  const p = payload as Record<string, unknown>
  switch (p.kind) {
    case 'address':
      return {
        kind: 'address',
        value: {
          id,
          country: str(p.country),
          name: str(p.name),
          organization: str(p.organization),
          streetAddress: str(p.streetAddress),
          locality: str(p.locality),
          region: str(p.region),
          postalCode: str(p.postalCode),
          sortingCode: str(p.sortingCode),
          phone: str(p.phone),
          email: str(p.email),
          createdAt: num(p.createdAt),
          updatedAt: num(p.updatedAt),
          lastUsedAt: nullableNum(p.lastUsedAt)
        }
      }
    case 'card':
      return {
        kind: 'card',
        value: {
          id,
          number: str(p.number),
          expMonth: num(p.expMonth),
          expYear: num(p.expYear),
          name: str(p.name),
          nickname: str(p.nickname),
          createdAt: num(p.createdAt),
          updatedAt: num(p.updatedAt),
          lastUsedAt: nullableNum(p.lastUsedAt)
        }
      }
    case 'passkey':
      return {
        kind: 'passkey',
        value: {
          id,
          rpId: str(p.rpId),
          rpName: str(p.rpName),
          userName: str(p.userName),
          userDisplayName: str(p.userDisplayName),
          credentialId: str(p.credentialId),
          origin: str(p.origin),
          createdAt: num(p.createdAt),
          lastUsedAt: nullableNum(p.lastUsedAt)
        }
      }
    default:
      return {
        kind: 'login',
        value: {
          id,
          origin: str(p.origin),
          url: str(p.url),
          username: str(p.username),
          password: str(p.password),
          realm: typeof p.realm === 'string' ? p.realm : null,
          notes: str(p.notes),
          createdAt: num(p.createdAt),
          updatedAt: num(p.updatedAt),
          lastUsedAt: nullableNum(p.lastUsedAt),
          breached: nullableNum(p.breached),
          checkedAt: nullableNum(p.checkedAt),
          leakWarnedAt: nullableNum(p.leakWarnedAt),
          leakIgnoredAt: nullableNum(p.leakIgnoredAt)
        }
      }
  }
}

export async function encryptEntry(
  key: Uint8Array,
  vaultId: string,
  record: VaultRecord
): Promise<VaultEntry> {
  const box = await sealJson(key, payloadOf(record), entryAad(vaultId, record.value.id))
  return { id: record.value.id, ...box }
}

async function decryptEntry(
  key: Uint8Array,
  vaultId: string,
  entry: VaultEntry
): Promise<VaultRecord> {
  let payload: EntryPayload
  try {
    payload = await openJson<EntryPayload>(key, entry, entryAad(vaultId, entry.id))
  } catch {
    throw new VaultError('tampered', `Entry ${entry.id} failed authentication.`)
  }
  return recordOf(entry.id, payload)
}

/** Seal the manifest for the current set of entries (in order) and never-save domains. */
export async function sealManifest(
  key: Uint8Array,
  vaultId: string,
  ids: string[],
  neverSave: string[],
  now: number = Date.now()
): Promise<SealedBox> {
  const manifest: ManifestPayload = { ids: [...ids], neverSave: [...neverSave], updatedAt: now }
  return sealJson(key, manifest, manifestAad(vaultId))
}

/** Build the whole file from plaintext state (every entry is re-sealed with a fresh nonce). */
export async function encodeVault(
  key: Uint8Array,
  meta: { vaultId: string; createdAt: number; keyWrap: KeyWrapRecord },
  records: VaultRecord[],
  neverSave: string[],
  now: number = Date.now()
): Promise<VaultFile> {
  const entries: VaultEntry[] = []
  for (const record of records) entries.push(await encryptEntry(key, meta.vaultId, record))
  const manifest: ManifestPayload = {
    ids: records.map((r) => r.value.id),
    neverSave: [...neverSave],
    updatedAt: now
  }
  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    vaultId: meta.vaultId,
    createdAt: meta.createdAt,
    updatedAt: now,
    keyWrap: meta.keyWrap,
    manifest: await sealJson(key, manifest, manifestAad(meta.vaultId)),
    entries
  }
}

export interface DecodedVault {
  credentials: Credential[]
  addresses: AddressEntry[]
  cards: PaymentCard[]
  passkeys: PasskeyEntry[]
  neverSave: string[]
}

/**
 * Decrypt everything. Throws `VaultError('wrong-key')` when the manifest does not open (the key
 * is not this vault's) and `VaultError('tampered')` when an entry fails authentication or the
 * entry list does not match the manifest.
 */
export async function decodeVault(key: Uint8Array, file: VaultFile): Promise<DecodedVault> {
  let manifest: ManifestPayload
  try {
    manifest = await openJson<ManifestPayload>(key, file.manifest, manifestAad(file.vaultId))
  } catch {
    throw new VaultError('wrong-key', 'The vault manifest does not open with this key.')
  }
  if (!Array.isArray(manifest.ids) || !Array.isArray(manifest.neverSave))
    throw new VaultError('tampered', 'The vault manifest is malformed.')
  const ids = file.entries.map((e) => e.id)
  if (ids.length !== manifest.ids.length || ids.some((id, i) => id !== manifest.ids[i]))
    throw new VaultError('tampered', 'The vault entries do not match the manifest.')
  const decoded: DecodedVault = {
    credentials: [],
    addresses: [],
    cards: [],
    passkeys: [],
    neverSave: manifest.neverSave.filter((d): d is string => typeof d === 'string')
  }
  for (const entry of file.entries) {
    const record = await decryptEntry(key, file.vaultId, entry)
    switch (record.kind) {
      case 'login':
        decoded.credentials.push(record.value)
        break
      case 'address':
        decoded.addresses.push(record.value)
        break
      case 'card':
        decoded.cards.push(record.value)
        break
      case 'passkey':
        decoded.passkeys.push(record.value)
        break
    }
  }
  return decoded
}

/** Wrap the data key with a key derived from `passphrase` through the host's KDF. */
export async function wrapWithPassphrase(
  host: KeyWrapHost,
  vaultId: string,
  dataKey: Uint8Array,
  passphrase: string
): Promise<PassphraseWrap> {
  const salt = randomBytes(PASSPHRASE_SALT_BYTES)
  const params = host.kdfParams()
  const kek = await host.deriveKey(passphrase.normalize('NFKC'), salt, params)
  if (kek.length !== DATA_KEY_BYTES) throw new Error('the derived key must be 32 bytes')
  return { salt: toBase64(salt), params, box: await seal(kek, dataKey, keyAad(vaultId)) }
}

/** Throws `VaultError('wrong-key')` for a wrong passphrase. */
export async function unwrapWithPassphrase(
  host: KeyWrapHost,
  vaultId: string,
  wrap: PassphraseWrap,
  passphrase: string
): Promise<Uint8Array> {
  const kek = await host.deriveKey(passphrase.normalize('NFKC'), fromBase64(wrap.salt), wrap.params)
  try {
    const key = await open(kek, wrap.box, keyAad(vaultId))
    if (key.length !== DATA_KEY_BYTES) throw new Error('bad key length')
    return key
  } catch {
    throw new VaultError('wrong-key', 'Wrong passphrase.')
  }
}
