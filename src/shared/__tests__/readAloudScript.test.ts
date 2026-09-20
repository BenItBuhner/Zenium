// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  READ_ALOUD_MARK_ATTRIBUTE,
  elementAt,
  extract,
  installReadAloud,
  keptBlocks,
  onReadAloudSentence,
  paintHighlight,
  pathOf,
  rangeFor,
  readerArticle,
  readerBlocks,
  walkBlocks
} from '../readAloudScript'
import {
  READ_ALOUD_SENTENCE_HIGHLIGHT,
  READ_ALOUD_WORD_HIGHLIGHT,
  blocksFromHtml,
  type ReadAloudExtraction,
  type ReadAloudHighlightMessage,
  type ReadAloudHostMessage
} from '../readAloud'

// ---------------------------------------------------------------------------
// The CSS Custom Highlight API, which happy-dom lacks: a registry of named highlights.
// ---------------------------------------------------------------------------

class FakeHighlight {
  ranges: Range[]
  constructor(...ranges: Range[]) {
    this.ranges = ranges
  }
  add(range: Range): void {
    this.ranges.push(range)
  }
  clear(): void {
    this.ranges = []
  }
}

const registry = new Map<string, FakeHighlight>()

/** The text a named highlight paints, or null when none is registered. */
const painted = (name: string): string | null => {
  const highlight = registry.get(name)
  if (!highlight) return null
  return highlight.ranges.map((r) => r.toString()).join('|')
}

function installHighlightApi(): void {
  const w = window as unknown as { Highlight?: unknown }
  w.Highlight = FakeHighlight
  // happy-dom's `CSS` object takes no new members: stand in for it with the registry attached.
  Object.defineProperty(window, 'CSS', {
    value: { highlights: registry },
    configurable: true,
    writable: true
  })
}

const PAGE_HTML = `
  <header><h1>Site name</h1><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
  <main>
    <h1>The headline</h1>
    <p>First sentence here. Second   one <b>bold</b> too.</p>
    <p hidden>Hidden text.</p>
    <p aria-hidden="true">Also hidden.</p>
    <ul><li>Item one</li><li lang="fr">Élément deux</li></ul>
    <blockquote><p>Quoted words.</p></blockquote>
    <div role="complementary">Related links</div>
    <figure><img alt="x"><figcaption>A caption.</figcaption></figure>
  </main>
  <aside>Sidebar text.</aside>
  <footer>Footer text.</footer>
`

const highlightMessage = (
  overrides: Partial<ReadAloudHighlightMessage> &
    Pick<ReadAloudHighlightMessage, 'blockId' | 'sentence'>
): ReadAloudHighlightMessage => ({
  type: 'readAloud',
  action: 'highlight',
  tabId: 't1',
  word: null,
  mode: 'both',
  at: null,
  ...overrides
})

describe('readAloud.extract', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('lang', 'en-GB')
    document.title = 'A page'
    document.body.innerHTML = PAGE_HTML
  })

  it('walks the visible main text into blocks with their kinds, languages and positions; the furniture and the hidden stay out', () => {
    const extraction = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r1',
      from: 'top'
    })
    expect(extraction.requestId).toBe('r1')
    expect(extraction.title).toBe('A page')
    expect(extraction.lang).toBe('en-gb')
    expect(extraction.blocks.map((b) => [b.id, b.kind, b.text])).toEqual([
      ['b0', 'heading', 'The headline'],
      ['b1', 'paragraph', 'First sentence here. Second one bold too.'],
      ['b2', 'list-item', 'Item one'],
      ['b3', 'list-item', 'Élément deux'],
      ['b4', 'quote', 'Quoted words.'],
      ['b5', 'caption', 'A caption.']
    ])
    expect(extraction.blocks[3].lang).toBe('fr')
    expect(extraction.blocks[0].lang).toBeUndefined()
    // Positions: `children` paths from the body, the run and a zero offset.
    const main = document.querySelector('main')!
    const mainIndex = Array.prototype.indexOf.call(document.body.children, main)
    expect(extraction.blocks[1].at).toEqual({ path: [mainIndex, 1], run: 0, offset: 0 })
    expect(extraction.blocks[3].at.path).toEqual([mainIndex, 4, 1])
    for (const block of extraction.blocks) {
      expect(elementAt(document.body, block.at.path)).not.toBeNull()
    }
  })

  it('keeps the blocks Readability kept when they cover enough of the article, else the whole walk', () => {
    const all = walkBlocks(document.body, 'en', { skipFurniture: true, visibleOnly: true })
    const kept = keptBlocks(all, ['First sentence   here. Second one bold too.', 'Quoted words.'])
    expect(kept.map((b) => b.text)).toEqual([
      'First sentence here. Second one bold too.',
      'Quoted words.'
    ])
    // A `keep` naming mostly text the page does not have: the heuristic walk stands in.
    const sparse = keptBlocks(all, [
      'Quoted words.',
      'Something Readability made up out of thin air, twice over.'
    ])
    expect(sparse).toBe(all)
    // Through the request: the kept blocks are renumbered from b0.
    const extraction = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r2',
      from: 'top',
      keep: ['The headline', 'Quoted words.']
    })
    expect(extraction.blocks.map((b) => [b.id, b.text])).toEqual([
      ['b0', 'The headline'],
      ['b1', 'Quoted words.']
    ])
  })

  it('a duplicate text in keep matches as many blocks, no more', () => {
    document.body.innerHTML = '<p>Same.</p><p>Same.</p><p>Same.</p><p>Other.</p>'
    const all = walkBlocks(document.body, 'en')
    expect(keptBlocks(all, ['Same.', 'Same.', 'Other.']).map((b) => b.text)).toEqual([
      'Same.',
      'Same.',
      'Other.'
    ])
  })

  it('reads the selection from where it starts to where it ends, across blocks', () => {
    document.body.innerHTML =
      '<p>Alpha beta gamma.</p><p>Delta epsilon.</p><p>Zeta eta theta.</p><p>Iota.</p>'
    const [p1, p2, p3] = Array.from(document.querySelectorAll('p'))
    const range = document.createRange()
    range.setStart(p1.firstChild!, 6) // "beta gamma."
    range.setEnd(p3.firstChild!, 8) // "Zeta eta"
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const extraction = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r3',
      from: 'selection'
    })
    expect(extraction.blocks.map((b) => [b.text, b.at.path, b.at.offset])).toEqual([
      ['beta gamma.', [0], 6],
      ['Delta epsilon.', [1], 0],
      ['Zeta eta', [2], 0]
    ])
    expect(p2.textContent).toBe('Delta epsilon.')
    // A collapsed selection reads nothing.
    selection.removeAllRanges()
    const none = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r4',
      from: 'selection'
    })
    expect(none.blocks).toEqual([])
  })

  it('a selection that starts mid-run maps its offset through the whitespace collapse', () => {
    document.body.innerHTML = '<p>\n   Lead   in <i>and</i>  more   text here.</p>'
    const p = document.querySelector('p')!
    const range = document.createRange()
    range.setStart(p.firstChild!, 11) // just before "in"
    range.setEnd(p.lastChild!, p.lastChild!.textContent!.length)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    const extraction = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r5',
      from: 'selection'
    })
    expect(extraction.blocks).toHaveLength(1)
    expect(extraction.blocks[0].text).toBe('in and more text here.')
    expect(extraction.blocks[0].at.offset).toBe('Lead '.length)
  })

  it('selection-on: the selection first, then the rest of its last block and the blocks after it, nothing twice (EDGE-11)', () => {
    document.body.innerHTML =
      '<p>Alpha beta gamma.</p><p>Delta epsilon.</p><p>Zeta eta theta. Iota kappa.</p><p>Lambda.</p><nav>Menu</nav>'
    const [p1, , p3] = Array.from(document.querySelectorAll('p'))
    const range = document.createRange()
    range.setStart(p1.firstChild!, 6) // "beta gamma."
    range.setEnd(p3.firstChild!, 8) // "Zeta eta"
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const extraction = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r6',
      from: 'selection',
      then: 'document'
    })
    expect(extraction.blocks.map((b) => [b.id, b.text, b.at.path, b.at.offset])).toEqual([
      ['b0', 'beta gamma.', [0], 6],
      ['b1', 'Delta epsilon.', [1], 0],
      ['b2', 'Zeta eta', [2], 0],
      // The rest of the last block from where the selection ended, then what follows – the
      // selection's own walk (no furniture rule: a selection may sit in a nav), so the nav rides.
      ['b3', 'theta. Iota kappa.', [2], 9],
      ['b4', 'Lambda.', [3], 0],
      ['b5', 'Menu', [4], 0]
    ])
    // Readability's blocks, when they cover the page, keep the continuation to the main content.
    const kept = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r7',
      from: 'selection',
      then: 'document',
      keep: ['Alpha beta gamma.', 'Delta epsilon.', 'Zeta eta theta. Iota kappa.', 'Lambda.']
    })
    expect(kept.blocks.map((b) => b.text)).toEqual([
      'beta gamma.',
      'Delta epsilon.',
      'Zeta eta',
      'theta. Iota kappa.',
      'Lambda.'
    ])
    // A selection that ends exactly at a block's end leaves no remainder; the next blocks follow.
    range.setEnd(p1.firstChild!, p1.firstChild!.textContent!.length)
    selection.removeAllRanges()
    selection.addRange(range)
    const toEnd = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r8',
      from: 'selection',
      then: 'document',
      keep: ['Alpha beta gamma.', 'Delta epsilon.', 'Zeta eta theta. Iota kappa.', 'Lambda.']
    })
    expect(toEnd.blocks.map((b) => b.text)).toEqual([
      'beta gamma.',
      'Delta epsilon.',
      'Zeta eta theta. Iota kappa.',
      'Lambda.'
    ])
    // Without `then`, the selection alone.
    const alone = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r9',
      from: 'selection'
    })
    expect(alone.blocks.map((b) => b.text)).toEqual(['beta gamma.'])
  })

  it('answers the host through the transport', () => {
    let listener: ((message: ReadAloudHostMessage) => void) | null = null
    const sent: ReadAloudExtraction[] = []
    installReadAloud({
      send: (message) => sent.push(message.readAloud),
      onReadAloud: (l) => {
        listener = l
      }
    })
    listener!({ type: 'readAloud', action: 'extract', requestId: 'r9', from: 'top' })
    expect(sent).toHaveLength(1)
    expect(sent[0].requestId).toBe('r9')
    expect(sent[0].blocks[0].text).toBe('The headline')
  })

  it('pathOf and elementAt are inverses from the root', () => {
    const li = document.querySelector('li[lang]')!
    const path = pathOf(li, document.body)
    expect(elementAt(document.body, path)).toBe(li)
    expect(pathOf(document.body, document.body)).toEqual([])
    expect(elementAt(document.body, [99])).toBeNull()
  })
})

describe('readAloud.highlight', () => {
  beforeEach(() => {
    installHighlightApi()
    registry.clear()
    document.documentElement.setAttribute('lang', 'en')
    document.body.innerHTML = PAGE_HTML
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const at = (blockText: string): { path: number[]; run: number; offset: number } => {
    const block = walkBlocks(document.body, 'en').find((b) => b.text === blockText)!
    return { path: pathOf(block.ref, document.body), run: block.run, offset: 0 }
  }

  it('paints the sentence and the word as Ranges over the page’s own text nodes', () => {
    const text = 'First sentence here. Second one bold too.'
    paintHighlight(
      document,
      highlightMessage({
        blockId: 'b1',
        at: at(text),
        sentence: { start: 21, end: text.length },
        word: { start: 11, end: 15 }
      })
    )
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toBe('Second   one bold too.')
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toBe('bold')
    // The next word, across into the trailing text node.
    paintHighlight(
      document,
      highlightMessage({
        blockId: 'b1',
        at: at(text),
        sentence: { start: 21, end: text.length },
        word: { start: 16, end: 20 }
      })
    )
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toBe('too.')
  })

  it('a word range stops before the space that follows it, even a collapsed run', () => {
    const text = 'First sentence here. Second one bold too.'
    paintHighlight(
      document,
      highlightMessage({
        blockId: 'b1',
        at: at(text),
        sentence: { start: 21, end: text.length },
        word: { start: 0, end: 6 },
        mode: 'word'
      })
    )
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toBe('Second')
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toBeNull()
  })

  it('the mode chooses what is painted; off clears both', () => {
    const text = 'The headline'
    const message = highlightMessage({
      blockId: 'b0',
      at: at(text),
      sentence: { start: 0, end: 12 },
      word: { start: 4, end: 12 },
      mode: 'sentence'
    })
    paintHighlight(document, message)
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toBe('The headline')
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toBeNull()
    paintHighlight(document, { ...message, mode: 'both' })
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toBe('headline')
    paintHighlight(document, { ...message, mode: 'off' })
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toBeNull()
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toBeNull()
  })

  it('a block that starts mid-run (a selection’s first) offsets its ranges', () => {
    document.body.innerHTML = '<p>Alpha beta gamma delta.</p>'
    paintHighlight(
      document,
      highlightMessage({
        blockId: 'b0',
        at: { path: [0], run: 0, offset: 6 },
        sentence: { start: 0, end: 17 },
        word: { start: 5, end: 10 }
      })
    )
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toBe('beta gamma delta.')
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toBe('gamma')
  })

  it('a position the document no longer has paints nothing', () => {
    paintHighlight(
      document,
      highlightMessage({
        blockId: 'b7',
        at: { path: [40, 2], run: 0, offset: 0 },
        sentence: { start: 0, end: 5 }
      })
    )
    expect(registry.size).toBe(0)
  })

  it('scrolls the sentence into view when it is off screen, once per sentence', () => {
    const text = 'Quoted words.'
    const rect = { top: 2000, bottom: 2020, width: 100, height: 20 }
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      const message = highlightMessage({
        blockId: 'b4',
        at: at(text),
        sentence: { start: 0, end: 13 }
      })
      paintHighlight(document, message)
      expect(scrolled).toHaveLength(1)
      expect(scrolled[0].textContent).toBe('Quoted words.')
      // A word event within the same sentence does not scroll again.
      paintHighlight(document, { ...message, word: { start: 7, end: 13 } })
      expect(scrolled).toHaveLength(1)
      // On screen: no scroll.
      vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 10,
        bottom: 30,
        width: 100,
        height: 20
      } as DOMRect)
      paintHighlight(
        document,
        highlightMessage({ blockId: 'b0', at: at('The headline'), sentence: { start: 0, end: 12 } })
      )
      expect(scrolled).toHaveLength(1)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('rangeFor maps collapsed offsets back onto the raw text', () => {
    document.body.innerHTML = '<p>  One   two<span> three </span>four  </p>'
    const [block] = walkBlocks(document.body, 'en')
    expect(block.text).toBe('One two three four')
    expect(rangeFor(document, block, 0, 3)!.toString()).toBe('One')
    expect(rangeFor(document, block, 4, 7)!.toString()).toBe('two')
    expect(rangeFor(document, block, 8, 13)!.toString()).toBe('three')
    expect(rangeFor(document, block, 14, 18)!.toString()).toBe('four')
    expect(rangeFor(document, block, 4, 13)!.toString()).toBe('two three')
    expect(rangeFor(document, block, 5, 5)).toBeNull()
  })

  it('paints nothing in a window without the highlight API, but still announces and follows the sentence', () => {
    const w = window as unknown as { Highlight?: unknown }
    delete w.Highlight
    // The previous session's clear (the core sends `off` on stop) resets what was painted last.
    paintHighlight(
      document,
      highlightMessage({ blockId: '', sentence: { start: 0, end: 0 }, mode: 'off' })
    )
    const announced: Array<string | null> = []
    onReadAloudSentence((range) => announced.push(range ? range.toString() : null))
    paintHighlight(
      document,
      highlightMessage({ blockId: 'b0', at: at('The headline'), sentence: { start: 0, end: 12 } })
    )
    expect(registry.size).toBe(0)
    expect(announced).toEqual(['The headline'])
    paintHighlight(
      document,
      highlightMessage({ blockId: 'b0', sentence: { start: 0, end: 0 }, mode: 'off' })
    )
    expect(announced).toEqual(['The headline', null])
  })

  it('scrolls by the sentence’s own rect when the document scrolls, so a long paragraph’s sentence lands in view', () => {
    const scroller = document.scrollingElement ?? document.documentElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 2000,
      bottom: 2020,
      width: 100,
      height: 20
    } as DOMRect)
    const scrolledBy: number[] = []
    const scrollBy = vi.fn((options: { top: number }) => scrolledBy.push(options.top))
    Object.defineProperty(window, 'scrollBy', {
      value: scrollBy,
      configurable: true,
      writable: true
    })
    const elementScrolls: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      elementScrolls.push(this)
    }
    try {
      paintHighlight(
        document,
        highlightMessage({
          blockId: 'b4',
          at: at('Quoted words.'),
          sentence: { start: 0, end: 13 }
        })
      )
      // The sentence's top lands 30% down the view: 2000 - 800 * 0.3.
      expect(scrolledBy).toEqual([1760])
      expect(elementScrolls).toHaveLength(0)
    } finally {
      Element.prototype.scrollIntoView = original
      delete (scroller as unknown as Record<string, unknown>).scrollHeight
      delete (scroller as unknown as Record<string, unknown>).clientHeight
    }
  })
})

describe('the reader document', () => {
  const setUrl = (url: string): void => {
    const g = globalThis as typeof globalThis & { happyDOM?: { setURL(url: string): void } }
    g.happyDOM?.setURL(url)
  }
  const ARTICLE =
    '<h2>Head</h2><div>Intro text <p>Nested para.</p> tail text</div><p>Body one. Body <em>two</em>.</p><ul><li lang="fr">Bonjour</li></ul>'

  beforeEach(() => {
    installHighlightApi()
    registry.clear()
    setUrl('zen://reader?id=a1&url=https%3A%2F%2Fexample.com%2Farticle')
    document.documentElement.setAttribute('lang', 'en')
    document.title = 'The article'
    document.body.innerHTML = `<nav class="toolbar">A− A+</nav><main><header><h1>The article</h1></header><article>${ARTICLE}</article></main>`
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setUrl('about:blank')
  })

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('answers extract from its own article: the same blocks the core walks from the HTML, with positions', () => {
    expect(readerArticle(document)).toBe(document.querySelector('article'))
    const extraction = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r1',
      from: 'top'
    })
    expect(extraction.title).toBe('The article')
    expect(extraction.lang).toBe('en')
    expect(
      extraction.blocks.map((b) => [b.id, b.kind, b.text, b.lang ?? '', b.at.path, b.at.run])
    ).toEqual([
      ['b0', 'heading', 'Head', '', [0], 0],
      ['b1', 'paragraph', 'Intro text', '', [1], 0],
      ['b2', 'paragraph', 'Nested para.', '', [1, 0], 0],
      ['b3', 'paragraph', 'tail text', '', [1], 1],
      ['b4', 'paragraph', 'Body one. Body two.', '', [2], 0],
      ['b5', 'list-item', 'Bonjour', 'fr', [3, 0], 0]
    ])
    // The chrome of the reader page (its toolbar, the title row) is not the article's text.
    expect(extraction.blocks.some((b) => b.text.includes('A−') || b.text === 'The article')).toBe(
      false
    )
    // The same blocks the core's HTML walk names (`blocksFromHtml`): ids line up.
    expect(blocksFromHtml(ARTICLE, 'en').map((b) => [b.id, b.text])).toEqual(
      extraction.blocks.map((b) => [b.id, b.text])
    )
  })

  it('paints a highlight by position, or by b<index> against its own walk when the core has no positions', () => {
    // By index (the core walked the article's HTML: no `at`).
    paintHighlight(document, highlightMessage({ blockId: 'b4', sentence: { start: 10, end: 19 } }))
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toBe('Body two.')
    // By position (the reader document's own extraction).
    paintHighlight(
      document,
      highlightMessage({
        blockId: 'b3',
        at: { path: [1], run: 1, offset: 0 },
        sentence: { start: 0, end: 9 },
        word: { start: 5, end: 9 }
      })
    )
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toBe('tail text')
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toBe('text')
  })

  it('its walk is cached until the article changes; marks split the text without moving the blocks or their paths', async () => {
    const article = document.querySelector('article')!
    const before = readerBlocks(article, 'en')
    expect(readerBlocks(article, 'en')).toBe(before)
    // A mark (the extras' syllable dot) splits "Intro text" in two text nodes and adds an
    // element child before the nested <p>: the blocks, texts and paths stand.
    const div = article.querySelector('div')!
    const intro = div.firstChild as Text
    const rest = intro.splitText(3)
    const mark = document.createElement('span')
    mark.setAttribute(READ_ALOUD_MARK_ATTRIBUTE, 'syllable')
    div.insertBefore(mark, rest)
    await tick()
    const after = readerBlocks(article, 'en')
    expect(after).not.toBe(before)
    expect(after.map((b) => b.text)).toEqual(before.map((b) => b.text))
    const extraction = extract(document, {
      type: 'readAloud',
      action: 'extract',
      requestId: 'r2',
      from: 'top'
    })
    expect(extraction.blocks[2]).toMatchObject({ text: 'Nested para.', at: { path: [1, 0] } })
    expect(elementAt(article, [1, 0])).toBe(div.querySelector('p'))
    expect(pathOf(div.querySelector('p')!, article)).toEqual([1, 0])
    // The highlight spans the split: one range over both text nodes.
    paintHighlight(document, highlightMessage({ blockId: 'b1', sentence: { start: 0, end: 10 } }))
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toBe('Intro text')
  })
})
