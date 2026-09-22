// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HIGHLIGHT_NAME,
  LATE_CONTENT_MS,
  highlightTextFragments,
  installTextFragmentScript,
  isTextFragmentPageMessage,
  needsTextFragmentFallback,
  type TextFragmentHostMessage,
  type TextFragmentPageMessage
} from '../textFragmentScript'

const HTML =
  '<article><h1>The lighthouse keeper</h1><p>Every evening he climbed the steps. The ledger did not care.</p><p>He climbed the steps again.</p></article>'

function select(text: string): Range {
  const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const at = (node as Text).data.indexOf(text)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + text.length)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return range
  }
  throw new Error(`no text node holds ${JSON.stringify(text)}`)
}

/** A window whose URL the test controls (happy-dom's `location.href` is assignable, but a stand-in keeps the document's own). */
function windowAt(href: string, fragmentDirective: boolean): Window {
  const doc = document
  if (fragmentDirective)
    Object.defineProperty(doc, 'fragmentDirective', { value: {}, configurable: true })
  else delete (doc as unknown as Record<string, unknown>).fragmentDirective
  const scrolls: unknown[] = []
  const win = {
    document: doc,
    location: { href },
    innerHeight: 800,
    scrollY: 0,
    scrollTo: (opts: unknown) => void scrolls.push(opts),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: (type: string, fn: () => void) => window.addEventListener(type, fn),
    CSS: undefined,
    Highlight: undefined
  } as unknown as Window & { scrolls: unknown[] }
  ;(win as unknown as { top: Window }).top = win
  win.scrolls = scrolls
  return win
}

interface Harness {
  sent: TextFragmentPageMessage[]
  down: (message: TextFragmentHostMessage) => void
}

function install(win: Window = window, withSelection?: <T>(work: () => T) => T): Harness {
  const sent: TextFragmentPageMessage[] = []
  let listener: ((message: TextFragmentHostMessage) => void) | null = null
  installTextFragmentScript(
    {
      send: (message) => void sent.push(message),
      onCommand: (l) => {
        listener = l
      },
      withSelection
    },
    win
  )
  return { sent, down: (message) => listener!(message) }
}

beforeEach(() => {
  document.body.innerHTML = HTML
  document.getSelection()?.removeAllRanges()
})

afterEach(() => {
  vi.useRealTimers()
  delete (document as unknown as Record<string, unknown>).fragmentDirective
})

describe('making a link to the highlight (the core’s generate request)', () => {
  it('answers with the encoded directive for the selection under the request’s id', () => {
    const h = install()
    select('ledger did not care')
    h.down({ type: 'textFragment', action: 'generate', id: 'tf1' })
    expect(h.sent).toEqual([
      { type: 'textFragment', id: 'tf1', directive: 'text=ledger%20did%20not%20care' }
    ])
  })

  it('disambiguates a repeated passage with context, as Chrome does', () => {
    const h = install()
    // "climbed the steps" occurs twice; the second is the one selected.
    const walker = document.createTreeWalker(document.body, 4)
    let node: Node | null
    let target: Text | null = null
    while ((node = walker.nextNode()))
      if ((node as Text).data.includes('again')) target = node as Text
    const range = document.createRange()
    const at = target!.data.indexOf('climbed the steps')
    range.setStart(target!, at)
    range.setEnd(target!, at + 'climbed the steps'.length)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    h.down({ type: 'textFragment', action: 'generate', id: 'tf2' })
    const directive = h.sent[0].directive!
    expect(directive.startsWith('text=')).toBe(true)
    // A prefix or a suffix pins it to the second paragraph.
    expect(directive.includes('-,') || directive.includes(',-')).toBe(true)
  })

  it('answers null for a collapsed selection', () => {
    const h = install()
    h.down({ type: 'textFragment', action: 'generate', id: 'tf3' })
    expect(h.sent).toEqual([{ type: 'textFragment', id: 'tf3', directive: null }])
  })

  it('generates through the host’s selection wrapper (the action mode’s cleared selection stands in)', () => {
    const range = select('lighthouse keeper')
    document.getSelection()!.removeAllRanges()
    const withSelection = <T>(work: () => T): T => {
      const selection = document.getSelection()!
      selection.addRange(range)
      try {
        return work()
      } finally {
        selection.removeAllRanges()
      }
    }
    const h = install(window, withSelection)
    h.down({ type: 'textFragment', action: 'generate', id: 'tf4' })
    expect(h.sent[0].directive).toBe('text=lighthouse%20keeper')
    expect(document.getSelection()!.rangeCount).toBe(0)
  })

  it('ignores messages that are not a generate request', () => {
    const h = install()
    h.down({ type: 'textFragment', action: 'other' } as unknown as TextFragmentHostMessage)
    expect(h.sent).toEqual([])
  })

  it('checks the page’s answer’s shape for the core', () => {
    expect(isTextFragmentPageMessage({ type: 'textFragment', id: 'a', directive: 'text=x' })).toBe(
      true
    )
    expect(isTextFragmentPageMessage({ type: 'textFragment', id: 'a', directive: null })).toBe(true)
    expect(isTextFragmentPageMessage({ type: 'textFragment', id: 1, directive: null })).toBe(false)
    expect(isTextFragmentPageMessage({ type: 'share', id: 'a' })).toBe(false)
  })
})

describe('following a link to the highlight where the engine does not (the WebView)', () => {
  it('needs the fallback only in a top document of an engine without fragmentDirective whose URL has a directive', () => {
    expect(needsTextFragmentFallback(windowAt('https://a.test/#:~:text=ledger', false))).toBe(true)
    expect(needsTextFragmentFallback(windowAt('https://a.test/#:~:text=ledger', true))).toBe(false)
    expect(needsTextFragmentFallback(windowAt('https://a.test/#top', false))).toBe(false)
  })

  it('selects the match and scrolls to it without the Highlight API', () => {
    const win = windowAt('https://a.test/#:~:text=ledger%20did%20not', false) as Window & {
      scrolls: unknown[]
    }
    const intoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = intoView
    try {
      expect(highlightTextFragments(win)).toBe(true)
    } finally {
      Element.prototype.scrollIntoView = original
    }
    expect(document.getSelection()!.toString()).toBe('ledger did not')
    // A centring scroll from the match's rect – or, with happy-dom's empty rects, the paragraph
    // brought into view instead: one of the two, never neither.
    expect(win.scrolls.length + intoView.mock.calls.length).toBe(1)
    if (intoView.mock.calls.length)
      expect(intoView.mock.calls[0][0]).toEqual({ block: 'center', inline: 'nearest' })
  })

  it('paints through CSS.highlights when the engine has the API, in the ::target-text colours', () => {
    const win = windowAt('https://a.test/#:~:text=lighthouse&text=steps%20again', false)
    const highlights = new Map<string, unknown>()
    class Highlight {
      ranges: Range[]
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    }
    ;(win as unknown as { CSS: unknown }).CSS = { highlights }
    ;(win as unknown as { Highlight: unknown }).Highlight = Highlight
    expect(highlightTextFragments(win)).toBe(true)
    const painted = highlights.get(HIGHLIGHT_NAME) as Highlight
    expect(painted.ranges.map((r) => r.toString())).toEqual(['lighthouse', 'steps again'])
    expect(document.getElementById('zen-text-fragment-style')!.textContent).toContain(
      `::highlight(${HIGHLIGHT_NAME})`
    )
    expect(document.getSelection()!.rangeCount).toBe(0)
  })

  it('finds nothing for a directive the page does not contain', () => {
    const win = windowAt('https://a.test/#:~:text=submarine', false)
    expect(highlightTextFragments(win)).toBe(false)
  })

  it('runs once the document has loaded and looks once more for late content', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<p>Loading…</p>'
    const win = windowAt('https://a.test/#:~:text=ledger', false)
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
    install(win)
    expect(document.getSelection()!.toString()).toBe('')
    document.body.innerHTML = HTML
    vi.advanceTimersByTime(LATE_CONTENT_MS)
    expect(document.getSelection()!.toString()).toBe('ledger')
  })
})
