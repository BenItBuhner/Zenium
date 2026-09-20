import { describe, expect, it } from 'vitest'
import {
  normalizeOffscreenRequest,
  OFFSCREEN_CLOSED_WHILE_LOADING_ERROR,
  OFFSCREEN_INVALID_URL_ERROR,
  OFFSCREEN_LOAD_FAILED_ERROR,
  OFFSCREEN_NONE_ERROR,
  OFFSCREEN_ONLY_ONE_ERROR,
  OFFSCREEN_REASON_REQUIRED_ERROR,
  OFFSCREEN_REASONS,
  OFFSCREEN_TESTING_ERROR,
  resolveOffscreenUrl
} from '../api/offscreen'
import { contextTypeOf } from '../api/runtimeContexts'
import { API_SPEC } from '../api/spec'
import {
  OffscreenApi,
  type OffscreenDocumentHost,
  type OffscreenDocumentPage
} from '../../../main/platform/extensionApi/offscreen'
import type { ApiContext } from '../../../main/platform/extensionApi/types'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

// ---------------------------------------------------------------------------
// Pure: Chrome's checks on createDocument's parameters
// ---------------------------------------------------------------------------

describe('offscreen.createDocument parameters', () => {
  it('resolves a relative URL against the extension root and keeps an absolute one of its own', () => {
    expect(resolveOffscreenUrl(EXT, 'offscreen.html')).toBe(
      `chrome-extension://${EXT}/offscreen.html`
    )
    expect(resolveOffscreenUrl(EXT, '/pages/record.html?x=1#y')).toBe(
      `chrome-extension://${EXT}/pages/record.html?x=1#y`
    )
    expect(resolveOffscreenUrl(EXT, `chrome-extension://${EXT}/a.html`)).toBe(
      `chrome-extension://${EXT}/a.html`
    )
  })

  it('refuses URLs of another origin, like Chrome', () => {
    expect(resolveOffscreenUrl(EXT, `chrome-extension://${OTHER}/a.html`)).toBeNull()
    expect(resolveOffscreenUrl(EXT, 'https://example.com/a.html')).toBeNull()
    expect(() =>
      normalizeOffscreenRequest(EXT, {
        url: 'https://example.com/a.html',
        reasons: ['BLOBS'],
        justification: 'x'
      })
    ).toThrow(OFFSCREEN_INVALID_URL_ERROR)
  })

  it('accepts the documented shape and deduplicates the reasons', () => {
    expect(
      normalizeOffscreenRequest(EXT, {
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'BLOBS', 'USER_MEDIA'],
        justification: 'recording'
      })
    ).toEqual({
      url: `chrome-extension://${EXT}/offscreen.html`,
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'recording'
    })
  })

  it('throws the binding TypeError for missing or mistyped properties and unknown reasons', () => {
    expect(() => normalizeOffscreenRequest(EXT, null)).toThrow(/No matching signature/)
    expect(() =>
      normalizeOffscreenRequest(EXT, { reasons: ['BLOBS'], justification: 'x' })
    ).toThrow(/property 'url': Invalid type: expected string, found undefined/)
    expect(() =>
      normalizeOffscreenRequest(EXT, { url: 'a.html', reasons: 'BLOBS', justification: 'x' })
    ).toThrow(/property 'reasons': Invalid type: expected array, found string/)
    expect(() =>
      normalizeOffscreenRequest(EXT, {
        url: 'a.html',
        reasons: ['BLOBS', 'NOPE'],
        justification: 'x'
      })
    ).toThrow(/property 'reasons': Error at index 1: Value must be one of TESTING, AUDIO_PLAYBACK/)
    expect(() => normalizeOffscreenRequest(EXT, { url: 'a.html', reasons: ['BLOBS'] })).toThrow(
      /property 'justification': Invalid type: expected string, found undefined/
    )
  })

  it('needs at least one reason and refuses TESTING without the switch', () => {
    expect(() =>
      normalizeOffscreenRequest(EXT, { url: 'a.html', reasons: [], justification: 'x' })
    ).toThrow(OFFSCREEN_REASON_REQUIRED_ERROR)
    expect(() =>
      normalizeOffscreenRequest(EXT, { url: 'a.html', reasons: ['TESTING'], justification: 'x' })
    ).toThrow(OFFSCREEN_TESTING_ERROR)
    // An empty justification passes the binding (a string) and the function (unchecked), as in Chrome.
    expect(
      normalizeOffscreenRequest(EXT, { url: 'a.html', reasons: ['DOM_PARSER'], justification: '' })
        .justification
    ).toBe('')
  })

  it("is in the desktop spec as an MV3 namespace gated on the permission, with Chrome's Reason enum", () => {
    const spec = API_SPEC.offscreen
    expect(spec.manifestVersion).toBe(3)
    expect(spec.permissions).toEqual(['offscreen'])
    expect(Object.keys(spec.methods).sort()).toEqual([
      'closeDocument',
      'createDocument',
      'hasDocument'
    ])
    expect(Object.keys((spec.constants as Record<string, Record<string, string>>).Reason)).toEqual([
      ...OFFSCREEN_REASONS
    ])
  })

  it('types the hosted document as OFFSCREEN_DOCUMENT in runtime.getContexts', () => {
    expect(contextTypeOf('offscreen', `chrome-extension://${EXT}/offscreen.html`, {})).toBe(
      'OFFSCREEN_DOCUMENT'
    )
    expect(contextTypeOf('other', `chrome-extension://${EXT}/offscreen.html`, {})).toBe('TAB')
  })
})

// ---------------------------------------------------------------------------
// Router over a fake document host
// ---------------------------------------------------------------------------

interface FakePage extends OffscreenDocumentPage {
  url: string
  closed: boolean
  finish(): void
  fail(message: string): void
  crash(): void
}

function fakeHost(): { host: OffscreenDocumentHost; pages: FakePage[] } {
  const pages: FakePage[] = []
  const host: OffscreenDocumentHost = {
    open(_session, url, onGone) {
      let resolve!: () => void
      let reject!: (error: Error) => void
      const loaded = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      loaded.catch(() => undefined)
      const page: FakePage = {
        url,
        closed: false,
        webContents: { id: pages.length + 1 } as unknown as OffscreenDocumentPage['webContents'],
        loaded,
        finish: () => resolve(),
        fail: (message) => reject(new Error(message)),
        close: () => {
          if (page.closed) return
          page.closed = true
          reject(new Error('document closed'))
        },
        crash: () => {
          page.closed = true
          reject(new Error('document closed'))
          onGone()
        }
      }
      pages.push(page)
      return page
    }
  }
  return { host, pages }
}

function ctxFor(extensionId: string): ApiContext {
  return {
    extensionId,
    extension: { id: extensionId, sessions: [{}] },
    session: {},
    sender: { kind: 'worker' }
  } as unknown as ApiContext
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('OffscreenApi', () => {
  const params = { url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'capture' }

  it('creates one document per extension, resolving once the page has loaded', async () => {
    const { host, pages } = fakeHost()
    const api = new OffscreenApi(host)
    const ctx = ctxFor(EXT)
    expect(api.handlers.hasDocument(ctx)).toBe(false)
    const created = api.handlers.createDocument(ctx, params) as Promise<void>
    let settled = false
    void created.then(() => (settled = true))
    await tick()
    expect(pages).toHaveLength(1)
    expect(pages[0].url).toBe(`chrome-extension://${EXT}/offscreen.html`)
    // Counted from creation, as Chrome's manager counts it.
    expect(api.handlers.hasDocument(ctx)).toBe(true)
    expect(api.hosts(pages[0].webContents)).toBe(true)
    expect(settled).toBe(false)
    pages[0].finish()
    await created
    expect(api.documentOf(EXT)).toEqual({
      url: `chrome-extension://${EXT}/offscreen.html`,
      webContents: pages[0].webContents
    })
  })

  it('refuses a second document while the first exists or still loads', async () => {
    const { host, pages } = fakeHost()
    const api = new OffscreenApi(host)
    const ctx = ctxFor(EXT)
    const first = api.handlers.createDocument(ctx, params) as Promise<void>
    await expect(api.handlers.createDocument(ctx, params)).rejects.toThrow(OFFSCREEN_ONLY_ONE_ERROR)
    pages[0].finish()
    await first
    await expect(api.handlers.createDocument(ctx, params)).rejects.toThrow(OFFSCREEN_ONLY_ONE_ERROR)
    // Another extension is unaffected.
    const other = api.handlers.createDocument(ctxFor(OTHER), params) as Promise<void>
    pages[1].finish()
    await other
    expect(pages).toHaveLength(2)
  })

  it('closeDocument closes the page and frees the slot; with none it fails like Chrome', async () => {
    const { host, pages } = fakeHost()
    const api = new OffscreenApi(host)
    const ctx = ctxFor(EXT)
    expect(() => api.handlers.closeDocument(ctx)).toThrow(OFFSCREEN_NONE_ERROR)
    const created = api.handlers.createDocument(ctx, params) as Promise<void>
    pages[0].finish()
    await created
    api.handlers.closeDocument(ctx)
    expect(pages[0].closed).toBe(true)
    expect(api.handlers.hasDocument(ctx)).toBe(false)
    expect(api.hosts(pages[0].webContents)).toBe(false)
    const again = api.handlers.createDocument(ctx, params) as Promise<void>
    pages[1].finish()
    await again
    expect(api.documentOf(EXT)?.webContents).toBe(pages[1].webContents)
  })

  it("a close while loading fails the pending creation with Chrome's text", async () => {
    const { host, pages } = fakeHost()
    const api = new OffscreenApi(host)
    const ctx = ctxFor(EXT)
    const created = api.handlers.createDocument(ctx, params) as Promise<void>
    await tick()
    api.handlers.closeDocument(ctx)
    await expect(created).rejects.toThrow(OFFSCREEN_CLOSED_WHILE_LOADING_ERROR)
    expect(pages[0].closed).toBe(true)
    expect(api.handlers.hasDocument(ctx)).toBe(false)
  })

  it('a page that fails to load is closed and the creation fails', async () => {
    const { host, pages } = fakeHost()
    const api = new OffscreenApi(host)
    const ctx = ctxFor(EXT)
    const created = api.handlers.createDocument(ctx, params) as Promise<void>
    await tick()
    pages[0].fail('ERR_FILE_NOT_FOUND (-6)')
    await expect(created).rejects.toThrow(OFFSCREEN_LOAD_FAILED_ERROR)
    expect(pages[0].closed).toBe(true)
    expect(api.handlers.hasDocument(ctx)).toBe(false)
  })

  it('a page that goes away on its own frees the slot; the unload of the extension closes it', async () => {
    const { host, pages } = fakeHost()
    const api = new OffscreenApi(host)
    const ctx = ctxFor(EXT)
    const created = api.handlers.createDocument(ctx, params) as Promise<void>
    pages[0].finish()
    await created
    pages[0].crash()
    expect(api.handlers.hasDocument(ctx)).toBe(false)
    const again = api.handlers.createDocument(ctx, params) as Promise<void>
    pages[1].finish()
    await again
    api.unload(EXT)
    expect(pages[1].closed).toBe(true)
    expect(api.handlers.hasDocument(ctx)).toBe(false)
  })

  it('validates the parameters before touching the host', async () => {
    const { host, pages } = fakeHost()
    const api = new OffscreenApi(host)
    await expect(
      api.handlers.createDocument(ctxFor(EXT), { url: 'a.html', reasons: [], justification: 'x' })
    ).rejects.toThrow(OFFSCREEN_REASON_REQUIRED_ERROR)
    expect(pages).toHaveLength(0)
  })
})
