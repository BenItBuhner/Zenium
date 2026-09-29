// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HIGHLIGHT_NAME,
  LATE_CONTENT_MS,
  MAX_DIRECTIVES,
  TEXT_FRAGMENT_LINK_EVENT,
  followTextFragment,
  highlightTextFragments,
  installTextFragmentScript,
  isTextFragmentPageMessage,
  needsTextFragmentFallback,
  takeTextDirectives,
  type TextFragmentHostMessage,
  type TextFragmentPageMessage
} from '../textFragmentScript'
import { linearize } from '../textFragment'

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

type TestWindow = Window & {
  scrolls: unknown[]
  replaced: (string | null | undefined)[]
}

interface WindowOptions {
  /** Whether the engine follows text fragments itself (`document.fragmentDirective`). */
  native?: boolean
  /** The document's own protocol (`location.protocol`); a web page unless said otherwise. */
  protocol?: string
  /** Whether the document is a frame of another (then `top` is a different window). */
  framed?: boolean
}

/** A window whose URL the test controls (happy-dom's `location.href` is assignable, but a stand-in keeps the document's own). */
function windowAt(href: string, opts: WindowOptions = {}): TestWindow {
  const doc = document
  if (opts.native) Object.defineProperty(doc, 'fragmentDirective', { value: {}, configurable: true })
  else delete (doc as unknown as Record<string, unknown>).fragmentDirective
  const scrolls: unknown[] = []
  const replaced: (string | null | undefined)[] = []
  const protocol = opts.protocol ?? new URL(href).protocol
  const win = {
    document: doc,
    location: { href, protocol },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url?: string | null) => void replaced.push(url)
    },
    innerHeight: 800,
    scrollY: 0,
    scrollTo: (opts: unknown) => void scrolls.push(opts),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: (type: string, fn: () => void) => window.addEventListener(type, fn),
    CSS: undefined,
    Highlight: undefined
  } as unknown as TestWindow
  ;(win as unknown as { top: unknown }).top = opts.framed ? {} : win
  win.scrolls = scrolls
  win.replaced = replaced
  return win
}

interface Harness {
  sent: TextFragmentPageMessage[]
  down: (message: TextFragmentHostMessage) => void
}

/** The DOM listeners the installs of a test left on the shared document, removed after it. */
const domListeners: EventListenerOrEventListenerObject[] = []

function install(win: Window = window, withSelection?: <T>(work: () => T) => T): Harness {
  const sent: TextFragmentPageMessage[] = []
  let listener: ((message: TextFragmentHostMessage) => void) | null = null
  const doc = win.document
  const addEventListener = doc.addEventListener.bind(doc)
  doc.addEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: unknown) => {
    if (type === TEXT_FRAGMENT_LINK_EVENT) domListeners.push(l)
    addEventListener(type, l, o as AddEventListenerOptions)
  }) as Document['addEventListener']
  try {
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
  } finally {
    delete (doc as { addEventListener?: unknown }).addEventListener
  }
  return { sent, down: (message) => listener!(message) }
}

/** What the phone's host does through `evaluateJavascript`: dispatch the DOM event and read the answer. */
function askThroughDom(): string | null | undefined {
  const detail: { directive?: string | null } = {}
  document.dispatchEvent(new CustomEvent(TEXT_FRAGMENT_LINK_EVENT, { detail }))
  return detail.directive
}

beforeEach(() => {
  document.body.innerHTML = HTML
  document.getSelection()?.removeAllRanges()
})

afterEach(() => {
  vi.useRealTimers()
  delete (document as unknown as Record<string, unknown>).fragmentDirective
  for (const l of domListeners) document.removeEventListener(TEXT_FRAGMENT_LINK_EVENT, l)
  domListeners.length = 0
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

describe('making a link to the highlight without the bridge (the phone’s action mode, through the DOM)', () => {
  it('writes the selection’s directive into the event’s detail', () => {
    install()
    select('ledger did not care')
    expect(askThroughDom()).toBe('text=ledger%20did%20not%20care')
  })

  it('answers null for a collapsed selection', () => {
    install()
    expect(askThroughDom()).toBeNull()
  })

  it('generates through the host’s selection wrapper, as the bridge’s request does', () => {
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
    install(window, withSelection)
    expect(askThroughDom()).toBe('text=lighthouse%20keeper')
    expect(document.getSelection()!.rangeCount).toBe(0)
  })

  it('leaves an event without an object detail alone', () => {
    install()
    select('ledger')
    expect(() =>
      document.dispatchEvent(new CustomEvent(TEXT_FRAGMENT_LINK_EVENT, { detail: 'x' }))
    ).not.toThrow()
    expect(() => document.dispatchEvent(new CustomEvent(TEXT_FRAGMENT_LINK_EVENT))).not.toThrow()
  })
})

describe('following a link to the highlight where the engine does not (the WebView)', () => {
  it('needs the fallback only in a top web document of an engine without fragmentDirective whose URL has a directive', () => {
    expect(needsTextFragmentFallback(windowAt('https://a.test/#:~:text=ledger'))).toBe(true)
    expect(needsTextFragmentFallback(windowAt('http://a.test/#:~:text=ledger'))).toBe(true)
    expect(needsTextFragmentFallback(windowAt('file:///tmp/a.html#:~:text=ledger'))).toBe(true)
    expect(needsTextFragmentFallback(windowAt('https://a.test/#:~:text=ledger', { native: true }))).toBe(
      false
    )
    expect(needsTextFragmentFallback(windowAt('https://a.test/#top'))).toBe(false)
    expect(needsTextFragmentFallback(windowAt('https://a.test/?q=:~:text=ledger'))).toBe(false)
  })

  it('never runs in the browser’s own pages nor in a frame', () => {
    expect(
      needsTextFragmentFallback(windowAt('zen://settings/#:~:text=ledger', { protocol: 'zen:' }))
    ).toBe(false)
    expect(
      needsTextFragmentFallback(windowAt('about:blank#:~:text=ledger', { protocol: 'about:' }))
    ).toBe(false)
    expect(
      needsTextFragmentFallback(windowAt('blob:https://a.test/x#:~:text=ledger', { protocol: 'blob:' }))
    ).toBe(false)
    expect(needsTextFragmentFallback(windowAt('https://a.test/#:~:text=ledger', { framed: true }))).toBe(
      false
    )
  })

  it('takes the directives out of the URL the page sees, keeping the page’s own fragment', () => {
    const win = windowAt('https://a.test/p#section:~:text=ledger&text=prefix-,steps,-again&other=1')
    const directives = takeTextDirectives(win)
    expect(directives).toEqual([
      { textStart: 'ledger' },
      { prefix: 'prefix', textStart: 'steps', suffix: 'again' }
    ])
    expect(win.replaced).toEqual(['https://a.test/p#section'])
  })

  it('drops the empty fragment a directive-only hash leaves behind', () => {
    const win = windowAt('https://a.test/p?q=1#:~:text=ledger')
    expect(takeTextDirectives(win)).toEqual([{ textStart: 'ledger' }])
    expect(win.replaced).toEqual(['https://a.test/p?q=1'])
  })

  it('percent-decodes the terms and reads several text directives in order', () => {
    const win = windowAt('https://a.test/#:~:text=The%20ledger%2C%20kept&text=a%2Db&text=%E4%BA%AC%E9%83%BD')
    expect(takeTextDirectives(win)).toEqual([
      { textStart: 'The ledger, kept' },
      { textStart: 'a-b' },
      { textStart: '京都' }
    ])
  })

  it('follows at most MAX_DIRECTIVES directives of a URL', () => {
    const many = Array.from({ length: MAX_DIRECTIVES + 5 }, (_, i) => `text=w${i}`).join('&')
    const win = windowAt(`https://a.test/#:~:${many}`)
    const directives = takeTextDirectives(win)!
    expect(directives).toHaveLength(MAX_DIRECTIVES)
    expect(directives[0]).toEqual({ textStart: 'w0' })
    expect(directives[MAX_DIRECTIVES - 1]).toEqual({ textStart: `w${MAX_DIRECTIVES - 1}` })
  })

  it('takes nothing where the engine follows the directive itself, and leaves the URL to it', () => {
    const win = windowAt('https://a.test/#:~:text=ledger', { native: true })
    expect(takeTextDirectives(win)).toBeNull()
    expect(win.replaced).toEqual([])
  })

  it('takes nothing from a URL whose directive holds no text directive', () => {
    const win = windowAt('https://a.test/#:~:other=1')
    expect(takeTextDirectives(win)).toBeNull()
    // The unknown directive still comes out of the URL, as the spec has it.
    expect(win.replaced).toEqual(['https://a.test/'])
  })

  it('selects the match and scrolls to it without the Highlight API', () => {
    const win = windowAt('https://a.test/#:~:text=ledger%20did%20not')
    const intoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = intoView
    try {
      expect(highlightTextFragments(win, takeTextDirectives(win)!)).toBe(true)
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
    const win = windowAt('https://a.test/#:~:text=lighthouse&text=steps%20again')
    const highlights = new Map<string, unknown>()
    class Highlight {
      ranges: Range[]
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    }
    ;(win as unknown as { CSS: unknown }).CSS = { highlights }
    ;(win as unknown as { Highlight: unknown }).Highlight = Highlight
    expect(highlightTextFragments(win, takeTextDirectives(win)!)).toBe(true)
    const painted = highlights.get(HIGHLIGHT_NAME) as Highlight
    expect(painted.ranges.map((r) => r.toString())).toEqual(['lighthouse', 'steps again'])
    expect(document.getElementById('zen-text-fragment-style')!.textContent).toContain(
      `::highlight(${HIGHLIGHT_NAME})`
    )
    expect(document.getSelection()!.rangeCount).toBe(0)
  })

  it('matches whole words only: a term inside a longer word is not the passage', () => {
    const win = windowAt('https://a.test/#:~:text=ledge')
    expect(highlightTextFragments(win, takeTextDirectives(win)!)).toBe(false)
  })

  it('finds nothing for a directive the page does not contain', () => {
    const win = windowAt('https://a.test/#:~:text=submarine')
    expect(highlightTextFragments(win, takeTextDirectives(win)!)).toBe(false)
  })

  it('runs once the document has loaded and looks once more for late content', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<p>Loading…</p>'
    const win = windowAt('https://a.test/#:~:text=ledger')
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
    install(win)
    expect(win.replaced).toEqual(['https://a.test/'])
    expect(document.getSelection()!.toString()).toBe('')
    document.body.innerHTML = HTML
    vi.advanceTimersByTime(LATE_CONTENT_MS)
    expect(document.getSelection()!.toString()).toBe('ledger')
  })

  it('does nothing at all where the engine is native: no URL change, no scroll, no selection', () => {
    const win = windowAt('https://a.test/#:~:text=ledger', { native: true })
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
    followTextFragment(win)
    expect(win.replaced).toEqual([])
    expect(win.scrolls).toEqual([])
    expect(document.getSelection()!.toString()).toBe('')
  })
})

describe('the reading of the document is bounded', () => {
  it('stops at the node cap and says so', () => {
    document.body.innerHTML = Array.from({ length: 20 }, (_, i) => `<p>word${i}</p>`).join('')
    const linear = linearize(document.body, { maxNodes: 5, maxChars: 1_000_000 })
    expect(linear.truncated).toBe(true)
    expect(linear.segments).toHaveLength(5)
    expect(linear.text).toContain('word4')
    expect(linear.text).not.toContain('word5')
  })

  it('stops at the character cap: a node reached under it is taken whole, the next is not', () => {
    document.body.innerHTML = '<p>aaaa</p><p>bbbb</p><p>cccc</p>'
    // The text read so far counts the block boundaries: "\naaaa\n" is six characters.
    const linear = linearize(document.body, { maxNodes: 1_000, maxChars: 7 })
    expect(linear.truncated).toBe(true)
    expect(linear.segments.map((s) => s.node.data)).toEqual(['aaaa', 'bbbb'])
  })

  it('reads a document within the caps whole', () => {
    const linear = linearize(document.body)
    expect(linear.truncated).toBe(false)
    expect(linear.text).toContain('ledger did not care')
  })

  it('a passage past the cap is simply not found', () => {
    document.body.innerHTML = Array.from({ length: 20 }, (_, i) => `<p>word${i}</p>`).join('')
    const win = windowAt('https://a.test/#:~:text=word19')
    const linear = linearize(document.body, { maxNodes: 5, maxChars: 1_000_000 })
    expect(linear.truncated).toBe(true)
    // The fallback's own reading has the production caps; within them the passage is found.
    expect(highlightTextFragments(win, takeTextDirectives(win)!)).toBe(true)
  })
})
