// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path'
// eslint-disable-next-line no-restricted-imports
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_FILTERS_FORMAT, DocumentFilters, optionsIndex } from '../documentFilters'

const LIST = [
  '[Adblock Plus 2.0]',
  '! comment',
  '||ads.example^',
  '-ad-banner.',
  '||malware.example^$all',
  '||phish.example^$document',
  '||scam.example^$doc,important',
  '@@||scam.example^$document',
  '||shop.example/checkout$document,~third-party',
  '@@||trusted.example^$document',
  '@@||partly.example/safe/$document',
  '/^https?:\\/\\/[a-z0-9-]+\\.lander\\.example\\//$document',
  '||regional.example^$document,domain=regional.example|~eu.regional.example',
  '||notdoc.example^$~document',
  '||csp.example^$csp=script-src none,document',
  '||third.example^$document,third-party',
  '||gone.example^$document',
  '||gone.example^$document,badfilter',
  'example.com##.ad',
  ''
].join('\n')

describe('optionsIndex', () => {
  it('finds the options separator and skips dollars inside regular expressions', () => {
    expect(optionsIndex('||a.example^$document')).toBe(12)
    expect(optionsIndex('||a.example^')).toBe(-1)
    expect(optionsIndex('/ads\\.js$/')).toBe(-1)
    expect(optionsIndex('/ads\\.js$/$script,document')).toBe(10)
    expect(optionsIndex("||a.example^$csp=script-src 'none'")).toBe(12)
  })
})

describe('DocumentFilters', () => {
  const filters = DocumentFilters.parse([LIST])

  it('keeps only the lines that apply to documents', () => {
    expect(filters.lines).toEqual([
      '||malware.example^$all',
      '||phish.example^$document',
      '||scam.example^$doc,important',
      '@@||scam.example^$document',
      '||shop.example/checkout$document,~third-party',
      '@@||trusted.example^$document',
      '@@||partly.example/safe/$document',
      '/^https?:\\/\\/[a-z0-9-]+\\.lander\\.example\\//$document',
      '||regional.example^$document,domain=regional.example|~eu.regional.example'
    ])
    expect(filters.size).toBe(9)
    expect(DocumentFilters.EMPTY.size).toBe(0)
    expect(DocumentFilters.EMPTY.decide('https://malware.example/')).toBeNull()
  })

  it('blocks navigations only through $document and $all filters', () => {
    expect(filters.decide('https://ads.example/')).toBeNull()
    expect(filters.decide('https://site.example/-ad-banner.html')).toBeNull()
    expect(filters.decide('https://malware.example/landing')).toEqual({
      action: 'block',
      filter: '||malware.example^$all'
    })
    expect(filters.decide('https://cdn.phish.example/')).toEqual({
      action: 'block',
      filter: '||phish.example^$document'
    })
    expect(filters.decide('https://phish.example.evil/')).toBeNull()
    expect(filters.decide('https://shop.example/checkout/step-2')).toMatchObject({
      action: 'block'
    })
    expect(filters.decide('https://shop.example/basket')).toBeNull()
    expect(filters.decide('https://x1.lander.example/offer')).toMatchObject({ action: 'block' })
    expect(filters.decide('https://lander.example/offer')).toBeNull()
    expect(filters.decide('https://notdoc.example/')).toBeNull()
    expect(filters.decide('https://csp.example/')).toBeNull()
    expect(filters.decide('https://third.example/')).toBeNull()
    expect(filters.decide('https://gone.example/')).toBeNull()
  })

  it('resolves important over exceptions over blocks and honours domain options', () => {
    expect(filters.decide('https://scam.example/')).toEqual({
      action: 'block',
      filter: '||scam.example^$doc,important'
    })
    expect(filters.decide('https://trusted.example/')).toEqual({
      action: 'allow',
      filter: '@@||trusted.example^$document'
    })
    expect(filters.decide('https://www.regional.example/')).toMatchObject({ action: 'block' })
    expect(filters.decide('https://eu.regional.example/')).toBeNull()
  })

  it('reports the $document exception whitelisting a page', () => {
    expect(filters.exception('https://www.trusted.example/page?x=1')).toBe(
      '@@||trusted.example^$document'
    )
    expect(filters.exception('https://partly.example/safe/index.html')).toBe(
      '@@||partly.example/safe/$document'
    )
    expect(filters.exception('https://partly.example/other/')).toBeNull()
    expect(filters.exception('https://malware.example/')).toBeNull()
    expect(filters.exception('https://scam.example/')).toBe('@@||scam.example^$document')
    expect(filters.exception('about:blank')).toBeNull()
  })

  it('parses several lists at once and round-trips its own lines', () => {
    const two = DocumentFilters.parse(['||a.example^$all', '@@||b.example^$document\n||c.example^'])
    expect(two.lines).toEqual(['||a.example^$all', '@@||b.example^$document'])
    const again = DocumentFilters.parse([two.lines.join('\n')])
    expect(again.lines).toEqual(two.lines)
    expect(again.decide('https://a.example/')).toMatchObject({ action: 'block' })
  })

  it('matches a `||host/path` pattern by its host first, and a `||host*` pattern against the URL', () => {
    const f = DocumentFilters.parse([
      [
        '||cdn.example/payload/x.exe$all',
        '||Mixed.Example^trail$document',
        '||port.example:8080/admin$document',
        '||end.example|$document',
        '||prefix.exam*$document',
        '||short.exampl$document',
        '||192.168.0.1/login$document',
        '@@||cdn.example/payload/safe.exe$document'
      ].join('\n')
    ])
    expect(f.size).toBe(8)
    // The path still has to match: the host alone is not enough.
    expect(f.decide('https://cdn.example/payload/x.exe')).toMatchObject({ action: 'block' })
    expect(f.decide('https://files.cdn.example/payload/x.exe')).toMatchObject({ action: 'block' })
    expect(f.decide('https://cdn.example/payload/other.exe')).toBeNull()
    expect(f.decide('https://cdn.example/')).toBeNull()
    expect(f.decide('https://notcdn.example/payload/x.exe')).toBeNull()
    expect(f.decide('https://cdn.example/payload/safe.exe')).toMatchObject({ action: 'allow' })
    expect(f.exception('https://cdn.example/payload/safe.exe')).toBe(
      '@@||cdn.example/payload/safe.exe$document'
    )
    expect(f.decide('https://mixed.example/trail')).toMatchObject({ action: 'block' })
    expect(f.decide('https://mixed.example/other')).toBeNull()
    expect(f.decide('https://port.example:8080/admin')).toMatchObject({ action: 'block' })
    expect(f.decide('https://port.example/admin')).toBeNull()
    expect(f.decide('https://end.example')).toMatchObject({ action: 'block' })
    expect(f.decide('https://end.example/')).toBeNull()
    expect(f.decide('http://192.168.0.1/login')).toMatchObject({ action: 'block' })
    expect(f.decide('http://192.168.0.10/login')).toBeNull()
    // `||prefix.exam*` is a prefix of a hostname, not a host: matched as a pattern against the
    // whole URL, as the regular expression it translates to says.
    expect(f.decide('https://prefix.example/')).toMatchObject({ action: 'block' })
    expect(f.decide('https://prefix.exam.other/')).toMatchObject({ action: 'block' })
    // `||short.exampl` with nothing after the hostname is a host-only filter, as it always was.
    expect(f.decide('https://short.exampl/')).toMatchObject({ action: 'block' })
    expect(f.decide('https://sub.short.exampl/path')).toMatchObject({ action: 'block' })
    expect(f.decide('https://short.example/')).toBeNull()
    expect(f.decide('https://other.example/short.exampl')).toBeNull()
  })

  it('decides a `||host^*…` filter by the hostname, not by the credentials in front of it', () => {
    // uBlock Origin's `||host` anchors to the request's hostname; a URL whose userinfo reads
    // `opera.com@` is a request to `other.example`. The older parse tested every pattern's
    // regular expression against the whole URL, and its `||` anchor (`HOSTNAME_ANCHOR`, which
    // nothing stops at an `@`) accepted the userinfo as the hostname and the `@` or `:` after
    // it as the `^` separator – a false positive on exactly these three easylist lines. The
    // pattern is now filed under its hostname and found through the URL's real one.
    const f = DocumentFilters.parse([
      [
        '||net.geo.opera.com^*utm_source=OFT$document',
        '||opera.com^*admaven$document',
        '||opera.com^*PWNgames$document'
      ].join('\n')
    ])
    expect(f.size).toBe(3)
    expect(f.decide('https://opera.com@other.example/admaven')).toBeNull()
    expect(f.decide('https://x.opera.com@other.example/admaven')).toBeNull()
    expect(f.decide('https://opera.com:pw@other.example/admaven')).toBeNull()
    expect(f.decide('https://net.geo.opera.com@other.example/utm_source=OFT')).toBeNull()
    expect(new URL('https://opera.com:pw@other.example/admaven').hostname).toBe('other.example')
    // The filters themselves are live.
    expect(f.decide('https://opera.com/admaven')).toEqual({
      action: 'block',
      filter: '||opera.com^*admaven$document'
    })
    expect(f.decide('https://www.opera.com/x/PWNgames?y')).toMatchObject({ action: 'block' })
    expect(f.decide('https://net.geo.opera.com/?utm_source=OFT')).toMatchObject({
      action: 'block'
    })
    expect(f.decide('https://other.example/admaven')).toBeNull()
    // Read back from the serialised form: the same.
    const read = DocumentFilters.deserialize(f.serialize())
    expect(read.decide('https://opera.com@other.example/admaven')).toBeNull()
    expect(read.decide('https://opera.com/admaven')).toMatchObject({ action: 'block' })
  })
})

describe('the serialised form', () => {
  /** Every decision the two make for `url`, side by side. */
  function same(a: DocumentFilters, b: DocumentFilters, url: string): void {
    expect(b.decide(url)).toEqual(a.decide(url))
    expect(b.exception(url)).toEqual(a.exception(url))
  }

  it('round-trips the test list: the same lines in the same order, deciding the same', () => {
    const parsed = DocumentFilters.parse([LIST])
    const bytes = parsed.serialize()
    expect(bytes).toBeInstanceOf(Uint8Array)
    const read = DocumentFilters.deserialize(bytes)
    expect(read.lines).toEqual(parsed.lines)
    expect(read.size).toBe(parsed.size)
    for (const url of [
      'https://ads.example/',
      'https://malware.example/landing',
      'https://cdn.phish.example/',
      'https://phish.example.evil/',
      'https://shop.example/checkout/step-2',
      'https://shop.example/basket',
      'https://x1.lander.example/offer',
      'https://lander.example/offer',
      'https://scam.example/',
      'https://trusted.example/',
      'https://www.trusted.example/page?x=1',
      'https://partly.example/safe/index.html',
      'https://partly.example/other/',
      'https://www.regional.example/',
      'https://eu.regional.example/',
      'https://notdoc.example/',
      'https://csp.example/',
      'https://third.example/',
      'https://gone.example/',
      'about:blank'
    ])
      same(parsed, read, url)
    // Read back and written again: the same bytes.
    expect(Buffer.from(read.serialize())).toEqual(Buffer.from(bytes))
    // The empty set has a form too.
    expect(DocumentFilters.deserialize(DocumentFilters.EMPTY.serialize()).size).toBe(0)
    expect(new TextDecoder().decode(DocumentFilters.EMPTY.serialize())).toBe('[1,[],[],[],[],[]]')
    // A pattern shorter than a `||host` – one character, or none at all – parses to a filter,
    // and its form reads back (a user's own list can carry `@@$document`).
    for (const line of ['a$document', '@@$document', '*$document', '|$document', '^$document']) {
      const one = DocumentFilters.parse([line])
      expect(one.size).toBe(1)
      const back = DocumentFilters.deserialize(one.serialize())
      expect(back.lines).toEqual([line])
      for (const url of ['https://x.example/a', 'https://a.example/', 'https://x.example/b?a'])
        same(one, back, url)
    }
  })

  it('writes the same bytes for the same lines (the pin: a change here is a format change)', () => {
    const lines = [
      '||malware.example^$all',
      '@@||scam.example^$document',
      '||cdn.example/payload/x.exe$all,important',
      '||regional.example^$document,domain=regional.example|~eu.regional.example',
      '||case.example/Path$document,match-case',
      '/^https?:\\/\\/[a-z0-9-]+\\.lander\\.example\\//$document',
      'plain-substring$document,denyallow=safe.example'
    ]
    const once = DocumentFilters.parse([lines.join('\n')]).serialize()
    const twice = DocumentFilters.parse(lines).serialize()
    expect(Buffer.from(twice)).toEqual(Buffer.from(once))
    // The format, the lines, then per line: flags (1 exception, 2 important, 4 match-case,
    // 8 host-only), where the pattern ends, the anchor host's length; then the domain lists.
    expect(new TextDecoder().decode(once)).toBe(
      '[1,' +
        '["||malware.example^$all",' +
        '"@@||scam.example^$document",' +
        '"||cdn.example/payload/x.exe$all,important",' +
        '"||regional.example^$document,domain=regional.example|~eu.regional.example",' +
        '"||case.example/Path$document,match-case",' +
        '"/^https?:\\\\/\\\\/[a-z0-9-]+\\\\.lander\\\\.example\\\\//$document",' +
        '"plain-substring$document,denyallow=safe.example"],' +
        '[8,9,2,8,4,0,0],' +
        '[18,17,27,19,19,43,15],' +
        '[15,12,11,16,12,0,0],' +
        '[[3,["regional.example"],["eu.regional.example"]],[6,null,["safe.example"]]]' +
        ']'
    )
    const read = DocumentFilters.deserialize(once)
    expect(read.decide('https://case.example/Path')).toMatchObject({ action: 'block' })
    expect(read.decide('https://case.example/path')).toBeNull()
    expect(read.decide('https://x.example/plain-substring')).toMatchObject({ action: 'block' })
    expect(read.decide('https://safe.example/plain-substring')).toBeNull()
    expect(read.decide('https://cdn.example/payload/x.exe')).toEqual({
      action: 'block',
      filter: '||cdn.example/payload/x.exe$all,important'
    })
  })

  it('refuses bytes of another format or shape, naming the reason, so a caller can parse the text instead', () => {
    const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
    expect(() => DocumentFilters.deserialize(encode([DOCUMENT_FILTERS_FORMAT + 1, []]))).toThrow(
      `document filters: format ${DOCUMENT_FILTERS_FORMAT + 1}, this build reads ${DOCUMENT_FILTERS_FORMAT}`
    )
    expect(() => DocumentFilters.deserialize(encode([0, []]))).toThrow(/format 0/)
    expect(() => DocumentFilters.deserialize(encode({ v: 1 }))).toThrow('not a serialised form')
    expect(() => DocumentFilters.deserialize(encode([]))).toThrow('not a serialised form')
    expect(() => DocumentFilters.deserialize(encode([1]))).toThrow('malformed form')
    expect(() => DocumentFilters.deserialize(encode([1, {}]))).toThrow('malformed form')
    expect(() => DocumentFilters.deserialize(new TextEncoder().encode('[1,["x'))).toThrow()
    expect(() => DocumentFilters.deserialize(new Uint8Array(0))).toThrow()
    const line = '||a.example^$document'
    // A form whose columns do not describe filters: the wrong types or lengths, offsets that do
    // not fit the line, a host-only filter without a host (it would match every URL).
    for (const form of [
      [1, [line], [8], [12], [9]],
      [1, [line], [8], [12], [9], [], 'extra'],
      [1, line, [8], [12], [9], []],
      [1, [0], [8], [12], [9], []],
      [1, [line], ['8'], [12], [9], []],
      [1, [line], [8], [12.5], [9], []],
      [1, [line], [8], [-1], [9], []],
      [1, [line], [], [12], [9], []],
      [1, [line], [8], [12], [9, 0], []],
      [1, [line], [8], [99], [9], []],
      [1, [`@@${line}`], [1], [1], [0], []],
      [1, [line], [8], [12], [11], []],
      [1, [line], [8], [12], [0], []],
      [1, [line], [8], [12], [9], {}],
      [1, [line], [8], [12], [9], [[0, null]]],
      [1, [line], [8], [12], [9], [[1, null, null]]],
      [1, [line], [8], [12], [9], [[0, 'a.example', null]]],
      [1, [line], [8], [12], [9], [[0, null, [1]]]]
    ])
      expect(() => DocumentFilters.deserialize(encode(form))).toThrow('malformed form')
    // Every flag at once, read back as written.
    const full = DocumentFilters.deserialize(
      encode([1, ['@@||a.example^$document,important,match-case'], [15], [14], [9], []])
    )
    expect(full.lines).toEqual(['@@||a.example^$document,important,match-case'])
    expect(full.decide('https://a.example/')).toEqual({
      action: 'allow',
      filter: '@@||a.example^$document,important,match-case'
    })
    expect(full.decide('https://b.example/')).toBeNull()
    // A regular expression the form carries that does not compile matches nothing.
    const bad = DocumentFilters.deserialize(encode([1, ['/(/$document'], [0], [3], [0], []]))
    expect(bad.size).toBe(1)
    expect(bad.decide('https://a.example/(')).toBeNull()
  })

  it('round-trips the bundled lists: every decision on a sample built from their lines is the same', () => {
    const dir = join(__dirname, '../../../../resources/blocking')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      lists: Array<{ file: string }>
    }
    const texts = manifest.lists.map((l) =>
      gunzipSync(readFileSync(join(dir, l.file))).toString('utf8')
    )
    const parsed = DocumentFilters.parse(texts)
    expect(parsed.size).toBeGreaterThan(1000)
    const bytes = parsed.serialize()
    const read = DocumentFilters.deserialize(bytes)
    expect(read.lines).toEqual(parsed.lines)
    expect(Buffer.from(read.serialize())).toEqual(Buffer.from(bytes))
    expect(Buffer.from(DocumentFilters.parse(texts).serialize())).toEqual(Buffer.from(bytes))
    // The sample: for every seventh accepted line – at most four lines per host, since a few
    // hosts (raw.githubusercontent.com) carry thousands of them – its own target URL, that URL
    // under `www.`, its host's root and a sibling path; plus a few unrelated navigations.
    const urls: string[] = [
      'https://example.com/',
      'https://www.google.com/search?q=1',
      'https://user:pw@example.com/path',
      'about:blank'
    ]
    const OPTIONS = /\$[^$]*$/
    const perHost = new Map<string, number>()
    parsed.lines.forEach((line, index) => {
      if (index % 7 !== 0) return
      const body = (line.startsWith('@@') ? line.slice(2) : line).replace(OPTIONS, '')
      if (!body.startsWith('||')) return
      const [host = '', ...path] = body.slice(2).replace(/\^$/, '').split('/')
      const seen = perHost.get(host) ?? 0
      if (seen >= 4) return
      perHost.set(host, seen + 1)
      const p = path.length ? `/${path.join('/')}` : '/'
      urls.push(`https://${host}${p}`, `https://www.${host}${p}`, `https://${host}/`)
      urls.push(`https://${host}${p}-other`)
    })
    expect(urls.length).toBeGreaterThan(1000)
    let blocked = 0
    for (const url of urls) {
      same(parsed, read, url)
      if (read.decide(url)?.action === 'block') blocked++
    }
    expect(blocked).toBeGreaterThan(100)
  }, 60_000)
})
