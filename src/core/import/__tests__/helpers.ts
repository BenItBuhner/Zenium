// Test fixtures: the core itself never touches Node's file or database APIs.
// eslint-disable-next-line no-restricted-imports
import { DatabaseSync } from 'node:sqlite'
import type { ImportDatabase, ImportFileKind, ImportHost, ImportTempCopy } from '../../platform'

/**
 * Test doubles for the import engine: a SQLite database built in memory with `node:sqlite`, an
 * `ImportHost` over an in-memory file tree that records every copy and open, and an LZ4 block
 * compressor (the decoder's inverse) for mozlz4 fixtures.
 */

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export type SqlBuilder = (db: DatabaseSync) => void

/** An in-memory database as the core sees it, built by `build`. */
export function memoryDatabase(build: SqlBuilder): ImportDatabase & { native: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  build(db)
  return {
    native: db,
    all: (sql) => {
      // WebKit microsecond stamps pass 2^53: node:sqlite throws unless integers come as BigInts.
      const statement = db.prepare(sql)
      statement.setReadBigInts(true)
      return statement.all() as Record<string, unknown>[]
    },
    close: () => db.close()
  }
}

/** Chrome's `History` tables (the columns the import reads plus a few Chrome writes). */
export function chromiumHistorySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,
    visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
    last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);
  CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL,
    from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER,
    visit_duration INTEGER DEFAULT 0 NOT NULL);`)
}

/** Chrome's `Login Data` `logins` table. */
export function chromiumLoginsSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE logins(origin_url VARCHAR NOT NULL, action_url VARCHAR, username_element VARCHAR,
    username_value VARCHAR, password_element VARCHAR, password_value BLOB, submit_element VARCHAR,
    signon_realm VARCHAR NOT NULL, date_created INTEGER NOT NULL, blacklisted_by_user INTEGER NOT NULL,
    scheme INTEGER NOT NULL, password_type INTEGER, times_used INTEGER, form_data BLOB,
    display_name VARCHAR, icon_url VARCHAR, federation_url VARCHAR, skip_zero_click INTEGER,
    generation_upload_status INTEGER, possible_username_pairs BLOB, id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_last_used INTEGER NOT NULL DEFAULT 0, moving_blocked_for BLOB, date_password_modified INTEGER NOT NULL DEFAULT 0);`)
}

/**
 * `FieldType`'s values for the fields the fixtures write, read from
 * `components/autofill/core/browser/field_types.h` on their own so a slip in the reader's table
 * fails a test rather than agreeing with itself.
 */
export const CHROMIUM_FIELD_TYPE = {
  NAME_FIRST: 3,
  NAME_MIDDLE: 4,
  NAME_LAST: 5,
  NAME_FULL: 7,
  EMAIL_ADDRESS: 9,
  PHONE_HOME_WHOLE_NUMBER: 14,
  ADDRESS_HOME_CITY: 33,
  ADDRESS_HOME_STATE: 34,
  ADDRESS_HOME_ZIP: 35,
  ADDRESS_HOME_COUNTRY: 36,
  COMPANY_NAME: 60,
  ADDRESS_HOME_STREET_ADDRESS: 77,
  ADDRESS_HOME_SORTING_CODE: 79,
  ADDRESS_HOME_DEPENDENT_LOCALITY: 81
} as const

export type ChromiumAddressShape = 'unified' | 'split' | 'legacy'

/** One saved address as a `Web Data` fixture writes it: its guid, whose it is, its fields by `FieldType`. */
export interface ChromiumAddressRow {
  guid: string
  /** `AutofillProfile::RecordType`: 0 local, 1 account, 4 the account's name and email. */
  recordType?: number
  fields: Partial<Record<keyof typeof CHROMIUM_FIELD_TYPE, string>>
}

/**
 * Chrome's `Web Data` address tables in one of their three shapes
 * (`components/autofill/core/browser/webdata/addresses/address_autofill_table.cc`): `unified`
 * is `InitAddressesTable` + `InitAddressTypeTokensTable` (schema 134+); `split` the
 * `MigrateToVersion107AddContactInfoTables` / `…113MigrateLocalAddressProfilesToNewTable` pairs;
 * `legacy` the `autofill_profiles*` tables of before. The form-history `autofill` table Chrome
 * always has comes along so a fixture is told apart from an empty database by its address tables.
 */
export function chromiumWebDataSchema(db: DatabaseSync, shape: ChromiumAddressShape): void {
  db.exec(`CREATE TABLE autofill(name VARCHAR, value VARCHAR, value_lower VARCHAR, date_created INTEGER DEFAULT 0,
    date_last_used INTEGER DEFAULT 0, count INTEGER DEFAULT 1, PRIMARY KEY (name, value));`)
  if (shape === 'unified') {
    db.exec(`CREATE TABLE addresses(guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0,
      use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR,
      label VARCHAR, initial_creator_id INTEGER DEFAULT 0, record_type INTEGER);
    CREATE TABLE address_type_tokens(guid VARCHAR, type INTEGER, value VARCHAR,
      verification_status INTEGER DEFAULT 0, observations BLOB, PRIMARY KEY (guid, type));`)
  } else if (shape === 'split') {
    for (const [rows, tokens] of [
      ['local_addresses', 'local_addresses_type_tokens'],
      ['contact_info', 'contact_info_type_tokens']
    ])
      db.exec(`CREATE TABLE ${rows}(guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0,
        use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR,
        label VARCHAR, initial_creator_id INTEGER DEFAULT 0, last_modifier_id INTEGER DEFAULT 0);
      CREATE TABLE ${tokens}(guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0,
        PRIMARY KEY (guid, type));`)
  } else {
    db.exec(`CREATE TABLE autofill_profiles(guid VARCHAR PRIMARY KEY, company_name VARCHAR, street_address VARCHAR,
      dependent_locality VARCHAR, city VARCHAR, state VARCHAR, zipcode VARCHAR, sorting_code VARCHAR,
      country_code VARCHAR, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0,
      date_modified INTEGER NOT NULL DEFAULT 0, origin VARCHAR DEFAULT '', language_code VARCHAR, label VARCHAR,
      disallow_settings_visible_updates INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE autofill_profile_names(guid VARCHAR, first_name VARCHAR, middle_name VARCHAR, last_name VARCHAR,
      full_name VARCHAR, honorific_prefix VARCHAR, first_last_name VARCHAR, conjunction_last_name VARCHAR,
      second_last_name VARCHAR);
    CREATE TABLE autofill_profile_emails(guid VARCHAR, email VARCHAR);
    CREATE TABLE autofill_profile_phones(guid VARCHAR, number VARCHAR);`)
  }
}

/** Write `rows` into a `Web Data` of `shape`; the legacy shape holds local addresses only. */
export function insertChromiumAddresses(
  db: DatabaseSync,
  shape: ChromiumAddressShape,
  rows: ChromiumAddressRow[]
): void {
  const field = (row: ChromiumAddressRow, name: keyof typeof CHROMIUM_FIELD_TYPE): string =>
    row.fields[name] ?? ''
  if (shape === 'legacy') {
    const profile = db.prepare(
      `INSERT INTO autofill_profiles(guid, company_name, street_address, dependent_locality, city, state, zipcode,
        sorting_code, country_code, date_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const name = db.prepare(
      'INSERT INTO autofill_profile_names(guid, first_name, middle_name, last_name, full_name) VALUES (?, ?, ?, ?, ?)'
    )
    const email = db.prepare('INSERT INTO autofill_profile_emails(guid, email) VALUES (?, ?)')
    const phone = db.prepare('INSERT INTO autofill_profile_phones(guid, number) VALUES (?, ?)')
    for (const row of rows) {
      profile.run(
        row.guid,
        field(row, 'COMPANY_NAME'),
        field(row, 'ADDRESS_HOME_STREET_ADDRESS'),
        field(row, 'ADDRESS_HOME_DEPENDENT_LOCALITY'),
        field(row, 'ADDRESS_HOME_CITY'),
        field(row, 'ADDRESS_HOME_STATE'),
        field(row, 'ADDRESS_HOME_ZIP'),
        field(row, 'ADDRESS_HOME_SORTING_CODE'),
        field(row, 'ADDRESS_HOME_COUNTRY'),
        1_705_526_400
      )
      name.run(
        row.guid,
        field(row, 'NAME_FIRST'),
        field(row, 'NAME_MIDDLE'),
        field(row, 'NAME_LAST'),
        field(row, 'NAME_FULL')
      )
      email.run(row.guid, field(row, 'EMAIL_ADDRESS'))
      phone.run(row.guid, field(row, 'PHONE_HOME_WHOLE_NUMBER'))
    }
    return
  }
  for (const row of rows) {
    const account = (row.recordType ?? 0) !== 0
    const [table, tokens] =
      shape === 'unified'
        ? ['addresses', 'address_type_tokens']
        : account
          ? ['contact_info', 'contact_info_type_tokens']
          : ['local_addresses', 'local_addresses_type_tokens']
    if (shape === 'unified')
      db.prepare(
        `INSERT INTO ${table}(guid, date_modified, language_code, record_type) VALUES (?, ?, ?, ?)`
      ).run(row.guid, 1_705_526_400, 'en', row.recordType ?? 0)
    else
      db.prepare(`INSERT INTO ${table}(guid, date_modified, language_code) VALUES (?, ?, ?)`).run(
        row.guid,
        1_705_526_400,
        'en'
      )
    const token = db.prepare(`INSERT INTO ${tokens}(guid, type, value) VALUES (?, ?, ?)`)
    for (const [name, value] of Object.entries(row.fields))
      token.run(row.guid, CHROMIUM_FIELD_TYPE[name as keyof typeof CHROMIUM_FIELD_TYPE], value)
  }
}

/** Firefox's `places.sqlite` tables the import reads. */
export function firefoxPlacesSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
    rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL,
    typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER,
    guid TEXT, foreign_count INTEGER DEFAULT 0 NOT NULL, url_hash INTEGER DEFAULT 0 NOT NULL);
  CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER,
    position INTEGER, title LONGVARCHAR, keyword_id INTEGER, folder_type TEXT, dateAdded INTEGER,
    lastModified INTEGER, guid TEXT, syncStatus INTEGER NOT NULL DEFAULT 0,
    syncChangeCounter INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER,
    visit_date INTEGER, visit_type INTEGER, session INTEGER, source INTEGER DEFAULT 0 NOT NULL,
    triggeringPlaceId INTEGER);`)
}

/** Safari's `History.db` tables the import reads. */
export function safariHistorySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE history_items(id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
    domain_expansion TEXT NULL, visit_count INTEGER NOT NULL, daily_visit_counts BLOB NOT NULL,
    weekly_visit_counts BLOB NULL, autocomplete_triggers BLOB NULL,
    should_recompute_derived_visit_counts INTEGER NOT NULL, visit_count_score INTEGER NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE history_visits(id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL,
    visit_time REAL NOT NULL, title TEXT NULL, load_successful BOOLEAN NOT NULL DEFAULT 1,
    http_non_get BOOLEAN NOT NULL DEFAULT 0, synthesized BOOLEAN NOT NULL DEFAULT 0,
    redirect_source INTEGER NULL, redirect_destination INTEGER NULL, origin INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0, attributes INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0);`)
}

// ---------------------------------------------------------------------------
// Chrome's sealed passwords
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

function bytes(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(text.length * 3))
  const { written } = encoder.encodeInto(text, out)
  return out.subarray(0, written) as Uint8Array<ArrayBuffer>
}

/** Seal a password the way OSCrypt does: `prefix` + AES-128-CBC(PBKDF2-SHA1(secret, "saltysalt")). */
export async function sealChromiumPassword(
  prefix: 'v10' | 'v11',
  secret: string,
  iterations: number,
  plaintext: string
): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle
  const material = await subtle.importKey('raw', bytes(secret), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-1', salt: bytes('saltysalt'), iterations },
    material,
    128
  )
  const key = await subtle.importKey('raw', bits, { name: 'AES-CBC' }, false, ['encrypt'])
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-CBC', iv: new Uint8Array(16).fill(0x20) },
      key,
      bytes(plaintext)
    )
  )
  const out = new Uint8Array(3 + sealed.length)
  out.set(bytes(prefix), 0)
  out.set(sealed, 3)
  return out
}

// ---------------------------------------------------------------------------
// LZ4 / mozlz4
// ---------------------------------------------------------------------------

/** A greedy LZ4 block compressor: 4-byte hashes, the spec's end-of-block literal rules. */
export function lz4CompressBlock(src: Uint8Array): Uint8Array {
  const out: number[] = []
  const n = src.length
  const table = new Map<number, number>()
  let anchor = 0
  const lengthBytes = (value: number): void => {
    let rest = value - 15
    while (rest >= 255) {
      out.push(255)
      rest -= 255
    }
    out.push(rest)
  }
  const emit = (literalsEnd: number, matchLength: number | null, offset: number): void => {
    const literals = literalsEnd - anchor
    const match = matchLength === null ? 0 : matchLength - 4
    const tokenAt = out.length
    out.push(0)
    if (literals >= 15) lengthBytes(literals)
    for (let k = anchor; k < literalsEnd; k++) out.push(src[k])
    if (matchLength !== null) {
      out.push(offset & 0xff, offset >> 8)
      if (match >= 15) lengthBytes(match)
    }
    out[tokenAt] = (Math.min(literals, 15) << 4) | Math.min(match, 15)
  }
  const hash = (p: number): number =>
    (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0
  // A match may not start in the last 12 bytes nor run into the last 5 (the block's own rules).
  const lastMatchStart = n - 12
  let i = 0
  while (i < lastMatchStart) {
    const h = hash(i)
    const ref = table.get(h)
    table.set(h, i)
    if (
      ref !== undefined &&
      i - ref <= 0xffff &&
      src[ref] === src[i] &&
      src[ref + 1] === src[i + 1] &&
      src[ref + 2] === src[i + 2] &&
      src[ref + 3] === src[i + 3]
    ) {
      let length = 4
      const maxLength = n - 5 - i
      while (length < maxLength && src[ref + length] === src[i + length]) length++
      emit(i, length, i - ref)
      i += length
      anchor = i
    } else i++
  }
  emit(n, null, 0)
  return Uint8Array.from(out)
}

/** Text as Firefox's `mozLz40\0` container. */
export function mozlz4Encode(text: string): Uint8Array {
  const raw = bytes(text)
  const block = lz4CompressBlock(raw)
  const out = new Uint8Array(12 + block.length)
  out.set(bytes('mozLz40\0'), 0)
  new DataView(out.buffer).setUint32(8, raw.length, true)
  out.set(block, 12)
  return out
}

// ---------------------------------------------------------------------------
// An in-memory ImportHost
// ---------------------------------------------------------------------------

type Entry =
  | { kind: 'file'; text?: string; bytes?: Uint8Array; sqlite?: SqlBuilder }
  | { kind: 'dir' }
  | { kind: 'symlink' }
  /** A file whose every read fails with `code` (a browser's exclusive lock). */
  | { kind: 'locked'; code: string }

function fail(code: string, path: string): Error {
  const error = new Error(`${code}: ${path}`) as Error & { code: string }
  error.code = code
  return error
}

/**
 * A file tree in memory. Databases are `SqlBuilder`s run on open; `openSqlite` insists on a
 * temp copy so the copy-before-read rule is checked by every test that reads one.
 */
export class FakeImportHost implements ImportHost {
  readonly homeDir: string
  readonly env: Record<string, string | undefined>
  readonly entries = new Map<string, Entry>()
  /** The path lists handed to `copyToTemp`, in order. */
  readonly copyRequests: string[][] = []
  /** Temp directories created and removed. */
  readonly tempDirs: string[] = []
  readonly removedDirs: string[] = []
  /** Paths opened as databases. */
  readonly opened: string[] = []
  secret: string | null = null
  secretRequests: string[] = []
  private tempCounter = 0

  constructor(homeDir = '/home/tester', env: Record<string, string | undefined> = {}) {
    this.homeDir = homeDir
    this.env = env
  }

  file(path: string, content: string | Uint8Array): this {
    this.entries.set(
      path,
      typeof content === 'string'
        ? { kind: 'file', text: content }
        : { kind: 'file', bytes: content }
    )
    return this
  }

  sqlite(path: string, build: SqlBuilder): this {
    this.entries.set(path, { kind: 'file', sqlite: build })
    return this
  }

  dir(path: string): this {
    this.entries.set(path, { kind: 'dir' })
    return this
  }

  symlink(path: string): this {
    this.entries.set(path, { kind: 'symlink' })
    return this
  }

  locked(path: string, code = 'EBUSY'): this {
    this.entries.set(path, { kind: 'locked', code })
    return this
  }

  remove(path: string): this {
    this.entries.delete(path)
    return this
  }

  async stat(path: string): Promise<ImportFileKind> {
    const entry = this.entries.get(path)
    if (entry) return entry.kind === 'locked' ? 'file' : entry.kind
    for (const key of this.entries.keys()) if (key.startsWith(`${path}/`)) return 'dir'
    return 'missing'
  }

  async readText(path: string): Promise<string> {
    const entry = this.requireFile(path)
    if (entry.text !== undefined) return entry.text
    if (entry.bytes) return new TextDecoder().decode(entry.bytes)
    throw fail('EISDIR', path)
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const entry = this.requireFile(path)
    if (entry.bytes) return entry.bytes
    if (entry.text !== undefined) return new TextEncoder().encode(entry.text)
    throw fail('EISDIR', path)
  }

  async list(dir: string): Promise<string[]> {
    const names = new Set<string>()
    const prefix = `${dir}/`
    for (const key of this.entries.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf('/')
      names.add(slash === -1 ? rest : rest.slice(0, slash))
    }
    return [...names].sort()
  }

  async copyToTemp(paths: string[]): Promise<ImportTempCopy> {
    this.copyRequests.push([...paths])
    const dir = `/tmp/zenium-import-${++this.tempCounter}`
    this.tempDirs.push(dir)
    const copies: (string | null)[] = []
    for (const path of paths) {
      const entry = this.entries.get(path)
      if (!entry || entry.kind === 'dir' || entry.kind === 'symlink') {
        copies.push(null)
        continue
      }
      if (entry.kind === 'locked') {
        // A host that fails mid-copy leaves nothing behind (the contract the Electron host keeps).
        await this.removeTemp(dir)
        throw fail(entry.code, path)
      }
      const copy = `${dir}/${path.split('/').pop()}`
      this.entries.set(copy, { ...entry })
      copies.push(copy)
    }
    return { dir, copies }
  }

  async removeTemp(dir: string): Promise<void> {
    this.removedDirs.push(dir)
    for (const key of [...this.entries.keys()])
      if (key.startsWith(`${dir}/`)) this.entries.delete(key)
  }

  async openSqlite(path: string): Promise<ImportDatabase> {
    if (!path.startsWith('/tmp/zenium-import-'))
      throw new Error(`openSqlite must be given a temp copy, got ${path}`)
    const entry = this.requireFile(path)
    if (!entry.sqlite) throw fail('SQLITE_NOTADB', path)
    this.opened.push(path)
    return memoryDatabase(entry.sqlite)
  }

  async safeStorageSecret(browser: string): Promise<string | null> {
    this.secretRequests.push(browser)
    return this.secret
  }

  private requireFile(path: string): Extract<Entry, { kind: 'file' }> {
    const entry = this.entries.get(path)
    if (!entry) throw fail('ENOENT', path)
    if (entry.kind === 'locked') throw fail(entry.code, path)
    if (entry.kind !== 'file') throw fail('EISDIR', path)
    return entry
  }
}
