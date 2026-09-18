import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import type { CustomScheme, Session } from 'electron'
import type { EngineRuleSet } from '../../../core/extensions/dnr/sink'
import { parseEngineSetId } from '../../../core/extensions/dnr/sink'
import {
  DEFAULT_FAVICON_SVG,
  DEFAULT_FAVICON_TYPE,
  FAVICON_PATH,
  faviconQuery,
  type FaviconImage,
  type FaviconRequest
} from '../../../core/extensions/favicon'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import {
  normalizeResourcePath,
  webAccessibleEntryFor
} from '../../../core/extensions/webAccessible'

/** Scheme of the per-run origin Zenium serves `use_dynamic_url` resources from. */
export const EXTENSION_RESOURCE_SCHEME = 'zen-extension'

/** Registered with `protocol.registerSchemesAsPrivileged` before `app.ready`. */
export const EXTENSION_RESOURCE_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: EXTENSION_RESOURCE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
}

/** What the origin needs to know about an installed extension. */
export interface ServedExtension {
  path: string
  manifest: Pick<
    ExtensionManifest,
    'web_accessible_resources' | 'permissions' | 'optional_permissions'
  >
}

/** Answers the `_favicon/` route: the page's icon, or undefined when the browser knows none. */
export interface FaviconProvider {
  faviconFor(pageUrl: string): Promise<FaviconImage | undefined>
}

export interface ResourceOriginOptions {
  /** Without one the `_favicon/` route serves the default icon for every page. */
  favicons?: FaviconProvider
  /** The per-run token; drawn at random when not given (tests fix it). */
  token?: string
}

const MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

const TOKEN_BYTES = 16

/**
 * Chrome serves a `use_dynamic_url` web-accessible resource from `chrome-extension://<guid>/`, a
 * per-session origin a page cannot guess, and lets a declarativeNetRequest redirect reach the
 * resource through it. Electron has no handle on that origin: the engine's redirect lands on the
 * static `chrome-extension://<id>/` URL, which Chromium refuses for such resources
 * (`ERR_BLOCKED_BY_CLIENT`); uBlock Origin Lite marks every one of its neutered stubs this way.
 *
 * This is Zenium's stand-in: `zen-extension://<id>.<token>/<path>` with a token drawn per run,
 * served straight from the package for paths the manifest lists as web-accessible. The
 * declarativeNetRequest sink rewrites redirects into it (`rewriteSet`); a page holding the
 * static URL still gets Chromium's refusal, and one guessing at this origin gets nothing without
 * the token.
 *
 * The origin also answers Chrome's favicon resource, `chrome-extension://<id>/_favicon/`, which
 * Electron's loader leaves hanging: the request pipeline redirects it here (`favicons.ts`) for
 * an extension holding the `favicon` permission, and the route serves the page's icon.
 */
export class ExtensionResourceOrigin {
  private readonly token: string
  private readonly favicons: FaviconProvider | undefined

  constructor(
    private readonly lookup: (extensionId: string) => ServedExtension | undefined,
    options: ResourceOriginOptions = {}
  ) {
    this.token = options.token ?? randomBytes(TOKEN_BYTES).toString('hex')
    this.favicons = options.favicons
  }

  /** The URL a page loads `path` of `extensionId` through. */
  urlFor(extensionId: string, path: string): string {
    const clean = path.replace(/^\/+/, '')
    return `${EXTENSION_RESOURCE_SCHEME}://${extensionId}.${this.token}/${clean}`
  }

  /**
   * Where a favicon request is served, or undefined when the extension is not installed or its
   * manifest does not declare the `favicon` permission (required or optional; whether an optional
   * one is granted is the redirecting handler's check).
   */
  faviconUrl(request: FaviconRequest): string | undefined {
    const served = this.lookup(request.extensionId)
    if (!served || !declaresFavicon(served)) return undefined
    return `${this.urlFor(request.extensionId, FAVICON_PATH)}?${faviconQuery(request)}`
  }

  /**
   * Where a redirect to `url` should go instead: the served origin when `url` is a
   * `use_dynamic_url` resource of `extensionId`, otherwise undefined (leave the redirect alone).
   */
  redirectTarget(extensionId: string, url: string): string | undefined {
    const prefix = `chrome-extension://${extensionId}/`
    if (!url.startsWith(prefix)) return undefined
    const served = this.lookup(extensionId)
    if (!served) return undefined
    const rest = url.slice(prefix.length)
    const entry = webAccessibleEntryFor(served.manifest, rest)
    if (!entry?.useDynamicUrl) return undefined
    return this.urlFor(extensionId, rest)
  }

  /** A translated rule set with its redirects rewritten where they need to be. */
  rewriteSet(set: EngineRuleSet): EngineRuleSet {
    const parsed = parseEngineSetId(set.id)
    if (!parsed || !set.rules) return set
    let changed = false
    const rules = set.rules.map((rule) => {
      const url = rule.action.redirect?.url
      if (url === undefined) return rule
      const target = this.redirectTarget(parsed.extensionId, url)
      if (target === undefined) return rule
      changed = true
      return {
        ...rule,
        action: { ...rule.action, redirect: { ...rule.action.redirect, url: target } }
      }
    })
    return changed ? { ...set, rules } : set
  }

  /** Serve the origin in a session (every session: redirects happen wherever requests do). */
  install(ses: Session): void {
    if (ses.protocol.isProtocolHandled(EXTENSION_RESOURCE_SCHEME)) return
    ses.protocol.handle(EXTENSION_RESOURCE_SCHEME, (request) => this.serve(request.url))
  }

  /** The response for one request URL: the file, or a status that gives nothing away. */
  async serve(url: string): Promise<Response> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return new Response(null, { status: 400 })
    }
    const dot = parsed.hostname.indexOf('.')
    if (dot <= 0) return new Response(null, { status: 404 })
    const extensionId = parsed.hostname.slice(0, dot)
    const token = parsed.hostname.slice(dot + 1)
    if (!this.tokenMatches(token)) return new Response(null, { status: 404 })
    const served = this.lookup(extensionId)
    if (!served) return new Response(null, { status: 404 })
    if (parsed.pathname === FAVICON_PATH) {
      if (!declaresFavicon(served)) return new Response(null, { status: 403 })
      return this.serveFavicon(parsed.searchParams.get('pageUrl'))
    }
    // The URL parser has resolved dot segments already; anything left over is not a package path.
    const path = normalizeResourcePath(parsed.pathname)
    if (path === '' || path.split('/').some((segment) => segment === '..' || segment === '.')) {
      return new Response(null, { status: 404 })
    }
    if (!webAccessibleEntryFor(served.manifest, path)) return new Response(null, { status: 403 })
    const root = resolve(served.path)
    const file = resolve(root, path)
    const rel = relative(root, file)
    if (!rel || rel.startsWith('..') || rel.startsWith(sep))
      return new Response(null, { status: 404 })
    let body: Uint8Array<ArrayBuffer>
    try {
      body = Uint8Array.from(await fs.readFile(file))
    } catch {
      return new Response(null, { status: 404 })
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store'
      }
    })
  }

  /**
   * The page's icon as the models keep it, the default globe when they keep none (a while only:
   * the page may be visited next). `size` is not honoured: the icon comes as stored and the page
   * scales it, as an `<img>` of that size does anyway.
   */
  private async serveFavicon(pageUrl: string | null): Promise<Response> {
    let icon: FaviconImage | undefined
    if (pageUrl && this.favicons) {
      try {
        icon = await this.favicons.faviconFor(pageUrl)
      } catch {
        icon = undefined
      }
    }
    const body = icon ? Uint8Array.from(icon.body) : new TextEncoder().encode(DEFAULT_FAVICON_SVG)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': icon ? icon.type : DEFAULT_FAVICON_TYPE,
        'access-control-allow-origin': '*',
        'cache-control': icon ? 'private, max-age=3600' : 'private, max-age=60'
      }
    })
  }

  private tokenMatches(candidate: string): boolean {
    if (candidate.length !== this.token.length) return false
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token))
  }
}

/** Whether the manifest declares the `favicon` permission, required or optional. */
function declaresFavicon(served: ServedExtension): boolean {
  const { permissions, optional_permissions } = served.manifest
  return (
    permissions?.includes('favicon') === true || optional_permissions?.includes('favicon') === true
  )
}
