import {
  isClipboardReadCall,
  type ClipboardReadCall,
  type ClipboardReadResult
} from '../shared/clipboardRead'
import { PRIVATE_CONTAINER_ID, type ClipboardReadItems } from '../shared/types'
import type { Browser } from './browser'
import type { PermissionRequestDetails } from './permissions'

/** The catalogue row a page's clipboard read is decided on – Electron's name for it too. */
export const CLIPBOARD_READ_PERMISSION = 'clipboard-read'

/**
 * `navigator.clipboard.read()` / `readText()` for pages whose engine refuses every read (MW-38;
 * the Android WebView): the page's shim asks here (`shared/clipboardRead`), the site's
 * `clipboard-read` permission is decided by the shared permission service – the prompt, the
 * answer remembered per site, the user's default, the unused-sites sweep, exactly what the
 * desktop's engine request goes through – and, allowed, the host's clipboard text goes back to
 * the page, with the clip's image beside it for a `read()` (`ClipboardHost.readItems`, PNG
 * base64, bounded by the host). Refused, the page's promise rejects as Chrome's does.
 */
export class ClipboardReadService {
  constructor(private readonly browser: Browser) {}

  /** The page's shim asked. */
  handleMessage(tabId: string, call: unknown): void {
    if (!isClipboardReadCall(call)) return
    if (!this.browser.tabs.pageView(tabId)) return
    void this.answer(tabId, call)
  }

  private async answer(tabId: string, call: ClipboardReadCall): Promise<void> {
    // The asking page's address: the page's own beneath the reader's cover.
    const url = this.browser.tabs.pageUrl(tabId)
    if (url === undefined) return
    const allowed = await this.browser.permissions.decide(
      CLIPBOARD_READ_PERMISSION,
      url,
      this.details(tabId)
    )
    if (!allowed) {
      this.post(tabId, url, { id: call.id, error: 'denied' })
      return
    }
    // A page gone while its prompt was up gets no read at all: the clipboard is not touched
    // (nor Android 12's toast shown) for a document that is no longer there to receive it.
    if (!this.stillThere(tabId, url)) return
    // `read()` takes the clip's image too, where the host reads one; `readText()` the text alone.
    const items = call.kind === 'items' ? await this.readItems() : { text: await this.readText() }
    const result: ClipboardReadResult = { id: call.id, text: items.text }
    if (items.image) result.image = items.image
    this.post(tabId, url, result)
  }

  /** A private tab's answer stays with the private session (Chrome's Incognito rule). */
  private details(tabId: string): PermissionRequestDetails {
    const details: PermissionRequestDetails = { tabId }
    const tab = this.browser.tabs.tab(tabId)
    if (tab && this.browser.tabs.isPrivate(tab)) details.privateContainerId = PRIVATE_CONTAINER_ID
    return details
  }

  /**
   * The clipboard's text through the host ('' when it holds none, or the host cannot read it):
   * on the phone the same read as the URL bar's row, which Android 12+ announces with its
   * "pasted from" toast, once per clip.
   */
  private async readText(): Promise<string> {
    const read = this.browser.platform.clipboard.readText
    if (!read) return ''
    try {
      return await read()
    } catch {
      return ''
    }
  }

  /**
   * The clipboard's text and image for a page's `read()`: the host's `readItems` where it has
   * one (the phone: one read of the clip, its image bounded and PNG-encoded by the host), else
   * the text alone as `readText` gives it. A failed read hands the text alone ('' at worst), as
   * `readText` does – never a rejection for a clip the page is allowed to see.
   */
  private async readItems(): Promise<ClipboardReadItems> {
    const read = this.browser.platform.clipboard.readItems
    if (!read) return { text: await this.readText() }
    try {
      return await read()
    } catch {
      return { text: await this.readText() }
    }
  }

  /**
   * Whether the tab's page is still the one that asked – the same origin as at the call – and
   * its view still there to answer (the page's own beneath the reader's cover).
   */
  private stillThere(tabId: string, url: string): boolean {
    const pageUrl = this.browser.tabs.pageUrl(tabId)
    const view = this.browser.tabs.pageView(tabId)
    if (pageUrl === undefined || !view || view.isDestroyed()) return false
    return sameOrigin(pageUrl, url)
  }

  /** The answer, to the page that asked – not to a document that has since replaced it. */
  private post(tabId: string, url: string, result: ClipboardReadResult): void {
    if (!this.stillThere(tabId, url)) return
    this.browser.tabs.pageView(tabId)?.postToPage?.({ type: 'clipboardRead', ...result })
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return a === b
  }
}
