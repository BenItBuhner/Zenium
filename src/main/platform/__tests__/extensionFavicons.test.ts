import { describe, expect, it, vi } from 'vitest'
import type { BookmarkNode } from '../../../shared/types'
import { DEFAULT_FAVICON_SVG, DEFAULT_FAVICON_TYPE } from '../../../core/extensions/favicon'
import {
  ExtensionFavicons,
  FAVICON_HANDLER_ORDER,
  faviconRequestHandler,
  iconType,
  type FaviconModels
} from '../extensionApi/favicons'
import {
  EXTENSION_RESOURCE_SCHEME,
  ExtensionResourceOrigin,
  type FaviconProvider,
  type ServedExtension
} from '../extensionApi/resourceOrigin'
import { HANDLER_ORDER, type BeforeRequestDetails, type HostRequest } from '../webRequest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OPTIONAL = 'bcdefghijklmnopabcdefghijklmnopa'
const PLAIN = 'cdefghijklmnopabcdefghijklmnopab'
const TOKEN = '0123456789abcdef0123456789abcdef'
const PAGE = 'https://news.example/story?id=1'

const extensions: Record<string, ServedExtension> = {
  [ID]: { path: '/ext/a', manifest: { permissions: ['favicon', 'tabs'] } },
  [OPTIONAL]: { path: '/ext/b', manifest: { optional_permissions: ['favicon'] } },
  [PLAIN]: { path: '/ext/c', manifest: { permissions: ['tabs'] } }
}

function models(
  icons: Record<string, string | null> = {},
  byDomain: Record<string, string> = {},
  bookmarks: Array<Pick<BookmarkNode, 'url' | 'favicon'>> = []
): FaviconModels {
  return {
    history: {
      faviconFor: (url) => icons[url] ?? null,
      faviconsByDomain: () => new Map(Object.entries(byDomain))
    },
    bookmarks: {
      findByUrl: (url) => bookmarks.filter((b) => b.url === url) as BookmarkNode[]
    }
  }
}

function faviconRequest(extensionId: string, pageUrl = PAGE, size = 16): string {
  return `chrome-extension://${extensionId}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('ExtensionFavicons', () => {
  it("finds the page's own icon, else a bookmark's, else the domain's newest", () => {
    const source = new ExtensionFavicons(
      models(
        { 'https://a.test/x': 'https://a.test/own.ico' },
        { 'b.test': 'https://b.test/domain.ico' },
        [{ url: 'https://c.test/', favicon: 'data:image/png;base64,iVBORw0KGgo=' }]
      ),
      async () => undefined
    )
    expect(source.iconUrlFor('https://a.test/x')).toBe('https://a.test/own.ico')
    expect(source.iconUrlFor('https://www.b.test/deep/page')).toBe('https://b.test/domain.ico')
    expect(source.iconUrlFor('https://c.test/')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(source.iconUrlFor('https://d.test/')).toBeNull()
    expect(source.iconUrlFor('not a url')).toBeNull()
  })

  it('fetches a remote icon once per run and keeps a failure', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('ok.ico') ? { body: PNG, type: 'image/x-icon' } : undefined
    )
    const source = new ExtensionFavicons(
      models({
        'https://a.test/': 'https://a.test/ok.ico',
        'https://b.test/': 'https://b.test/gone.ico'
      }),
      fetcher
    )
    const [first, again] = await Promise.all([
      source.faviconFor('https://a.test/'),
      source.faviconFor('https://a.test/')
    ])
    expect(first).toEqual({ body: PNG, type: 'image/x-icon' })
    expect(again).toBe(first)
    expect(await source.faviconFor('https://b.test/')).toBeUndefined()
    expect(await source.faviconFor('https://b.test/')).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('decodes a data: icon itself, fetches nothing for other schemes, and swallows a fetch error', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('offline')
    })
    const source = new ExtensionFavicons(
      models({
        'https://a.test/': 'data:image/png;base64,iVBORw0KGgo=',
        'https://b.test/': 'zen://blank',
        'https://c.test/': 'https://c.test/favicon.ico'
      }),
      fetcher
    )
    const data = await source.faviconFor('https://a.test/')
    expect(data?.type).toBe('image/png')
    expect(data?.body.length).toBe(8)
    expect(await source.faviconFor('https://b.test/')).toBeUndefined()
    expect(await source.faviconFor('https://c.test/')).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('types a fetched icon by the response when it says image, else by its name', () => {
    expect(iconType('https://a.test/favicon.ico', 'image/png')).toBe('image/png')
    expect(iconType('https://a.test/favicon.ico', 'Image/X-Icon; charset=binary')).toBe(
      'image/x-icon'
    )
    expect(iconType('https://a.test/favicon.ico', 'application/octet-stream')).toBe('image/x-icon')
    expect(iconType('https://a.test/icon.svg?v=2', 'text/plain')).toBe('image/svg+xml')
    expect(iconType('https://a.test/icon.PNG', null)).toBe('image/png')
    expect(iconType('https://a.test/icon', null)).toBe('image/x-icon')
  })
})

describe('the _favicon/ route of the served origin', () => {
  const provider: FaviconProvider = {
    faviconFor: async (pageUrl) => (pageUrl === PAGE ? { body: PNG, type: 'image/png' } : undefined)
  }
  const origin = new ExtensionResourceOrigin((id) => extensions[id], {
    token: TOKEN,
    favicons: provider
  })
  const route = (id: string, query = `pageUrl=${encodeURIComponent(PAGE)}&size=16`): string =>
    `${EXTENSION_RESOURCE_SCHEME}://${id}.${TOKEN}/_favicon/?${query}`

  it('names the route for an extension declaring the permission, required or optional', () => {
    const wanted = { extensionId: ID, pageUrl: PAGE, size: 16 }
    expect(origin.faviconUrl(wanted)).toBe(route(ID))
    expect(origin.faviconUrl({ ...wanted, extensionId: OPTIONAL })).toBe(route(OPTIONAL))
    expect(origin.faviconUrl({ ...wanted, extensionId: PLAIN })).toBeUndefined()
    expect(
      origin.faviconUrl({ ...wanted, extensionId: 'dcdefghijklmnopabcdefghijklmnopa' })
    ).toBeUndefined()
  })

  it("serves the page's icon with its type, CORS and a cache life", async () => {
    const response = await origin.serve(route(ID))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })

  it('serves the default globe, briefly cacheable, for a page without one or a request without a page', async () => {
    for (const url of [
      route(ID, `pageUrl=${encodeURIComponent('https://unknown.test/')}`),
      route(ID, 'size=16')
    ]) {
      const response = await origin.serve(url)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(DEFAULT_FAVICON_TYPE)
      expect(response.headers.get('cache-control')).toBe('private, max-age=60')
      expect(await response.text()).toBe(DEFAULT_FAVICON_SVG)
    }
  })

  it('falls back to the default when the provider fails or there is none', async () => {
    const failing = new ExtensionResourceOrigin((id) => extensions[id], {
      token: TOKEN,
      favicons: { faviconFor: () => Promise.reject(new Error('boom')) }
    })
    expect(await (await failing.serve(route(ID))).text()).toBe(DEFAULT_FAVICON_SVG)
    const bare = new ExtensionResourceOrigin((id) => extensions[id], { token: TOKEN })
    expect(await (await bare.serve(route(ID))).text()).toBe(DEFAULT_FAVICON_SVG)
  })

  it('refuses the route for an extension without the permission and keeps the token check', async () => {
    expect((await origin.serve(route(PLAIN))).status).toBe(403)
    const wrongToken = `${EXTENSION_RESOURCE_SCHEME}://${ID}.${TOKEN.replace('0', '1')}/_favicon/?pageUrl=x`
    expect((await origin.serve(wrongToken)).status).toBe(404)
    // The exact path only: a file under it is a package path like any other.
    expect(
      (await origin.serve(`${EXTENSION_RESOURCE_SCHEME}://${ID}.${TOKEN}/_favicon/x.png`)).status
    ).toBe(403)
  })
})

describe('faviconRequestHandler', () => {
  const origin = new ExtensionResourceOrigin((id) => extensions[id], { token: TOKEN })
  const granted = new Set([ID])
  const handler = faviconRequestHandler(origin, (id) => granted.has(id))
  const request = {} as HostRequest
  const details = (url: string): BeforeRequestDetails =>
    ({ url, method: 'GET' }) as BeforeRequestDetails

  it('runs before the rule engine', () => {
    expect(handler.order).toBe(FAVICON_HANDLER_ORDER)
    expect(handler.order).toBeLessThan(HANDLER_ORDER.ruleEngine)
    expect(handler.id).toBe('extension-favicon')
  })

  it('redirects a granted extension to the served route with the page and size carried over', () => {
    const result = handler.onBeforeRequest?.(request, details(faviconRequest(ID, PAGE, 32)))
    expect(result).toEqual({
      redirectURL: `${EXTENSION_RESOURCE_SCHEME}://${ID}.${TOKEN}/_favicon/?pageUrl=${encodeURIComponent(PAGE)}&size=32`
    })
  })

  it('cancels the request of an extension without the grant, an undeclared one, or an unknown one', () => {
    // Declared optional but not granted yet.
    expect(handler.onBeforeRequest?.(request, details(faviconRequest(OPTIONAL)))).toEqual({
      cancel: true
    })
    granted.add(OPTIONAL)
    expect(handler.onBeforeRequest?.(request, details(faviconRequest(OPTIONAL)))).toMatchObject({
      redirectURL: expect.stringContaining(`${OPTIONAL}.${TOKEN}/_favicon/`)
    })
    // Granted in the store somehow, but the manifest never declared it: the origin refuses.
    granted.add(PLAIN)
    expect(handler.onBeforeRequest?.(request, details(faviconRequest(PLAIN)))).toEqual({
      cancel: true
    })
    granted.add('dcdefghijklmnopabcdefghijklmnopa')
    expect(
      handler.onBeforeRequest?.(
        request,
        details(faviconRequest('dcdefghijklmnopabcdefghijklmnopa'))
      )
    ).toEqual({ cancel: true })
  })

  it('fails a malformed favicon request and leaves every other request alone', () => {
    expect(
      handler.onBeforeRequest?.(request, details(`chrome-extension://${ID}/_favicon/`))
    ).toEqual({ cancel: true })
    expect(
      handler.onBeforeRequest?.(request, details(`chrome-extension://${ID}/popup.html`))
    ).toBeUndefined()
    expect(
      handler.onBeforeRequest?.(request, details(`chrome-extension://${ID}/_favicon/x.png`))
    ).toBeUndefined()
    expect(
      handler.onBeforeRequest?.(request, details('https://news.example/_favicon/?pageUrl=x'))
    ).toBeUndefined()
  })
})
