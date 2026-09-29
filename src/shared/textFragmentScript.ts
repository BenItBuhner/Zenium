/**
 * The page-script half of text fragments (SH-11, Chrome's link to a highlight). Two duties:
 *
 * Making a link: the browser asks the page for the directive that singles out its selection
 * (`textFragment` / `generate`, a `PageHostMessage`) and the script answers with the encoded
 * `text=` directive (`generateForSelection`) or null when the selection cannot be linked to. The
 * selection toolbar's Share and the menu's Copy Link to Highlight go through this; on Android the
 * action mode has collapsed the selection by the time the request lands, so the host wraps the
 * work so the one it cleared stands in (`withSelection`, `selectionMemory.ts`).
 *
 * Following one: an engine with text fragments (`document.fragmentDirective` present) scrolls to
 * and highlights the text itself and strips the directive from `location.hash`; one without
 * (Android's WebView leaves the feature off) shows the page's top and the directive stays in the
 * URL. The script then does the engine's part (PUI-40): at document start – before the page's
 * own scripts read `location.hash` – the directives are taken out of the URL
 * (`history.replaceState`; the spec keeps the fragment directive out of the document's URL) and
 * kept; once the document has loaded, their first matches are found (`findTextDirective`, the
 * document read up to `LINEARIZE_LIMITS`), painted through the CSS Custom Highlight API in the
 * `::target-text` colours (or selected, where the API is missing), and the first one is scrolled
 * to the middle of the viewport, as Chrome's `TextFragmentAnchor` does. Web documents alone: a
 * `zen:` or `about:` document never runs it, nor does a frame, nor a same-document fragment
 * change (the spec's "full navigation" rule; Chrome does not follow `#:~:text=` set in place).
 *
 * The phone's toolbar asks for the link without the bridge (`TEXT_FRAGMENT_LINK_EVENT`, a DOM
 * event the host's `evaluateJavascript` dispatches; `TextFragmentLink.kt`): the listener writes
 * the selection's directive into the event's `detail`, and the host builds the URL.
 */

import {
  findTextDirective,
  generateForSelection,
  hasFragmentDirective,
  linearize,
  parseTextDirectives,
  stripFragmentDirective,
  type TextDirective
} from './textFragment'

/** Browser → page: make the directive for the current selection, answered under `id`. */
export interface TextFragmentHostMessage {
  type: 'textFragment'
  action: 'generate'
  id: string
}

/** Page → browser: the answer to a `generate` – the encoded `text=` directive, or null. */
export interface TextFragmentPageMessage {
  type: 'textFragment'
  id: string
  directive: string | null
}

export interface TextFragmentTransport {
  send(message: TextFragmentPageMessage): void
  onCommand(listener: (message: TextFragmentHostMessage) => void): void
  /** Wrap the generation so a selection the host just collapsed stands in (Android's action mode). */
  withSelection?: <T>(work: () => T) => T
}

/** The highlight's name in `CSS.highlights`, and the style rule that colours it. */
export const HIGHLIGHT_NAME = 'zen-text-fragment'
const STYLE_ID = 'zen-text-fragment-style'
/** Content that renders late (a framework's first paint) gets one more look after this long. */
export const LATE_CONTENT_MS = 600
/** Directives followed at most per document (the spec allows any number; Chrome paints them all). */
export const MAX_DIRECTIVES = 16
/** The documents the fallback follows a directive in: web pages and files, never the browser's own. */
const FOLLOWED_PROTOCOLS: readonly string[] = ['http:', 'https:', 'file:']

/**
 * The DOM event the phone's host dispatches on the document to ask for the selection's directive
 * (`TextFragmentLink.kt`'s script, through `evaluateJavascript`): dispatched with an object as
 * `detail`, answered by writing `detail.directive` – the encoded `text=` directive, or null when
 * the selection cannot be linked to. Nothing a page cannot compute of its own selection itself.
 */
export const TEXT_FRAGMENT_LINK_EVENT = 'zen-text-fragment-link'

/** The Custom Highlight API's constructor, where the engine has it (the DOM lib in use predates it). */
type HighlightConstructor = new (...ranges: Range[]) => object
interface CssWithHighlights {
  highlights?: Map<string, object>
}

export function isTextFragmentHostMessage(value: unknown): value is TextFragmentHostMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return m.type === 'textFragment' && m.action === 'generate' && typeof m.id === 'string'
}

/** The page's answer, as the core reads it (the page is not trusted). */
export function isTextFragmentPageMessage(value: unknown): value is TextFragmentPageMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    m.type === 'textFragment' &&
    typeof m.id === 'string' &&
    (m.directive === null || typeof m.directive === 'string')
  )
}

/**
 * Answer the browser's `generate` requests (the bridge's, and the host's DOM event), and follow
 * the URL's own directive when the engine did not.
 */
export function installTextFragmentScript(
  transport: TextFragmentTransport,
  win: Window = window
): void {
  const generate = (): string | null => {
    const run = (): string | null => generateForSelection(win.document)
    try {
      return transport.withSelection ? transport.withSelection(run) : run()
    } catch {
      return null
    }
  }
  transport.onCommand((message) => {
    if (!isTextFragmentHostMessage(message)) return
    transport.send({ type: 'textFragment', id: message.id, directive: generate() })
  })
  win.document.addEventListener(TEXT_FRAGMENT_LINK_EVENT, (e) => {
    const detail: unknown = (e as CustomEvent<unknown>).detail
    if (!detail || typeof detail !== 'object') return
    ;(detail as { directive?: string | null }).directive = generate()
  })
  followTextFragment(win)
}

/**
 * Whether this document is one for the script to follow the directive in: the top document of
 * a web page (or a file) in an engine without text fragments, whose URL carries one. Nothing but
 * the URL is read here, at document start: one look for `#` and one for `:~:` after it.
 */
export function needsTextFragmentFallback(win: Window): boolean {
  try {
    if (win !== win.top) return false
    if ('fragmentDirective' in win.document) return false
    if (!FOLLOWED_PROTOCOLS.includes(win.location.protocol)) return false
    return hasFragmentDirective(win.location.href)
  } catch {
    return false
  }
}

/**
 * Take the text directives out of the document's URL, as the spec keeps them out of the URL a
 * document sees: parsed and kept, then `history.replaceState` to the URL without them, so the
 * page's own scripts – a hash router among them – read the fragment as the author wrote it.
 * Null when there is nothing to follow (the engine's own case, no directive, not a web page).
 */
export function takeTextDirectives(win: Window): TextDirective[] | null {
  if (!needsTextFragmentFallback(win)) return null
  const href = win.location.href
  const directives = parseTextDirectives(href.slice(href.indexOf('#') + 1)).slice(
    0,
    MAX_DIRECTIVES
  )
  try {
    win.history.replaceState(win.history.state, '', stripFragmentDirective(href))
  } catch {
    /* a document whose URL cannot be replaced keeps the directive in its hash */
  }
  return directives.length > 0 ? directives : null
}

/**
 * Scroll to and highlight the URL's text directives once the document has loaded (and once more a
 * moment later, for content that renders late), where the engine did not. Nothing when it did.
 */
export function followTextFragment(win: Window): void {
  const directives = takeTextDirectives(win)
  if (!directives) return
  const doc = win.document
  let done = false
  const attempt = (): void => {
    if (done) return
    if (highlightTextFragments(win, directives)) done = true
  }
  const start = (): void => {
    attempt()
    if (!done) win.setTimeout(attempt, LATE_CONTENT_MS)
  }
  if (doc.readyState === 'complete') start()
  else win.addEventListener('load', start, { once: true })
}

/**
 * Find the `directives` (the document URL's, as `takeTextDirectives` kept them) in the document,
 * paint their matches and scroll the first into view. True when at least one matched. The
 * engine's own processing is not repeated: callers check `needsTextFragmentFallback` first.
 */
export function highlightTextFragments(win: Window, directives: TextDirective[]): boolean {
  const doc = win.document
  const root = doc.body
  if (!root || directives.length === 0) return false
  const linear = linearize(root)
  const ranges: Range[] = []
  for (const directive of directives) {
    const range = findTextDirective(doc, directive, linear)
    if (range) ranges.push(range)
  }
  if (ranges.length === 0) return false
  paintRanges(win, ranges)
  scrollToRange(win, ranges[0])
  return true
}

/**
 * The matches in the `::target-text` colours through the CSS Custom Highlight API; where the
 * engine has none, the first match becomes the selection – a highlight too, of the page's own.
 */
function paintRanges(win: Window, ranges: Range[]): void {
  const doc = win.document
  const css = (win as unknown as { CSS?: CssWithHighlights }).CSS
  const Highlight = (win as unknown as { Highlight?: HighlightConstructor }).Highlight
  if (css?.highlights && Highlight) {
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = `::highlight(${HIGHLIGHT_NAME}){background-color:Mark;color:MarkText}`
      ;(doc.head ?? doc.documentElement).appendChild(style)
    }
    css.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
    return
  }
  const selection = doc.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  selection.addRange(ranges[0])
}

/** The first match to the middle of the viewport (Chrome's `TextFragmentAnchor` centres it). */
function scrollToRange(win: Window, range: Range): void {
  const node = range.startContainer
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  if (!element) return
  try {
    const rect = range.getBoundingClientRect()
    if (rect.height > 0 || rect.width > 0) {
      const y = rect.top + win.scrollY - (win.innerHeight - rect.height) / 2
      win.scrollTo({ top: Math.max(0, y), behavior: 'auto' })
      return
    }
  } catch {
    /* a detached range: the element stands in */
  }
  element.scrollIntoView({ block: 'center', inline: 'nearest' })
}
