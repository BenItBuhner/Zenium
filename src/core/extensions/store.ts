/**
 * Chrome Web Store and Edge Add-ons protocol helpers: CRX download and update-check URLs
 * (Omaha "update2" protocol), store-page URL parsing, and the Omaha XML response parser.
 *
 * Networking is injected: hosts pass a `StoreFetch` that already follows redirects (the store
 * endpoints answer `302` to a CDN URL, and Edge's CDN URL is plain http, which is acceptable
 * because every CRX is signed and the update check carries a SHA-256).
 */
import { toHex, utf8DecodeLenient, sha256 } from './bytes'

export type StoreId = 'chrome-web-store' | 'edge-add-ons'

export interface StoreResponse {
  /** Final HTTP status after redirects. */
  status: number
  /** Final URL after redirects. */
  url: string
  bytes: Uint8Array
}

/** The only network primitive this module needs. Implementations must follow redirects. */
export type StoreFetch = (url: string) => Promise<StoreResponse>

export class StoreError extends Error {
  constructor(
    readonly code: 'http' | 'hash-mismatch' | 'bad-response' | 'bad-id' | 'bad-url',
    message: string
  ) {
    super(message)
    this.name = 'StoreError'
  }
}

// ---------------------------------------------------------------------------
// IDs and URLs
// ---------------------------------------------------------------------------

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/

export function isExtensionId(value: string): boolean {
  return EXTENSION_ID_PATTERN.test(value)
}

export const CHROME_WEB_STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx'
export const EDGE_ADD_ONS_UPDATE_URL = 'https://edge.microsoft.com/extensionwebstorebase/v1/crx'

/** Store endpoints by canonical `update_url` (also what store-installed manifests declare). */
export const STORE_UPDATE_URLS: Readonly<Record<StoreId, string>> = {
  'chrome-web-store': CHROME_WEB_STORE_UPDATE_URL,
  'edge-add-ons': EDGE_ADD_ONS_UPDATE_URL
}

export interface StoreRequestOptions {
  /** Full Chromium version, e.g. `152.0.7590.12`; the store filters incompatible packages by it. */
  chromiumVersion: string
}

function assertId(id: string): void {
  if (!isExtensionId(id))
    throw new StoreError('bad-id', `Not an extension id: ${JSON.stringify(id)}`)
}

/**
 * The `x=` parameter of the update2 protocol: an URL-encoded query string of its own. `uc` marks
 * an interactive (user-initiated) request; Edge additionally expects `installsource=ondemand`.
 */
function buildX(store: StoreId | null, id: string, version?: string): string {
  const parts = [`id=${id}`]
  if (version !== undefined) parts.push(`v=${version}`)
  if (store === 'edge-add-ons') parts.push('installsource=ondemand')
  parts.push('uc')
  return parts.join('&')
}

/** Download URL for a store package; the response is a redirect to the CRX on the store's CDN. */
export function crxDownloadUrl(store: StoreId, id: string, options: StoreRequestOptions): string {
  assertId(id)
  const url = new URL(STORE_UPDATE_URLS[store])
  url.searchParams.set('response', 'redirect')
  if (store === 'chrome-web-store') {
    url.searchParams.set('prodversion', options.chromiumVersion)
    url.searchParams.set('acceptformat', 'crx3')
  }
  url.searchParams.set('x', buildX(store, id))
  return url.toString()
}

export interface UpdateCheckApp {
  id: string
  /** The installed version; the server compares against it. */
  version: string
}

/**
 * Omaha update-check URL for one or more extensions sharing an update endpoint. `endpoint` may be
 * a store or the `update_url` of a self-hosted extension (Chrome uses the same protocol for both).
 */
export function updateCheckUrl(
  endpoint: StoreId | string,
  apps: readonly UpdateCheckApp[],
  options: StoreRequestOptions
): string {
  if (apps.length === 0) throw new StoreError('bad-id', 'No extensions to check')
  const store = storeForEndpoint(endpoint)
  let url: URL
  try {
    url = new URL(store ? STORE_UPDATE_URLS[store] : endpoint)
  } catch {
    throw new StoreError('bad-url', `Invalid update URL: ${endpoint}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new StoreError('bad-url', `Update URL must be http(s): ${endpoint}`)
  }
  url.searchParams.set('response', 'updatecheck')
  url.searchParams.set('prodversion', options.chromiumVersion)
  url.searchParams.set('acceptformat', 'crx3')
  for (const app of apps) {
    assertId(app.id)
    url.searchParams.append('x', buildX(store, app.id, app.version))
  }
  return url.toString()
}

/** Maps a store id or a manifest `update_url` to the store it belongs to (null when self-hosted). */
export function storeForEndpoint(endpoint: StoreId | string): StoreId | null {
  if (endpoint === 'chrome-web-store' || endpoint === 'edge-add-ons') return endpoint
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  const bare = `${url.origin}${url.pathname}`
  for (const store of Object.keys(STORE_UPDATE_URLS) as StoreId[]) {
    if (bare === STORE_UPDATE_URLS[store]) return store
  }
  if (url.hostname === 'clients2.google.com' && url.pathname.startsWith('/service/update2/crx')) {
    return 'chrome-web-store'
  }
  return null
}

export interface StorePageRef {
  store: StoreId
  id: string
  /** The human-readable slug from the URL, when present. */
  slug: string | null
}

/**
 * Recognises store listing URLs:
 *   https://chromewebstore.google.com/detail/<slug>/<id>
 *   https://chrome.google.com/webstore/detail/<slug>/<id>
 *   https://microsoftedge.microsoft.com/addons/detail/<slug>/<id>
 * (the slug is optional). Returns null for anything else.
 */
export function parseStorePageUrl(input: string): StorePageRef | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  let store: StoreId
  let rest: string[]
  if (host === 'chromewebstore.google.com' && segments[0] === 'detail') {
    store = 'chrome-web-store'
    rest = segments.slice(1)
  } else if (
    host === 'chrome.google.com' &&
    segments[0] === 'webstore' &&
    segments[1] === 'detail'
  ) {
    store = 'chrome-web-store'
    rest = segments.slice(2)
  } else if (
    host === 'microsoftedge.microsoft.com' &&
    segments[0] === 'addons' &&
    segments[1] === 'detail'
  ) {
    store = 'edge-add-ons'
    rest = segments.slice(2)
  } else {
    return null
  }
  const id = rest.find((segment) => isExtensionId(segment))
  if (!id) return null
  const slug = rest.length > 1 && rest[0] !== id ? decodeURIComponent(rest[0]) : null
  return { store, id, slug }
}

// ---------------------------------------------------------------------------
// Omaha XML responses
// ---------------------------------------------------------------------------

export interface OmahaApp {
  appId: string
  /** `ok`, `noupdate`, or an `error-*` code such as `error-unknownApplication`. */
  status: string
  /** Populated when an update is available (`updatecheck status="ok"`). */
  update: {
    version: string
    codebase: string
    /** Lowercase hex SHA-256 of the CRX, when the server sent one. */
    sha256: string | null
    size: number | null
  } | null
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10))
    return ENTITY_MAP[body] ?? whole
  })
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(tag)) !== null) {
    attributes.set(match[1], decodeXmlEntities(match[2] ?? match[3] ?? ''))
  }
  return attributes
}

/**
 * Parses a `<gupdate>` response into one record per `<app>`. Both stores and self-hosted
 * `update_url` servers speak this dialect:
 *
 *   <gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
 *     <app appid="…" status="ok">
 *       <updatecheck status="ok" codebase="https://…/x.crx" version="1.2.3" hash_sha256="…"/>
 *     </app>
 *   </gupdate>
 */
export function parseOmahaResponse(xml: string): OmahaApp[] {
  if (!/<gupdate[\s>]/.test(xml)) {
    throw new StoreError('bad-response', 'Update server did not return a gupdate document')
  }
  const apps: OmahaApp[] = []
  const appPattern = /<app\b([^>]*?)(\/>|>([\s\S]*?)<\/app\s*>)/g
  let match: RegExpExecArray | null
  while ((match = appPattern.exec(xml)) !== null) {
    const attributes = parseAttributes(match[1])
    const appId = attributes.get('appid') ?? ''
    const appStatus = attributes.get('status') ?? 'ok'
    const body = match[3] ?? ''
    const check = /<updatecheck\b([^>]*?)\/?>/.exec(body)
    let status = appStatus
    let update: OmahaApp['update'] = null
    if (appStatus === 'ok' && check) {
      const checkAttributes = parseAttributes(check[1])
      status = checkAttributes.get('status') ?? 'ok'
      const version = checkAttributes.get('version')
      const codebase = checkAttributes.get('codebase')
      if (status === 'ok' && version && codebase) {
        const hash = checkAttributes.get('hash_sha256')
        const size = checkAttributes.get('size')
        update = {
          version,
          codebase,
          sha256: hash && /^[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null,
          size: size && /^\d+$/.test(size) ? Number(size) : null
        }
      } else if (status === 'ok') {
        status = 'error-incompleteUpdatecheck'
      }
    } else if (appStatus === 'ok' && !check) {
      status = 'error-missingUpdatecheck'
    }
    apps.push({ appId, status, update })
  }
  return apps
}

// ---------------------------------------------------------------------------
// Network operations over the injected fetch
// ---------------------------------------------------------------------------

/** Runs an update check and parses the response. */
export async function fetchUpdateCheck(fetch: StoreFetch, url: string): Promise<OmahaApp[]> {
  const response = await fetch(url)
  if (response.status !== 200) {
    throw new StoreError('http', `Update check failed with HTTP ${response.status}`)
  }
  return parseOmahaResponse(utf8DecodeLenient(response.bytes))
}

export interface DownloadOptions {
  /** Expected SHA-256 (hex, any case) from the update check; verified when provided. */
  sha256?: string | null
}

/** Downloads a CRX (following the store redirect inside `fetch`) and checks its hash if known. */
export async function downloadCrx(
  fetch: StoreFetch,
  url: string,
  options: DownloadOptions = {}
): Promise<Uint8Array> {
  const response = await fetch(url)
  if (response.status !== 200) {
    throw new StoreError('http', `Download failed with HTTP ${response.status}`)
  }
  if (options.sha256) {
    const actual = toHex(await sha256(response.bytes))
    if (actual !== options.sha256.toLowerCase()) {
      throw new StoreError(
        'hash-mismatch',
        'Downloaded package does not match the hash the update server announced'
      )
    }
  }
  return response.bytes
}
