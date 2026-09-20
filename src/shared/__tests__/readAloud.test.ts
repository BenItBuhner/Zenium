import { afterEach, describe, expect, it } from 'vitest'
import {
  BlockCollector,
  DEFAULT_READ_ALOUD_SETTINGS,
  READ_ALOUD_RATES,
  baseLanguage,
  blocksFromHtml,
  collapseWhitespace,
  decodeHtmlEntities,
  normalizeLanguageTag,
  readAloudExtractionOf,
  resolveReadAloudVoice,
  sanitizeReadAloudRate,
  sanitizeReadAloudSettings,
  segmentSentences,
  splitSentencesFallback,
  stepReadAloudRate,
  voiceForLanguage,
  voicesByLanguage,
  type ReadAloudBlock,
  type ReadAloudVoice
} from '../readAloud'

const block = (id: string, text: string, kind: ReadAloudBlock['kind'] = 'paragraph', lang?: string): ReadAloudBlock =>
  lang ? { id, kind, text, lang } : { id, kind, text }

describe('read aloud settings and the rate ladder', () => {
  it('sanitises stored settings from any version', () => {
    expect(sanitizeReadAloudSettings(undefined)).toEqual(DEFAULT_READ_ALOUD_SETTINGS)
    expect(sanitizeReadAloudSettings({ rate: 'fast', highlight: 'rainbow', voiceByLanguage: 3 })).toEqual(
      DEFAULT_READ_ALOUD_SETTINGS
    )
    expect(
      sanitizeReadAloudSettings({
        rate: 9,
        highlight: 'word',
        voiceByLanguage: { 'EN_us': 'Alex', fr: '', '???': 'x', de: 42 }
      })
    ).toEqual({ rate: 4, highlight: 'word', voiceByLanguage: { 'en-us': 'Alex' } })
  })

  it('clamps rates to the ladder range with two decimals', () => {
    expect(sanitizeReadAloudRate(0.1)).toBe(0.5)
    expect(sanitizeReadAloudRate(1.234)).toBe(1.23)
    expect(sanitizeReadAloudRate(NaN)).toBe(1)
    expect(sanitizeReadAloudRate('2')).toBe(1)
  })

  it('steps up and down Chrome’s ladder with sticky ends', () => {
    expect(READ_ALOUD_RATES).toEqual([0.5, 0.8, 1, 1.2, 1.5, 2, 3, 4])
    expect(stepReadAloudRate(1, 1)).toBe(1.2)
    expect(stepReadAloudRate(1, -1)).toBe(0.8)
    expect(stepReadAloudRate(1.1, 1)).toBe(1.2)
    expect(stepReadAloudRate(1.1, -1)).toBe(1)
    expect(stepReadAloudRate(4, 1)).toBe(4)
    expect(stepReadAloudRate(0.5, -1)).toBe(0.5)
    expect(stepReadAloudRate(2, 0)).toBe(2)
  })
})

describe('languages and voices (contract 2.4)', () => {
  const voices: ReadAloudVoice[] = [
    { id: 'Google US English', name: 'Google US English', lang: 'en-US', local: false },
    { id: 'Daniel', name: 'Daniel', lang: 'en-GB', local: true },
    { id: 'Samantha', name: 'Samantha', lang: 'en-US', local: true, default: true },
    { id: 'Amélie', name: 'Amélie', lang: 'fr-CA', local: true },
    { id: 'Thomas', name: 'Thomas', lang: 'fr-FR', local: false },
    { id: 'Kyoko', name: 'Kyoko', lang: 'ja-JP', local: true }
  ]

  it('normalises tags', () => {
    expect(normalizeLanguageTag('EN_us')).toBe('en-us')
    expect(normalizeLanguageTag(' fr ')).toBe('fr')
    expect(normalizeLanguageTag('english')).toBe('')
    expect(normalizeLanguageTag(null)).toBe('')
    expect(baseLanguage('en-GB')).toBe('en')
  })

  it('resolves the per-language default: the user’s choice, the engine’s default, exact tag, local base match, remote base match', () => {
    // The user's choice for the tag wins while its voice exists.
    expect(voiceForLanguage(voices, 'en-US', { 'en-us': 'Daniel' })).toBe('Daniel')
    // The user's choice for the base language covers its regions.
    expect(voiceForLanguage(voices, 'en-GB', { en: 'Samantha' })).toBe('Samantha')
    // A choice whose voice is gone falls through.
    expect(voiceForLanguage(voices, 'en-US', { 'en-us': 'Gone' })).toBe('Samantha')
    // The engine's default for the exact tag before the first listed.
    expect(voiceForLanguage(voices, 'en-US')).toBe('Samantha')
    // The first listed for the exact tag.
    expect(voiceForLanguage(voices, 'fr-FR')).toBe('Thomas')
    // No exact tag: the first local voice of the base language.
    expect(voiceForLanguage(voices, 'en-AU')).toBe('Samantha')
    expect(voiceForLanguage(voices, 'fr')).toBe('Amélie')
    // Only remote voices of the base language: the first remote one.
    expect(voiceForLanguage([voices[0]], 'en-GB')).toBe('Google US English')
    // No voice at all for the language.
    expect(voiceForLanguage(voices, 'de')).toBeNull()
    expect(voiceForLanguage(voices, '')).toBeNull()
  })

  it('falls back to the UI language’s voice and flags it; no-voice only when the engine has none', () => {
    expect(resolveReadAloudVoice(voices, 'ja', {}, 'en')).toEqual({ voiceId: 'Kyoko', fallback: false })
    expect(resolveReadAloudVoice(voices, 'de', {}, 'en-GB')).toEqual({ voiceId: 'Daniel', fallback: true })
    expect(resolveReadAloudVoice(voices, 'de', {}, 'xx')).toEqual({ voiceId: 'Samantha', fallback: true })
    expect(resolveReadAloudVoice([], 'en', {}, 'en')).toEqual({ voiceId: null, fallback: true })
  })

  it('lists a default for every language the voices speak, the preferences applied', () => {
    const byLanguage = voicesByLanguage(voices, { fr: 'Thomas' }, ['de'])
    expect(byLanguage).toEqual({
      en: 'Samantha',
      'en-gb': 'Daniel',
      'en-us': 'Samantha',
      fr: 'Thomas',
      // The user's choice for `fr` covers its regions.
      'fr-ca': 'Thomas',
      'fr-fr': 'Thomas',
      ja: 'Kyoko',
      'ja-jp': 'Kyoko'
    })
  })
})

describe('the sentence walker', () => {
  it('cuts a paragraph into sentences with offsets into the block', () => {
    const blocks = [block('b0', 'Hello there. How are you? Fine!')]
    const sentences = segmentSentences(blocks, 'en')
    expect(sentences.map((s) => s.text)).toEqual(['Hello there.', 'How are you?', 'Fine!'])
    expect(sentences.map((s) => [s.blockId, s.index, s.start, s.end])).toEqual([
      ['b0', 0, 0, 12],
      ['b0', 1, 13, 25],
      ['b0', 2, 26, 31]
    ])
    for (const s of sentences) expect(blocks[0].text.slice(s.start, s.end)).toBe(s.text)
  })

  it('reads headings and list items as one sentence each, drops empty blocks, and numbers across blocks', () => {
    const blocks = [
      block('b0', 'A title. With a stop.', 'heading'),
      block('b1', '   '),
      block('b2', 'Item one. Item one still.', 'list-item'),
      block('b3', 'Body one. Body two.')
    ]
    const sentences = segmentSentences(blocks, 'en')
    expect(sentences.map((s) => [s.blockId, s.text])).toEqual([
      ['b0', 'A title. With a stop.'],
      ['b2', 'Item one. Item one still.'],
      ['b3', 'Body one.'],
      ['b3', 'Body two.']
    ])
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2, 3])
  })

  it('segments a lang-tagged block with its own language (Japanese full stops, no spaces)', () => {
    const blocks = [block('b0', '今日は晴れです。明日は雨でしょう。', 'paragraph', 'ja')]
    const sentences = segmentSentences(blocks, 'en')
    expect(sentences.map((s) => s.text)).toEqual(['今日は晴れです。', '明日は雨でしょう。'])
  })

  it('keeps decimals together and honours closing quotes', () => {
    const sentences = segmentSentences([block('b0', 'It costs 3.50 dollars. "Really?" Yes.')], 'en')
    expect(sentences.map((s) => s.text)).toEqual(['It costs 3.50 dollars.', '"Really?"', 'Yes.'])
  })

  describe('without Intl.Segmenter', () => {
    const original = Intl.Segmenter
    afterEach(() => {
      Object.defineProperty(Intl, 'Segmenter', { value: original, configurable: true, writable: true })
    })

    it('falls back to punctuation boundaries', () => {
      Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true, writable: true })
      expect(splitSentencesFallback('One. Two? Three! "Four." Five')).toEqual([
        [0, 4],
        [4, 9],
        [9, 16],
        [16, 24],
        [24, 29]
      ])
      // The walker's cache is keyed by language: an unseen tag exercises the fallback.
      const sentences = segmentSentences([block('b0', 'One. Two? Three… Four')], 'xx-fallback')
      expect(sentences.map((s) => s.text)).toEqual(['One.', 'Two?', 'Three…', 'Four'])
      const cjk = segmentSentences([block('b0', '一。二！三')], 'yy-fallback')
      expect(cjk.map((s) => s.text)).toEqual(['一。', '二！', '三'])
    })
  })
})

describe('blocks from HTML (the reader article) and the collector', () => {
  it('decodes entities and collapses whitespace', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &#233; &#x1F600; &nbsp;x &unknown;')).toBe(
      'a & b <c> é 😀 \u00a0x &unknown;'
    )
    expect(collapseWhitespace('  a \n\t b\u00a0 c  ')).toBe('a b c')
  })

  it('walks paragraphs, headings, lists, quotes and captions with their kinds and lang', () => {
    const html = `
      <h2>Title <em>here</em></h2>
      <p>First para. Second sentence.</p>
      <ul><li>One</li><li lang="fr">Deux</li></ul>
      <blockquote><p>Quoted words.</p></blockquote>
      <figure><img src="x.png" alt="ignored"><figcaption>A caption</figcaption></figure>
      <p>Line one<br>line two</p>
      <script>ignored()</script><style>p{}</style>
      <p hidden>hidden</p><p aria-hidden="true">also hidden</p>
      <table><tr><td>Cell A</td><td>Cell B</td></tr></table>
    `
    expect(blocksFromHtml(html, 'en')).toEqual([
      { id: 'b0', kind: 'heading', text: 'Title here' },
      { id: 'b1', kind: 'paragraph', text: 'First para. Second sentence.' },
      { id: 'b2', kind: 'list-item', text: 'One' },
      { id: 'b3', kind: 'list-item', text: 'Deux', lang: 'fr' },
      { id: 'b4', kind: 'quote', text: 'Quoted words.' },
      { id: 'b5', kind: 'caption', text: 'A caption' },
      { id: 'b6', kind: 'paragraph', text: 'Line one line two' },
      { id: 'b7', kind: 'other', text: 'Cell A' },
      { id: 'b8', kind: 'other', text: 'Cell B' }
    ])
  })

  it('splits a block’s inline runs around a nested block, and keeps the inline text with its block', () => {
    const html = `<div>Intro text <b>bold</b><p>Inner para</p>tail text</div>`
    expect(blocksFromHtml(html, 'en').map((b) => b.text)).toEqual(['Intro text bold', 'Inner para', 'tail text'])
  })

  it('tolerates omitted end tags and stray ones', () => {
    const html = `<p>One<p>Two<ul><li>a<li>b</ul></p></div><p>Three&nbsp;&amp; four`
    expect(blocksFromHtml(html, 'en').map((b) => b.text)).toEqual(['One', 'Two', 'a', 'b', 'Three & four'])
  })

  it('inherits lang from ancestors and only marks blocks whose language differs from the document’s', () => {
    const html = `<div lang="de"><p>Hallo</p><p lang="en">Hello</p></div><p>Plain</p>`
    expect(blocksFromHtml(html, 'en')).toEqual([
      { id: 'b0', kind: 'paragraph', text: 'Hallo', lang: 'de' },
      { id: 'b1', kind: 'paragraph', text: 'Hello' },
      { id: 'b2', kind: 'paragraph', text: 'Plain' }
    ])
  })

  it('the collector records which element and run a block is, and the pieces it came from', () => {
    const collector = new BlockCollector<string, string>('en', 'root', true)
    collector.open('div', {}, 'div1')
    collector.text('Hello ', 't1')
    collector.text('world', 't2')
    collector.open('p', {}, 'p1')
    collector.text('Inner', 't3')
    collector.close()
    collector.text(' after', 't4')
    collector.close()
    const blocks = collector.finish()
    expect(blocks.map((b) => [b.ref, b.run, b.text])).toEqual([
      ['div1', 0, 'Hello world'],
      ['p1', 0, 'Inner'],
      ['div1', 1, 'after']
    ])
    expect(blocks[0].pieces).toEqual([
      { node: 't1', text: 'Hello ' },
      { node: 't2', text: 'world' }
    ])
  })
})

describe('the extraction off the wire', () => {
  it('validates field by field and drops malformed blocks', () => {
    expect(readAloudExtractionOf(null)).toBeNull()
    expect(readAloudExtractionOf({ requestId: 1, blocks: [] })).toBeNull()
    const extraction = readAloudExtractionOf({
      requestId: 'r1',
      title: 'T',
      lang: 'EN-gb',
      blocks: [
        { id: 'b0', kind: 'heading', text: 'Head', at: { path: [1, 0], run: 0, offset: 0 } },
        { id: 'b1', kind: 'weird', text: 'Body', lang: 'FR', at: { path: [1, 1], run: 1.7, offset: -2 } },
        { id: 'b2', text: 'no position' },
        { id: 'b3', text: 'bad path', at: { path: [-1], run: 0, offset: 0 } },
        'junk'
      ]
    })
    expect(extraction).toEqual({
      requestId: 'r1',
      title: 'T',
      lang: 'en-gb',
      blocks: [
        { id: 'b0', kind: 'heading', text: 'Head', at: { path: [1, 0], run: 0, offset: 0 } },
        { id: 'b1', kind: 'paragraph', text: 'Body', lang: 'fr', at: { path: [1, 1], run: 1, offset: 0 } }
      ]
    })
  })
})

