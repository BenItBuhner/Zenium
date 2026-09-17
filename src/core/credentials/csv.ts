import type { Credential } from '../../shared/types'
import { siteLabel } from './origins'
import type { ImportRow } from './store'

/**
 * Password CSV files. Parsing follows RFC 4180 (quoted fields, doubled quotes, CR LF or LF, a
 * UTF-8 BOM tolerated); the header row decides which browser or manager wrote the file. Export
 * uses Chrome's header so Chrome, Edge, Brave and most managers import it unchanged.
 */

export const CHROME_HEADER = ['name', 'url', 'username', 'password', 'note'] as const

/** Split CSV text into rows of fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      quoted = true
      i++
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (c === '\r' || c === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += c
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f !== ''))
}

export function csvField(value: string): string {
  return /[",\r\n]/.test(value) || value.startsWith(' ') || value.endsWith(' ')
    ? `"${value.replace(/"/g, '""')}"`
    : value
}

export function serializeCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ParsedImport {
  /** `chrome`, `firefox`, `bitwarden`, `safari`, `lastpass`, `keepass`, `generic`; null when no usable columns. */
  format: string | null
  rows: ImportRow[]
  /** Rows without a URL or password. */
  invalid: number
}

interface Columns {
  url: number
  username: number
  password: number
  notes: number
  name: number
  realm: number
  created: number
  lastUsed: number
  /** Bitwarden: only `login` rows carry credentials. */
  type: number
}

const URL_HEADERS = [
  'url',
  'login_uri',
  'web site',
  'website',
  'site',
  'uri',
  'location',
  'hostname',
  'origin'
]
const USER_HEADERS = [
  'username',
  'login_username',
  'user name',
  'user',
  'login',
  'email',
  'account'
]
const PASSWORD_HEADERS = ['password', 'login_password', 'pass', 'passwd']
const NOTES_HEADERS = ['note', 'notes', 'extra', 'comment', 'comments']
const NAME_HEADERS = ['name', 'title']

function findColumn(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const at = headers.indexOf(candidate)
    if (at >= 0) return at
  }
  return -1
}

function detectFormat(headers: string[]): string | null {
  const has = (h: string): boolean => headers.includes(h)
  if (has('login_uri') && has('login_username')) return 'bitwarden'
  if (has('formactionorigin') || has('httprealm') || has('timepasswordchanged')) return 'firefox'
  if (has('otpauth')) return 'safari'
  if (has('grouping') && has('extra')) return 'lastpass'
  if (has('login name') || has('web site')) return 'keepass'
  if (has('name') && has('url') && has('username') && has('password')) return 'chrome'
  return 'generic'
}

/** Read a password export; unknown layouts still work when URL, username and password are named. */
export function parseImport(text: string): ParsedImport {
  const rows = parseCsv(text)
  if (rows.length === 0) return { format: null, rows: [], invalid: 0 }
  const headers = rows[0].map((h) => h.trim().toLowerCase())
  const cols: Columns = {
    url: findColumn(headers, URL_HEADERS),
    username: findColumn(headers, USER_HEADERS),
    password: findColumn(headers, PASSWORD_HEADERS),
    notes: findColumn(headers, NOTES_HEADERS),
    name: findColumn(headers, NAME_HEADERS),
    realm: headers.indexOf('httprealm'),
    created: headers.indexOf('timecreated'),
    lastUsed: headers.indexOf('timelastused'),
    type: headers.indexOf('type')
  }
  if (cols.url < 0 || cols.password < 0) return { format: null, rows: [], invalid: rows.length - 1 }
  const format = detectFormat(headers)
  const out: ImportRow[] = []
  let invalid = 0
  const cell = (r: string[], at: number): string => (at >= 0 && at < r.length ? r[at].trim() : '')
  for (const r of rows.slice(1)) {
    if (format === 'bitwarden' && cols.type >= 0 && cell(r, cols.type) !== 'login') {
      invalid++
      continue
    }
    // Bitwarden allows several URIs per login separated by commas inside the quoted field.
    const url = cell(r, cols.url).split(/[\s,]+/)[0] ?? ''
    const password = at(r, cols.password)
    if (!url || !password) {
      invalid++
      continue
    }
    const row: ImportRow = {
      url,
      username: cell(r, cols.username),
      password,
      notes: cell(r, cols.notes)
    }
    const realm = cell(r, cols.realm)
    if (realm) row.realm = realm
    const created = timestamp(cell(r, cols.created))
    if (created) row.createdAt = created
    const used = timestamp(cell(r, cols.lastUsed))
    if (used) row.lastUsedAt = used
    out.push(row)
  }
  return { format, rows: out, invalid }
}

/** A raw cell (passwords keep their surrounding spaces). */
function at(r: string[], index: number): string {
  return index >= 0 && index < r.length ? r[index] : ''
}

/** Firefox writes milliseconds since the epoch; tolerate seconds too. */
function timestamp(text: string): number | null {
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) return null
  return value < 1e11 ? value * 1000 : value
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Chrome's `name,url,username,password,note` layout, one line per login. */
export function toChromeCsv(credentials: Credential[]): string {
  const rows: string[][] = [[...CHROME_HEADER]]
  for (const c of credentials) {
    rows.push([siteLabel(c.origin), c.url || c.origin, c.username, c.password, c.notes])
  }
  return serializeCsv(rows)
}
