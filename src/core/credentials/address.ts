import type {
  AddressEntry,
  AddressFieldSpec,
  AddressFormat,
  AddressInput
} from '../../shared/types'
import type { FormValues } from '../../shared/forms'
import {
  ADDRESS_DEFAULTS,
  COUNTRY_METADATA,
  COUNTRY_NAMES,
  type CountryMetadata
} from './data/addressMetadata'

/**
 * Country-aware addresses on top of the bundled libaddressinput metadata: which fields a country
 * uses and in which order (the manager's form and the printed address), what they are called,
 * which are required, the region lists, postal-code checks, and the two-way mapping between an
 * address and the fields of a web form.
 */

/** Format letters → address fields. `%D` (dependent locality) is not modelled and is dropped. */
const TOKEN_FIELDS: Record<string, keyof AddressInput> = {
  N: 'name',
  O: 'organization',
  A: 'streetAddress',
  C: 'locality',
  S: 'region',
  Z: 'postalCode',
  X: 'sortingCode'
}

const FIELD_TOKENS: Partial<Record<keyof AddressInput, string>> = {
  name: 'N',
  organization: 'O',
  streetAddress: 'A',
  locality: 'C',
  region: 'S',
  postalCode: 'Z',
  sortingCode: 'X'
}

const POSTAL_LABELS: Record<string, string> = {
  postal: 'Postal code',
  zip: 'ZIP code',
  pin: 'PIN code',
  eircode: 'Eircode'
}

const REGION_LABELS: Record<string, string> = {
  province: 'Province',
  state: 'State',
  county: 'County',
  prefecture: 'Prefecture',
  area: 'Area',
  department: 'Department',
  district: 'District',
  do_si: 'Do / Si',
  emirate: 'Emirate',
  island: 'Island',
  oblast: 'Oblast',
  parish: 'Parish',
  region: 'Region'
}

const LOCALITY_LABELS: Record<string, string> = {
  city: 'City',
  district: 'District',
  post_town: 'Post town',
  suburb: 'Suburb'
}

const FIXED_LABELS: Partial<Record<keyof AddressInput, string>> = {
  name: 'Name',
  organization: 'Organization',
  streetAddress: 'Street address',
  sortingCode: 'Sorting code',
  phone: 'Phone',
  email: 'Email',
  country: 'Country'
}

export interface CountryRules {
  fmt: string
  require: string
  upper: string
  zip: string | null
  zipex: string[]
  zipType: string
  stateType: string
  cityType: string
  regions: { key: string; name: string }[]
}

const rulesCache = new Map<string, CountryRules>()

/** The metadata of a country with the defaults filled in; unknown countries get the defaults. */
export function countryRules(country: string): CountryRules {
  const code = normalizeCountry(country) ?? 'ZZ'
  const cached = rulesCache.get(code)
  if (cached) return cached
  const meta: CountryMetadata = COUNTRY_METADATA[code] ?? {}
  const rules: CountryRules = {
    fmt: meta.fmt ?? ADDRESS_DEFAULTS.fmt,
    require: meta.require ?? ADDRESS_DEFAULTS.require,
    upper: meta.upper ?? ADDRESS_DEFAULTS.upper,
    zip: meta.zip ?? null,
    zipex: meta.zipex ? meta.zipex.split(',') : [],
    zipType: meta.zipType ?? ADDRESS_DEFAULTS.zip_name_type,
    stateType: meta.stateType ?? ADDRESS_DEFAULTS.state_name_type,
    cityType: meta.cityType ?? ADDRESS_DEFAULTS.locality_name_type,
    regions: (meta.regions ?? []).map((entry) => {
      const eq = entry.indexOf('=')
      return eq >= 0
        ? { key: entry.slice(0, eq), name: entry.slice(eq + 1) }
        : { key: entry, name: entry }
    })
  }
  rulesCache.set(code, rules)
  return rules
}

let countryList: { code: string; name: string }[] | null = null

/** Every country of the metadata, sorted by English name. */
export function countries(): { code: string; name: string }[] {
  countryList ??= Object.entries(COUNTRY_NAMES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return countryList
}

export function countryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase()
}

/** A two-letter code the metadata knows, or null. */
export function normalizeCountry(text: string): string | null {
  const code = text.trim().toUpperCase()
  return code.length === 2 && code in COUNTRY_NAMES ? code : null
}

/** Spellings pages use that the display names do not cover. */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US',
  'united states of america': 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  america: 'US',
  uk: 'GB',
  'united kingdom': 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  deutschland: 'DE',
  'the netherlands': 'NL',
  holland: 'NL',
  'south korea': 'KR',
  'republic of korea': 'KR',
  korea: 'KR',
  russia: 'RU',
  'russian federation': 'RU',
  'czech republic': 'CZ',
  'viet nam': 'VN',
  'hong kong sar': 'HK',
  'macau': 'MO',
  'ivory coast': 'CI',
  'cote d’ivoire': 'CI',
  "cote d'ivoire": 'CI',
  'republic of ireland': 'IE',
  'united arab emirates': 'AE',
  uae: 'AE',
  'saudi arabia': 'SA',
  taiwan: 'TW',
  'republic of china': 'TW',
  "people's republic of china": 'CN',
  'mainland china': 'CN',
  eire: 'IE',
  'bosnia and herzegovina': 'BA',
  'antigua and barbuda': 'AG',
  'trinidad and tobago': 'TT',
  'saint kitts and nevis': 'KN',
  'st kitts and nevis': 'KN',
  'saint lucia': 'LC',
  'saint vincent and the grenadines': 'VC',
  'sao tome and principe': 'ST',
  'turks and caicos islands': 'TC',
  'wallis and futuna': 'WF',
  'svalbard and jan mayen': 'SJ',
  'heard island and mcdonald islands': 'HM',
  'south georgia and the south sandwich islands': 'GS',
  'congo (kinshasa)': 'CD',
  'democratic republic of the congo': 'CD',
  'congo (brazzaville)': 'CG',
  'republic of the congo': 'CG',
  myanmar: 'MM',
  burma: 'MM',
  'cabo verde': 'CV',
  'timor-leste': 'TL',
  'east timor': 'TL',
  eswatini: 'SZ',
  swaziland: 'SZ',
  'north macedonia': 'MK',
  macedonia: 'MK',
  'vatican city': 'VA',
  'holy see': 'VA',
  palestine: 'PS',
  'palestinian territories': 'PS',
  'brunei darussalam': 'BN',
  'lao people’s democratic republic': 'LA',
  laos: 'LA',
  'iran, islamic republic of': 'IR',
  'syrian arab republic': 'SY',
  'tanzania, united republic of': 'TZ',
  'moldova, republic of': 'MD',
  'bolivia, plurinational state of': 'BO',
  'venezuela, bolivarian republic of': 'VE',
  'micronesia, federated states of': 'FM'
}

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

let namesByFolded: Map<string, string> | null = null

/**
 * Resolve what a page reported for its country field: a code (`US`, `usa`), an English name
 * ("United States"), a common alias ("UK"), or the `value|label` pair of a `<select>`.
 */
export function resolveCountry(text: string): string | null {
  const parts = text.split('|').map((p) => p.trim()).filter(Boolean)
  for (const part of parts) {
    const code = normalizeCountry(part)
    if (code) return code
    const three = part.toUpperCase()
    if (three.length === 3 && three in ALPHA3) return ALPHA3[three]
  }
  namesByFolded ??= new Map(Object.entries(COUNTRY_NAMES).map(([code, name]) => [fold(name), code]))
  for (const part of parts) {
    const folded = fold(part)
    const alias = COUNTRY_ALIASES[folded] ?? COUNTRY_ALIASES[folded.replace(/^the /, '')]
    if (alias) return alias
    const byName = namesByFolded.get(folded) ?? namesByFolded.get(folded.replace(/^the /, ''))
    if (byName) return byName
  }
  return null
}

/** ISO 3166-1 alpha-3 codes pages sometimes use as option values. */
const ALPHA3: Record<string, string> = {
  USA: 'US',
  GBR: 'GB',
  CAN: 'CA',
  AUS: 'AU',
  DEU: 'DE',
  FRA: 'FR',
  ESP: 'ES',
  ITA: 'IT',
  NLD: 'NL',
  BEL: 'BE',
  CHE: 'CH',
  AUT: 'AT',
  SWE: 'SE',
  NOR: 'NO',
  DNK: 'DK',
  FIN: 'FI',
  IRL: 'IE',
  PRT: 'PT',
  POL: 'PL',
  CZE: 'CZ',
  JPN: 'JP',
  CHN: 'CN',
  KOR: 'KR',
  IND: 'IN',
  BRA: 'BR',
  MEX: 'MX',
  ARG: 'AR',
  ZAF: 'ZA',
  NZL: 'NZ',
  SGP: 'SG',
  HKG: 'HK',
  TWN: 'TW',
  RUS: 'RU',
  TUR: 'TR',
  ISR: 'IL',
  ARE: 'AE',
  SAU: 'SA',
  GRC: 'GR',
  HUN: 'HU',
  ROU: 'RO',
  UKR: 'UA',
  IDN: 'ID',
  MYS: 'MY',
  THA: 'TH',
  PHL: 'PH',
  VNM: 'VN',
  CHL: 'CL',
  COL: 'CO',
  PER: 'PE',
  EGY: 'EG',
  NGA: 'NG',
  KEN: 'KE',
  PAK: 'PK',
  BGD: 'BD',
  LUX: 'LU',
  ISL: 'IS',
  SVK: 'SK',
  SVN: 'SI',
  HRV: 'HR',
  BGR: 'BG',
  LTU: 'LT',
  LVA: 'LV',
  EST: 'EE'
}

/** The country to assume for a form without a country field, from the device's locales. */
export function defaultCountry(locales: readonly string[]): string {
  for (const locale of locales) {
    const m = /^[a-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2})\b/.exec(locale)
    if (m) {
      const code = normalizeCountry(m[1])
      if (code) return code
    }
  }
  return 'US'
}

export function regionsOf(country: string): { key: string; name: string }[] {
  return countryRules(country).regions
}

/**
 * Turn what a form reported for the region into the metadata key when the country has a list
 * (`California`, `ca`, `CA|California` → `CA`); other countries keep the text as typed.
 */
export function resolveRegion(country: string, text: string): string {
  const regions = regionsOf(country)
  const parts = text.split('|').map((p) => p.trim()).filter(Boolean)
  if (!regions.length) return parts[0] ?? ''
  for (const part of parts) {
    const upper = part.toUpperCase()
    const byKey = regions.find((r) => r.key.toUpperCase() === upper)
    if (byKey) return byKey.key
  }
  for (const part of parts) {
    const folded = fold(part)
    const byName = regions.find((r) => fold(r.name) === folded)
    if (byName) return byName.key
  }
  return parts[0] ?? ''
}

/** The display name of a region key (`CA` → `California`); the key itself when there is no list. */
export function regionName(country: string, key: string): string {
  return regionsOf(country).find((r) => r.key === key)?.name ?? key
}

function labelFor(field: keyof AddressInput, rules: CountryRules): string {
  switch (field) {
    case 'postalCode':
      return POSTAL_LABELS[rules.zipType] ?? POSTAL_LABELS.postal
    case 'region':
      return REGION_LABELS[rules.stateType] ?? REGION_LABELS.province
    case 'locality':
      return LOCALITY_LABELS[rules.cityType] ?? LOCALITY_LABELS.city
    default:
      return FIXED_LABELS[field] ?? field
  }
}

/** The address fields of a country in display order (from its format string). */
export function fieldOrder(country: string): (keyof AddressInput)[] {
  const rules = countryRules(country)
  const order: (keyof AddressInput)[] = []
  for (const m of rules.fmt.matchAll(/%([A-Z])/g)) {
    const field = TOKEN_FIELDS[m[1]]
    if (field && !order.includes(field)) order.push(field)
  }
  // Every country has a name line even where the format omits one (the manager needs it).
  if (!order.includes('name')) order.unshift('name')
  return order
}

/** Which fields a country requires (`require: "ACSZ"` → street, city, region, postal code). */
export function requiredFields(country: string): Set<keyof AddressInput> {
  const rules = countryRules(country)
  const required = new Set<keyof AddressInput>()
  for (const letter of rules.require) {
    const field = TOKEN_FIELDS[letter]
    if (field) required.add(field)
  }
  return required
}

/** The manager's form for a country: the country picker, the format's fields, then phone and email. */
export function addressFormat(country: string): AddressFormat {
  const code = normalizeCountry(country) ?? 'US'
  const rules = countryRules(code)
  const required = requiredFields(code)
  const fields: AddressFieldSpec[] = [{ field: 'country', label: FIXED_LABELS.country ?? 'Country', required: true }]
  for (const field of fieldOrder(code)) {
    const spec: AddressFieldSpec = { field, label: labelFor(field, rules), required: required.has(field) }
    if (field === 'region' && rules.regions.length) spec.options = rules.regions
    fields.push(spec)
  }
  fields.push({ field: 'phone', label: 'Phone', required: false })
  fields.push({ field: 'email', label: 'Email', required: false })
  return { country: code, countryName: countryName(code), fields, postalCodeExamples: rules.zipex }
}

/** Whether `code` is a postal code of `country` (countries without a pattern accept anything). */
export function postalCodeValid(country: string, code: string): boolean {
  const rules = countryRules(country)
  if (!rules.zip) return true
  try {
    return new RegExp(`^(?:${rules.zip})$`, 'i').test(code.trim())
  } catch {
    return true
  }
}

/** The required fields of the country are filled (a save prompt only offers complete addresses). */
export function addressComplete(address: AddressInput): boolean {
  for (const field of requiredFields(address.country)) if (!address[field].trim()) return false
  return true
}

/**
 * The address as the country prints it, one array element per line (region keys become names,
 * upper-cased fields upper-cased, a multi-line street on its own lines). Phone and email are not
 * part of the printed address; the name and the country line can be left out.
 */
export function formatAddress(
  address: AddressInput,
  options: { name?: boolean; country?: boolean } = {}
): string[] {
  const includeName = options.name ?? true
  const includeCountry = options.country ?? true
  const code = normalizeCountry(address.country) ?? 'ZZ'
  const rules = countryRules(code)
  const value = (field: keyof AddressInput): string => {
    if (field === 'name' && !includeName) return ''
    let text = address[field].trim()
    if (field === 'region') text = regionName(code, text)
    const token = FIELD_TOKENS[field]
    if (token && rules.upper.includes(token)) text = text.toUpperCase()
    return text
  }
  const lines: string[] = []
  for (const rawLine of rules.fmt.split('%n')) {
    let any = false
    const text = rawLine.replace(/%([A-Z])/g, (_m, letter: string) => {
      const field = TOKEN_FIELDS[letter]
      const v = field ? value(field) : ''
      if (v) any = true
      return v
    })
    if (!any) continue
    for (const part of text.split('\n')) {
      const cleaned = part.replace(/^[\s,\-–]+|[\s,\-–]+$/g, '').replace(/\s{2,}/g, ' ')
      if (cleaned) lines.push(cleaned)
    }
  }
  if (includeName && !rules.fmt.includes('%N') && address.name.trim())
    lines.unshift(address.name.trim())
  if (includeCountry && code !== 'ZZ') lines.push(countryName(code))
  return lines
}

/** One line for prompts and picker rows: `1600 Amphitheatre Pkwy, Mountain View, CA 94043`. */
export function addressPreview(address: AddressInput): string {
  return formatAddress(address, { name: false, country: false }).join(', ')
}

/** Two addresses are the same entry when their fields agree ignoring case and spacing. */
export function sameAddress(a: AddressInput, b: AddressInput): boolean {
  const keys: (keyof AddressInput)[] = [
    'country',
    'name',
    'organization',
    'streetAddress',
    'locality',
    'region',
    'postalCode',
    'sortingCode'
  ]
  return keys.every((k) => fold(a[k]).replace(/[\s,.]/g, '') === fold(b[k]).replace(/[\s,.]/g, ''))
}

/** `a` is `b` plus new details (a phone, an organization), so `b` can be brought up to date. */
export function extendsAddress(a: AddressInput, b: AddressInput): boolean {
  if (!sameAddress(a, b)) return false
  return (['phone', 'email', 'organization'] as const).some((k) => a[k].trim() && !b[k].trim())
}

const plain = (raw: string | undefined): string => {
  if (!raw) return ''
  const bar = raw.indexOf('|')
  return (bar >= 0 ? raw.slice(0, bar) : raw).trim()
}

/**
 * The address a submitted form carried, or null when it is not one worth saving (no street or
 * no city). `fallbackCountry` stands in when the form has no country field.
 */
export function addressFromForm(values: FormValues, fallbackCountry: string): AddressInput | null {
  const country =
    (values.country ? resolveCountry(values.country) : null) ??
    normalizeCountry(fallbackCountry) ??
    'US'
  const street =
    values['street-address']?.trim() ||
    [values['address-line1'], values['address-line2']]
      .map((l) => l?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
  const name =
    values.name?.trim() ||
    [values['given-name'], values['family-name']]
      .map((l) => l?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
  const address: AddressInput = {
    country,
    name,
    organization: values.organization?.trim() ?? '',
    streetAddress: street,
    locality: plain(values['address-level2']),
    region: values['address-level1'] ? resolveRegion(country, values['address-level1']) : '',
    postalCode: values['postal-code']?.trim() ?? '',
    sortingCode: '',
    phone: values.tel?.trim() ?? '',
    email: values.email?.trim() ?? ''
  }
  if (!address.streetAddress || (!address.locality && !address.postalCode)) return null
  return address
}

/** The form values (and the `<select>` labels) that fill a page's address fields. */
export function addressToForm(address: AddressEntry | AddressInput): {
  values: FormValues
  labels: { countryName: string; regionName: string }
} {
  const lines = address.streetAddress.split('\n').map((l) => l.trim()).filter(Boolean)
  const nameParts = address.name.trim().split(/\s+/).filter(Boolean)
  const values: FormValues = {
    name: address.name,
    'given-name': nameParts[0] ?? '',
    'family-name': nameParts.slice(1).join(' '),
    organization: address.organization,
    'street-address': lines.join('\n'),
    'address-line1': lines[0] ?? '',
    'address-line2': lines.slice(1).join(', '),
    'address-level2': address.locality,
    'address-level1': address.region,
    'postal-code': address.postalCode,
    country: address.country,
    tel: address.phone,
    email: address.email
  }
  for (const key of Object.keys(values) as (keyof FormValues)[]) if (!values[key]) delete values[key]
  return {
    values,
    labels: {
      countryName: countryName(address.country),
      regionName: regionName(address.country, address.region)
    }
  }
}
