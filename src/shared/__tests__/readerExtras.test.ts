// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LINE_FOCUS_MASK_CLASS,
  READER_LINE_FOCUS_ATTRIBUTE,
  READER_SPACING_ATTRIBUTE,
  READER_SYLLABLES_ATTRIBUTE,
  SYLLABLE_MARK_CLASS
} from '../reader'
import {
  LINE_FOCUS_REST,
  LineFocus,
  extrasOf,
  installReaderExtras,
  markSyllables,
  marksLanguage,
  syllableBoundaries,
  textSyllableBoundaries,
  unmarkSyllables
} from '../readerExtras'
import { READ_ALOUD_MARK_ATTRIBUTE, paintHighlight, pathOf, walkBlocks } from '../readAloudScript'

const setUrl = (url: string): void => {
  const g = globalThis as typeof globalThis & { happyDOM?: { setURL(url: string): void } }
  g.happyDOM?.setURL(url)
}

/** A word with its syllable dots at the heuristic's boundaries. */
const dotted = (word: string): string => {
  const out: string[] = []
  let at = 0
  for (const b of syllableBoundaries(word)) {
    out.push(word.slice(at, b))
    at = b
  }
  out.push(word.slice(at))
  return out.join('·')
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// The syllable heuristic
// ---------------------------------------------------------------------------

describe('syllableBoundaries (the English heuristic)', () => {
  it.each([
    ['basic', 'ba·sic'],
    ['better', 'bet·ter'],
    ['father', 'fa·ther'],
    ['pocket', 'pock·et'],
    ['quickly', 'quick·ly'],
    ['monster', 'mon·ster'],
    ['instrument', 'in·stru·ment'],
    ['handsome', 'hand·some'],
    ['table', 'ta·ble'],
    ['little', 'lit·tle'],
    ['boxes', 'box·es'],
    ['wanted', 'want·ed'],
    ['exit', 'ex·it'],
    ['reading', 'read·ing'],
    ['walking', 'walk·ing'],
    ['running', 'run·ning'],
    ['making', 'mak·ing'],
    ['fishing', 'fish·ing'],
    ['beginning', 'be·gin·ning'],
    ['immersive', 'im·mer·sive'],
    ['syllable', 'syl·la·ble'],
    ['happy', 'hap·py'],
    ['nation', 'na·tion'],
    ['hundred', 'hun·dred'],
    ['sacred', 'sac·red'],
    ['complete', 'com·plete'],
    ['sister', 'sis·ter']
  ])('%s → %s', (word, expected) => {
    expect(dotted(word)).toBe(expected)
  })

  it('has the recorded limits: adjacent vowels are one core, a silent inner e is a core, two consonants always split', () => {
    expect(dotted('lion')).toBe('lion')
    expect(dotted('create')).toBe('create')
    expect(dotted('going')).toBe('going')
    expect(dotted('Zenium')).toBe('Ze·nium')
    expect(dotted('hopeful')).toBe('ho·pe·ful')
    expect(dotted('paragraph')).toBe('pa·rag·raph')
  })

  it.each([
    'make',
    'makes',
    'walked',
    'cared',
    'stirred',
    'the',
    'and',
    'cat',
    'strength',
    'queue'
  ])('%s is one syllable to the marker', (word) => {
    expect(syllableBoundaries(word)).toEqual([])
  })

  it('leaves anything but ASCII letters alone', () => {
    expect(syllableBoundaries('naïve')).toEqual([])
    expect(syllableBoundaries('e-mail')).toEqual([])
    expect(syllableBoundaries('1990s')).toEqual([])
    expect(syllableBoundaries("don't")).toEqual([])
  })

  it('answers offsets into a text for every word', () => {
    const text = 'Better reading, quickly.'
    expect(textSyllableBoundaries(text)).toEqual([3, 11, 21])
    expect(text.slice(0, 3)).toBe('Bet')
    expect(text.slice(7, 11)).toBe('read')
    expect(text.slice(16, 21)).toBe('quick')
  })

  it('marks English and an unknown language only', () => {
    expect(marksLanguage('en')).toBe(true)
    expect(marksLanguage('en-GB')).toBe(true)
    expect(marksLanguage('')).toBe(true)
    expect(marksLanguage('fr')).toBe(false)
    expect(marksLanguage('de-DE')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Marking the article
// ---------------------------------------------------------------------------

describe('markSyllables / unmarkSyllables', () => {
  let article: HTMLElement

  beforeEach(() => {
    document.body.innerHTML =
      '<article><h2>Better reading</h2><p>A <em>little</em> table. <code>pocket</code></p><p lang="fr">Bonjour monsieur</p><pre>instrument</pre></article>'
    article = document.querySelector('article') as HTMLElement
  })

  it('splits the words at their boundaries with empty marks and keeps the text the same', () => {
    const before = article.textContent
    const count = markSyllables(article, 'en')
    expect(count).toBe(4) // Bet·ter, read·ing, lit·tle, ta·ble
    expect(article.textContent).toBe(before)
    const marks = article.querySelectorAll(`.${SYLLABLE_MARK_CLASS}`)
    expect(marks.length).toBe(4)
    for (const mark of Array.from(marks)) {
      expect(mark.getAttribute(READ_ALOUD_MARK_ATTRIBUTE)).toBe('syllable')
      expect(mark.getAttribute('aria-hidden')).toBe('true')
      expect(mark.textContent).toBe('')
    }
    expect(article.querySelector('h2')?.childNodes.length).toBe(5) // Bet | · | ter read | · | ing
  })

  it('skips code, another language and words already marked', () => {
    markSyllables(article, 'en')
    expect(article.querySelector('code')?.childNodes.length).toBe(1)
    expect(article.querySelector('pre')?.childNodes.length).toBe(1)
    expect(article.querySelector('p[lang="fr"]')?.childNodes.length).toBe(1)
    // Idempotent: a second pass finds nothing to split.
    expect(markSyllables(article, 'en')).toBe(0)
    expect(article.querySelectorAll(`.${SYLLABLE_MARK_CLASS}`).length).toBe(4)
  })

  it('marks nothing when the document is not English', () => {
    expect(markSyllables(article, 'de')).toBe(0)
    expect(article.querySelectorAll(`.${SYLLABLE_MARK_CLASS}`).length).toBe(0)
  })

  it('unmarking joins the text back into whole nodes', () => {
    markSyllables(article, 'en')
    unmarkSyllables(article)
    expect(article.querySelectorAll(`[${READ_ALOUD_MARK_ATTRIBUTE}]`).length).toBe(0)
    expect(article.querySelector('h2')?.childNodes.length).toBe(1)
    expect(article.querySelector('h2')?.textContent).toBe('Better reading')
    expect(article.querySelector('em')?.childNodes.length).toBe(1)
  })

  it('the read-aloud walk names the same blocks with the marks in place', () => {
    const shape = (): unknown[] =>
      walkBlocks(article, 'en').map((b) => [b.text, pathOf(b.ref, article), b.run])
    const plain = shape()
    expect(plain.length).toBe(4)
    markSyllables(article, 'en')
    expect(shape()).toEqual(plain)
    unmarkSyllables(article)
    expect(shape()).toEqual(plain)
  })
})

// ---------------------------------------------------------------------------
// Line focus
// ---------------------------------------------------------------------------

describe('LineFocus', () => {
  let article: HTMLElement
  let focus: LineFocus
  const VIEW_HEIGHT = 800
  const LINE = 30

  beforeEach(() => {
    document.body.innerHTML =
      '<main><article><p>One line of text.</p><p>Another line.</p></article></main>'
    article = document.querySelector('article') as HTMLElement
    Object.defineProperty(window, 'innerHeight', {
      value: VIEW_HEIGHT,
      configurable: true,
      writable: true
    })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      lineHeight: `${LINE}px`,
      fontSize: '18px'
    } as unknown as CSSStyleDeclaration)
    focus = new LineFocus(document, article)
  })

  afterEach(() => {
    focus.setLines(0)
    vi.restoreAllMocks()
  })

  const masks = (): HTMLElement[] =>
    Array.from(document.querySelectorAll(`.${LINE_FOCUS_MASK_CLASS}`)) as HTMLElement[]

  it('puts two fixed masks around a resting band and takes them away at 0', () => {
    expect(focus.active).toBe(false)
    expect(focus.band()).toBeNull()
    focus.setLines(1)
    expect(focus.active).toBe(true)
    expect(masks().length).toBe(2)
    for (const mask of masks()) {
      expect(mask.getAttribute(READ_ALOUD_MARK_ATTRIBUTE)).toBe('focus')
      expect(mask.style.position).toBe('fixed')
      expect(mask.style.pointerEvents).toBe('none')
    }
    const rest = Math.round(VIEW_HEIGHT * LINE_FOCUS_REST)
    expect(focus.band()).toEqual({ top: rest, bottom: rest + LINE })
    focus.setLines(0)
    expect(masks().length).toBe(0)
    expect(focus.band()).toBeNull()
  })

  it('a band of three or five lines centres the current line', () => {
    const rest = Math.round(VIEW_HEIGHT * LINE_FOCUS_REST)
    focus.setLines(3)
    expect(focus.band()).toEqual({ top: rest - LINE, bottom: rest + 2 * LINE })
    focus.setLines(5)
    expect(focus.band()).toEqual({ top: rest - 2 * LINE, bottom: rest + 3 * LINE })
    expect(masks().length).toBe(2)
  })

  it('follows a range by its first line and rests again when reading stops', () => {
    focus.setLines(3)
    const range = document.createRange()
    range.selectNodeContents(article.querySelector('p') as Node)
    vi.spyOn(range, 'getClientRects').mockReturnValue([
      { top: 500, height: 24 },
      { top: 524, height: 24 }
    ] as unknown as DOMRectList)
    focus.follow(range)
    // The fragment (24) sits centred in its 30px line: the line's top is 497.
    expect(focus.band()).toEqual({ top: 497 - LINE, bottom: 497 + 2 * LINE })
    focus.follow(null)
    const rest = Math.round(VIEW_HEIGHT * LINE_FOCUS_REST)
    expect(focus.band()).toEqual({ top: rest - LINE, bottom: rest + 2 * LINE })
  })

  it('the arrow keys step the band a line at a time and scroll the page at the edges', () => {
    focus.setLines(1)
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined)
    const rest = Math.round(VIEW_HEIGHT * LINE_FOCUS_REST)
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    document.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(focus.band()).toEqual({ top: rest + LINE, bottom: rest + 2 * LINE })
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    )
    expect(focus.band()).toEqual({ top: rest, bottom: rest + LINE })
    // Past the lower bound the page scrolls a line and the band stays.
    for (let i = 0; i < 20 && scrollBy.mock.calls.length === 0; i++) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    }
    expect(scrollBy).toHaveBeenCalledWith({ top: LINE, behavior: 'auto' })
    const band = focus.band()
    expect(band && band.top <= VIEW_HEIGHT * 0.68 + LINE).toBe(true)
    // A modifier or a field leaves the keys alone.
    const withCtrl = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
      cancelable: true
    })
    document.dispatchEvent(withCtrl)
    expect(withCtrl.defaultPrevented).toBe(false)
  })

  it('a click on the text puts the current line where it landed', () => {
    focus.setLines(1)
    const p = article.querySelector('p') as HTMLElement
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 300 }))
    expect(focus.band()).toEqual({ top: 300, bottom: 300 + LINE })
    // A click outside the article changes nothing.
    document.body.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 100 })
    )
    expect(focus.band()).toEqual({ top: 300, bottom: 300 + LINE })
  })
})

// ---------------------------------------------------------------------------
// Installation in the reader document
// ---------------------------------------------------------------------------

describe('installReaderExtras', () => {
  beforeEach(() => {
    setUrl('zen://reader?id=a1&url=https%3A%2F%2Fexample.com%2Farticle')
    document.documentElement.setAttribute('lang', 'en')
    document.documentElement.setAttribute(READER_LINE_FOCUS_ATTRIBUTE, '0')
    document.documentElement.setAttribute(READER_SYLLABLES_ATTRIBUTE, 'false')
    document.body.innerHTML =
      '<main><header><h1>The article</h1></header><article><p>Better reading here.</p><p>Second paragraph.</p></article></main>'
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      lineHeight: '30px',
      fontSize: '18px'
    } as unknown as CSSStyleDeclaration)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.setAttribute(READER_LINE_FOCUS_ATTRIBUTE, '0')
    document.documentElement.setAttribute(READER_SYLLABLES_ATTRIBUTE, 'false')
    setUrl('about:blank')
  })

  it('reads the root attributes', () => {
    const root = document.documentElement
    expect(extrasOf(root)).toEqual({ lineFocus: 0, syllables: false })
    root.setAttribute(READER_LINE_FOCUS_ATTRIBUTE, '3')
    root.setAttribute(READER_SYLLABLES_ATTRIBUTE, 'true')
    expect(extrasOf(root)).toEqual({ lineFocus: 3, syllables: true })
    root.setAttribute(READER_LINE_FOCUS_ATTRIBUTE, '4')
    expect(extrasOf(root).lineFocus).toBe(0)
  })

  it('is nothing outside a reader document', () => {
    setUrl('https://example.com/article')
    expect(installReaderExtras(document)).toBeNull()
  })

  it('applies the saved settings, follows the root attributes and takes the marks back off', async () => {
    const root = document.documentElement
    root.setAttribute(READER_SYLLABLES_ATTRIBUTE, 'true')
    const extras = installReaderExtras(document)
    expect(extras).not.toBeNull()
    if (!extras) return
    expect(extras.syllablesOn).toBe(true)
    // Bet·ter read·ing, Sec·ond pa·rag·raph – the article's words; the header's "article" is not.
    expect(document.querySelectorAll(`article .${SYLLABLE_MARK_CLASS}`).length).toBe(5)
    expect(document.querySelectorAll(`.${SYLLABLE_MARK_CLASS}`).length).toBe(5)
    expect(extras.lineFocus.active).toBe(false)

    root.setAttribute(READER_LINE_FOCUS_ATTRIBUTE, '3')
    await tick()
    expect(extras.lineFocus.active).toBe(true)
    expect(document.querySelectorAll(`.${LINE_FOCUS_MASK_CLASS}`).length).toBe(2)

    root.setAttribute(READER_SYLLABLES_ATTRIBUTE, 'false')
    root.setAttribute(READER_LINE_FOCUS_ATTRIBUTE, '0')
    await tick()
    expect(extras.syllablesOn).toBe(false)
    expect(document.querySelectorAll(`[${READ_ALOUD_MARK_ATTRIBUTE}]`).length).toBe(0)
    expect(document.querySelector('article p')?.childNodes.length).toBe(1)
    expect(extras.lineFocus.active).toBe(false)
  })

  it('a typography change on the root (text spacing) places the band again at the new line height', async () => {
    const root = document.documentElement
    root.setAttribute(READER_LINE_FOCUS_ATTRIBUTE, '5')
    const extras = installReaderExtras(document)
    if (!extras) throw new Error('no extras')
    const rest = Math.round(800 * LINE_FOCUS_REST)
    expect(extras.lineFocus.band()).toEqual({ top: rest - 60, bottom: rest + 90 })

    // Wider spacing: the article's line height goes from 30 to 40 (the reader stylesheet's
    // line-height 2.15), and nothing scrolled. The five lines are five of the new ones.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      lineHeight: '40px',
      fontSize: '18px'
    } as unknown as CSSStyleDeclaration)
    root.setAttribute(READER_SPACING_ATTRIBUTE, 'wider')
    await tick()
    expect(extras.lineFocus.band()).toEqual({ top: rest - 80, bottom: rest + 120 })

    // A band anchored by a click takes the new line height too (no caret API here: the anchor
    // is the click's own y at the article's line height).
    document.querySelector('article p')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 300, button: 0 })
    )
    expect(extras.lineFocus.band()).toEqual({ top: 300 - 80, bottom: 300 + 120 })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      lineHeight: '30px',
      fontSize: '18px'
    } as unknown as CSSStyleDeclaration)
    root.setAttribute(READER_SPACING_ATTRIBUTE, 'normal')
    await tick()
    expect(extras.lineFocus.band()).toEqual({ top: 300 - 60, bottom: 300 + 90 })
    root.removeAttribute(READER_SPACING_ATTRIBUTE)
  })

  it('the band follows the read-aloud sentence as it is painted', async () => {
    const root = document.documentElement
    root.setAttribute(READER_LINE_FOCUS_ATTRIBUTE, '1')
    const extras = installReaderExtras(document)
    if (!extras) throw new Error('no extras')
    const rest = Math.round(800 * LINE_FOCUS_REST)
    expect(extras.lineFocus.band()).toEqual({ top: rest, bottom: rest + 30 })

    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      { top: 620, height: 26 }
    ] as unknown as DOMRectList)
    paintHighlight(document, {
      type: 'readAloud',
      action: 'highlight',
      tabId: 't1',
      blockId: 'b1',
      at: { path: [1], run: 0, offset: 0 },
      sentence: { start: 0, end: 17 },
      word: null,
      mode: 'sentence'
    })
    // A 26px fragment in a 30px line: the line starts 2px above it.
    expect(extras.lineFocus.band()).toEqual({ top: 618, bottom: 618 + 30 })

    paintHighlight(document, {
      type: 'readAloud',
      action: 'highlight',
      tabId: 't1',
      blockId: 'b1',
      at: { path: [1], run: 0, offset: 0 },
      sentence: { start: 0, end: 17 },
      word: null,
      mode: 'off'
    })
    expect(extras.lineFocus.band()).toEqual({ top: rest, bottom: rest + 30 })
  })
})
