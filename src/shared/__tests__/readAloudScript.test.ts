// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  elementAt,
  extract,
  installReadAloud,
  keptBlocks,
  paintHighlight,
  pathOf,
  rangeFor,
  walkBlocks
} from '../readAloudScript'
import {
  READ_ALOUD_SENTENCE_HIGHLIGHT,
  READ_ALOUD_WORD_HIGHLIGHT,
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

  it('does nothing in a window without the highlight API', () => {
    const w = window as unknown as { Highlight?: unknown }
    delete w.Highlight
    paintHighlight(
      document,
      highlightMessage({ blockId: 'b0', at: at('The headline'), sentence: { start: 0, end: 12 } })
    )
    expect(registry.size).toBe(0)
  })
})
