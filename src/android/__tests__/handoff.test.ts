import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  documentUrl,
  fetchBundledFeed,
  fetchDeferredDocuments,
  readSpilledBody,
  type HandoffFetch
} from '../handoff'

type Reply =
  { status: number; etag?: string; text: string; textError?: Error; never?: boolean } | Error

/** A `fetch` answering each URL from `replies`, recording what was asked for. */
function fakeFetch(replies: Record<string, Reply>): { fetch: HandoffFetch; urls: string[] } {
  const urls: string[] = []
  const fetch: HandoffFetch = async (url, init) => {
    urls.push(url)
    expect(init).toEqual({ cache: 'no-store' })
    const reply = replies[url]
    if (!reply)
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    if (reply instanceof Error) throw reply
    if (reply.never) return new Promise(() => undefined)
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name) => (name === 'ETag' && reply.etag ? `"${reply.etag}"` : null) },
      text: async () => {
        if (reply.textError) throw reply.textError
        return reply.text
      }
    }
  }
  return { fetch, urls }
}

const ORIGIN = 'https://appassets.androidplatform.net'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('documentUrl', () => {
  it('names a document under the handler path, one or two segments, encoded', () => {
    expect(documentUrl('state.json')).toBe(`${ORIGIN}/zen-docs/state.json`)
    expect(documentUrl('blocking/index.json')).toBe(`${ORIGIN}/zen-docs/blocking/index.json`)
    expect(documentUrl('safebrowsing/a b.json', 'http://dev:5173')).toBe(
      'http://dev:5173/zen-docs/safebrowsing/a%20b.json'
    )
  })
})

describe('fetchDeferredDocuments', () => {
  it('brings every deferred document in by file, in parallel, never through the bridge', async () => {
    const { fetch, urls } = fakeFetch({
      [`${ORIGIN}/zen-docs/safebrowsing/phishing-database.json`]: {
        status: 200,
        etag: '7a120-18f3',
        text: '{"prefixes":"AAAA"}'
      },
      [`${ORIGIN}/zen-docs/blocking/index.json`]: { status: 200, etag: '1f-1', text: '{"sets":[]}' }
    })
    const readSync = vi.fn(() => null)
    const docs = await fetchDeferredDocuments(
      [
        { name: 'safebrowsing/phishing-database.json', bytes: 500000, etag: '7a120-18f3' },
        { name: 'blocking/index.json', bytes: 31, etag: '1f-1' }
      ],
      { fetch, readSync }
    )
    expect(docs).toEqual({
      'safebrowsing/phishing-database.json': '{"prefixes":"AAAA"}',
      'blocking/index.json': '{"sets":[]}'
    })
    expect(urls).toHaveLength(2)
    expect(readSync).not.toHaveBeenCalled()
  })

  it('takes the fetched text when its version tag differs from the manifest (the core rewrote the document meanwhile)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { fetch } = fakeFetch({
      [`${ORIGIN}/zen-docs/state.json`]: { status: 200, etag: '20-9', text: '{"newer":true}' }
    })
    const docs = await fetchDeferredDocuments([{ name: 'state.json', bytes: 30, etag: '1e-8' }], {
      fetch,
      readSync: () => null
    })
    expect(docs).toEqual({ 'state.json': '{"newer":true}' })
    expect(info).toHaveBeenCalledWith(expect.stringContaining('1e-8 → 20-9'))
  })

  it('reads a document the handler has no file for the old way, through the bridge', async () => {
    const { fetch } = fakeFetch({})
    const readSync = vi.fn((name: string) => (name === 'history.json' ? '{"items":[]}' : null))
    const docs = await fetchDeferredDocuments(
      [
        { name: 'history.json', bytes: 12, etag: 'c-1' },
        { name: 'gone.json', bytes: 12, etag: 'c-2' }
      ],
      { fetch, readSync }
    )
    expect(docs).toEqual({ 'history.json': '{"items":[]}' })
    expect(readSync.mock.calls.map(([name]) => name).sort()).toEqual(['gone.json', 'history.json'])
  })

  it('falls back to the bridge when the fetch itself fails (a chrome on another origin)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fetch } = fakeFetch({
      [`http://localhost:5173/zen-docs/state.json`]: new TypeError('Failed to fetch')
    })
    const docs = await fetchDeferredDocuments([{ name: 'state.json', bytes: 9, etag: '9-1' }], {
      fetch,
      readSync: () => '{"ok":1}',
      origin: 'http://localhost:5173'
    })
    expect(docs).toEqual({ 'state.json': '{"ok":1}' })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('falls back to the bridge on an error status that is not 404, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fetch } = fakeFetch({
      [`${ORIGIN}/zen-docs/state.json`]: { status: 500, text: 'boom' }
    })
    const docs = await fetchDeferredDocuments([{ name: 'state.json', bytes: 9, etag: '9-1' }], {
      fetch,
      readSync: () => '{"ok":1}'
    })
    expect(docs).toEqual({ 'state.json': '{"ok":1}' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('answered 500'))
  })

  it('falls back to the bridge when the body cannot be read (a truncated document)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fetch } = fakeFetch({
      [`${ORIGIN}/zen-docs/state.json`]: {
        status: 200,
        etag: '9-1',
        text: '',
        textError: new TypeError('network error')
      }
    })
    const readSync = vi.fn(() => '{"ok":1}')
    const docs = await fetchDeferredDocuments([{ name: 'state.json', bytes: 9, etag: '9-1' }], {
      fetch,
      readSync
    })
    expect(docs).toEqual({ 'state.json': '{"ok":1}' })
    expect(readSync).toHaveBeenCalledWith('state.json')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('gives up on a fetch that never answers and reads the document through the bridge', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fetch } = fakeFetch({
      [`${ORIGIN}/zen-docs/safebrowsing/phishing-database.json`]: {
        status: 200,
        text: '',
        never: true
      },
      [`${ORIGIN}/zen-docs/state.json`]: { status: 200, etag: '9-1', text: '{"fast":true}' }
    })
    const readSync = vi.fn((name: string) =>
      name === 'safebrowsing/phishing-database.json' ? '{"prefixes":"AAAA"}' : null
    )
    const docs = await fetchDeferredDocuments(
      [
        { name: 'safebrowsing/phishing-database.json', bytes: 500000, etag: '7a120-18f3' },
        { name: 'state.json', bytes: 9, etag: '9-1' }
      ],
      { fetch, readSync, timeoutMs: 20 }
    )
    expect(docs).toEqual({
      'safebrowsing/phishing-database.json': '{"prefixes":"AAAA"}',
      'state.json': '{"fast":true}'
    })
    expect(readSync).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('safebrowsing/phishing-database.json'),
      expect.objectContaining({ message: expect.stringContaining('20 ms') })
    )
  })

  it('has nothing to do for a payload without a manifest (an older host, the preview host)', async () => {
    const { fetch, urls } = fakeFetch({})
    expect(await fetchDeferredDocuments(undefined, { fetch, readSync: () => null })).toEqual({})
    expect(await fetchDeferredDocuments([], { fetch, readSync: () => null })).toEqual({})
    expect(urls).toEqual([])
  })
})

describe('readSpilledBody', () => {
  const token = '0123456789abcdef0123456789abcdef'

  it('fetches the body by token and releases the file afterwards', async () => {
    const { fetch, urls } = fakeFetch({
      [`${ORIGIN}/zen-net/${token}`]: { status: 200, text: 'example.com\nexample.org\n' }
    })
    const release = vi.fn()
    const text = await readSpilledBody({ token, bytes: 24 }, fetch, release)
    expect(text).toBe('example.com\nexample.org\n')
    expect(urls).toEqual([`${ORIGIN}/zen-net/${token}`])
    expect(release).toHaveBeenCalledWith(token)
  })

  it('releases the file even when the fetch fails, and reports the failure', async () => {
    const { fetch } = fakeFetch({})
    const release = vi.fn()
    await expect(readSpilledBody({ token, bytes: 24 }, fetch, release)).rejects.toThrow('404')
    expect(release).toHaveBeenCalledWith(token)
  })

  it('releases the file when the body cannot be read, and reports that too', async () => {
    const { fetch } = fakeFetch({
      [`${ORIGIN}/zen-net/${token}`]: {
        status: 200,
        text: '',
        textError: new TypeError('network error')
      }
    })
    const release = vi.fn()
    await expect(readSpilledBody({ token, bytes: 24 }, fetch, release)).rejects.toThrow(
      'network error'
    )
    expect(release).toHaveBeenCalledWith(token)
  })

  it('refuses a token that names no spill file, without asking the host', async () => {
    const { fetch, urls } = fakeFetch({})
    const release = vi.fn()
    await expect(
      readSpilledBody({ token: '../state.json', bytes: 1 }, fetch, release)
    ).rejects.toThrow('token')
    expect(urls).toEqual([])
    expect(release).not.toHaveBeenCalled()
  })
})

describe('fetchBundledFeed', () => {
  it('reads the bundled snapshot from the asset path', async () => {
    const { fetch, urls } = fakeFetch({
      [`${ORIGIN}/assets/safebrowsing/urlhaus.json`]: { status: 200, text: '{"id":"urlhaus"}' }
    })
    expect(await fetchBundledFeed('urlhaus', fetch)).toBe('{"id":"urlhaus"}')
    expect(urls).toEqual([`${ORIGIN}/assets/safebrowsing/urlhaus.json`])
  })

  it('answers null for a feed that is not bundled, an empty asset, a failed fetch or a bad id', async () => {
    const { fetch, urls } = fakeFetch({
      [`${ORIGIN}/assets/safebrowsing/empty.json`]: { status: 200, text: '' },
      [`${ORIGIN}/assets/safebrowsing/broken.json`]: new TypeError('Failed to fetch')
    })
    expect(await fetchBundledFeed('missing', fetch)).toBeNull()
    expect(await fetchBundledFeed('empty', fetch)).toBeNull()
    expect(await fetchBundledFeed('broken', fetch)).toBeNull()
    expect(await fetchBundledFeed('../../state', fetch)).toBeNull()
    expect(urls).toHaveLength(3)
  })
})
