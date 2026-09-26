import type { ShareAnswer, SharePayload, ShareRequest, Tab } from '../shared/types'
import {
  isShareCall,
  shareFileInfo,
  type ShareCall,
  type ShareFile,
  type ShareOutcome
} from '../shared/share'
import { copyConfirmation } from '../shared/clipboard'
import { newId } from '../shared/ids'
import { displayHost } from '../shared/url'
import type { Browser } from './browser'
import { surfaceMounted, type ZenWindow } from './window'

export interface ShareServiceOptions {
  now?: () => number
}

interface Pending {
  request: ShareRequest
  files: ShareFile[]
  /** Set for a page's `navigator.share`: the page hears how it ended. */
  page: { tabId: string; callId: string } | null
}

/** A page's share the OS's own sheet is showing (Android): the host's answer settles the page's promise. */
interface SystemPending {
  tabId: string
  callId: string
}

/** The text a "Copy" of a share puts on the clipboard: the link when there is one, else the text. */
export function shareClipboardText(request: Pick<ShareRequest, 'title' | 'text' | 'url'>): string {
  if (request.url) return request.url
  if (request.text) return request.text
  return request.title
}

/**
 * The one picture a share carries, when that is all it carries: a single image file with its
 * bytes and no link or text beside it – a capture's Share, a page's
 * `navigator.share({ files: [png] })`. The sheet's Copy puts it on the clipboard as an image
 * then, not the share's words (the chrome's `sharedImage` names the row the same way).
 */
export function shareImage(
  request: Pick<ShareRequest, 'url' | 'text'>,
  files: readonly ShareFile[]
): ShareFile | null {
  if (request.url || request.text || files.length !== 1) return null
  const [file] = files
  return file.data !== undefined && /^image\//i.test(file.type) ? file : null
}

/** A `mailto:` carrying the share (Chrome's "Mail" target on the desktop sheet). */
export function shareMailto(request: Pick<ShareRequest, 'title' | 'text' | 'url'>): string {
  const params = new URLSearchParams()
  if (request.title) params.set('subject', request.title)
  const body = [request.text, request.url].filter(Boolean).join('\n')
  if (body) params.set('body', body)
  const query = params.toString().replace(/\+/g, '%20')
  return `mailto:${query ? `?${query}` : ''}`
}

/**
 * The chrome's share sheet (MW-21; `capabilities.shareSheet`): what a page's `navigator.share`
 * or a Share… menu item asks to share, with the targets a desktop has – copy the link, a QR code
 * (the chrome draws it from `url`), email, save shared files, and the OS's own sheet where there
 * is one (macOS). A page's promise resolves once a target was chosen and rejects when the sheet
 * is dismissed, as in Chrome.
 *
 * Where the chrome has no sheet of its own and the OS has one (`capabilities.share`, Android;
 * SH-14), a page's call goes to the OS's sheet through the host's `share` with `awaitOutcome`,
 * and the host's word on how it ended settles the promise the same way.
 */
export class ShareService {
  private readonly pending: Pending[] = []
  private readonly system: SystemPending[] = []
  private readonly now: () => number

  constructor(
    private readonly browser: Browser,
    options: ShareServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  /** This window's sheet requests, oldest first. */
  listFor(win: ZenWindow): ShareRequest[] {
    return this.pending.filter((p) => p.request.windowId === win.id).map((p) => p.request)
  }

  /**
   * A page called `navigator.share`. A window whose chrome has no share sheet up
   * (`ChromeSurface`) hands the call to the OS's own sheet where the host has one (Android), or
   * else answers at once as a dismissed sheet would – the page's promise rejects with Chrome's
   * `AbortError` – rather than holding the call for a sheet that is not there.
   */
  handleMessage(tabId: string, call: unknown): void {
    if (!isShareCall(call)) return
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!tab || !view) return
    // One share at a time per page (the shim refuses a second call; a stale one gives way).
    this.cancelForTab(tabId)
    const win = this.browser.tabs.windowFor(tabId)
    if (!surfaceMounted(win, 'share')) {
      if (this.systemShare(tabId, call, tab)) return
      view.postToPage?.({ type: 'share', id: call.id, result: 'aborted' })
      return
    }
    this.add(
      {
        tabId,
        windowId: win.id,
        origin: displayHost(tab.url) || null,
        title: call.title,
        text: call.text,
        url: call.url,
        files: call.files.map(shareFileInfo),
        imageUrl: null
      },
      call.files,
      { tabId, callId: call.id }
    )
  }

  /**
   * The OS's share sheet for a page's call (SH-14): the host shows it with the page's text, link
   * and files and answers once it has closed; `shared` when a target took the share, `aborted`
   * when it was dismissed – or when the host could not say, since a page whose promise never
   * settles is worse than one told its share was cancelled. False when the host has no sheet.
   */
  private systemShare(tabId: string, call: ShareCall, tab: Tab): boolean {
    const { shell } = this.browser.platform
    if (!this.browser.state.capabilities.share || !shell.share) return false
    const entry: SystemPending = { tabId, callId: call.id }
    this.system.push(entry)
    const payload: SharePayload = {
      title: call.title,
      text: call.text,
      url: call.url,
      files: call.files,
      tabId,
      favicon: tab.favicon ?? undefined,
      awaitOutcome: true
    }
    void shell
      .share(payload)
      .then(
        (outcome): ShareOutcome => (outcome === 'shared' ? 'shared' : 'aborted'),
        (): ShareOutcome => 'aborted'
      )
      .then((outcome) => {
        const index = this.system.indexOf(entry)
        // Gone already: the tab navigated or closed and the page heard `aborted` then.
        if (index < 0) return
        this.system.splice(index, 1)
        this.browser.tabs.view(tabId)?.postToPage?.({ type: 'share', id: call.id, result: outcome })
      })
    return true
  }

  /**
   * The browser's own share (a Share… menu item, the toolbar; a capture's Share with the
   * picture as its one file). Files with bytes are the sheet's to copy, save or hand on; a
   * file the host holds by address only (`uri`) is Android's and never reaches this sheet.
   */
  open(payload: SharePayload, win: ZenWindow): ShareRequest {
    const files = (payload.files ?? []).filter((f) => f.data !== undefined)
    return this.add(
      {
        tabId: payload.tabId ?? null,
        windowId: win.id,
        origin: null,
        title: payload.title ?? '',
        text: payload.text ?? '',
        url: payload.url ?? '',
        files: files.map(shareFileInfo),
        imageUrl: payload.imageUrl ?? null
      },
      files,
      null
    )
  }

  private add(
    fields: Omit<ShareRequest, 'id' | 'system' | 'requestedAt'>,
    files: ShareFile[],
    page: Pending['page']
  ): ShareRequest {
    const request: ShareRequest = {
      id: newId('share'),
      ...fields,
      system: typeof this.browser.platform.shareSheet?.system === 'function',
      requestedAt: this.now()
    }
    this.pending.push({ request, files, page })
    this.browser.state.commitVolatile()
    return request
  }

  /** The sheet's answer. */
  async respond(id: string, answer: ShareAnswer): Promise<void> {
    const index = this.pending.findIndex((p) => p.request.id === id)
    if (index < 0) return
    const [entry] = this.pending.splice(index, 1)
    this.browser.state.commitVolatile()
    const { request } = entry
    const win =
      this.browser.allWindows().find((w) => w.id === request.windowId) ??
      this.browser.focusedWindow()
    let outcome: ShareOutcome = 'shared'
    try {
      switch (answer) {
        case 'copy': {
          const image = shareImage(request, entry.files)
          if (image) {
            await this.copyImage(image, win)
            break
          }
          const text = shareClipboardText(request)
          if (text) this.browser.copyText(text, request.url ? 'Link copied' : 'Copied', win)
          break
        }
        case 'email':
          this.browser.platform.shell.openExternal(shareMailto(request))
          break
        case 'save':
          await this.save(entry, win)
          break
        case 'system': {
          const system = this.browser.platform.shareSheet?.system
          if (system)
            await system(
              { title: request.title, text: request.text, url: request.url, files: entry.files },
              win
            )
          else outcome = 'aborted'
          break
        }
        case 'dismiss':
          outcome = 'aborted'
          break
      }
    } catch (error) {
      this.browser.toast(`Could not share: ${(error as Error).message}`, 'error', win)
      outcome = 'aborted'
    }
    this.finish(entry, outcome)
  }

  /**
   * A shared picture onto the clipboard as an image (a capture's Share › Copy image): the
   * image context menu's path on both hosts, with its confirmation – the desktop's toast too,
   * since the sheet has left by then and nothing else says the copy happened.
   */
  private async copyImage(image: ShareFile, win: ZenWindow): Promise<void> {
    const ok = await this.browser.platform.clipboard.writeImageFromUrl(
      `data:${image.type};base64,${image.data}`
    )
    if (!ok) throw new Error('the picture could not be copied')
    const toast = copyConfirmation(
      this.browser.state.platform,
      this.browser.state.capabilities,
      'Image copied',
      'Image copied'
    )
    if (toast) this.browser.toast(toast, 'info', win)
  }

  /**
   * Shared files into the downloads folder, each listed as a finished download – the bubble
   * and the Downloads page show where it went, with Show in folder, as they do a capture the
   * card saved itself (capture-22). The host writes the files with bytes in the order given
   * and answers with their paths in that order.
   */
  private async save(entry: Pending, win: ZenWindow): Promise<void> {
    const { request } = entry
    if (entry.files.length > 0) {
      const host = this.browser.platform.shareSheet
      if (!host) throw new Error('this device cannot save shared files')
      const written = entry.files.filter((f) => f.data !== undefined)
      const paths = await host.saveFiles(entry.files)
      const tab = request.tabId ? this.browser.tabs.tab(request.tabId) : undefined
      paths.forEach((path, i) => {
        const file = written[i]
        this.browser.downloads.addCompleted(path, file?.type ?? '', {
          containerId: tab?.containerId,
          private: win.isPrivate,
          size: file?.size
        })
      })
      const n = paths.length
      if (n > 0)
        this.browser.toast(
          n === 1 ? 'File saved to Downloads' : `${n} files saved to Downloads`,
          'info',
          win
        )
      return
    }
    if (request.imageUrl && request.tabId) {
      this.browser.tabs.view(request.tabId)?.downloadURL(request.imageUrl)
      return
    }
    throw new Error('nothing to save')
  }

  private finish(entry: Pending, outcome: ShareOutcome): void {
    if (!entry.page) return
    this.browser.tabs
      .view(entry.page.tabId)
      ?.postToPage?.({ type: 'share', id: entry.page.callId, result: outcome })
  }

  /** The tab navigated or closed: its sheet goes and the page's promise rejects. */
  cancelForTab(tabId: string): void {
    for (const entry of this.system.filter((p) => p.tabId === tabId)) {
      this.system.splice(this.system.indexOf(entry), 1)
      this.browser.tabs
        .view(tabId)
        ?.postToPage?.({ type: 'share', id: entry.callId, result: 'aborted' })
    }
    const gone = this.pending.filter((p) => p.request.tabId === tabId && p.page !== null)
    if (gone.length === 0) return
    for (const entry of gone) {
      this.pending.splice(this.pending.indexOf(entry), 1)
      this.finish(entry, 'aborted')
    }
    this.browser.state.commitVolatile()
  }
}
