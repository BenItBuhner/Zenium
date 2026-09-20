import type { Session, WebContents } from 'electron'
import {
  normalizeOffscreenRequest,
  OFFSCREEN_CLOSED_WHILE_LOADING_ERROR,
  OFFSCREEN_LOAD_FAILED_ERROR,
  OFFSCREEN_NONE_ERROR,
  OFFSCREEN_ONLY_ONE_ERROR,
  type OffscreenReason
} from '../../../core/extensions/api/offscreen'
import { ApiError, validated, type ApiContext, type NamespaceHandlers } from './types'

/** A hosted document: its page, its first load, and how to close it. */
export interface OffscreenDocumentPage {
  webContents: WebContents
  /** Settles with the document's first load: resolved once loaded, rejected when it failed. */
  loaded: Promise<void>
  close(): void
}

/** What the API needs of the engine (`offscreenBridge.ts` wraps Electron's hidden window). */
export interface OffscreenDocumentHost {
  /**
   * Open a hidden page of the session at the URL; the page exists on return (so its hello can be
   * placed) and loads in the background. `onGone` fires when the page goes away on its own after.
   */
  open(session: Session, url: string, onGone: () => void): OffscreenDocumentPage
}

interface OpenDocument {
  url: string
  reasons: OffscreenReason[]
  page: OffscreenDocumentPage
}

/**
 * `chrome.offscreen` with the document hosted by the browser layer: one per extension, created
 * from a URL of the extension, closed by the extension, with its unload, or by the page going
 * away (a crash). The document counts from the moment it is created, as in Chrome's
 * `OffscreenDocumentManager`: a second `createDocument` while the first still loads is refused,
 * `hasDocument` is true meanwhile, and a `closeDocument` meanwhile fails the pending creation
 * with Chrome's text. Hosting the page here rather than in Chromium's `ExtensionHost` is what
 * keeps a document that enumerates or opens media devices from crashing the browser on
 * Electron, and what lets it consume a `tabCapture` stream.
 *
 * Not carried over from Chrome: the per-reason lifetime enforcers (an `AUDIO_PLAYBACK` document
 * closed after 30 s of silence, and so on). A document lives until the extension closes it or
 * is unloaded.
 */
export class OffscreenApi {
  private readonly documents = new Map<string, OpenDocument>()

  constructor(private readonly pages: OffscreenDocumentHost) {}

  readonly handlers: NamespaceHandlers = {
    createDocument: (ctx, parameters) => this.createDocument(ctx, parameters),
    closeDocument: (ctx) => this.closeDocument(ctx),
    hasDocument: (ctx) => this.hasDocument(ctx)
  }

  /** Whether the page is an extension's offscreen document (`runtime.getContexts` typing). */
  hosts(wc: WebContents): boolean {
    for (const doc of this.documents.values()) if (doc.page.webContents === wc) return true
    return false
  }

  /** The offscreen document of an extension, if it has one open. */
  documentOf(extensionId: string): { url: string; webContents: WebContents } | null {
    const doc = this.documents.get(extensionId)
    return doc ? { url: doc.url, webContents: doc.page.webContents } : null
  }

  /** The extension went away (unload, reload, uninstall): so does its document. */
  unload(extensionId: string): void {
    const doc = this.documents.get(extensionId)
    if (!doc) return
    this.documents.delete(extensionId)
    doc.page.close()
  }

  private async createDocument(ctx: ApiContext, parameters: unknown): Promise<void> {
    const request = validated(() => normalizeOffscreenRequest(ctx.extensionId, parameters))
    if (this.documents.has(ctx.extensionId)) throw new ApiError(OFFSCREEN_ONLY_ONE_ERROR)
    const session = ctx.extension.sessions[0] ?? ctx.session
    const page = this.pages.open(session, request.url, () => this.gone(ctx.extensionId, page))
    this.documents.set(ctx.extensionId, { url: request.url, reasons: request.reasons, page })
    try {
      await page.loaded
    } catch (error) {
      // Closed (by the extension or its unload) before it loaded, or a load that failed: the
      // failed one is closed here, the way Chrome closes it before answering.
      if (this.documents.get(ctx.extensionId)?.page !== page) {
        throw new ApiError(OFFSCREEN_CLOSED_WHILE_LOADING_ERROR)
      }
      this.documents.delete(ctx.extensionId)
      page.close()
      console.warn(
        `[zen] offscreen document of ${ctx.extensionId} failed to load:`,
        error instanceof Error ? error.message : error
      )
      throw new ApiError(OFFSCREEN_LOAD_FAILED_ERROR)
    }
    if (this.documents.get(ctx.extensionId)?.page !== page) {
      throw new ApiError(OFFSCREEN_CLOSED_WHILE_LOADING_ERROR)
    }
  }

  private closeDocument(ctx: ApiContext): void {
    const doc = this.documents.get(ctx.extensionId)
    if (!doc) throw new ApiError(OFFSCREEN_NONE_ERROR)
    this.documents.delete(ctx.extensionId)
    doc.page.close()
  }

  private hasDocument(ctx: ApiContext): boolean {
    return this.documents.has(ctx.extensionId)
  }

  /** The page went away on its own (a crash, the engine closing it): the slot is free again. */
  private gone(extensionId: string, page: OffscreenDocumentPage): void {
    if (this.documents.get(extensionId)?.page !== page) return
    this.documents.delete(extensionId)
  }
}
