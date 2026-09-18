import { describe, expect, it } from 'vitest'
import type { AddressInput } from '../../../shared/types'
import {
  addressComplete,
  addressFormat,
  addressFromForm,
  addressPreview,
  addressToForm,
  countries,
  countryName,
  countryRules,
  defaultCountry,
  extendsAddress,
  fieldOrder,
  formatAddress,
  normalizeCountry,
  postalCodeValid,
  regionName,
  requiredFields,
  resolveCountry,
  resolveRegion,
  sameAddress
} from '../address'

function address(overrides: Partial<AddressInput> = {}): AddressInput {
  return {
    country: 'US',
    name: 'Ada Lovelace',
    organization: '',
    streetAddress: '1600 Amphitheatre Pkwy',
    locality: 'Mountain View',
    region: 'CA',
    postalCode: '94043',
    sortingCode: '',
    phone: '',
    email: '',
    ...overrides
  }
}

describe('country metadata', () => {
  it('fills the libaddressinput defaults in for countries without their own rules', () => {
    const rules = countryRules('AQ')
    expect(rules.fmt).toBe('%N%n%O%n%A%n%C')
    expect(rules.require).toBe('AC')
    expect(rules.zip).toBeNull()
    expect(rules.regions).toEqual([])
    expect(countryRules('not a country')).toEqual(countryRules('ZZ'))
  })

  it('reads the region lists with keys and names', () => {
    const us = countryRules('us')
    expect(us.zipType).toBe('zip')
    expect(us.stateType).toBe('state')
    expect(us.regions.find((r) => r.key === 'CA')).toEqual({ key: 'CA', name: 'California' })
    // Ireland's counties have no separate key.
    expect(countryRules('IE').regions[0]).toEqual({ key: 'Co. Carlow', name: 'Co. Carlow' })
  })

  it('knows every country by code and lists them by name', () => {
    expect(normalizeCountry(' de ')).toBe('DE')
    expect(normalizeCountry('XX')).toBeNull()
    expect(normalizeCountry('Germany')).toBeNull()
    expect(countryName('de')).toBe('Germany')
    expect(countryName('XX')).toBe('XX')
    const list = countries()
    expect(list.length).toBeGreaterThan(200)
    expect(list.map((c) => c.name)).toEqual(
      [...list.map((c) => c.name)].sort((a, b) => a.localeCompare(b))
    )
  })
})

describe('resolveCountry', () => {
  it('accepts codes, alpha-3 codes, English names, aliases and select value|label pairs', () => {
    expect(resolveCountry('US')).toBe('US')
    expect(resolveCountry('usa')).toBe('US')
    expect(resolveCountry('United States')).toBe('US')
    expect(resolveCountry('UK')).toBe('GB')
    expect(resolveCountry('The Netherlands')).toBe('NL')
    expect(resolveCountry('Deutschland')).toBe('DE')
    expect(resolveCountry('Côte d’Ivoire')).toBe('CI')
    expect(resolveCountry('DEU')).toBe('DE')
    expect(resolveCountry('223|Germany')).toBe('DE')
    expect(resolveCountry('GB|United Kingdom')).toBe('GB')
    expect(resolveCountry('Bosnia & Herzegovina')).toBe('BA')
  })

  it('returns null for what it cannot place', () => {
    expect(resolveCountry('Mars')).toBeNull()
    expect(resolveCountry('')).toBeNull()
    expect(resolveCountry('12|Please choose')).toBeNull()
  })
})

describe('defaultCountry', () => {
  it('takes the region of the first locale that has one, else the US', () => {
    expect(defaultCountry(['en-GB', 'en'])).toBe('GB')
    expect(defaultCountry(['de', 'de-AT'])).toBe('AT')
    expect(defaultCountry(['zh-Hant-TW'])).toBe('TW')
    expect(defaultCountry(['en', 'fr'])).toBe('US')
    expect(defaultCountry([])).toBe('US')
    expect(defaultCountry(['en-XX'])).toBe('US')
  })
})

describe('regions', () => {
  it('resolves what a form reported to the metadata key where the country has a list', () => {
    expect(resolveRegion('US', 'California')).toBe('CA')
    expect(resolveRegion('US', 'ca')).toBe('CA')
    expect(resolveRegion('US', 'CA|California')).toBe('CA')
    expect(resolveRegion('US', '5|California')).toBe('CA')
    expect(resolveRegion('AE', 'Dubai')).toBe('إمارة دبيّ')
    // No list: the text stays as typed.
    expect(resolveRegion('DE', 'Bayern')).toBe('Bayern')
    expect(resolveRegion('US', '')).toBe('')
    // Unknown to the list: the first spelling is kept rather than lost.
    expect(resolveRegion('US', 'Atlantis')).toBe('Atlantis')
  })

  it('names a key and leaves unknown keys alone', () => {
    expect(regionName('US', 'CA')).toBe('California')
    expect(regionName('US', 'Atlantis')).toBe('Atlantis')
    expect(regionName('DE', 'Bayern')).toBe('Bayern')
  })
})

describe('fields per country', () => {
  it('orders the fields by the country format and always includes a name line', () => {
    expect(fieldOrder('US')).toEqual([
      'name',
      'organization',
      'streetAddress',
      'locality',
      'region',
      'postalCode'
    ])
    expect(fieldOrder('DE')).toEqual([
      'name',
      'organization',
      'streetAddress',
      'postalCode',
      'locality'
    ])
    // Japan writes the name last; the format decides, not a fixed order.
    expect(fieldOrder('JP')).toEqual([
      'postalCode',
      'region',
      'streetAddress',
      'organization',
      'name'
    ])
    expect(fieldOrder('AQ')).toEqual(['name', 'organization', 'streetAddress', 'locality'])
  })

  it('reads the required letters', () => {
    expect([...requiredFields('US')].sort()).toEqual([
      'locality',
      'postalCode',
      'region',
      'streetAddress'
    ])
    expect([...requiredFields('DE')].sort()).toEqual(['locality', 'postalCode', 'streetAddress'])
    expect([...requiredFields('AE')].sort()).toEqual(['region', 'streetAddress'])
  })

  it('describes the manager form with country-specific labels and region options', () => {
    const us = addressFormat('US')
    expect(us.country).toBe('US')
    expect(us.countryName).toBe('United States')
    expect(us.fields.map((f) => f.field)).toEqual([
      'country',
      'name',
      'organization',
      'streetAddress',
      'locality',
      'region',
      'postalCode',
      'phone',
      'email'
    ])
    const region = us.fields.find((f) => f.field === 'region')
    expect(region?.label).toBe('State')
    expect(region?.required).toBe(true)
    expect(region?.options?.some((o) => o.key === 'NY' && o.name === 'New York')).toBe(true)
    expect(us.fields.find((f) => f.field === 'postalCode')?.label).toBe('ZIP code')
    expect(us.postalCodeExamples).toEqual(['95014', '22162-1010'])

    const gb = addressFormat('GB')
    expect(gb.fields.find((f) => f.field === 'locality')?.label).toBe('Post town')
    expect(gb.fields.find((f) => f.field === 'postalCode')?.label).toBe('Postal code')
    expect(gb.fields.some((f) => f.field === 'region')).toBe(false)
    expect(addressFormat('IE').fields.find((f) => f.field === 'postalCode')?.label).toBe('Eircode')
    expect(addressFormat('IE').fields.find((f) => f.field === 'region')?.label).toBe('County')
    expect(addressFormat('JP').fields.find((f) => f.field === 'region')?.label).toBe('Prefecture')
    // An unknown country falls back to the US form rather than an empty one.
    expect(addressFormat('??').country).toBe('US')
  })
})

describe('postalCodeValid', () => {
  it('checks the country pattern, whole and case-insensitively, and accepts anything without one', () => {
    expect(postalCodeValid('US', '94043')).toBe(true)
    expect(postalCodeValid('US', '94043-1234')).toBe(true)
    expect(postalCodeValid('US', '9404')).toBe(false)
    expect(postalCodeValid('US', '94043x')).toBe(false)
    expect(postalCodeValid('GB', 'EC1Y 8SY')).toBe(true)
    expect(postalCodeValid('GB', 'ec1y 8sy')).toBe(true)
    expect(postalCodeValid('GB', '12345')).toBe(false)
    expect(postalCodeValid('CA', 'H3Z 2Y7')).toBe(true)
    expect(postalCodeValid('DE', ' 26133 ')).toBe(true)
    expect(postalCodeValid('AE', 'anything')).toBe(true)
  })
})

describe('addressComplete', () => {
  it('needs the required fields of the country', () => {
    expect(addressComplete(address())).toBe(true)
    expect(addressComplete(address({ region: '' }))).toBe(false)
    expect(addressComplete(address({ country: 'DE', region: '' }))).toBe(true)
    expect(addressComplete(address({ country: 'DE', postalCode: ' ' }))).toBe(false)
  })
})

describe('formatAddress', () => {
  it('prints a US address in the country format with the state code as stored', () => {
    expect(formatAddress(address())).toEqual([
      'Ada Lovelace',
      '1600 Amphitheatre Pkwy',
      'Mountain View, CA 94043',
      'United States'
    ])
  })

  it('follows the country format and puts a multi-line street on its own lines', () => {
    expect(
      formatAddress(
        address({
          country: 'DE',
          streetAddress: 'Platz der Republik 1\nHinterhaus',
          locality: 'Berlin',
          region: '',
          postalCode: '11011'
        })
      )
    ).toEqual(['Ada Lovelace', 'Platz der Republik 1', 'Hinterhaus', '11011 Berlin', 'Germany'])
    expect(
      formatAddress(
        address({ country: 'CA', locality: 'Toronto', region: 'ON', postalCode: 'M5H 2N2' }),
        {
          name: false,
          country: false
        }
      )
    ).toEqual(['1600 Amphitheatre Pkwy', 'Toronto ON M5H 2N2'])
  })

  it('leaves the name and country out on request and skips empty lines', () => {
    expect(
      formatAddress(address({ organization: 'Google' }), { name: false, country: false })
    ).toEqual(['Google', '1600 Amphitheatre Pkwy', 'Mountain View, CA 94043'])
  })

  it('upper-cases the country’s envelope fields only when asked', () => {
    expect(formatAddress(address(), { upper: true })).toEqual([
      'Ada Lovelace',
      '1600 Amphitheatre Pkwy',
      'MOUNTAIN VIEW, CA 94043',
      'United States'
    ])
    expect(
      formatAddress(
        address({ country: 'CA', locality: 'Toronto', region: 'ON', postalCode: 'M5H 2N2' }),
        {
          country: false,
          upper: true
        }
      )
    ).toEqual(['ADA LOVELACE', '1600 AMPHITHEATRE PKWY', 'TORONTO ON M5H 2N2'])
  })

  it('keeps a name line for countries whose format has none, and the format’s fixed text', () => {
    expect(countryRules('ZZ').fmt).toContain('%N')
    expect(formatAddress(address({ country: 'AQ', region: '', postalCode: '' }))).toEqual([
      'Ada Lovelace',
      '1600 Amphitheatre Pkwy',
      'Mountain View',
      'Antarctica'
    ])
    expect(
      formatAddress(
        address({
          country: 'JP',
          name: '山田太郎',
          streetAddress: '1-2-3',
          locality: '',
          region: '東京都',
          postalCode: '100-0001'
        }),
        { country: false }
      )
    ).toEqual(['〒100-0001', '東京都', '1-2-3', '山田太郎'])
  })

  it('previews on one line', () => {
    expect(addressPreview(address())).toBe('1600 Amphitheatre Pkwy, Mountain View, CA 94043')
  })
})

describe('comparing addresses', () => {
  it('ignores case, spacing and punctuation but not the content', () => {
    expect(
      sameAddress(
        address(),
        address({ streetAddress: '1600 amphitheatre pkwy.', locality: 'MOUNTAIN VIEW' })
      )
    ).toBe(true)
    expect(sameAddress(address(), address({ streetAddress: '1601 Amphitheatre Pkwy' }))).toBe(false)
    expect(sameAddress(address(), address({ name: 'Bob' }))).toBe(false)
    // Phone and email are details, not identity.
    expect(sameAddress(address(), address({ phone: '+1 650 253 0000' }))).toBe(true)
  })

  it('says when a submitted address brings details the saved one lacks', () => {
    const saved = address()
    expect(extendsAddress(address({ phone: '+1 650 253 0000' }), saved)).toBe(true)
    expect(extendsAddress(address({ email: 'ada@example.com' }), saved)).toBe(true)
    expect(extendsAddress(address(), saved)).toBe(false)
    expect(extendsAddress(address({ phone: '1', streetAddress: 'elsewhere' }), saved)).toBe(false)
  })
})

describe('addressFromForm', () => {
  it('assembles an address from autocomplete-style fields and resolves the country and region', () => {
    expect(
      addressFromForm(
        {
          'given-name': 'Ada',
          'family-name': 'Lovelace',
          'address-line1': '1600 Amphitheatre Pkwy',
          'address-line2': 'Building 43',
          'address-level2': 'Mountain View',
          'address-level1': 'California',
          'postal-code': '94043',
          country: 'US|United States',
          tel: '+1 650 253 0000',
          email: 'ada@example.com'
        },
        'GB'
      )
    ).toEqual({
      country: 'US',
      name: 'Ada Lovelace',
      organization: '',
      streetAddress: '1600 Amphitheatre Pkwy\nBuilding 43',
      locality: 'Mountain View',
      region: 'CA',
      postalCode: '94043',
      sortingCode: '',
      phone: '+1 650 253 0000',
      email: 'ada@example.com'
    })
  })

  it('falls back to the device country and a plain street field, and takes a select’s value for the city', () => {
    const a = addressFromForm(
      {
        name: 'Ada',
        'street-address': 'Platz der Republik 1',
        'address-level2': 'berlin|Berlin',
        'postal-code': '11011'
      },
      'de'
    )
    expect(a).toMatchObject({
      country: 'DE',
      streetAddress: 'Platz der Republik 1',
      locality: 'berlin',
      postalCode: '11011'
    })
    expect(addressFromForm({ 'street-address': 'x', 'postal-code': '1' }, 'nowhere')?.country).toBe(
      'US'
    )
  })

  it('refuses forms without a street or without both city and postal code', () => {
    expect(addressFromForm({ 'address-level2': 'Berlin', 'postal-code': '11011' }, 'DE')).toBeNull()
    expect(addressFromForm({ 'street-address': 'Platz der Republik 1' }, 'DE')).toBeNull()
    expect(
      addressFromForm({ 'street-address': 'Platz der Republik 1', 'postal-code': '11011' }, 'DE')
    ).not.toBeNull()
  })
})

describe('addressToForm', () => {
  it('spreads an address over every field spelling a page may use, with select labels', () => {
    const { values, labels } = addressToForm(
      address({ streetAddress: 'Line 1\nLine 2\nLine 3', phone: '555' })
    )
    expect(values).toEqual({
      name: 'Ada Lovelace',
      'given-name': 'Ada',
      'family-name': 'Lovelace',
      'street-address': 'Line 1\nLine 2\nLine 3',
      'address-line1': 'Line 1',
      'address-line2': 'Line 2, Line 3',
      'address-level2': 'Mountain View',
      'address-level1': 'CA',
      'postal-code': '94043',
      country: 'US',
      tel: '555'
    })
    expect(labels).toEqual({ countryName: 'United States', regionName: 'California' })
  })

  it('leaves empty fields out so a fill does not blank what the user typed', () => {
    const { values } = addressToForm(address({ name: '', organization: '' }))
    expect(values).not.toHaveProperty('name')
    expect(values).not.toHaveProperty('given-name')
    expect(values).not.toHaveProperty('organization')
  })
})
