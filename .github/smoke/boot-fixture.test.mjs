import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BOOT_PAGES,
  DOWNLOAD_FIXTURE,
  FIND_MATCHES,
  FIND_WORD,
  HANGING_PATH,
  bootPageUrls,
  bootPages,
  isWebPage,
  startBootFixture
} from './boot-fixture.mjs'

/** GET `path` from the fixture. */
function get(fixture, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: fixture.port, path }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      })
      .on('error', reject)
  })
}

/** The text of `html` outside its tags, lower-cased, the `<head>` left out. */
const bodyText = (html) =>
  html
    .replace(/^[\s\S]*<body[^>]*>/i, '')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()

const occurrences = (text, word) => text.split(word.toLowerCase()).length - 1

describe('BOOT_PAGES', () => {
  const pages = Object.values(BOOT_PAGES)

  it('names three pages with distinct paths', () => {
    expect(Object.keys(BOOT_PAGES)).toEqual(['first', 'second', 'handoff'])
    expect(new Set(pages.map((p) => p.path)).size).toBe(3)
    for (const p of pages) expect(p.path).toMatch(/^\/[a-z-]+\.html$/)
  })

  it('gives them titles that share no substring, so a sidebar row filter names one page only', () => {
    for (const a of pages) {
      for (const b of pages) {
        if (a === b) continue
        expect(a.title.toLowerCase()).not.toContain(b.title.toLowerCase())
      }
    }
  })

  it('keeps the product name out of the titles: the window-title check must find it in the suffix', () => {
    for (const p of pages) expect(p.title).not.toMatch(/zenium/i)
  })
})

describe('bootPages', () => {
  const origin = 'http://127.0.0.1:4321'
  const pages = bootPages(origin)

  it('serves each page under its path with its title', () => {
    for (const p of Object.values(BOOT_PAGES)) {
      expect(pages[p.path]).toContain(`<title>${p.title}</title>`)
    }
    expect(Object.keys(pages).sort()).toEqual(
      Object.values(BOOT_PAGES)
        .map((p) => p.path)
        .sort()
    )
  })

  it("has the find word exactly FIND_MATCHES times in the first page's body and nowhere in its title", () => {
    const first = pages[BOOT_PAGES.first.path]
    expect(occurrences(bodyText(first), FIND_WORD)).toBe(FIND_MATCHES)
    expect(BOOT_PAGES.first.title.toLowerCase()).not.toContain(FIND_WORD.toLowerCase())
  })

  it('says where the pages came from', () => {
    for (const html of Object.values(pages)) expect(html).toContain(origin)
  })
})

describe('bootPageUrls', () => {
  it('puts every page on the origin, keeping path and title', () => {
    const urls = bootPageUrls('http://127.0.0.1:5000')
    expect(urls.first).toEqual({ ...BOOT_PAGES.first, url: 'http://127.0.0.1:5000/first.html' })
    expect(urls.second.url).toBe('http://127.0.0.1:5000/second.html')
    expect(urls.handoff.url).toBe('http://127.0.0.1:5000/handoff.html')
  })

  it('makes URLs none of which is a prefix of another (startsWith picks one tab)', () => {
    const urls = Object.values(bootPageUrls('http://127.0.0.1:5000')).map((p) => p.url)
    for (const a of urls) for (const b of urls) if (a !== b) expect(b.startsWith(a)).toBe(false)
  })
})

describe('isWebPage', () => {
  it('takes http and https pages and nothing of the app’s own', () => {
    expect(isWebPage('http://127.0.0.1:5000/first.html')).toBe(true)
    expect(isWebPage('https://example.com/')).toBe(true)
    expect(isWebPage('HTTPS://EXAMPLE.COM/')).toBe(true)
    expect(isWebPage('zen://newtab/')).toBe(false)
    expect(isWebPage('zenium://settings')).toBe(false)
    expect(isWebPage('file:///tmp/index.html')).toBe(false)
    expect(isWebPage('about:blank')).toBe(false)
    expect(isWebPage('')).toBe(false)
    expect(isWebPage(undefined)).toBe(false)
  })
})

describe('startBootFixture', () => {
  let fixture
  beforeAll(async () => {
    fixture = await startBootFixture()
  })
  afterAll(() => fixture.close())

  it('binds 127.0.0.1 on an ephemeral port and names the pages on that origin', () => {
    expect(fixture.port).toBeGreaterThan(0)
    expect(fixture.origin).toBe(`http://127.0.0.1:${fixture.port}`)
    for (const [role, page] of Object.entries(BOOT_PAGES)) {
      expect(fixture[role]).toEqual({ ...page, url: `${fixture.origin}${page.path}` })
    }
  })

  it('serves the three pages uncached, a blank favicon and nothing else', async () => {
    for (const page of Object.values(BOOT_PAGES)) {
      const res = await get(fixture, page.path)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.body).toContain(`<title>${page.title}</title>`)
    }
    expect((await get(fixture, '/favicon.ico')).status).toBe(204)
    expect((await get(fixture, '/')).status).toBe(404)
    expect((await get(fixture, '/other.html')).status).toBe(404)
  })

  it('sends the attachment as a download – a type no page renders, uncached, the size it says – and the page linking to it', async () => {
    const { page, file } = DOWNLOAD_FIXTURE
    expect(fixture.download).toEqual({
      page: { ...page, url: `${fixture.origin}${page.path}` },
      file: { ...file, url: `${fixture.origin}${file.path}` }
    })
    const res = await get(fixture, file.path)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${file.filename}"`)
    expect(res.headers['content-length']).toBe(String(file.size))
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.length).toBe(file.size)
    const linked = await get(fixture, page.path)
    expect(linked.status).toBe(200)
    expect(linked.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(linked.body).toContain(`<title>${page.title}</title>`)
    expect(linked.body).toContain(`<a id="${page.linkId}" href="${file.path}">`)
    // Neither is a boot page: the boot family's page table stays the three.
    expect(Object.values(BOOT_PAGES).map((p) => p.path)).not.toContain(page.path)
    expect(Object.keys(bootPages(fixture.origin))).not.toContain(page.path)
  })

  it('logs each request with its path', () => {
    expect(fixture.requests.map((r) => r.path)).toEqual(
      expect.arrayContaining([BOOT_PAGES.first.path, BOOT_PAGES.handoff.path, '/favicon.ico'])
    )
    expect(fixture.requests[0].host).toBe(`127.0.0.1:${fixture.port}`)
  })

  it('names the address that never answers, under no page’s path', () => {
    expect(fixture.hanging).toEqual({ path: HANGING_PATH, url: `${fixture.origin}${HANGING_PATH}` })
    expect(Object.values(BOOT_PAGES).map((p) => p.path)).not.toContain(HANGING_PATH)
    expect(HANGING_PATH).toMatch(/^\/[a-z-]+\.html$/)
  })

  it('holds a request for it without a byte in answer, and lets go when the client does', async () => {
    const req = http.get({ host: '127.0.0.1', port: fixture.port, path: HANGING_PATH })
    let answered = false
    req.on('response', () => (answered = true))
    req.on('error', () => undefined)
    await new Promise((r) => {
      const poll = setInterval(() => {
        if (fixture.held() === 1) {
          clearInterval(poll)
          r()
        }
      }, 5)
    })
    // The request is logged like any other, and sits there: nothing came back.
    expect(fixture.requests.at(-1).path).toBe(HANGING_PATH)
    await new Promise((r) => setTimeout(r, 50))
    expect(answered).toBe(false)
    expect(fixture.held()).toBe(1)
    // The client gives up (a stopped navigation closes its socket): the server forgets it.
    req.destroy()
    await new Promise((r) => {
      const poll = setInterval(() => {
        if (fixture.held() === 0) {
          clearInterval(poll)
          r()
        }
      }, 5)
    })
    expect(answered).toBe(false)
  })

  it('ends a held request when the server closes', async () => {
    const own = await startBootFixture()
    const req = http.get({ host: '127.0.0.1', port: own.port, path: HANGING_PATH })
    const ended = new Promise((r) => {
      req.on('error', (err) => r(err.code))
      req.on('response', () => r('response'))
    })
    await new Promise((r) => {
      const poll = setInterval(() => {
        if (own.held() === 1) {
          clearInterval(poll)
          r()
        }
      }, 5)
    })
    await own.close()
    expect(await ended).toBe('ECONNRESET')
    expect(own.held()).toBe(0)
  })
})
