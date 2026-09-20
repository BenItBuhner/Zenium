import type {
  AddressEntry,
  AddressInput,
  Credential,
  ImportConflict,
  ImportResult,
  PasskeyEntry,
  PaymentCard,
  PaymentCardInput
} from '../../shared/types'
import { newId } from '../../shared/ids'
import type { KeyWrapHost, StoreIO } from '../platform'
import { bytesEqual, newDataKey } from './crypto'
import {
  VAULT_DOCUMENT,
  VAULT_FORMAT,
  VAULT_VERSION,
  VaultError,
  decodeVault,
  encryptEntry,
  newVaultId,
  parseVaultFile,
  sealManifest,
  unwrapWithPassphrase,
  wrapWithPassphrase,
  type KeyWrapRecord,
  type VaultEntry,
  type VaultFile,
  type VaultRecord
} from './vault'
import { domainOf, normalizeDomain, normalizeOrigin, normalizeUrl, originMatches } from './origins'

/** What callers hand in to create a login (the origin is derived from the URL). */
export interface CredentialInput {
  url: string
  username: string
  password: string
  notes?: string
  /** HTTP authentication realm; leave unset for form logins. */
  realm?: string | null
}

export type CredentialPatch = Partial<Pick<Credential, 'url' | 'username' | 'password' | 'notes'>>

/** One parsed row of a password export, before it is reconciled with the vault. */
export interface ImportRow {
  url: string
  username: string
  password: string
  notes: string
  /** HTTP authentication realm (Firefox exports carry one for Basic / Digest logins). */
  realm?: string
  createdAt?: number
  lastUsedAt?: number
}

export type Protection = { os: boolean; passphrase: boolean }

/** The plaintext state one write seals (see `snapshot`). */
interface Snapshot {
  credentials: Map<string, Credential>
  addresses: Map<string, AddressEntry>
  cards: Map<string, PaymentCard>
  passkeys: Map<string, PasskeyEntry>
  neverSave: string[]
}

const MAX_FIELD = 4096
const MAX_NOTES = 16 * 1024

/**
 * The credential store: plaintext logins, addresses, payment cards and passkey records in memory
 * while unlocked, one encrypted vault document on disk (see `vault.ts`). Everything the manager,
 * the in-page save / fill prompts, HTTP authentication and sync need goes through here; the
 * password of a login and the number of a card are only handed out by `get` / `getCard`, so
 * callers gate them behind re-authentication themselves.
 *
 * Writes are eager: every mutation re-seals just the changed entry plus the manifest and hands the
 * document to the host's atomic `StoreIO.write`. `flushSync` writes the last fully sealed document
 * synchronously for shutdown paths.
 */
export class CredentialStore {
  private key: Uint8Array | null = null
  private file: VaultFile | null = null
  private credentials = new Map<string, Credential>()
  private addresses = new Map<string, AddressEntry>()
  private cards = new Map<string, PaymentCard>()
  private passkeys = new Map<string, PasskeyEntry>()
  private neverSaveDomains: string[] = []
  private sealed = new Map<string, VaultEntry>()
  private loadError: VaultError | null = null
  private encoded: string | null = null
  private writing: Promise<void> = Promise.resolve()
  private writeSeq = 0
  /** Something changed after the last successful `flush` finished. */
  private dirty = false
  onChange: () => void = () => {}

  constructor(
    private readonly io: StoreIO,
    private readonly keys: KeyWrapHost,
    private readonly document: string = VAULT_DOCUMENT
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Read the vault document (not decrypt it); safe to call again after a reset. */
  loadSync(): void {
    this.loadError = null
    this.file = null
    let raw: string | null
    try {
      raw = this.io.readSync(this.document)
    } catch (error) {
      this.loadError = new VaultError('corrupt', `The vault could not be read: ${String(error)}`)
      return
    }
    if (raw === null || raw === '') return
    try {
      this.file = parseVaultFile(raw)
    } catch (error) {
      this.loadError =
        error instanceof VaultError
          ? error
          : new VaultError('corrupt', 'The password vault could not be parsed.')
    }
  }

  /** A vault document exists on disk (possibly unreadable, see `error`). */
  exists(): boolean {
    return this.file !== null || this.loadError !== null
  }

  error(): VaultError | null {
    return this.loadError
  }

  unlocked(): boolean {
    return this.key !== null
  }

  protection(): Protection {
    const wrap = this.file?.keyWrap
    return { os: Boolean(wrap?.os), passphrase: Boolean(wrap?.passphrase) }
  }

  /**
   * Create the vault. Without an OS keystore a passphrase is required; with one the passphrase is
   * an optional second wrapping (and the re-authentication secret on hosts that cannot verify the
   * user themselves).
   */
  async create(passphrase?: string): Promise<void> {
    if (this.file || this.loadError) throw new Error('A vault already exists')
    const os = await this.keys.osAvailable()
    if (!os && !passphrase) throw new VaultError('locked', 'A passphrase is needed on this device.')
    const key = newDataKey()
    const vaultId = newVaultId()
    const keyWrap: KeyWrapRecord = {
      os: os ? await this.keys.wrap(key) : null,
      passphrase: passphrase ? await wrapWithPassphrase(this.keys, vaultId, key, passphrase) : null
    }
    const now = Date.now()
    const file: VaultFile = {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      vaultId,
      createdAt: now,
      updatedAt: now,
      keyWrap,
      manifest: await sealManifest(key, vaultId, [], [], now),
      entries: []
    }
    this.key = key
    this.clearPlaintext()
    this.file = file
    const plain = this.snapshot()
    await this.enqueue(() => this.commit(key, file, plain))
    this.onChange()
  }

  private clearPlaintext(): void {
    this.credentials = new Map()
    this.addresses = new Map()
    this.cards = new Map()
    this.passkeys = new Map()
    this.neverSaveDomains = []
    this.sealed = new Map()
  }

  /**
   * Open the vault. Prefers the OS wrapping; falls back to the passphrase wrapping when given a
   * passphrase. Throws `VaultError('locked')` when a passphrase is required, `'wrong-key'` for a
   * wrong passphrase and whatever the OS keystore threw when it refused.
   */
  async unlock(passphrase?: string, interactive = true): Promise<void> {
    if (this.key) return
    if (this.loadError) throw this.loadError
    if (!this.file) {
      await this.create(passphrase)
      return
    }
    const file = this.file
    let key: Uint8Array | null = null
    let osFailure: unknown = null
    if (file.keyWrap.passphrase && passphrase !== undefined) {
      key = await unwrapWithPassphrase(this.keys, file.vaultId, file.keyWrap.passphrase, passphrase)
    } else if (file.keyWrap.os) {
      try {
        key = await this.keys.unwrap(file.keyWrap.os, interactive)
      } catch (error) {
        osFailure = error
      }
    }
    if (!key) {
      if (file.keyWrap.passphrase)
        throw new VaultError('locked', 'The vault passphrase is needed to open it.')
      throw osFailure ?? new VaultError('locked', 'The vault key cannot be opened on this device.')
    }
    const decoded = await decodeVault(key, file)
    this.key = key
    this.credentials = new Map(decoded.credentials.map((c) => [c.id, c]))
    this.addresses = new Map(decoded.addresses.map((a) => [a.id, a]))
    this.cards = new Map(decoded.cards.map((c) => [c.id, c]))
    this.passkeys = new Map(decoded.passkeys.map((p) => [p.id, p]))
    this.neverSaveDomains = decoded.neverSave
    this.sealed = new Map(file.entries.map((e) => [e.id, e]))
    // A passphrase unlock on a device whose keystore has meanwhile become usable adds the OS
    // wrapping so the next start opens silently.
    if (!file.keyWrap.os && (await this.keys.osAvailable().catch(() => false))) {
      try {
        file.keyWrap = { ...file.keyWrap, os: await this.keys.wrap(key) }
        const plain = this.snapshot()
        await this.enqueue(() => this.commit(key, file, plain))
      } catch {
        // Not fatal: the passphrase keeps working.
      }
    }
    this.onChange()
  }

  /** Drop the key and every plaintext entry; the sealed document stays on disk. */
  lock(): void {
    this.key = null
    this.clearPlaintext()
    this.onChange()
  }

  /** Forget the vault and its key, keeping nothing; the next `unlock` creates a fresh one. */
  async reset(): Promise<void> {
    this.lock()
    this.file = null
    this.loadError = null
    ++this.writeSeq
    await this.enqueue(async () => {
      this.encoded = ''
      this.dirty = true
      await this.io.write(this.document, '')
      this.dirty = false
    })
    this.onChange()
  }

  /** Set or change the passphrase wrapping (the vault must be unlocked). */
  async setPassphrase(passphrase: string): Promise<void> {
    const key = this.requireKey()
    const file = this.requireFile()
    file.keyWrap = {
      ...file.keyWrap,
      passphrase: await wrapWithPassphrase(this.keys, file.vaultId, key, passphrase)
    }
    const plain = this.snapshot()
    await this.enqueue(() => this.commit(key, file, plain))
    this.onChange()
  }

  /** Whether `passphrase` opens this vault (used as the re-authentication secret). */
  async verifyPassphrase(passphrase: string): Promise<boolean> {
    const file = this.file
    if (!file?.keyWrap.passphrase) return false
    try {
      const key = await unwrapWithPassphrase(
        this.keys,
        file.vaultId,
        file.keyWrap.passphrase,
        passphrase
      )
      return this.key ? bytesEqual(key, this.key) : true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Every login, most recently changed first. */
  list(): Credential[] {
    return [...this.credentials.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Credential | null {
    return this.credentials.get(id) ?? null
  }

  count(): number {
    return this.credentials.size
  }

  /** Case-insensitive match on site, URL, username and notes; every term must match. */
  search(query: string): Credential[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return this.list()
    return this.list().filter((c) => {
      const hay = `${c.origin} ${c.url} ${c.username} ${c.notes}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }

  /**
   * Form logins usable on `pageOrigin` (same registrable domain, never https → http), exact
   * origin matches first, then most recently used. This is what in-page fill will call.
   */
  findForOrigin(pageOrigin: string): Credential[] {
    const origin = normalizeOrigin(pageOrigin)
    if (!origin) return []
    return this.list()
      .filter((c) => c.realm === null && originMatches(c.origin, origin))
      .sort((a, b) => {
        const exact = Number(b.origin === origin) - Number(a.origin === origin)
        if (exact !== 0) return exact
        return (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt)
      })
  }

  /** Saved HTTP authentication logins for an origin and realm (for the auth prompt to adopt). */
  findForHttpAuth(pageOrigin: string, realm: string): Credential[] {
    const origin = normalizeOrigin(pageOrigin)
    if (!origin) return []
    return this.list().filter((c) => c.realm !== null && c.origin === origin && c.realm === realm)
  }

  neverSaveList(): string[] {
    return [...this.neverSaveDomains]
  }

  isNeverSave(originOrUrl: string): boolean {
    const domain = domainOf(originOrUrl)
    return domain !== '' && this.neverSaveDomains.includes(domain)
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  add(input: CredentialInput, now: number = Date.now()): Credential {
    this.requireKey()
    const url = normalizeUrl(input.url)
    const origin = normalizeOrigin(input.url)
    if (!origin) throw new Error('A login needs a valid http or https address.')
    const credential: Credential = {
      id: newId('login'),
      origin,
      url,
      username: clip(input.username, MAX_FIELD),
      password: clip(input.password, MAX_FIELD),
      realm: input.realm ?? null,
      notes: clip(input.notes ?? '', MAX_NOTES),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    }
    this.credentials.set(credential.id, credential)
    this.changed([credential.id])
    return credential
  }

  update(id: string, patch: CredentialPatch, now: number = Date.now()): Credential | null {
    this.requireKey()
    const credential = this.credentials.get(id)
    if (!credential) return null
    if (patch.url !== undefined) {
      const origin = normalizeOrigin(patch.url)
      if (!origin) throw new Error('A login needs a valid http or https address.')
      credential.origin = origin
      credential.url = normalizeUrl(patch.url)
    }
    if (patch.username !== undefined) credential.username = clip(patch.username, MAX_FIELD)
    if (patch.password !== undefined) credential.password = clip(patch.password, MAX_FIELD)
    if (patch.notes !== undefined) credential.notes = clip(patch.notes, MAX_NOTES)
    credential.updatedAt = now
    this.changed([id])
    return credential
  }

  /** Remove a login and hand it back so the caller can offer undo. */
  remove(id: string): Credential | null {
    this.requireKey()
    const credential = this.credentials.get(id)
    if (!credential) return null
    this.credentials.delete(id)
    this.sealed.delete(id)
    this.changed([])
    return credential
  }

  /** Put a removed login back under its old id (undo). */
  restore(credential: Credential): boolean {
    this.requireKey()
    if (this.credentials.has(credential.id)) return false
    this.credentials.set(credential.id, credential)
    this.changed([credential.id])
    return true
  }

  markUsed(id: string, now: number = Date.now()): void {
    const credential = this.credentials.get(id)
    if (!credential || !this.key) return
    credential.lastUsedAt = now
    this.changed([id])
  }

  // ---------------------------------------------------------------------------
  // Sync (ID-09): another device's entries land under their own ids
  // ---------------------------------------------------------------------------

  /**
   * Put a login another device published in place of this device's copy (or add it). The
   * record's id, values and timestamps are kept as they came (the other device normalised them
   * when it saved the login), so both devices hold the same entry and the sync engine's hashes
   * agree; the field bounds this device applies to its own entries hold here too.
   */
  applySynced(login: Credential): void {
    this.requireKey()
    this.credentials.set(login.id, {
      id: login.id,
      origin: login.origin,
      url: login.url,
      username: clip(login.username, MAX_FIELD),
      password: clip(login.password, MAX_FIELD),
      realm: login.realm,
      notes: clip(login.notes, MAX_NOTES),
      createdAt: login.createdAt,
      updatedAt: login.updatedAt,
      lastUsedAt: login.lastUsedAt
    })
    this.changed([login.id])
  }

  /** Delete a login another device deleted (no undo: the deletion was confirmed there). */
  removeSynced(id: string): boolean {
    this.requireKey()
    if (!this.credentials.delete(id)) return false
    this.sealed.delete(id)
    this.changed([])
    return true
  }

  /**
   * A passkey's public record from another device: it lists there like the device's own, but
   * signing in needs the private key, which stays in that device's authenticator.
   */
  applySyncedPasskey(passkey: PasskeyEntry): void {
    this.requireKey()
    this.passkeys.set(passkey.id, {
      id: passkey.id,
      rpId: clip(passkey.rpId, MAX_FIELD),
      rpName: clip(passkey.rpName, MAX_FIELD),
      userName: clip(passkey.userName, MAX_FIELD),
      userDisplayName: clip(passkey.userDisplayName, MAX_FIELD),
      credentialId: clip(passkey.credentialId, MAX_FIELD),
      origin: clip(passkey.origin, MAX_FIELD),
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt
    })
    this.changed([passkey.id])
  }

  removeSyncedPasskey(id: string): boolean {
    this.requireKey()
    if (!this.passkeys.delete(id)) return false
    this.sealed.delete(id)
    this.changed([])
    return true
  }

  neverSaveAdd(domainOrUrl: string): void {
    this.requireKey()
    const domain = normalizeDomain(domainOrUrl)
    if (!domain || this.neverSaveDomains.includes(domain)) return
    this.neverSaveDomains = [...this.neverSaveDomains, domain].sort()
    this.changed([])
  }

  neverSaveRemove(domain: string): void {
    this.requireKey()
    const before = this.neverSaveDomains.length
    this.neverSaveDomains = this.neverSaveDomains.filter((d) => d !== domain.toLowerCase())
    if (this.neverSaveDomains.length !== before) this.changed([])
  }

  /**
   * Merge imported rows. A row matches an existing login when origin and username agree;
   * `skip` keeps the existing one, `replace` overwrites its password and notes, `keep-both`
   * adds a second login.
   */
  importRows(
    rows: ImportRow[],
    conflict: ImportConflict,
    format: string | null,
    now: number = Date.now()
  ): ImportResult {
    this.requireKey()
    const result: ImportResult = {
      format,
      total: rows.length,
      added: 0,
      replaced: 0,
      skipped: 0,
      invalid: 0
    }
    const touched: string[] = []
    const byKey = new Map<string, Credential>()
    const keyOf = (origin: string, username: string, realm: string | null): string =>
      `${origin}\n${username}\n${realm ?? ''}`
    for (const c of this.credentials.values()) byKey.set(keyOf(c.origin, c.username, c.realm), c)
    for (const row of rows) {
      const origin = normalizeOrigin(row.url)
      if (!origin || !row.password) {
        result.invalid++
        continue
      }
      const username = clip(row.username, MAX_FIELD)
      const realm = row.realm ? clip(row.realm, MAX_FIELD) : null
      const existing = byKey.get(keyOf(origin, username, realm))
      if (existing) {
        if (existing.password === row.password) {
          result.skipped++
          continue
        }
        if (conflict === 'skip') {
          result.skipped++
          continue
        }
        if (conflict === 'replace') {
          existing.password = clip(row.password, MAX_FIELD)
          if (row.notes) existing.notes = clip(row.notes, MAX_NOTES)
          existing.updatedAt = now
          touched.push(existing.id)
          result.replaced++
          continue
        }
      }
      const credential: Credential = {
        id: newId('login'),
        origin,
        url: normalizeUrl(row.url),
        username,
        password: clip(row.password, MAX_FIELD),
        realm,
        notes: clip(row.notes, MAX_NOTES),
        createdAt: row.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: row.lastUsedAt ?? null
      }
      this.credentials.set(credential.id, credential)
      if (!existing) byKey.set(keyOf(origin, username, realm), credential)
      touched.push(credential.id)
      result.added++
    }
    if (touched.length > 0 || result.replaced > 0) this.changed(touched)
    return result
  }

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  /** Every address, most recently used (else changed) first. */
  listAddresses(): AddressEntry[] {
    return [...this.addresses.values()].sort(
      (a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt)
    )
  }

  getAddress(id: string): AddressEntry | null {
    return this.addresses.get(id) ?? null
  }

  addAddress(input: AddressInput, now: number = Date.now()): AddressEntry {
    this.requireKey()
    const address: AddressEntry = {
      id: newId('address'),
      ...clipAddress(input),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    }
    this.addresses.set(address.id, address)
    this.changed([address.id])
    return address
  }

  updateAddress(
    id: string,
    patch: Partial<AddressInput>,
    now: number = Date.now()
  ): AddressEntry | null {
    this.requireKey()
    const address = this.addresses.get(id)
    if (!address) return null
    Object.assign(address, clipAddress({ ...address, ...patch }), { updatedAt: now })
    this.changed([id])
    return address
  }

  removeAddress(id: string): AddressEntry | null {
    this.requireKey()
    const address = this.addresses.get(id)
    if (!address) return null
    this.addresses.delete(id)
    this.sealed.delete(id)
    this.changed([])
    return address
  }

  markAddressUsed(id: string, now: number = Date.now()): void {
    const address = this.addresses.get(id)
    if (!address || !this.key) return
    address.lastUsedAt = now
    this.changed([id])
  }

  // ---------------------------------------------------------------------------
  // Payment cards
  // ---------------------------------------------------------------------------

  /** Every card, most recently used (else changed) first. */
  listCards(): PaymentCard[] {
    return [...this.cards.values()].sort(
      (a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt)
    )
  }

  getCard(id: string): PaymentCard | null {
    return this.cards.get(id) ?? null
  }

  /** The caller validates the number and expiry first (`autofill/card.ts`). */
  addCard(input: PaymentCardInput, now: number = Date.now()): PaymentCard {
    this.requireKey()
    const card: PaymentCard = {
      id: newId('card'),
      number: input.number.replace(/\D/g, '').slice(0, 19),
      expMonth: input.expMonth,
      expYear: input.expYear,
      name: clip(input.name, MAX_FIELD),
      nickname: clip(input.nickname, MAX_FIELD),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    }
    this.cards.set(card.id, card)
    this.changed([card.id])
    return card
  }

  updateCard(
    id: string,
    patch: Partial<PaymentCardInput>,
    now: number = Date.now()
  ): PaymentCard | null {
    this.requireKey()
    const card = this.cards.get(id)
    if (!card) return null
    if (patch.number !== undefined) card.number = patch.number.replace(/\D/g, '').slice(0, 19)
    if (patch.expMonth !== undefined) card.expMonth = patch.expMonth
    if (patch.expYear !== undefined) card.expYear = patch.expYear
    if (patch.name !== undefined) card.name = clip(patch.name, MAX_FIELD)
    if (patch.nickname !== undefined) card.nickname = clip(patch.nickname, MAX_FIELD)
    card.updatedAt = now
    this.changed([id])
    return card
  }

  removeCard(id: string): PaymentCard | null {
    this.requireKey()
    const card = this.cards.get(id)
    if (!card) return null
    this.cards.delete(id)
    this.sealed.delete(id)
    this.changed([])
    return card
  }

  markCardUsed(id: string, now: number = Date.now()): void {
    const card = this.cards.get(id)
    if (!card || !this.key) return
    card.lastUsedAt = now
    this.changed([id])
  }

  // ---------------------------------------------------------------------------
  // Passkey records
  // ---------------------------------------------------------------------------

  listPasskeys(): PasskeyEntry[] {
    return [...this.passkeys.values()].sort(
      (a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt)
    )
  }

  /** The record of a passkey by relying party and credential id (or, without one, by user name). */
  findPasskey(rpId: string, credentialId: string, userName = ''): PasskeyEntry | null {
    for (const p of this.passkeys.values()) {
      if (p.rpId !== rpId) continue
      if (credentialId && p.credentialId === credentialId) return p
      if (!credentialId && userName && p.userName === userName) return p
    }
    return null
  }

  addPasskey(
    input: Omit<PasskeyEntry, 'id' | 'createdAt' | 'lastUsedAt'>,
    now: number = Date.now()
  ): PasskeyEntry {
    this.requireKey()
    const passkey: PasskeyEntry = {
      id: newId('passkey'),
      rpId: clip(input.rpId, MAX_FIELD),
      rpName: clip(input.rpName, MAX_FIELD),
      userName: clip(input.userName, MAX_FIELD),
      userDisplayName: clip(input.userDisplayName, MAX_FIELD),
      credentialId: clip(input.credentialId, MAX_FIELD),
      origin: clip(input.origin, MAX_FIELD),
      createdAt: now,
      lastUsedAt: null
    }
    this.passkeys.set(passkey.id, passkey)
    this.changed([passkey.id])
    return passkey
  }

  markPasskeyUsed(id: string, now: number = Date.now()): void {
    const passkey = this.passkeys.get(id)
    if (!passkey || !this.key) return
    passkey.lastUsedAt = now
    this.changed([id])
  }

  removePasskey(id: string): PasskeyEntry | null {
    this.requireKey()
    const passkey = this.passkeys.get(id)
    if (!passkey) return null
    this.passkeys.delete(id)
    this.sealed.delete(id)
    this.changed([])
    return passkey
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /** Wait for every queued write to land. */
  async flush(): Promise<void> {
    await this.writing
  }

  /** Shutdown path: write the newest sealed document synchronously if its write is still pending. */
  flushSync(): void {
    if (this.encoded === null || !this.dirty) return
    this.dirty = false
    try {
      this.io.writeSync(this.document, this.encoded)
    } catch (error) {
      console.error('[zenium] failed writing the password vault:', error)
    }
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new VaultError('locked', 'The password vault is locked.')
    return this.key
  }

  private requireFile(): VaultFile {
    if (!this.file) throw new VaultError('locked', 'The password vault does not exist yet.')
    return this.file
  }

  /** Run `work` after every earlier write; failures are logged, never propagated to callers. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.writing.then(work).catch((error) => {
      console.error('[zenium] failed writing the password vault:', error)
    })
    this.writing = run
    return run
  }

  /**
   * A mutation happened: re-seal the touched entries and write. Consecutive changes queue up;
   * a change whose entries a later one already re-sealed skips its own write.
   */
  private changed(ids: string[]): void {
    const seq = ++this.writeSeq
    const key = this.requireKey()
    const file = this.requireFile()
    const plain = this.snapshot()
    void this.enqueue(async () => {
      for (const id of ids) {
        const record = recordIn(plain, id)
        if (record) this.sealed.set(id, await encryptEntry(key, file.vaultId, record))
      }
      if (seq !== this.writeSeq) return
      await this.commit(key, file, plain)
    }).then(() => this.onChange())
  }

  /**
   * The plaintext a queued write seals, taken when the write is queued: a `lock()` that empties
   * the live maps before the write lands must not empty the document. Entries are copied so a
   * later in-place edit does not leak into an earlier write.
   */
  private snapshot(): Snapshot {
    const copy = <T extends object>(map: Map<string, T>): Map<string, T> =>
      new Map([...map].map(([id, value]) => [id, { ...value }]))
    return {
      credentials: copy(this.credentials),
      addresses: copy(this.addresses),
      cards: copy(this.cards),
      passkeys: copy(this.passkeys),
      neverSave: [...this.neverSaveDomains]
    }
  }

  /** Seal the manifest, assemble the document and write it atomically. */
  private async commit(key: Uint8Array, file: VaultFile, plain: Snapshot): Promise<void> {
    const now = Date.now()
    const entries: VaultEntry[] = []
    for (const record of recordsOf(plain)) {
      const id = record.value.id
      let entry = this.sealed.get(id)
      if (!entry) {
        entry = await encryptEntry(key, file.vaultId, record)
        this.sealed.set(id, entry)
      }
      entries.push(entry)
    }
    file.manifest = await sealManifest(
      key,
      file.vaultId,
      entries.map((e) => e.id),
      plain.neverSave,
      now
    )
    file.entries = entries
    file.updatedAt = now
    this.encoded = JSON.stringify(file)
    this.dirty = true
    await this.io.write(this.document, this.encoded)
    this.dirty = false
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

function clipAddress(input: AddressInput): AddressInput {
  return {
    country: input.country.trim().toUpperCase().slice(0, 2),
    name: clip(input.name.trim(), MAX_FIELD),
    organization: clip(input.organization.trim(), MAX_FIELD),
    streetAddress: clip(input.streetAddress.trim(), MAX_FIELD),
    locality: clip(input.locality.trim(), MAX_FIELD),
    region: clip(input.region.trim(), MAX_FIELD),
    postalCode: clip(input.postalCode.trim(), MAX_FIELD),
    sortingCode: clip(input.sortingCode.trim(), MAX_FIELD),
    phone: clip(input.phone.trim(), MAX_FIELD),
    email: clip(input.email.trim(), MAX_FIELD)
  }
}

/** Every entry of a snapshot in document order: logins, addresses, cards, passkey records. */
function recordsOf(plain: Snapshot): VaultRecord[] {
  const records: VaultRecord[] = []
  for (const value of plain.credentials.values()) records.push({ kind: 'login', value })
  for (const value of plain.addresses.values()) records.push({ kind: 'address', value })
  for (const value of plain.cards.values()) records.push({ kind: 'card', value })
  for (const value of plain.passkeys.values()) records.push({ kind: 'passkey', value })
  return records
}

function recordIn(plain: Snapshot, id: string): VaultRecord | null {
  const login = plain.credentials.get(id)
  if (login) return { kind: 'login', value: login }
  const address = plain.addresses.get(id)
  if (address) return { kind: 'address', value: address }
  const card = plain.cards.get(id)
  if (card) return { kind: 'card', value: card }
  const passkey = plain.passkeys.get(id)
  if (passkey) return { kind: 'passkey', value: passkey }
  return null
}
