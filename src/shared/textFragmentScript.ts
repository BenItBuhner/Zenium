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
 * URL. The script then does the engine's part once the document has loaded: the directives'
 * first matches are found (`findTextDirective`), painted through the CSS Custom Highlight API in
 * the `::target-text` colours (or selected, where the API is missing), and the first one is
 * scrolled to the middle of the viewport, as Chrome's `TextFragmentAnchor` does.
 */

import {
  findTextDirective,
  generateForSelection,
  hasFragmentDirective,
  linearize,
  parseTextDirectives
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

/** Answer the browser's `generate` requests, and follow the URL's own directive when the engine did not. */
export function installTextFragmentScript(
  transport: TextFragmentTransport,
  win: Window = window
): void {
  transport.onCommand((message) => {
    if (!isTextFragmentHostMessage(message)) return
    const run = (): string | null => generateForSelection(win.document)
    let directive: string | null = null
    try {
      directive = transport.withSelection ? transport.withSelection(run) : run()
    } catch {
      directive = null
    }
    transport.send({ type: 'textFragment', id: message.id, directive })
  })
  followTextFragment(win)
}

/**
 * Whether this document is one for the script to follow the directive in: the top document of
 * an engine without text fragments, whose URL carries one.
 */
export function needsTextFragmentFallback(win: Window): boolean {
  try {
    if (win !== win.top) return false
    if ('fragmentDirective' in win.document) return false
    return hasFragmentDirective(win.location.href)
  } catch {
    return false
  }
}

/**
 * Scroll to and highlight the URL's text directives once the document has loaded (and once more a
 * moment later, for content that renders late), where the engine did not. Nothing when it did.
 */
export function followTextFragment(win: Window): void {
  if (!needsTextFragmentFallback(win)) return
  const doc = win.document
  let done = false
  const attempt = (): void => {
    if (done) return
    if (highlightTextFragments(win)) done = true
  }
  const start = (): void => {
    attempt()
    if (!done) win.setTimeout(attempt, LATE_CONTENT_MS)
  }
  if (doc.readyState === 'complete') start()
  else win.addEventListener('load', start, { once: true })
}

/**
 * Find the directives of the document's URL in it, paint their matches and scroll the first
 * into view. True when at least one matched. The engine's own processing is not repeated:
 * callers check `needsTextFragmentFallback` first.
 */
export function highlightTextFragments(win: Window): boolean {
  const doc = win.document
  const root = doc.body
  if (!root) return false
  const hash = win.location.href.slice(win.location.href.indexOf('#') + 1)
  const directives = parseTextDirectives(hash)
  if (directives.length === 0) return false
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
