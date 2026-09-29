import { describe, expect, it } from 'vitest'
import type { AddressInput } from '../../../shared/types'
import {
  ChromiumAddressesError,
  addressKey,
  chromiumAddresses,
  dedupeAddresses,
  detectChromiumAddressSchema
} from '../chromiumAddresses'
import {
  chromiumLegacyAddressTables,
  chromiumWebDataSchema,
  insertChromiumAddresses,
  memoryDatabase,
  type ChromiumAddressRow,
  type ChromiumAddressShape
} from './helpers'

/*
 * `Web Data`'s saved addresses (ID-57) in the shapes Chromium has kept them in: the unified
 * `addresses` + `address_type_tokens` of today's Chrome, the split local/account pairs before
 * it (with the 107–112 layout that had the account's pair beside the old columns), the
 * `autofill_profiles*` columns of old. Each reads to the same vault inputs; the account's
 * name-and-email record is no address; a shape the reader does not know is refused, not read
 * as empty.
 */

const HOME: ChromiumAddressRow = {
  guid: '0b1c2d3e-0000-4000-8000-000000000001',
  recordType: 0,
  fields: {
    NAME_FULL: 'Bennett Buhner',
    NAME_FIRST: 'Bennett',
    NAME_LAST: 'Buhner',
    COMPANY_NAME: 'Zenium',
    ADDRESS_HOME_STREET_ADDRESS: '1 Infinite Loop\nSuite 4',
    ADDRESS_HOME_CITY: 'Cupertino',
    ADDRESS_HOME_STATE: 'CA',
    ADDRESS_HOME_ZIP: '95014',
    ADDRESS_HOME_COUNTRY: 'US',
    PHONE_HOME_WHOLE_NUMBER: '+1 408-555-0100',
    EMAIL_ADDRESS: 'bennett@example.com',
    ADDRESS_HOME_DEPENDENT_LOCALITY: 'Monta Vista'
  }
}

/** A profile saved before Chromium kept the whole name: the parts only. */
const PARTS: ChromiumAddressRow = {
  guid: '0b1c2d3e-0000-4000-8000-000000000002',
  recordType: 0,
  fields: {
    NAME_FIRST: 'Ada',
    NAME_MIDDLE: 'King',
    NAME_LAST: 'Lovelace',
    ADDRESS_HOME_STREET_ADDRESS: '12 St James’s Square',
    ADDRESS_HOME_CITY: 'London',
    ADDRESS_HOME_ZIP: 'SW1Y 4LB',
    ADDRESS_HOME_COUNTRY: 'GB',
    ADDRESS_HOME_SORTING_CODE: 'CEDEX 9'
  }
}

const HOME_ADDRESS: AddressInput = {
  country: 'US',
  name: 'Bennett Buhner',
  organization: 'Zenium',
  streetAddress: '1 Infinite Loop\nSuite 4',
  locality: 'Cupertino',
  region: 'CA',
  postalCode: '95014',
  sortingCode: '',
  phone: '+1 408-555-0100',
  email: 'bennett@example.com'
}

const PARTS_ADDRESS: AddressInput = {
  country: 'GB',
  name: 'Ada King Lovelace',
  organization: '',
  streetAddress: '12 St James’s Square',
  locality: 'London',
  region: '',
  postalCode: 'SW1Y 4LB',
  sortingCode: 'CEDEX 9',
  phone: '',
  email: ''
}

function webData(
  shape: ChromiumAddressShape,
  rows: ChromiumAddressRow[]
): ReturnType<typeof memoryDatabase> {
  return memoryDatabase((db) => {
    chromiumWebDataSchema(db, shape)
    insertChromiumAddresses(db, shape, rows)
  })
}

describe('chromiumAddresses', () => {
  it.each<ChromiumAddressShape>(['unified', 'split', 'transitional', 'legacy'])(
    'reads the %s shape into the vault’s fields, the name from the parts when the whole is missing, dependent locality left out',
    (shape) => {
      const db = webData(shape, [HOME, PARTS])
      const schema = shape === 'transitional' ? 'split' : shape
      expect(detectChromiumAddressSchema(db)).toBe(schema)
      const read = chromiumAddresses(db)
      expect(read.schema).toBe(schema)
      expect(read.invalid).toBe(0)
      expect(read.addresses).toEqual([HOME_ADDRESS, PARTS_ADDRESS])
    }
  )

  it('the unified shape: account addresses come in, the account’s name-and-email record does not, an empty row counts as unusable', () => {
    const db = webData('unified', [
      { ...HOME, recordType: 1 },
      {
        guid: '0b1c2d3e-0000-4000-8000-000000000009',
        recordType: 4,
        fields: { NAME_FULL: 'Bennett Buhner', EMAIL_ADDRESS: 'bennett@example.com' }
      },
      { guid: '0b1c2d3e-0000-4000-8000-000000000010', recordType: 0, fields: {} },
      { ...PARTS, recordType: 2 }
    ])
    const read = chromiumAddresses(db)
    expect(read.addresses).toEqual([HOME_ADDRESS, PARTS_ADDRESS])
    expect(read.invalid).toBe(1)
  })

  it('the split shape: the profile’s own addresses first, then the account’s; one pair alone still reads', () => {
    const both = webData('split', [
      { ...PARTS, recordType: 1 },
      { ...HOME, recordType: 0 }
    ])
    expect(chromiumAddresses(both).addresses).toEqual([HOME_ADDRESS, PARTS_ADDRESS])

    const accountOnly = memoryDatabase((db) => {
      chromiumWebDataSchema(db, 'split')
      db.exec('DROP TABLE local_addresses; DROP TABLE local_addresses_type_tokens;')
      insertChromiumAddresses(db, 'split', [{ ...HOME, recordType: 1 }])
    })
    expect(detectChromiumAddressSchema(accountOnly)).toBe('split')
    expect(chromiumAddresses(accountOnly).addresses).toEqual([HOME_ADDRESS])
  })

  it('schema 107–112: the account’s pair beside the profile’s own still in autofill_profiles – both read, the profile’s first; at 113 the copied legacy rows are not read again', () => {
    const between = webData('transitional', [
      { ...PARTS, recordType: 1 },
      { ...HOME, recordType: 0 }
    ])
    expect(detectChromiumAddressSchema(between)).toBe('split')
    expect(chromiumAddresses(between)).toEqual({
      schema: 'split',
      invalid: 0,
      addresses: [HOME_ADDRESS, PARTS_ADDRESS]
    })

    // `…113MigrateLocalAddressProfilesToNewTable` copies the rows into `local_addresses`; the
    // legacy tables stay, filled, until `…114DropLegacyAddressTables`.
    const at113 = memoryDatabase((native) => {
      chromiumWebDataSchema(native, 'split')
      insertChromiumAddresses(native, 'split', [HOME, { ...PARTS, recordType: 1 }])
      chromiumLegacyAddressTables(native)
      insertChromiumAddresses(native, 'legacy', [HOME])
    })
    expect(chromiumAddresses(at113).addresses).toEqual([HOME_ADDRESS, PARTS_ADDRESS])
  })

  it('the legacy shape: a side table missing reads as its fields empty, the first row per guid counts', () => {
    const db = memoryDatabase((native) => {
      chromiumWebDataSchema(native, 'legacy')
      insertChromiumAddresses(native, 'legacy', [HOME])
      native
        .prepare('INSERT INTO autofill_profile_phones(guid, number) VALUES (?, ?)')
        .run(HOME.guid, '+1 408-555-0199')
      native.exec('DROP TABLE autofill_profile_emails')
    })
    expect(chromiumAddresses(db).addresses).toEqual([{ ...HOME_ADDRESS, email: '' }])
  })

  it('refuses a Web Data whose address tables are none it knows instead of reading nothing', () => {
    const db = memoryDatabase((native) => {
      native.exec(`CREATE TABLE autofill(name VARCHAR, value VARCHAR);
        CREATE TABLE credit_cards(guid VARCHAR PRIMARY KEY, name_on_card VARCHAR);
        CREATE TABLE addresses_v2(guid VARCHAR PRIMARY KEY);`)
    })
    expect(detectChromiumAddressSchema(db)).toBeNull()
    expect(() => chromiumAddresses(db)).toThrow(ChromiumAddressesError)
    expect(() => chromiumAddresses(db)).toThrow(
      'the addresses are kept in a form this version of Zenium does not know.'
    )
  })
})

describe('dedupeAddresses', () => {
  it('keys an address by name, street, postal code and country, folded', () => {
    expect(
      addressKey({
        ...HOME_ADDRESS,
        name: '  bennett   BUHNER ',
        streetAddress: '1 infinite loop\n suite 4',
        postalCode: '95014 ',
        country: 'us',
        phone: '',
        organization: ''
      })
    ).toBe(addressKey(HOME_ADDRESS))
    expect(addressKey({ ...HOME_ADDRESS, postalCode: '95015' })).not.toBe(addressKey(HOME_ADDRESS))
  })

  it('leaves out what the vault holds and what came earlier in the same import, counting both', () => {
    const vault = [{ ...HOME_ADDRESS, phone: '' }]
    const incoming = [
      HOME_ADDRESS,
      PARTS_ADDRESS,
      { ...PARTS_ADDRESS, organization: 'Analytical Engines' }
    ]
    expect(dedupeAddresses(vault, incoming)).toEqual({ addresses: [PARTS_ADDRESS], duplicates: 2 })
    expect(dedupeAddresses([], [])).toEqual({ addresses: [], duplicates: 0 })
  })
})
