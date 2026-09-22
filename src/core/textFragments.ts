/**
 * Links to a highlight (SH-11; Chrome's Copy Link to Highlight and the share of a selection):
 * the page's own script singles the selection out as a `text=` directive
 * (`shared/textFragmentScript`, asked through `postToPage`) and the tab's URL takes it as its
 * fragment directive (`#:~:text=…`). The page has the selection and the rendered text, so the
 * work is done there; the core only asks, waits and appends. A page that does not answer in
 * time (no script in it yet, a frozen renderer) gives no link rather than a hanging action.
 */

import type { Browser } from './browser'
import { appendTextDirective } from '../shared/textFragment'
import { isTextFragmentPageMessage } from '../shared/textFragmentScript'
import { newId } from '../shared/ids'

/** How long a page may take to answer before the link is given up on. */
export const TEXT_FRAGMENT_WAIT_MS = 1_500

interface Pending {
  tabId: string
  resolve: (directive: string | null) => void
  timer: ReturnType<typeof setTimeout>
}

export class TextFragments {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly browser: Browser) {}

  /** The encoded `text=` directive for the tab's current selection, or null when there is none to make. */
  generate(tabId: string): Promise<string | null> {
    const view = this.browser.tabs.view(tabId)
    if (!view?.postToPage) return Promise.resolve(null)
    const id = newId('tf')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, TEXT_FRAGMENT_WAIT_MS)
      this.pending.set(id, { tabId, resolve, timer })
      view.postToPage?.({ type: 'textFragment', action: 'generate', id })
    })
  }

  /** The page answered (`handlePageMessage`): the request settles with its directive. */
  handleMessage(tabId: string, message: unknown): void {
    if (!isTextFragmentPageMessage(message)) return
    const entry = this.pending.get(message.id)
    if (!entry || entry.tabId !== tabId) return
    clearTimeout(entry.timer)
    this.pending.delete(message.id)
    entry.resolve(message.directive)
  }

  /**
   * The tab's URL with the directive for its selection as the fragment directive, or null: the
   * page is not a web page (a link to a highlight in `zen://` or a file means nothing to another
   * device), or the selection cannot be singled out.
   */
  async highlightUrl(tabId: string): Promise<string | null> {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !/^https?:\/\//i.test(tab.url)) return null
    const directive = await this.generate(tabId)
    if (!directive) return null
    const current = this.browser.tabs.tab(tabId)
    if (!current || current.url !== tab.url) return null
    return appendTextDirective(tab.url, directive)
  }

  /** A tab went: its pending requests answer nothing. */
  cancelForTab(tabId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.tabId !== tabId) continue
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.resolve(null)
    }
  }
}
