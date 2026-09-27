import type { SyncFetch, SyncFetchInit, SyncFetchResponse } from '../../platform'

/**
 * An in-memory WebDAV server shaped as a `SyncFetch`, for the transport's tests and for the
 * engine's convergence suite run over `WebDavTransport`: PROPFIND (`Depth: 0` / `1`, a SabreDAV-
 * shaped multistatus), GET with `If-None-Match` → 304, PUT with `If-Match` / `If-None-Match: *`
 * → 412 and the parent's 409, MKCOL (201 / 405 / 409), MOVE with `Destination` and `Overwrite`,
 * DELETE (a collection with everything under it), Basic auth against a user table (401 with
 * `WWW-Authenticate` otherwise). ETags are strong and derived from the content, as a server that
 * hashes would give them, so a body that changes under the server's feet (a test editing the
 * mounted map) changes its ETag with it.
 *
 * Switches for the failure paths: `down` (no response at all), `hang` (no answer until the
 * request's signal aborts), `locked` (every write is 423), `refuseMove` (405, a server without
 * MOVE), `failNext` (one answer with a status of the test's choosing). Every request is logged
 * with its method, path, headers and status; the log is what the tests assert on.
 */

export interface LoggedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string | undefined
  status: number
}

export interface FakeWebDavOptions {
  /** The collections that exist to begin with (the DAV root and the like), as paths. */
  roots?: string[]
  /** User → password; absent means no authentication at all. */
  users?: Record<string, string>
}

interface Reply {
  status: number
  headers?: Record<string, string>
  body?: string
}

/** FNV-1a over the UTF-16 code units: a strong ETag from the content, quoted as servers send it. */
export function contentEtag(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `"${hash.toString(16).padStart(8, '0')}-${text.length.toString(16)}"`
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** `/a/b/` and `/a/b` → `/a/b`; `/` stays `/`. */
function normalise(path: string): string {
  const decoded = path
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
    .join('/')
  return decoded.length > 1 && decoded.endsWith('/') ? decoded.slice(0, -1) : decoded
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function headerMap(headers: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [k, v] of Object.entries(headers)) map.set(k.toLowerCase(), v)
  return map
}

export class FakeWebDavServer {
  /** Every collection that exists, by normalised path (`/dav/files/alice`). */
  readonly collections = new Set<string>()
  /** Documents by their collection's path: name → text. A mounted map is a test's own. */
  private readonly dirs = new Map<string, Map<string, string>>()
  readonly log: LoggedRequest[] = []
  down = false
  hang = false
  locked = false
  refuseMove: false | 405 | 501 = false
  failNext: number | null = null
  private readonly users: Map<string, string> | null
  private readonly roots: string[]
  private readonly lastModified = 'Sun, 27 Sep 2026 09:16:03 GMT'

  constructor(options: FakeWebDavOptions = {}) {
    this.users = options.users ? new Map(Object.entries(options.users)) : null
    this.roots = (options.roots ?? []).map(normalise)
    this.reset()
  }

  readonly fetch: SyncFetch = (url, init) => this.handle(url, init)

  /** Back to the roots alone: no documents, no log, every switch off (a suite's `afterEach`). */
  reset(): void {
    this.collections.clear()
    this.dirs.clear()
    this.log.length = 0
    this.down = false
    this.hang = false
    this.locked = false
    this.refuseMove = false
    this.failNext = null
    this.collections.add('/')
    for (const root of this.roots) this.mkcolRecursive(root)
  }

  /** The account's password from now on (an app password revoked and a new one made). */
  setPassword(user: string, password: string): void {
    this.users?.set(user, password)
  }

  /** Make `dirPath` (and its parents) a collection whose documents live in `files`. */
  mount(dirPath: string, files: Map<string, string>): void {
    const path = normalise(dirPath)
    this.mkcolRecursive(path)
    this.dirs.set(path, files)
  }

  /** The documents of a collection (`name → text`), or `null` when it does not exist. */
  files(dirPath: string): Map<string, string> | null {
    const path = normalise(dirPath)
    if (!this.collections.has(path)) return null
    return this.filesOf(path)
  }

  /** The requests logged since the last call, oldest first. */
  drain(): LoggedRequest[] {
    return this.log.splice(0)
  }

  private filesOf(path: string): Map<string, string> {
    let files = this.dirs.get(path)
    if (!files) {
      files = new Map()
      this.dirs.set(path, files)
    }
    return files
  }

  private mkcolRecursive(path: string): void {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      this.collections.add(current)
    }
  }

  private document(path: string): string | undefined {
    return this.dirs.get(parentOf(path))?.get(nameOf(path))
  }

  private async handle(url: string, init: SyncFetchInit): Promise<SyncFetchResponse> {
    const path = normalise(new URL(url).pathname)
    const headers = headerMap(init.headers)
    if (this.down) throw new TypeError(`fetch failed: ${url} refused the connection`)
    if (this.hang) {
      await new Promise<never>((_, reject) => {
        const abort = (): void =>
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
        if (init.signal?.aborted) abort()
        else init.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    const reply = this.answer(init.method, path, headers, init.body)
    this.log.push({
      method: init.method,
      path,
      headers: Object.fromEntries(headers),
      body: init.body,
      status: reply.status
    })
    const replyHeaders = headerMap(reply.headers ?? {})
    return {
      status: reply.status,
      headers: { get: (name) => replyHeaders.get(name.toLowerCase()) ?? null },
      text: async () => reply.body ?? ''
    }
  }

  private answer(
    method: string,
    path: string,
    headers: Map<string, string>,
    body: string | undefined
  ): Reply {
    if (this.failNext !== null) {
      const status = this.failNext
      this.failNext = null
      return { status }
    }
    if (this.users) {
      const authorization = headers.get('authorization') ?? ''
      const ok = [...this.users].some(
        ([user, password]) => authorization === `Basic ${toBase64(`${user}:${password}`)}`
      )
      if (!ok)
        return { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Zenium test DAV"' } }
    }
    switch (method) {
      case 'PROPFIND':
        return this.propfind(path, headers.get('depth') ?? '1')
      case 'GET':
        return this.get(path, headers)
      case 'PUT':
        return this.put(path, headers, body ?? '')
      case 'MKCOL':
        return this.mkcol(path, body)
      case 'MOVE':
        return this.move(path, headers)
      case 'DELETE':
        return this.delete(path)
      case 'OPTIONS':
        return {
          status: 200,
          headers: { DAV: '1, 2', Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, MKCOL, MOVE' }
        }
      default:
        return { status: 405 }
    }
  }

  private propfind(path: string, depth: string): Reply {
    const responses: string[] = []
    if (this.collections.has(path)) {
      responses.push(this.collectionResponse(path))
      if (depth !== '0') {
        for (const child of this.collections)
          if (parentOf(child) === path && child !== path)
            responses.push(this.collectionResponse(child))
        for (const [name, text] of this.filesOf(path))
          responses.push(this.documentResponse(`${path === '/' ? '' : path}/${name}`, text))
      }
    } else {
      const text = this.document(path)
      if (text === undefined) return { status: 404 }
      responses.push(this.documentResponse(path, text))
    }
    const xml =
      '<?xml version="1.0"?>\n' +
      '<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">' +
      responses.join('') +
      '</d:multistatus>'
    return {
      status: 207,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: xml
    }
  }

  private collectionResponse(path: string): string {
    const href = path === '/' ? '/' : `${encodePath(path)}/`
    return (
      `<d:response><d:href>${href}</d:href>` +
      '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>' +
      `<d:getlastmodified>${this.lastModified}</d:getlastmodified></d:prop>` +
      '<d:status>HTTP/1.1 200 OK</d:status></d:propstat>' +
      '<d:propstat><d:prop><d:getetag/><d:getcontentlength/></d:prop>' +
      '<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>'
    )
  }

  private documentResponse(path: string, text: string): string {
    return (
      `<d:response><d:href>${encodePath(path)}</d:href>` +
      `<d:propstat><d:prop><d:resourcetype/><d:getetag>${escapeXml(contentEtag(text))}</d:getetag>` +
      `<d:getlastmodified>${this.lastModified}</d:getlastmodified>` +
      `<d:getcontentlength>${new TextEncoder().encode(text).length}</d:getcontentlength></d:prop>` +
      '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
    )
  }

  private get(path: string, headers: Map<string, string>): Reply {
    if (this.collections.has(path))
      return { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>listing</html>' }
    const text = this.document(path)
    if (text === undefined) return { status: 404 }
    const etag = contentEtag(text)
    if (headers.get('if-none-match') === etag) return { status: 304, headers: { ETag: etag } }
    return {
      status: 200,
      headers: {
        ETag: etag,
        'Last-Modified': this.lastModified,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(new TextEncoder().encode(text).length)
      },
      body: text
    }
  }

  private put(path: string, headers: Map<string, string>, body: string): Reply {
    if (this.collections.has(path)) return { status: 405 }
    const parent = parentOf(path)
    if (!this.collections.has(parent)) return { status: 409 }
    if (this.locked) return { status: 423 }
    const files = this.filesOf(parent)
    const name = nameOf(path)
    const existing = files.get(name)
    const ifMatch = headers.get('if-match')
    if (ifMatch !== undefined && (existing === undefined || contentEtag(existing) !== ifMatch))
      return { status: 412 }
    if (headers.get('if-none-match') === '*' && existing !== undefined) return { status: 412 }
    files.set(name, body)
    return { status: existing === undefined ? 201 : 204, headers: { ETag: contentEtag(body) } }
  }

  private mkcol(path: string, body: string | undefined): Reply {
    if (body) return { status: 415 }
    if (this.collections.has(path) || this.document(path) !== undefined) return { status: 405 }
    if (!this.collections.has(parentOf(path))) return { status: 409 }
    this.collections.add(path)
    return { status: 201 }
  }

  private move(path: string, headers: Map<string, string>): Reply {
    if (this.refuseMove) return { status: this.refuseMove }
    const destinationHeader = headers.get('destination')
    if (!destinationHeader) return { status: 400 }
    let destination: string
    try {
      destination = normalise(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(destinationHeader)
          ? new URL(destinationHeader).pathname
          : destinationHeader
      )
    } catch {
      return { status: 400 }
    }
    if (this.collections.has(path)) return { status: 403 }
    const text = this.document(path)
    if (text === undefined) return { status: 404 }
    if (!this.collections.has(parentOf(destination))) return { status: 409 }
    if (this.locked) return { status: 423 }
    const target = this.filesOf(parentOf(destination))
    const existed = target.has(nameOf(destination))
    if (existed && (headers.get('overwrite') ?? 'T').toUpperCase() === 'F') return { status: 412 }
    this.filesOf(parentOf(path)).delete(nameOf(path))
    target.set(nameOf(destination), text)
    return { status: existed ? 204 : 201 }
  }

  private delete(path: string): Reply {
    if (this.locked) return { status: 423 }
    if (this.collections.has(path)) {
      if (path === '/') return { status: 403 }
      for (const child of [...this.collections])
        if (child === path || child.startsWith(`${path}/`)) {
          this.collections.delete(child)
          this.dirs.get(child)?.clear()
          this.dirs.delete(child)
        }
      return { status: 204 }
    }
    const files = this.dirs.get(parentOf(path))
    if (!files?.has(nameOf(path))) return { status: 404 }
    files.delete(nameOf(path))
    return { status: 204 }
  }
}
