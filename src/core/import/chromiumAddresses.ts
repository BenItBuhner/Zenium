import type { AddressInput } from '../../shared/types'
import { clipAddress } from '../credentials/store'
import type { ImportDatabase } from '../platform'

/**
 * Chrome's, Chromium's and Edge's `Web Data`: the profile's saved addresses (ID-57). Unlike the
 * passwords they are stored in the clear, so every OS reads them. Chromium has kept them in
 * three shapes (`components/autofill/core/browser/webdata/addresses/address_autofill_table.cc`,
 * its `MigrateToVersion…` steps), told apart here by the tables present:
 *
 * - `unified` (schema 134+, `MigrateToVersion134UnifyLocalAndAccountAddressStorage`): one
 *   `addresses` table (guid, use_count, use_date, date_modified, language_code, label,
 *   initial_creator_id, record_type) with every field of a profile as a (guid, type, value) row
 *   of `address_type_tokens`.
 * - `split` (schema 107–133): the same two-table layout per store – `contact_info` +
 *   `contact_info_type_tokens` for the account's addresses
 *   (`MigrateToVersion107AddContactInfoTables`) and, from schema 113, `local_addresses` +
 *   `local_addresses_type_tokens` for the profile's own
 *   (`MigrateToVersion113MigrateLocalAddressProfilesToNewTable`). Between 107 and 112 the
 *   profile's own are still the legacy columns below, beside the account's pair; at 113 the
 *   legacy tables linger, already copied, until `MigrateToVersion114DropLegacyAddressTables`.
 * - `legacy` (before schema 107): `autofill_profiles` with the address as columns
 *   (company_name, street_address, city, state, zipcode, sorting_code, country_code) and the
 *   name, email and phone in `autofill_profile_names`, `autofill_profile_emails` and
 *   `autofill_profile_phones`, one row per guid.
 *
 * The token `type` is Chromium's `FieldType` (`components/autofill/core/browser/field_types.h`);
 * `record_type` is `AutofillProfile::RecordType`
 * (`components/autofill/core/browser/data_model/addresses/autofill_profile.h`). Dependent
 * locality is not modelled by the vault's addresses (`core/credentials/address.ts`) and is left
 * out, as the vault's own form leaves it out.
 */

/** `FieldType`'s values for the fields the vault's `AddressInput` has (`field_types.h`). */
const FIELD_TYPE = {
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
  ADDRESS_HOME_SORTING_CODE: 79
} as const

/**
 * `AutofillProfile::RecordType`: kLocalOrSyncable 0, kAccount 1, kAccountHome 2, kAccountWork 3
 * are saved addresses; kAccountNameEmail 4 is the signed-in account's name and email, made from
 * the identity rather than saved by the user, and is not an address to bring in.
 */
const RECORD_TYPE_ACCOUNT_NAME_EMAIL = 4

/** The tables each shape is known by, and the token-table pairs the token shapes read. */
export const CHROMIUM_ADDRESS_TABLES = {
  unified: { rows: 'addresses', tokens: 'address_type_tokens' },
  local: { rows: 'local_addresses', tokens: 'local_addresses_type_tokens' },
  account: { rows: 'contact_info', tokens: 'contact_info_type_tokens' },
  legacy: {
    rows: 'autofill_profiles',
    names: 'autofill_profile_names',
    emails: 'autofill_profile_emails',
    phones: 'autofill_profile_phones'
  }
} as const

export type ChromiumAddressSchema = 'unified' | 'split' | 'legacy'

/**
 * A `Web Data` whose address tables are none of the three shapes (not Chromium's, or newer than
 * this reader). The message is the reason `readFailure` appends to its "Could not read
 * <browser>'s Web Data:" line.
 */
export class ChromiumAddressesError extends Error {
  constructor() {
    super('the addresses are kept in a form this version of Zenium does not know.')
    this.name = 'ChromiumAddressesError'
  }
}

export interface ImportedAddresses {
  addresses: AddressInput[]
  /** Rows with nothing in any field the vault keeps. */
  invalid: number
  schema: ChromiumAddressSchema
}

/**
 * Which shape the database has, by the tables present; null when none of the three is there.
 * Either token pair makes `split` – between schema 107 and 112 only the account's is there, the
 * profile's own addresses still in the legacy tables beside it.
 */
export function detectChromiumAddressSchema(db: ImportDatabase): ChromiumAddressSchema | null {
  const tables = tableNames(db)
  const both = (pair: { rows: string; tokens: string }): boolean =>
    tables.has(pair.rows) && tables.has(pair.tokens)
  if (both(CHROMIUM_ADDRESS_TABLES.unified)) return 'unified'
  if (both(CHROMIUM_ADDRESS_TABLES.local) || both(CHROMIUM_ADDRESS_TABLES.account)) return 'split'
  if (tables.has(CHROMIUM_ADDRESS_TABLES.legacy.rows)) return 'legacy'
  return null
}

/**
 * Every saved address of the database as vault inputs, in the order the tables hold them (the
 * profile's own addresses before the account's where they are kept apart). Throws
 * `ChromiumAddressesError` when the schema is none it knows.
 */
export function chromiumAddresses(db: ImportDatabase): ImportedAddresses {
  const schema = detectChromiumAddressSchema(db)
  if (!schema) throw new ChromiumAddressesError()
  const out: ImportedAddresses = { addresses: [], invalid: 0, schema }
  const take = (address: AddressInput): void => {
    if (isEmpty(address)) out.invalid += 1
    else out.addresses.push(address)
  }
  if (schema === 'unified') {
    for (const address of tokenAddresses(db, CHROMIUM_ADDRESS_TABLES.unified, true)) take(address)
  } else if (schema === 'split') {
    const tables = tableNames(db)
    const has = (pair: { rows: string; tokens: string }): boolean =>
      tables.has(pair.rows) && tables.has(pair.tokens)
    // The profile's own addresses first: `local_addresses` from schema 113; before it, the legacy
    // columns beside the account's pair. At 113 both are there and the legacy rows are the copies
    // the migration made, so they are read through the new pair alone.
    if (has(CHROMIUM_ADDRESS_TABLES.local)) {
      for (const address of tokenAddresses(db, CHROMIUM_ADDRESS_TABLES.local, false)) take(address)
    } else if (tables.has(CHROMIUM_ADDRESS_TABLES.legacy.rows)) {
      for (const address of legacyAddresses(db)) take(address)
    }
    if (has(CHROMIUM_ADDRESS_TABLES.account)) {
      for (const address of tokenAddresses(db, CHROMIUM_ADDRESS_TABLES.account, false))
        take(address)
    }
  } else {
    for (const address of legacyAddresses(db)) take(address)
  }
  return out
}

// ---------------------------------------------------------------------------
// The token shapes
// ---------------------------------------------------------------------------

function tokenAddresses(
  db: ImportDatabase,
  pair: { rows: string; tokens: string },
  hasRecordType: boolean
): AddressInput[] {
  const tokens = new Map<string, Map<number, string>>()
  for (const row of db.all(`SELECT guid, type, value FROM "${pair.tokens}"`)) {
    const guid = text(row.guid)
    if (!guid) continue
    let fields = tokens.get(guid)
    if (!fields) {
      fields = new Map()
      tokens.set(guid, fields)
    }
    fields.set(Number(row.type), text(row.value))
  }
  const out: AddressInput[] = []
  const columns = hasRecordType ? 'guid, record_type' : 'guid'
  for (const row of db.all(`SELECT ${columns} FROM "${pair.rows}" ORDER BY rowid`)) {
    if (hasRecordType && Number(row.record_type) === RECORD_TYPE_ACCOUNT_NAME_EMAIL) continue
    const fields = tokens.get(text(row.guid)) ?? new Map<number, string>()
    const field = (type: number): string => fields.get(type) ?? ''
    out.push({
      country: field(FIELD_TYPE.ADDRESS_HOME_COUNTRY),
      name: fullName(
        field(FIELD_TYPE.NAME_FULL),
        field(FIELD_TYPE.NAME_FIRST),
        field(FIELD_TYPE.NAME_MIDDLE),
        field(FIELD_TYPE.NAME_LAST)
      ),
      organization: field(FIELD_TYPE.COMPANY_NAME),
      streetAddress: field(FIELD_TYPE.ADDRESS_HOME_STREET_ADDRESS),
      locality: field(FIELD_TYPE.ADDRESS_HOME_CITY),
      region: field(FIELD_TYPE.ADDRESS_HOME_STATE),
      postalCode: field(FIELD_TYPE.ADDRESS_HOME_ZIP),
      sortingCode: field(FIELD_TYPE.ADDRESS_HOME_SORTING_CODE),
      phone: field(FIELD_TYPE.PHONE_HOME_WHOLE_NUMBER),
      email: field(FIELD_TYPE.EMAIL_ADDRESS)
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The legacy shape
// ---------------------------------------------------------------------------

function legacyAddresses(db: ImportDatabase): AddressInput[] {
  const { legacy } = CHROMIUM_ADDRESS_TABLES
  const tables = tableNames(db)
  // One row per guid in each side table (Chromium reads the first it finds); the tables of a
  // very old profile may be missing one by one.
  const firstByGuid = (table: string): Map<string, Record<string, unknown>> => {
    const rows = new Map<string, Record<string, unknown>>()
    if (!tables.has(table)) return rows
    for (const row of db.all(`SELECT * FROM "${table}" ORDER BY rowid`)) {
      const guid = text(row.guid)
      if (guid && !rows.has(guid)) rows.set(guid, row)
    }
    return rows
  }
  const names = firstByGuid(legacy.names)
  const emails = firstByGuid(legacy.emails)
  const phones = firstByGuid(legacy.phones)
  const out: AddressInput[] = []
  for (const row of db.all(`SELECT * FROM "${legacy.rows}" ORDER BY rowid`)) {
    const guid = text(row.guid)
    const name = names.get(guid) ?? {}
    out.push({
      country: text(row.country_code),
      name: fullName(
        text(name.full_name),
        text(name.first_name),
        text(name.middle_name),
        text(name.last_name)
      ),
      organization: text(row.company_name),
      streetAddress: text(row.street_address),
      locality: text(row.city),
      region: text(row.state),
      postalCode: text(row.zipcode),
      sortingCode: text(row.sorting_code),
      phone: text(phones.get(guid)?.number),
      email: text(emails.get(guid)?.email)
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

/**
 * The key two addresses are the same by: name, street address, postal code and country, each as
 * the vault would keep it (`clipAddress`: the country its two upper-case letters, the rest
 * trimmed and cut to the vault's field length), then case-folded with its runs of white space
 * collapsed. The rest of the fields may differ between two records of one address (a phone
 * added, a company left off) and still name the same place for the same person. The vault's
 * entries are already clipped, so an entry that would land clipped has to be keyed clipped to
 * meet its twin there; the address itself is handed on unclipped – the store clips on add.
 */
export function addressKey(address: AddressInput): string {
  const clipped = clipAddress(address)
  const fold = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ')
  return [clipped.name, clipped.streetAddress, clipped.postalCode, clipped.country]
    .map(fold)
    .join('\n')
}

/**
 * The imported addresses not already in the vault and not seen earlier in the same import, with
 * the count of those that were (the outcome's `duplicates`).
 */
export function dedupeAddresses(
  existing: readonly AddressInput[],
  incoming: readonly AddressInput[]
): { addresses: AddressInput[]; duplicates: number } {
  const seen = new Set(existing.map(addressKey))
  const addresses: AddressInput[] = []
  let duplicates = 0
  for (const address of incoming) {
    const key = addressKey(address)
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    addresses.push(address)
  }
  return { addresses, duplicates }
}

// ---------------------------------------------------------------------------

function tableNames(db: ImportDatabase): Set<string> {
  return new Set(
    db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => text(row.name))
  )
}

/** The full name as stored, else the parts joined (a profile saved before Chromium kept the whole). */
function fullName(full: string, first: string, middle: string, last: string): string {
  if (full.trim()) return full
  return [first, middle, last]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isEmpty(address: AddressInput): boolean {
  return Object.values(address).every((value) => value.trim() === '')
}
