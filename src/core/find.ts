/**
 * Find in page: what Chrome's `FindTabHelper` and `FindBarState` remember between searches. Each
 * tab keeps the query it last searched for and the profile keeps the last query of any tab, so
 * Find Next / Previous with the bar closed reopen it with something to search for (F3, Ctrl+G) and
 * a tab that never searched starts from what the last one did. The results themselves stay per
 * window (`ZenWindow.findResult`); this is only the text.
 */
export class FindMemory {
  private readonly byTab = new Map<string, string>()
  private last = ''

  /** A search ran for `text` in the tab (an empty query clears nothing: it is the bar emptying). */
  remember(tabId: string, text: string): void {
    if (!text) return
    this.byTab.set(tabId, text)
    this.last = text
  }

  /** The query the bar opens with for `tabId`: the tab's own, else the profile's; '' at first. */
  queryFor(tabId: string): string {
    return this.byTab.get(tabId) ?? this.last
  }

  /** The tab closed; the profile-wide query outlives it. */
  forget(tabId: string): void {
    this.byTab.delete(tabId)
  }
}

/** Chrome prefills the bar with a selection only while it is short: one line of at most this many characters. */
export const SELECTION_QUERY_MAX = 100

/**
 * The page's selection as a find query: a single line (a selection spanning lines is a passage,
 * not a search term), trimmed, with runs of whitespace collapsed; '' when it will not do.
 */
export function selectionQuery(selection: unknown, maxLength = SELECTION_QUERY_MAX): string {
  if (typeof selection !== 'string') return ''
  const raw = selection.trim()
  if (!raw || /[\r\n]/.test(raw)) return ''
  const text = raw.replace(/\s+/g, ' ')
  return text.length > maxLength ? '' : text
}
