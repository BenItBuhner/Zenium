// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { extract, paintHighlight } from '../readAloudScript'
import {
  READ_ALOUD_SENTENCE_HIGHLIGHT,
  READ_ALOUD_WORD_HIGHLIGHT,
  segmentSentences,
  type ReadAloudBlock,
  type ReadAloudExtractRequest,
  type ReadAloudHighlightMessage
} from '../readAloud'

/**
 * EDGE-12: read aloud from the selection toolbar starts playback AT the selected text. The
 * phone's toolbar item runs `readAloud.start { from: 'selection-on' }` (`core/menus.ts`,
 * `selectionActions`), which asks the page for `{ from: 'selection', then: 'document' }`
 * (`core/readAloud.ts` `start`) and speaks from sentence 0 (`startIndex`: 0 for a string
 * `from`). So what the first utterance is, and where the highlight begins, is decided by the
 * page script's `selectionBlocks` (services', `readAloudScript.ts`) and the shared sentence walk
 * – pure functions, pinned here from the consumer's side: the selection's words come first, cut
 * from where the finger's selection starts, the paragraphs before it are not in the text at
 * all, and the rest of the page follows.
 */

const FIXTURE =
  '<h1>Three paragraphs</h1>' +
  '<p id="one">The first paragraph opens the page. It has two sentences.</p>' +
  '<p id="two">The second paragraph is where the finger lands. Its tail follows the selection. And a third sentence closes it.</p>' +
  '<p id="three">The third paragraph ends the page.</p>'

function select(node: Node, start: number, endNode: Node, end: number): void {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(endNode, end)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

const fromSelectionOn: ReadAloudExtractRequest = {
  type: 'readAloud',
  action: 'extract',
  requestId: 'edge-12',
  from: 'selection',
  then: 'document'
}

/** The blocks as the core turns them into speech text (`core/readAloud.ts` `start`). */
function speechBlocks(request: ReadAloudExtractRequest): ReadAloudBlock[] {
  return extract(document, request).blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text }))
}

/** The CSS Custom Highlight API as the page script sees it: named highlights, each its ranges. */
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

function installHighlightApi(): void {
  ;(window as unknown as { Highlight?: unknown }).Highlight = FakeHighlight
  // happy-dom's `CSS` object takes no new members: stand in for it with the registry attached.
  Object.defineProperty(window, 'CSS', {
    value: { highlights: registry },
    configurable: true,
    writable: true
  })
}

/** The texts a named highlight paints, one per range; [] when none is registered. */
const painted = (name: string): string[] =>
  (registry.get(name)?.ranges ?? []).map((range) => range.toString())

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
  registry.clear()
})

describe('EDGE-12: the selection toolbar’s Listen starts at the selected text', () => {
  it('a selection in the second paragraph: its words are the first block, the first paragraph is not in the text', () => {
    document.body.innerHTML = FIXTURE
    const two = document.getElementById('two')!.firstChild!
    // "where the finger lands" – mid-sentence, mid-paragraph.
    const start = two.textContent!.indexOf('where the finger lands')
    select(two, start, two, start + 'where the finger lands'.length)

    const extraction = extract(document, fromSelectionOn)
    expect(extraction.blocks.map((b) => [b.text, b.at.path, b.at.offset])).toEqual([
      // The selection's own words, cut from where it starts (its offset into the paragraph's
      // collapsed text: the highlight's first range begins there, not at the paragraph's start).
      ['where the finger lands', [2], start],
      // The rest of the paragraph after the selection's end, then the paragraph after it.
      [
        '. Its tail follows the selection. And a third sentence closes it.',
        [2],
        start + 'where the finger lands'.length
      ],
      ['The third paragraph ends the page.', [3], 0]
    ])
    expect(extraction.blocks.some((b) => b.text.includes('first paragraph'))).toBe(false)
    expect(extraction.blocks.some((b) => b.text.includes('Three paragraphs'))).toBe(false)
  })

  it('the first sentence spoken is the selection itself; the walk then reads on to the page’s end', () => {
    document.body.innerHTML = FIXTURE
    const two = document.getElementById('two')!.firstChild!
    const start = two.textContent!.indexOf('Its tail follows the selection.')
    select(two, start, two, start + 'Its tail follows the selection.'.length)

    const sentences = segmentSentences(speechBlocks(fromSelectionOn), 'en')
    // `startIndex` is 0 for `from: 'selection-on'`: sentence 0 is what the engine is handed first.
    expect(sentences[0]?.text).toBe('Its tail follows the selection.')
    expect(sentences[0]?.blockId).toBe('b0')
    expect(sentences.map((s) => s.text)).toEqual([
      'Its tail follows the selection.',
      'And a third sentence closes it.',
      'The third paragraph ends the page.'
    ])
  })

  it('the highlight is ONE sentence range at every position after a selection start: the selected word’s range does not outlive its turn', () => {
    // The design record's act (ReadAloudSelectionDemo.kt): a long press on the word "finger",
    // Listen, the reading moving on through the paragraph. Each `highlight` the core's player
    // posts (`core/readAloud.ts` `paint`: the sentence's block, its position, the sentence's
    // offsets, the word) is painted here as the page paints it, and after every one the sentence
    // highlight holds exactly the sentence being read – the word-first segment's range is
    // replaced by the next segment's, not joined by it, the same as every other transition.
    document.body.innerHTML = FIXTURE
    installHighlightApi()
    const two = document.getElementById('two')!.firstChild!
    const start = two.textContent!.indexOf('finger')
    select(two, start, two, start + 'finger'.length)

    const extraction = extract(document, fromSelectionOn)
    const positions = new Map(extraction.blocks.map((b) => [b.id, b.at]))
    const blocks: ReadAloudBlock[] = extraction.blocks.map((b) => ({
      id: b.id,
      kind: b.kind,
      text: b.text
    }))
    const sentences = segmentSentences(blocks, 'en')
    expect(sentences.map((s) => s.text)).toEqual([
      'finger',
      'lands.',
      'Its tail follows the selection.',
      'And a third sentence closes it.',
      'The third paragraph ends the page.'
    ])

    for (const sentence of sentences) {
      const word = /\S+/.exec(sentence.text)!
      const message: ReadAloudHighlightMessage = {
        type: 'readAloud',
        action: 'highlight',
        tabId: 't1',
        blockId: sentence.blockId,
        at: positions.get(sentence.blockId) ?? null,
        sentence: { start: sentence.start, end: sentence.end },
        word: { start: word.index, end: word.index + word[0].length },
        mode: 'both'
      }
      paintHighlight(document, message)
      // One range, the sentence being read; at every position after the first, the selection's
      // own word ("finger", spoken first) is in no sentence range any more.
      expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT), `sentence ${sentence.index}`).toEqual([
        sentence.text
      ])
      expect(painted(READ_ALOUD_WORD_HIGHLIGHT), `word of sentence ${sentence.index}`).toEqual([
        word[0]
      ])
      if (sentence.index > 0) {
        expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT).some((text) => text.includes('finger'))).toBe(
          false
        )
      }
      // The script registers its two names and nothing else.
      expect([...registry.keys()].sort()).toEqual(
        [READ_ALOUD_SENTENCE_HIGHLIGHT, READ_ALOUD_WORD_HIGHLIGHT].sort()
      )
    }

    // The walk's end (`clearHighlight`: `mode: 'off'`) leaves no range under either name.
    paintHighlight(document, {
      type: 'readAloud',
      action: 'highlight',
      tabId: 't1',
      blockId: '',
      at: null,
      sentence: { start: 0, end: 0 },
      word: null,
      mode: 'off'
    })
    expect(painted(READ_ALOUD_SENTENCE_HIGHLIGHT)).toEqual([])
    expect(painted(READ_ALOUD_WORD_HIGHLIGHT)).toEqual([])
  })

  it('a selection across two paragraphs starts at the first selected word and reads on past the second', () => {
    document.body.innerHTML = FIXTURE
    const two = document.getElementById('two')!.firstChild!
    const three = document.getElementById('three')!.firstChild!
    const start = two.textContent!.indexOf('And a third')
    select(two, start, three, 'The third'.length)

    const sentences = segmentSentences(speechBlocks(fromSelectionOn), 'en')
    expect(sentences.map((s) => s.text)).toEqual([
      'And a third sentence closes it.',
      'The third',
      'paragraph ends the page.'
    ])
  })

  it('a selection that is the whole of a paragraph starts at that paragraph, the ones before it left out', () => {
    document.body.innerHTML = FIXTURE
    const two = document.getElementById('two')!.firstChild!
    select(two, 0, two, two.textContent!.length)

    const extraction = extract(document, fromSelectionOn)
    expect(extraction.blocks.map((b) => [b.text, b.at.path, b.at.offset])).toEqual([
      [
        'The second paragraph is where the finger lands. Its tail follows the selection. And a third sentence closes it.',
        [2],
        0
      ],
      ['The third paragraph ends the page.', [3], 0]
    ])
  })

  it('a selection inside a heading or a list item starts there too', () => {
    document.body.innerHTML =
      '<p>Before.</p><h2 id="h">A heading to read</h2><ul><li>First item.</li><li id="li">Second item here.</li></ul><p>After.</p>'
    const heading = document.getElementById('h')!.firstChild!
    select(heading, 'A heading'.length + 1, heading, heading.textContent!.length)
    expect(extract(document, fromSelectionOn).blocks.map((b) => b.text)).toEqual([
      'to read',
      'First item.',
      'Second item here.',
      'After.'
    ])

    const item = document.getElementById('li')!.firstChild!
    select(item, 'Second '.length, item, item.textContent!.length)
    expect(extract(document, fromSelectionOn).blocks.map((b) => b.text)).toEqual([
      'item here.',
      'After.'
    ])
  })

  it('LIMIT: text inside a shadow root is not the document’s text – a selection there reads nothing (no-text)', () => {
    document.body.innerHTML = '<p>Light text.</p><div id="host"></div>'
    const host = document.getElementById('host')!
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p>Shadow text to select.</p>'
    const inShadow = shadow.querySelector('p')!.firstChild!
    select(inShadow, 0, inShadow, inShadow.textContent!.length)

    // The walk descends `childNodes`, never a shadow tree: the shadow's text is in no block, and
    // a selection there intersects none. The core fails the session `no-text` on an empty answer.
    const blocks = extract(document, fromSelectionOn).blocks
    expect(blocks.some((b) => b.text.includes('Shadow'))).toBe(false)
  })

  it('LIMIT: a collapsed selection (a caret, the mode already gone) reads nothing – selectionMemory.ts stands the cleared one in on the phone', () => {
    document.body.innerHTML = FIXTURE
    const two = document.getElementById('two')!.firstChild!
    select(two, 5, two, 5)
    expect(extract(document, fromSelectionOn).blocks).toEqual([])
  })
})
