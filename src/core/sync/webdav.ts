import type {
  WebDavErrorKind,
  WebDavProbe,
  WebDavSyncCredentials,
  WebDavSyncSettings
} from '../../shared/types'
import type { SyncFetch, SyncFetchResponse } from '../platform'
import { toBase64 } from '../credentials/crypto'
import { SYNC_DIR_NAME, type SyncTransport } from './transport'

/**
 * The sync folder on a WebDAV server (ID-32): Nextcloud, ownCloud, Apache's mod_dav, SabreDAV,
 * any server speaking RFC 4918 over plain HTTP. Chrome and Edge sync through their own servers;
 * a browser without one lets the user bring a server of their own. The folder is
 * `<root>/<folder>/zenium-sync/` under the account's DAV root (Nextcloud's
 * `remote.php/dav/files/<user>/`), and every document is one resource in it.
 *
 * The transport speaks over the host's fetch (`SyncPlatformHost.fetch`): the methods are plain
 * HTTP – PROPFIND `Depth: 1` lists, GET reads (`If-None-Match` on a known ETag, a 304 answered
 * from what was read before), PUT then MOVE writes, DELETE removes, MKCOL makes the folder on
 * first use – so no WebDAV library is needed. A write is atomic in the folder transport's sense
 * (a reader never sees a half-written file): the bytes go to `<name>.tmp-<random>` and MOVE with
 * `Overwrite: T` puts them in place, a server-side rename (RFC 4918 §9.9); a server that refuses
 * MOVE (405 / 501) gets a PUT in place from then on, guarded by `If-Match` on the ETag this
 * transport last saw for the resource so a concurrent writer is a 412 and not a lost update.
 *
 * Authentication is Basic with an APP PASSWORD (Nextcloud › Settings › Security), never the
 * account password: the header is built once and never written to a log or an error, and no
 * error carries the URL or the body. Every response class is a typed `WebDavError` for the
 * engine: 401 / 403 `auth`, 404 `missing`, 412 / 423 `conflict` (the engine runs the round
 * again), 5xx and network failures `unavailable`, everything else `refused`.
 */

/** The folder under the DAV root when the user leaves the field as it is. */
export const DEFAULT_WEBDAV_FOLDER = 'Zenium'
/** One request's whole time, headers and body: a device file is a few hundred kilobytes at most. */
export const WEBDAV_TIMEOUT_MS = 30_000
/** The one key the engine keeps the app password under in the host's secret store. */
export const WEBDAV_SECRET_KEY = 'sync.webdav.password'

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getetag/><d:getlastmodified/><d:getcontentlength/>' +
  '</d:prop></d:propfind>'
/** The most GET bodies kept for `If-None-Match`; the folder holds a few dozen documents. */
const READ_CACHE_MAX = 256

export class WebDavError extends Error {
  constructor(
    readonly kind: WebDavErrorKind,
    /** The HTTP status, 0 when no response came (a network failure, a timeout). */
    readonly status: number,
    readonly method: string,
    message: string
  ) {
    super(message)
    this.name = 'WebDavError'
  }
}

export function isWebDavError(error: unknown): error is WebDavError {
  return (
    error instanceof WebDavError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'WebDavError' &&
      typeof (error as { kind?: unknown }).kind === 'string')
  )
}

/** The class a status falls in, as the engine acts on it. */
export function classifyStatus(status: number): WebDavErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'missing'
  if (status === 412 || status === 423) return 'conflict'
  if (status >= 500 || status === 0) return 'unavailable'
  return 'refused'
}

/** The DAV root with one trailing slash (`https://cloud.example.com/remote.php/dav/files/alice/`). */
export function webDavRootUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/** The folder's segments under the root (`Zenium/sub` → `['Zenium', 'sub']`; empty for the root itself). */
export function webDavFolderSegments(folder: string): string[] {
  return folder
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..')
}

/** The `zenium-sync` directory's URL: the root, the folder, the directory, a trailing slash. */
export function webDavFolderUrl(settings: WebDavSyncSettings): string {
  const root = webDavRootUrl(settings.url)
  const segments = [...webDavFolderSegments(settings.folder), SYNC_DIR_NAME]
  return root + segments.map(encodeURIComponent).join('/') + '/'
}

/** The URL of a document in the directory (the name percent-encoded once). */
export function webDavDocumentUrl(settings: WebDavSyncSettings, name: string): string {
  return webDavFolderUrl(settings) + encodeURIComponent(name)
}

// ---------------------------------------------------------------------------
// The multistatus scanner
// ---------------------------------------------------------------------------

/** One `response` of a PROPFIND multistatus, its 200-status properties read. */
export interface DavEntry {
  /** The `href` as sent (a path, or an absolute URL on some servers), entities decoded. */
  href: string
  collection: boolean
  etag: string | null
  lastModified: string | null
  contentLength: number | null
}

/**
 * Read a PROPFIND multistatus (RFC 4918 §9.1, §14.16) with a tolerant scanner rather than a DOM:
 * the main process has no DOMParser, and a dependency is not wanted for five element names. Tags
 * are matched by local name whatever their prefix (`d:`, `D:`, `a:`, none under a default
 * namespace); comments, processing instructions and CDATA are skipped or taken as text;
 * properties count only from a `propstat` whose `status` is 2xx (Nextcloud lists the ones it does
 * not have under a 404 propstat). A `response` without an `href` is dropped.
 */
export function parseMultistatus(xml: string): DavEntry[] {
  const entries: DavEntry[] = []
  const stack: string[] = []
  let current: DavEntry | null = null
  let propstat: { status: number | null; props: Partial<DavEntry> } | null = null
  let text = ''
  let i = 0
  const n = xml.length
  const parent = (): string | undefined => stack[stack.length - 1]
  const grandparent = (): string | undefined => stack[stack.length - 2]

  const open = (name: string): void => {
    if (name === 'response') {
      current = { href: '', collection: false, etag: null, lastModified: null, contentLength: null }
      propstat = null
    } else if (name === 'propstat' && current) {
      propstat = { status: null, props: {} }
    } else if (name === 'collection' && propstat && parent() === 'resourcetype') {
      propstat.props.collection = true
    }
  }
  const close = (name: string, content: string): void => {
    if (!current) return
    const value = decodeEntities(content).trim()
    if (name === 'href' && parent() === 'response') {
      current.href = value
    } else if (propstat && parent() === 'prop' && grandparent() === 'propstat') {
      if (name === 'getetag') propstat.props.etag = value || null
      else if (name === 'getlastmodified') propstat.props.lastModified = value || null
      else if (name === 'getcontentlength') {
        const length = Number(value)
        propstat.props.contentLength = value !== '' && Number.isFinite(length) ? length : null
      }
    } else if (name === 'status' && propstat && parent() === 'propstat') {
      const m = /\b(\d{3})\b/.exec(value)
      propstat.status = m ? Number(m[1]) : null
    } else if (name === 'propstat' && propstat) {
      const status = propstat.status ?? 200
      if (status >= 200 && status < 300) Object.assign(current, propstat.props)
      propstat = null
    } else if (name === 'response') {
      if (current.href) entries.push(current)
      current = null
      propstat = null
    }
  }

  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) break
    text += xml.slice(i, lt)
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      text += xml.slice(lt + 9, end === -1 ? n : end)
      i = end === -1 ? n : end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt)
      i = end === -1 ? n : end + 1
      continue
    }
    const gt = tagEnd(xml, lt + 1)
    if (gt === -1) break
    const tag = xml.slice(lt + 1, gt).trim()
    i = gt + 1
    // While `open` and `close` run, the stack holds the enclosing elements only.
    if (tag.startsWith('/')) {
      const name = localName(tag.slice(1))
      if (stack[stack.length - 1] === name) stack.pop()
      close(name, text)
      text = ''
      continue
    }
    const selfClosing = tag.endsWith('/')
    const name = localName(selfClosing ? tag.slice(0, -1) : tag)
    open(name)
    text = ''
    if (selfClosing) close(name, '')
    else stack.push(name)
  }
  return entries
}

/** The index of the `>` that ends a tag opened before `from`, quotes respected; -1 when unterminated. */
function tagEnd(xml: string, from: number): number {
  let quote: string | null = null
  for (let i = from; i < xml.length; i++) {
    const c = xml[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return i
    }
  }
  return -1
}

/** `d:getetag` → `getetag`, `D:Href` → `href`: the local name, lower-cased, attributes dropped. */
function localName(tag: string): string {
  const token = /^[^\s/]+/.exec(tag)?.[0] ?? ''
  const colon = token.indexOf(':')
  return (colon === -1 ? token : token.slice(colon + 1)).toLowerCase()
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, entity: string) => {
    switch (entity) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'amp':
        return '&'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10)
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole
      }
    }
  })
}

/** An `href`'s path, percent-decoding undone and a trailing slash dropped (`/a/b/` and `http://h/a/b` → `/a/b`). */
export function hrefPath(href: string): string {
  let path = href
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    try {
      path = new URL(href).pathname
    } catch {
      path = href
    }
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // Left as sent: a name the server did not encode is still a name.
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * The documents a `Depth: 1` listing of `dirUrl` names: the direct children that are not
 * collections, by their last path segment; the directory's own entry is left out.
 */
export function namesInListing(entries: DavEntry[], dirUrl: string): string[] {
  const dir = hrefPath(new URL(dirUrl).pathname)
  const names: string[] = []
  for (const entry of entries) {
    if (entry.collection) continue
    const path = hrefPath(entry.href)
    if (path === dir) continue
    const slash = path.lastIndexOf('/')
    if (slash === -1 || path.slice(0, slash) !== dir) continue
    const name = path.slice(slash + 1)
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

interface Reply {
  status: number
  headers: SyncFetchResponse['headers']
  text: string
}

export interface WebDavTransportOptions {
  timeoutMs?: number
  /** The random part of a temporary name (tests pin it). */
  random?: () => string
}

export class WebDavTransport implements SyncTransport {
  /** The `zenium-sync` directory's URL, trailing slash included. */
  readonly dir: string
  private readonly root: string
  private readonly segments: string[]
  private readonly authorization: string
  private readonly timeoutMs: number
  private readonly random: () => string
  /** GET bodies by name with the ETag they came with, for `If-None-Match`. */
  private readonly cache = new Map<string, { etag: string; text: string }>()
  /** ETags a PUT answered with (a server that refuses MOVE): the next PUT's `If-Match`. */
  private readonly written = new Map<string, string>()
  private dirEnsured = false
  /** The server answered MOVE with 405 / 501: writes PUT in place from now on. */
  moveRefused = false

  constructor(
    credentials: WebDavSyncCredentials,
    private readonly fetch: SyncFetch,
    options: WebDavTransportOptions = {}
  ) {
    this.root = webDavRootUrl(credentials.url)
    this.segments = [...webDavFolderSegments(credentials.folder), SYNC_DIR_NAME]
    this.dir = this.root + this.segments.map(encodeURIComponent).join('/') + '/'
    this.authorization = basicAuthorization(credentials.username, credentials.password)
    this.timeoutMs = options.timeoutMs ?? WEBDAV_TIMEOUT_MS
    this.random = options.random ?? randomSuffix
  }

  /**
   * Reach the DAV root once with the credentials (PROPFIND `Depth: 0`): the address answers and
   * the sign-in is accepted. Nothing is created; a folder that does not exist yet is not a failure.
   */
  async probe(): Promise<WebDavProbe> {
    try {
      const reply = await this.request('PROPFIND', this.root, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY
      })
      if (reply.status === 207 || reply.status === 200) return { ok: true }
      return { ok: false, kind: classifyStatus(reply.status), status: reply.status }
    } catch (error) {
      if (isWebDavError(error)) return { ok: false, kind: error.kind, status: error.status }
      return { ok: false, kind: 'unavailable', status: 0 }
    }
  }

  async list(): Promise<string[]> {
    const reply = await this.request('PROPFIND', this.dir, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY
    })
    // No directory yet: the folder is empty as far as the engine is concerned.
    if (reply.status === 404) return []
    if (reply.status !== 207 && reply.status !== 200) throw this.error('PROPFIND', reply.status)
    return namesInListing(parseMultistatus(reply.text), this.dir)
  }

  async read(name: string): Promise<string | null> {
    const url = this.documentUrl(name)
    const cached = this.cache.get(name)
    const reply = await this.request('GET', url, {
      headers: cached ? { 'If-None-Match': cached.etag } : {}
    })
    if (reply.status === 304 && cached) return cached.text
    if (reply.status === 404) {
      this.cache.delete(name)
      return null
    }
    if (reply.status !== 200) throw this.error('GET', reply.status)
    const etag = reply.headers.get('etag')
    if (etag) this.remember(name, etag, reply.text)
    else this.cache.delete(name)
    return reply.text
  }

  async write(name: string, text: string): Promise<void> {
    const target = this.documentUrl(name)
    await this.ensureDir()
    if (!this.moveRefused) {
      const tmpName = `${name}.tmp-${this.random()}`
      const tmp = this.documentUrl(tmpName)
      const put = await this.request('PUT', tmp, {
        headers: { 'Content-Type': 'application/octet-stream' },
        body: text
      })
      if (!success(put.status)) throw this.error('PUT', put.status)
      const move = await this.request('MOVE', tmp, {
        headers: { Destination: target, Overwrite: 'T' }
      })
      if (success(move.status)) {
        // The destination's ETag is not in a MOVE reply: the next read fetches it whole.
        this.cache.delete(name)
        this.written.delete(name)
        return
      }
      // The temporary file must not stay behind whatever the refusal was.
      await this.request('DELETE', tmp).catch(() => undefined)
      if (move.status !== 405 && move.status !== 501) throw this.error('MOVE', move.status)
      this.moveRefused = true
    }
    // In place, guarded: a resource this transport read or wrote is replaced only as it last
    // saw it (`If-Match`); one it never saw is replaced as it is – its owner is this device.
    const known = this.written.get(name) ?? this.cache.get(name)?.etag
    const put = await this.request('PUT', target, {
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(known ? { 'If-Match': known } : {})
      },
      body: text
    })
    if (!success(put.status)) throw this.error('PUT', put.status)
    const etag = put.headers.get('etag')
    this.cache.delete(name)
    if (etag) this.written.set(name, etag)
    else this.written.delete(name)
  }

  async remove(name: string): Promise<void> {
    const reply = await this.request('DELETE', this.documentUrl(name))
    if (!success(reply.status) && reply.status !== 404) throw this.error('DELETE', reply.status)
    this.cache.delete(name)
    this.written.delete(name)
  }

  async removeAll(): Promise<void> {
    const reply = await this.request('DELETE', this.dir)
    if (!success(reply.status) && reply.status !== 404) throw this.error('DELETE', reply.status)
    this.cache.clear()
    this.written.clear()
    this.dirEnsured = false
  }

  // No `watch`: a server does not call back; the engine's poll is the trigger.

  /**
   * The folder and its `zenium-sync` directory, made level by level on the first write (MKCOL,
   * RFC 4918 §9.3: 201 made it, 405 says it exists already). Once per transport.
   */
  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return
    let url = this.root
    for (const segment of this.segments) {
      url += `${encodeURIComponent(segment)}/`
      const reply = await this.request('MKCOL', url)
      if (reply.status === 405 || success(reply.status)) continue
      throw this.error('MKCOL', reply.status)
    }
    this.dirEnsured = true
  }

  private documentUrl(name: string): string {
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))
      throw new Error(`invalid sync document name: ${name}`)
    return this.dir + encodeURIComponent(name)
  }

  private remember(name: string, etag: string, text: string): void {
    this.cache.delete(name)
    this.cache.set(name, { etag, text })
    if (this.cache.size > READ_CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
  }

  /**
   * One request, the Authorization header on it and the whole exchange under one timeout (the
   * body read included). A failure to get any response – the network, the timeout – is
   * `unavailable`; the message names the method and nothing of the address.
   */
  private async request(
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: string } = {}
  ): Promise<Reply> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetch(url, {
        method,
        headers: { Authorization: this.authorization, ...init.headers },
        body: init.body,
        signal: controller.signal,
        cache: 'no-store'
      })
      const text = await response.text()
      return { status: response.status, headers: response.headers, text }
    } catch (error) {
      if (isWebDavError(error)) throw error
      throw new WebDavError(
        'unavailable',
        0,
        method,
        controller.signal.aborted
          ? `WebDAV ${method}: no response within ${this.timeoutMs} ms`
          : `WebDAV ${method}: ${describeNetworkError(error)}`
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private error(method: string, status: number): WebDavError {
    return new WebDavError(
      classifyStatus(status),
      status,
      method,
      `WebDAV ${method} answered ${status}`
    )
  }
}

/** 2xx: the request did what it asked (201 Created, 204 No Content, 200 OK). */
function success(status: number): boolean {
  return status >= 200 && status < 300
}

/** `Basic` with the UTF-8 bytes of `user:password` (RFC 7617), built once. */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${toBase64(new TextEncoder().encode(`${username}:${password}`))}`
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10) || 'x'
}

/** An error's own words without anything a URL or a header may have put in them. */
function describeNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const first = message.split('\n')[0] ?? ''
  return (
    first
      .replace(/https?:\/\/\S+/gi, '<url>')
      .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic <…>')
      .slice(0, 200) || 'network failure'
  )
}
