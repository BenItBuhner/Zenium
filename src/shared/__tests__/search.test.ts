import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RELEVANCE,
  DEFAULT_SEARCH_ENGINES,
  buildSearchUrl,
  completeWwwCom,
  customSearchEngine,
  editedSearchEngine,
  engineFieldFavicon,
  engineKeywordProblem,
  engineKeywords,
  imageSearchByAddress,
  imageSearchFor,
  isActiveSearchEngine,
  matchEngineKeyword,
  matchEngineWord,
  matchKeyword,
  matchKeywordWord,
  normalizeEngineKeyword,
  parseSuggestPayload,
  parseSuggestResponse,
  sanitizeSearchEngines,
  searchTermsFromUrl,
  withDefaultSearchEngineActive,
  withSearchEngineActive
} from '../search'
import { searchCommands } from '../commands'
import type { FormFactor, HostCapabilities, SearchEngine } from '../types'

const google = DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'google')!

describe('search engines', () => {
  it('ships Google, DuckDuckGo and Ecosia (the onboarding choices)', () => {
    const ids = DEFAULT_SEARCH_ENGINES.map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['google', 'duckduckgo', 'ecosia']))
  })

  it('encodes queries into the search template', () => {
    expect(buildSearchUrl(google, 'zen browser & co')).toBe(
      'https://www.google.com/search?q=zen%20browser%20%26%20co'
    )
  })

  describe('the image search an engine defines (CT-32, Chrome’s image_url + image_url_post_params)', () => {
    const image = 'https://pics.example/a b.png?v=2&s=l'
    const bing = DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'bing')!
    const yandex: SearchEngine = {
      id: 'custom:yandex',
      name: 'Yandex',
      searchUrl: 'https://yandex.com/search/?text=%s',
      suggestUrl: null,
      keyword: '@yandex',
      glyph: 'Y',
      source: 'custom',
      imageSearch: { name: 'Yandex', url: 'https://yandex.com/images/search?rpt=imageview&url=%s' }
    }
    const uploader: SearchEngine = {
      ...yandex,
      id: 'custom:uploader',
      name: 'Uploader',
      imageSearch: {
        name: 'Uploader',
        url: 'https://up.example/?url=%s',
        post: {
          url: 'https://up.example/upload',
          params: 'img={imageThumbnail}',
          encoding: 'multipart',
          thumbnail: { maxSide: 640, minArea: 0 }
        }
      }
    }

    it('uploads the bytes to Google Lens for Google: Chrome’s image_url and multipart post params, the Lens path’s 1000 px thumbnail', () => {
      expect(imageSearchFor(google, image)).toEqual({
        kind: 'upload',
        engine: 'Google Lens',
        imageUrl: image,
        post: {
          url: 'https://lens.google.com/v3/upload',
          params:
            'encoded_image={imageThumbnail},image_url={imageURL},sbisrc={imageSearchSource},original_width={imageOriginalWidth},original_height={imageOriginalHeight},processed_image_dimensions={processedImageDimensions}',
          encoding: 'multipart',
          // lens::kMaxPixelsForImageSearch and kImageSearchThumbnailMinSize (300 × 300).
          thumbnail: { maxSide: 1000, minArea: 90_000 }
        }
      })
    })

    it('uploads the thumbnail base64 to Bing’s visual search for Bing, urlencoded, the generic 600 px thumbnail', () => {
      expect(imageSearchFor(bing, 'http://pics.example/a.png')).toEqual({
        kind: 'upload',
        engine: 'Bing',
        imageUrl: 'http://pics.example/a.png',
        post: {
          url: 'https://www.bing.com/images/detail/search?iss=sbiupload&FORM=CHROMI#enterInsights',
          params: 'imageBin={imageThumbnailBase64}',
          encoding: 'urlencoded',
          // kImageSearchThumbnailMaxWidth/Height and kImageSearchThumbnailMinSize.
          thumbnail: { maxSide: 600, minArea: 90_000 }
        }
      })
    })

    it('keeps the address form for Google and Bing too (a record from before the upload)', () => {
      expect(imageSearchByAddress(google, image)).toEqual({
        kind: 'address',
        engine: 'Google Lens',
        url: 'https://lens.google.com/uploadbyurl?url=https%3A%2F%2Fpics.example%2Fa%20b.png%3Fv%3D2%26s%3Dl'
      })
      expect(imageSearchByAddress(bing, 'http://pics.example/a.png')).toEqual({
        kind: 'address',
        engine: 'Bing',
        url: 'https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:http%3A%2F%2Fpics.example%2Fa.png'
      })
    })

    it('sends the address for an engine with a template and no post (Yandex), naming its product', () => {
      expect(imageSearchFor(yandex, 'https://pics.example/a.png')).toEqual({
        kind: 'address',
        engine: 'Yandex',
        url: 'https://yandex.com/images/search?rpt=imageview&url=https%3A%2F%2Fpics.example%2Fa.png'
      })
    })

    it('encodes the address once: ? and & inside it survive as %3F and %26, the template’s own stay', () => {
      const url = imageSearchByAddress(bing, image)!.url
      expect(url).toBe(
        'https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:https%3A%2F%2Fpics.example%2Fa%20b.png%3Fv%3D2%26s%3Dl'
      )
      expect(new URL(url).searchParams.get('q')).toBe(`imgurl:${image}`)
      expect(url).not.toContain('%253A')
    })

    it.each(['duckduckgo', 'ecosia', 'wikipedia'])('has none for %s, which defines none', (id) => {
      const engine = DEFAULT_SEARCH_ENGINES.find((e) => e.id === id)!
      expect(engine.imageSearch).toBeUndefined()
      expect(imageSearchFor(engine, image)).toBeNull()
      expect(imageSearchByAddress(engine, image)).toBeNull()
    })

    it('has none for a hand-added engine (the Search form defines none)', () => {
      const custom = customSearchEngine(
        'Kagi',
        'https://kagi.com/search?q=%s',
        DEFAULT_SEARCH_ENGINES
      )
      expect(custom.imageSearch).toBeUndefined()
      expect(imageSearchFor(custom, image)).toBeNull()
    })

    it.each(['data:image/png;base64,AAAA', 'blob:https://x.example/1'])(
      'uploads a %s image for an engine with a post – the bytes are what travels – with no address',
      (src) => {
        expect(imageSearchFor(google, src)).toMatchObject({ kind: 'upload', imageUrl: '' })
        expect(imageSearchFor(bing, src)).toMatchObject({ kind: 'upload', imageUrl: '' })
        expect(imageSearchFor(uploader, src)).toMatchObject({ kind: 'upload', imageUrl: '' })
        expect(imageSearchFor(yandex, src)).toBeNull()
        expect(imageSearchByAddress(google, src)).toBeNull()
      }
    )

    it.each(['file:///a.png', 'about:blank', ''])(
      'has none for an address no page can read back and no engine can fetch (%s)',
      (src) => {
        expect(imageSearchFor(google, src)).toBeNull()
        expect(imageSearchFor(bing, src)).toBeNull()
        expect(imageSearchFor(yandex, src)).toBeNull()
      }
    )

    it('keeps a stored engine’s valid image search and drops a broken one (the sync record is additive)', () => {
      const [kept] = sanitizeSearchEngines([yandex])
      expect(kept.imageSearch).toEqual(yandex.imageSearch)
      const broken = [
        { ...yandex, id: 'custom:a', imageSearch: { name: 'A', url: 'https://a.example/i' } },
        { ...yandex, id: 'custom:b', imageSearch: { name: 'B', url: 'https://b.example/%s/%s' } },
        { ...yandex, id: 'custom:c', imageSearch: { name: '', url: 'https://c.example/?u=%s' } },
        { ...yandex, id: 'custom:d', imageSearch: { name: 'D', url: 'ftp://d.example/?u=%s' } },
        { ...yandex, id: 'custom:e', imageSearch: 'https://e.example/?u=%s' },
        { ...yandex, id: 'custom:f', imageSearch: undefined }
      ]
      for (const engine of sanitizeSearchEngines(broken)) {
        expect(engine.imageSearch, engine.id).toBeUndefined()
        expect(imageSearchFor(engine, image), engine.id).toBeNull()
      }
      // A record from before the field has no row; an edit keeps a field the record had.
      const edited = editedSearchEngine(
        kept,
        { name: 'Yandex Images', searchUrl: kept.searchUrl, keyword: '@yandex' },
        [kept]
      )
      expect(edited.imageSearch).toEqual(yandex.imageSearch)
    })

    it('keeps a stored engine’s valid post (an https endpoint, params, one of the two encodings) and drops a broken one', () => {
      const [kept] = sanitizeSearchEngines([uploader])
      expect(kept.imageSearch).toEqual(uploader.imageSearch)
      expect(imageSearchFor(kept, 'data:image/png;base64,AAAA')).toMatchObject({ kind: 'upload' })
      // Plain http only on the user's own machine (a loopback host: the bytes and the engine's
      // cookies never reach a wire); anywhere else the row searches by address.
      for (const url of [
        'http://127.0.0.1:8080/upload',
        'http://localhost/upload',
        'http://dev.localhost:3000/upload',
        'http://[::1]/upload'
      ]) {
        const [local] = sanitizeSearchEngines([
          {
            ...uploader,
            imageSearch: { ...uploader.imageSearch, post: { ...uploader.imageSearch!.post!, url } }
          }
        ])
        expect(local.imageSearch!.post?.url, url).toBe(url)
      }
      const [clear] = sanitizeSearchEngines([
        {
          ...uploader,
          imageSearch: {
            ...uploader.imageSearch,
            post: { ...uploader.imageSearch!.post!, url: 'http://up.example/upload' }
          }
        }
      ])
      expect(clear.imageSearch).toEqual({ name: 'Uploader', url: 'https://up.example/?url=%s' })
      expect(imageSearchFor(clear, image)).toMatchObject({ kind: 'address' })
      const trimmed = sanitizeSearchEngines([
        {
          ...uploader,
          imageSearch: {
            ...uploader.imageSearch,
            post: {
              url: ' https://up.example/upload ',
              params: ' img={imageThumbnail} ',
              encoding: 'urlencoded',
              thumbnail: { maxSide: 640, minArea: 0 }
            }
          }
        }
      ])[0]
      expect(trimmed.imageSearch!.post).toEqual({
        url: 'https://up.example/upload',
        params: 'img={imageThumbnail}',
        encoding: 'urlencoded',
        thumbnail: { maxSide: 640, minArea: 0 }
      })
      const base = uploader.imageSearch!.post!
      const broken = [
        { ...base, url: 'ftp://up.example/upload' },
        { ...base, url: 'not a url' },
        { ...base, url: '' },
        { ...base, params: '' },
        { ...base, params: '   ' },
        { ...base, encoding: 'json' },
        { ...base, encoding: undefined },
        'https://up.example/upload',
        42
      ]
      broken.forEach((post, i) => {
        const [engine] = sanitizeSearchEngines([
          { ...uploader, id: `custom:p${i}`, imageSearch: { ...uploader.imageSearch, post } }
        ])
        // The template survives, the row searches by address.
        expect(engine.imageSearch, String(i)).toEqual({
          name: 'Uploader',
          url: 'https://up.example/?url=%s'
        })
        expect(imageSearchFor(engine, image), String(i)).toMatchObject({ kind: 'address' })
        expect(imageSearchFor(engine, 'data:image/png;base64,AAAA'), String(i)).toBeNull()
      })
    })

    it('keeps a stored engine’s own thumbnail bounds, and gives one without (or with broken ones) the generic engine’s', () => {
      const withBounds = (thumbnail: unknown): SearchEngine =>
        sanitizeSearchEngines([
          {
            ...uploader,
            imageSearch: {
              ...uploader.imageSearch,
              post: { ...uploader.imageSearch!.post!, thumbnail }
            }
          }
        ])[0]!
      expect(withBounds({ maxSide: 640, minArea: 0 }).imageSearch!.post!.thumbnail).toEqual({
        maxSide: 640,
        minArea: 0
      })
      expect(withBounds({ maxSide: 8192, minArea: 250_000 }).imageSearch!.post!.thumbnail).toEqual({
        maxSide: 8192,
        minArea: 250_000
      })
      // The area may reach the side squared: the pair still says "within the side".
      expect(withBounds({ maxSide: 600, minArea: 360_000 }).imageSearch!.post!.thumbnail).toEqual({
        maxSide: 600,
        minArea: 360_000
      })
      // A record from before the field, or one no canvas could honour, or a pair that contradicts
      // itself (an area above the side squared would carry an image over the side at its own
      // size): Chrome's generic numbers.
      for (const broken of [
        undefined,
        null,
        'big',
        { maxSide: 0, minArea: 0 },
        { maxSide: 8193, minArea: 0 },
        { maxSide: 600.5, minArea: 0 },
        { maxSide: 600, minArea: -1 },
        { maxSide: 600, minArea: 'none' },
        { maxSide: 600, minArea: 360_001 },
        { maxSide: 1000, minArea: 8192 * 8192 },
        { maxSide: 600 },
        { minArea: 0 }
      ]) {
        expect(withBounds(broken).imageSearch!.post!.thumbnail, JSON.stringify(broken)).toEqual({
          maxSide: 600,
          minArea: 90_000
        })
      }
    })

    it('never stores the shipped engines, so their post never syncs (the definition is the build’s)', () => {
      expect(sanitizeSearchEngines([google, bing])).toEqual([])
    })
  })

  it('parses OpenSearch array and Ecosia object responses', () => {
    expect(parseSuggestResponse(['zen', ['zen browser', 'zen garden']])).toEqual([
      'zen browser',
      'zen garden'
    ])
    expect(parseSuggestResponse({ suggestions: ['a', { value: 'b' }] })).toEqual(['a', 'b'])
    expect(parseSuggestResponse('garbage')).toEqual([])
  })

  it('detects engine keywords like "@ddg query"', () => {
    const hit = matchEngineKeyword('@ddg privacy browser', DEFAULT_SEARCH_ENGINES)
    expect(hit?.engine.id).toBe('duckduckgo')
    expect(hit?.query).toBe('privacy browser')
    expect(matchEngineKeyword('@ddg', DEFAULT_SEARCH_ENGINES)).toBeNull()
  })

  it('queries Google as client=chrome, the keyless payload with types and relevance', () => {
    expect(google.suggestUrl).toContain('client=chrome')
  })

  it('reads the typed Google payload: types, descriptions, relevance, verbatim', () => {
    const payload = parseSuggestPayload([
      'gith',
      ['github', 'https://github.com/', '= 4'],
      ['', 'GitHub', ''],
      [],
      {
        'google:suggesttype': ['QUERY', 'NAVIGATION', 'CALCULATOR'],
        'google:suggestrelevance': [1252, 800, 1250],
        'google:verbatimrelevance': 851
      }
    ])
    expect(payload.verbatimRelevance).toBe(851)
    expect(payload.suggestions).toEqual([
      { text: 'github', type: 'query', description: '', relevance: 1252 },
      { text: 'https://github.com/', type: 'navigation', description: 'GitHub', relevance: 800 },
      { text: '= 4', type: 'calculator', description: '', relevance: 1250 }
    ])
  })

  it('reads plain OpenSearch payloads as query rows with descending default relevance', () => {
    const payload = parseSuggestPayload(['cat', ['cats', 'cat food', 7, 'cat videos']])
    expect(payload.verbatimRelevance).toBeNull()
    expect(payload.suggestions.map((s) => [s.text, s.type, s.relevance])).toEqual([
      ['cats', 'query', DEFAULT_RELEVANCE],
      ['cat food', 'query', DEFAULT_RELEVANCE - 1],
      ['cat videos', 'query', DEFAULT_RELEVANCE - 2]
    ])
    expect(parseSuggestPayload({ suggestions: [{ value: 'eco' }] }).suggestions[0]).toMatchObject({
      text: 'eco',
      type: 'query'
    })
    expect(parseSuggestPayload('garbage').suggestions).toEqual([])
  })

  it('matches keywords for engines and the built-in scopes, as typed', () => {
    expect(matchKeyword('@bookmarks foo bar', DEFAULT_SEARCH_ENGINES)).toEqual({
      kind: 'scope',
      scope: 'bookmarks',
      keyword: '@bookmarks',
      query: 'foo bar'
    })
    expect(matchKeyword('@History x', DEFAULT_SEARCH_ENGINES)).toMatchObject({ scope: 'history' })
    expect(matchKeyword('@tabs ', DEFAULT_SEARCH_ENGINES)).toMatchObject({
      scope: 'tabs',
      query: ''
    })
    expect(matchKeyword('@duckduckgo cats', DEFAULT_SEARCH_ENGINES)).toMatchObject({
      kind: 'engine',
      keyword: '@duckduckgo',
      query: 'cats'
    })
    expect(matchKeyword('@wikipedia cats', DEFAULT_SEARCH_ENGINES)).toMatchObject({
      kind: 'engine',
      engine: expect.objectContaining({ id: 'wikipedia' })
    })
    expect(matchKeyword('@nope cats', DEFAULT_SEARCH_ENGINES)).toBeNull()
    expect(matchKeyword('ddg cats', DEFAULT_SEARCH_ENGINES)).toBeNull()
    expect(matchKeywordWord('@ddg', DEFAULT_SEARCH_ENGINES)).toMatchObject({ kind: 'engine' })
    expect(matchKeywordWord('@dd', DEFAULT_SEARCH_ENGINES)).toBeNull()
    expect(engineKeywords(google)).toEqual(['@google'])
    expect(engineKeywords(DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'duckduckgo')!)).toEqual([
      '@ddg',
      '@duckduckgo'
    ])
  })

  it('completes a bare word to www.<word>.com for Ctrl+Enter and leaves the rest alone', () => {
    expect(completeWwwCom('example')).toBe('www.example.com')
    expect(completeWwwCom(' zenium ')).toBe('www.zenium.com')
    expect(completeWwwCom('example/docs?x=1')).toBe('www.example.com/docs?x=1')
    expect(completeWwwCom('example.org')).toBe('example.org')
    expect(completeWwwCom('localhost:3000')).toBe('localhost:3000')
    expect(completeWwwCom('two words')).toBe('two words')
    expect(completeWwwCom('https://x')).toBe('https://x')
    expect(completeWwwCom('')).toBe('')
  })

  it('marks a field with the engine’s favicon whichever engine it is, the vendor’s default included (v2 §6, NTP-09)', () => {
    // The vendor's default leads the field too: §6 gives the engine's favicon, not the choice's.
    expect(engineFieldFavicon(google)).toBe('https://www.google.com/favicon.ico')
    // Every shipped engine carries its site's icon in the registry, and every one shows it.
    for (const engine of DEFAULT_SEARCH_ENGINES) {
      expect(engine.favicon).toMatch(/^https:\/\/.+\/favicon\.ico$/)
      expect(engineFieldFavicon(engine)).toBe(engine.favicon)
    }
    // A user's engine whose site offered no icon shows none: the slot falls back.
    expect(engineFieldFavicon({ favicon: null })).toBeNull()
    expect(engineFieldFavicon({})).toBeNull()
    expect(engineFieldFavicon({ favicon: 'https://s.example/i.png' })).toBe(
      'https://s.example/i.png'
    )
  })

  it("reads the terms out of an engine's results page, its own additions and `+` aside; another engine's page or path is not one", () => {
    expect(searchTermsFromUrl(google, buildSearchUrl(google, 'two words'))).toBe('two words')
    expect(
      searchTermsFromUrl(
        google,
        'https://www.google.com/search?q=two+words&sourceid=chrome&ie=UTF-8'
      )
    ).toBe('two words')
    // `www.` aside, the host must be the engine's; the path too.
    expect(searchTermsFromUrl(google, 'https://google.com/search?q=cats')).toBe('cats')
    expect(searchTermsFromUrl(google, 'https://www.google.com/maps?q=cats')).toBeNull()
    expect(searchTermsFromUrl(google, 'https://duckduckgo.com/?q=cats')).toBeNull()
    expect(searchTermsFromUrl(google, 'https://www.google.com/search?tbm=isch')).toBeNull()
    expect(searchTermsFromUrl(google, 'https://www.google.com/search?q=')).toBeNull()
    expect(searchTermsFromUrl(google, 'not a url')).toBeNull()
    const ddg = DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'duckduckgo')!
    expect(searchTermsFromUrl(ddg, 'https://duckduckgo.com/?q=cats&t=h_&ia=web')).toBe('cats')
    // A template with the terms in its path is not read.
    expect(
      searchTermsFromUrl(
        { searchUrl: 'https://example.com/find/%s' },
        'https://example.com/find/cats'
      )
    ).toBeNull()
  })
})

describe('search engines: the shortcut and the active flag (omnibox-09, settings-43)', () => {
  const own = customSearchEngine(
    'Marginalia',
    'https://marginalia.example/?q=%s',
    DEFAULT_SEARCH_ENGINES
  )
  const all = [...DEFAULT_SEARCH_ENGINES, own]

  it('normalises a typed shortcut to one lower-case @word, or none', () => {
    expect(normalizeEngineKeyword('wiki')).toBe('@wiki')
    expect(normalizeEngineKeyword(' @Wiki ')).toBe('@wiki')
    expect(normalizeEngineKeyword('')).toBeNull()
    expect(normalizeEngineKeyword('   ')).toBeNull()
    expect(normalizeEngineKeyword('two words')).toBeNull()
    expect(normalizeEngineKeyword('@')).toBeNull()
    expect(normalizeEngineKeyword('x'.repeat(65))).toBeNull()
    expect(normalizeEngineKeyword('x'.repeat(64))).toBe(`@${'x'.repeat(64)}`)
  })

  it('names why a shortcut cannot be an engine’s: spaces, length, Zenium’s scopes, another engine’s word', () => {
    // Empty is no problem: the derived shortcut stands in.
    expect(engineKeywordProblem('', own.id, all)).toBeNull()
    expect(engineKeywordProblem('mg', own.id, all)).toBeNull()
    // The engine's own current shortcut is fine for itself.
    expect(engineKeywordProblem(own.keyword, own.id, all)).toBeNull()
    expect(engineKeywordProblem('two words', own.id, all)).toBe(
      'A shortcut is one word, with no spaces'
    )
    expect(engineKeywordProblem('x'.repeat(65), own.id, all)).toBe('The shortcut is too long')
    expect(engineKeywordProblem('@tabs', own.id, all)).toBe(
      '@tabs is one of Zenium’s own shortcuts'
    )
    expect(engineKeywordProblem('bookmarks', own.id, all)).toBe(
      '@bookmarks is one of Zenium’s own shortcuts'
    )
    // Another engine's keyword, id and name are all its words.
    expect(engineKeywordProblem('ddg', own.id, all)).toBe('DuckDuckGo already answers to @ddg')
    expect(engineKeywordProblem('@DuckDuckGo', own.id, all)).toBe(
      'DuckDuckGo already answers to @duckduckgo'
    )
  })

  it('a bare @ is a word missing, not a word too long: its own line, spaces around it or not', () => {
    // `normalizeEngineKeyword('@')` is null as a 65-character word's is; the reason differs.
    expect(engineKeywordProblem('@', own.id, all)).toBe('Type a word after the @')
    expect(engineKeywordProblem(' @ ', own.id, all)).toBe('Type a word after the @')
    expect(engineKeywordProblem('@w', own.id, all)).toBeNull()
    // The long word keeps its line.
    expect(engineKeywordProblem(`@${'x'.repeat(65)}`, own.id, all)).toBe('The shortcut is too long')
  })

  it('an engine being added has no id: given one no engine has, every engine’s word is another’s', () => {
    // `sanitizeSearchEngine` keeps no engine with an empty id, so '' names none of them.
    expect(engineKeywordProblem('ddg', '', all)).toBe('DuckDuckGo already answers to @ddg')
    expect(engineKeywordProblem(own.keyword, '', all)).toBe(
      `${own.name} already answers to ${own.keyword}`
    )
    expect(engineKeywordProblem('fresh', '', all)).toBeNull()
  })

  it('an added engine takes the shortcut the form typed, normalised as an edit’s is; empty or not given, one derived from the name (W5-4)', () => {
    // Typed: `@` added when left off, lower case – `normalizeEngineKeyword`'s word.
    const typed = customSearchEngine('Wiki', 'https://wiki.example/w?search=%s', all, ' Wiki ')
    expect(typed.keyword).toBe('@wiki')
    expect(customSearchEngine('Wiki', 'https://wiki.example/w?search=%s', all, '@WP').keyword).toBe(
      '@wp'
    )
    // Empty, or not given at all (the callers before the form carried one): derived from the
    // name, unique among the engines – `@google` is the shipped engine's, so `2`.
    expect(customSearchEngine('Google', 'https://mirror.example/?q=%s', all, '').keyword).toBe(
      '@google2'
    )
    expect(customSearchEngine('Google', 'https://mirror.example/?q=%s', all).keyword).toBe(
      '@google2'
    )
    // A word that cannot be a shortcut (spaces) is null to the normaliser and derives too: the
    // caller refuses it before this with `engineKeywordProblem`, as the core does.
    expect(customSearchEngine('Wiki', 'https://wiki.example/?q=%s', all, 'two words').keyword).toBe(
      '@wiki'
    )
    // The rest of the engine is as without a shortcut.
    expect(typed).toMatchObject({
      id: 'custom:wiki',
      name: 'Wiki',
      searchUrl: 'https://wiki.example/w?search=%s',
      suggestUrl: null,
      glyph: 'W',
      source: 'custom',
      favicon: null
    })
  })

  it('edits name, shortcut and template; an empty shortcut derives from the new name, unique', () => {
    const edited = editedSearchEngine(
      own,
      {
        name: '  Marginalia Search  ',
        searchUrl: ' https://search.marginalia.nu/search?query=%s ',
        keyword: 'MS'
      },
      all
    )
    expect(edited).toMatchObject({
      id: own.id,
      name: 'Marginalia Search',
      searchUrl: 'https://search.marginalia.nu/search?query=%s',
      keyword: '@ms',
      glyph: 'M',
      source: 'custom'
    })
    // An empty shortcut derives one from the name; `@google` is the shipped engine's, so `2`.
    const derived = editedSearchEngine(
      own,
      { name: 'Google', searchUrl: own.searchUrl, keyword: '' },
      all
    )
    expect(derived.keyword).toBe('@google2')
    // The engine's own current shortcut never counts against itself.
    const same = editedSearchEngine(
      own,
      { name: 'Marginalia', searchUrl: own.searchUrl, keyword: '' },
      all
    )
    expect(same.keyword).toBe('@marginalia')
  })

  it('an edited discovered engine becomes the user’s own, its visit stamp gone', () => {
    const discovered = {
      ...own,
      id: 'discovered:marginalia.example',
      source: 'discovered' as const,
      visitedAt: 1234
    }
    const edited = editedSearchEngine(
      discovered,
      { name: 'Marginalia', searchUrl: discovered.searchUrl, keyword: 'mg' },
      [...DEFAULT_SEARCH_ENGINES, discovered]
    )
    expect(edited.source).toBe('custom')
    expect(edited.visitedAt).toBeUndefined()
    expect(edited.id).toBe('discovered:marginalia.example')
  })

  it('deactivates and activates by the flag alone: absent is active, `false` is not', () => {
    expect(isActiveSearchEngine(own)).toBe(true)
    expect(isActiveSearchEngine({ active: true })).toBe(true)
    expect(isActiveSearchEngine({ active: false })).toBe(false)
    const off = withSearchEngineActive([own], own.id, false)
    expect(off[0].active).toBe(false)
    const on = withSearchEngineActive(off, own.id, true)
    expect('active' in on[0]).toBe(false)
    // Another id leaves the list as it was.
    expect(withSearchEngineActive([own], 'nope', false)).toEqual([own])
  })

  it('a deactivated engine answers to no keyword, host or name until activated', () => {
    const inactive = { ...own, active: false }
    const engines = [...DEFAULT_SEARCH_ENGINES, inactive]
    expect(matchKeywordWord('@marginalia', engines)).toBeNull()
    expect(matchKeyword('@marginalia cats', engines)).toBeNull()
    expect(matchEngineKeyword('@marginalia cats', engines)).toBeNull()
    expect(matchEngineWord('marginalia.example', engines)).toBeNull()
    expect(matchEngineWord('marginalia', engines, true)).toBeNull()
    // The shipped engines beside it still answer.
    expect(matchKeywordWord('@ddg', engines)).toMatchObject({ kind: 'engine' })
    // Activated, it answers again.
    const active = withSearchEngineActive([inactive], own.id, true)
    expect(matchKeywordWord('@marginalia', [...DEFAULT_SEARCH_ENGINES, ...active])).toMatchObject({
      kind: 'engine',
      keyword: '@marginalia'
    })
  })

  it('an engine made the default while deactivated comes back active, the flag deleted; the other engines keep theirs; nothing to do leaves the same list (A7)', () => {
    const other = { ...own, id: 'custom:other', name: 'Other', keyword: '@other', active: false }
    const list = [{ ...own, active: false }, other]
    const made = withDefaultSearchEngineActive(list, own.id)
    expect(made).not.toBe(list)
    expect('active' in made[0]).toBe(false)
    expect(isActiveSearchEngine(made[0])).toBe(true)
    expect(made[1]).toEqual(other)
    // Its shortcut answers again.
    expect(matchKeywordWord('@marginalia', [...DEFAULT_SEARCH_ENGINES, ...made])).toMatchObject({
      kind: 'engine',
      keyword: '@marginalia'
    })
    // The default active already, or a shipped engine (not one of the user's): the same list.
    expect(withDefaultSearchEngineActive(made, own.id)).toBe(made)
    expect(withDefaultSearchEngineActive(list, 'google')).toBe(list)
  })

  it('the sanitiser keeps `active: false` and drops any other value of the flag', () => {
    const stored = JSON.parse(
      JSON.stringify([
        { ...own, active: false },
        { ...own, id: 'custom:2', keyword: '@two', active: true },
        { ...own, id: 'custom:3', keyword: '@three', active: 'yes' }
      ])
    )
    const read = sanitizeSearchEngines(stored)
    expect(read.map((e) => e.active)).toEqual([false, undefined, undefined])
  })
})

describe('command bar', () => {
  it('finds commands by label and keyword', () => {
    expect(searchCommands('compact').map((c) => c.action)).toContain('compact.toggle')
    expect(searchCommands('split grid').map((c) => c.action)).toContain('split.grid')
    expect(searchCommands('')).toEqual([])
  })

  it('offers each layout the commands that act on its chrome', () => {
    const caps = new Proxy({} as HostCapabilities, { get: () => true })
    const actions = (formFactor: FormFactor, query: string): string[] =>
      searchCommands(query, { capabilities: caps, formFactor }).map((c) => c.action)
    // Compact mode is the desktop's hover-revealed sidebar: not the tablet's (its rail is the
    // toolbar's toggle) nor the phone's (no sidebar).
    expect(actions('desktop', 'compact')).toContain('compact.toggle')
    expect(actions('tablet', 'compact')).not.toContain('compact.toggle')
    expect(actions('tablet', 'floating sidebar')).not.toContain('compact.toggleSidebar')
    expect(actions('phone', 'compact')).not.toContain('compact.toggle')
    // The sidebar layouts share the sidebar width toggle and Split View.
    expect(actions('tablet', 'sidebar width')).toContain('sidebar.toggle')
    expect(actions('tablet', 'split grid')).toContain('split.grid')
    expect(actions('phone', 'split grid')).not.toContain('split.grid')
  })
})
