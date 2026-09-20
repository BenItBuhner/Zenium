import type { Debugger, WebContents } from 'electron'
import {
  ERROR_ALREADY_ATTACHED,
  ERROR_CANNOT_ATTACH,
  ERROR_NOT_ATTACHED,
  ERROR_NO_TAB,
  ERROR_PERMISSION,
  ERROR_TARGET_NOT_FOUND,
  attachRefusal,
  commandErrorMessage,
  normalizeDebuggee,
  protocolVersionRefusal,
  tabIdOfTarget,
  tabTargetId,
  type Debuggee,
  type DebuggerTargetInfo,
  type DetachReason
} from '../../../core/extensions/api/debugger'
import type { Tab } from '../../../shared/types'
import {
  ApiError,
  isRecord,
  validated,
  type ApiContext,
  type ApiHost,
  type NamespaceHandlers
} from './types'

/** What the module needs of the engine's per-page debugger (`WebContents.debugger`). */
export type PageDebugger = Pick<
  Debugger,
  'attach' | 'detach' | 'isAttached' | 'sendCommand' | 'on' | 'off'
>

/** One extension's session on one tab. */
interface Attachment {
  extensionId: string
  tabId: number
  wc: WebContents
  dbg: PageDebugger
  /**
   * The engine's session was already open (Zenium's own overrides or DevTools hold it) when the
   * extension attached: the extension shares it and its `detach` leaves it in place, the way
   * Zenium's own holders leave a session they did not open.
   */
  shared: boolean
  off: () => void
}

/**
 * `chrome.debugger`: a DevTools protocol session on a tab, over the engine's per-page debugger.
 * Chrome's rules: the `debugger` permission, one extension per tab, no attaching to the browser's
 * own pages or another extension's, `sendCommand` only while attached, `onDetach` when the tab
 * goes away or the session is taken from under the extension (never for its own `detach`), and
 * `getTargets` listing the tabs. Chrome's "is debugging this browser" bar has no counterpart yet.
 */
export class DebuggerApi {
  private readonly attachments = new Map<string, Attachment>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    attach: (ctx, target, version) => this.attach(ctx, target, version),
    detach: (ctx, target) => this.detach(ctx, target),
    sendCommand: (ctx, target, method, params) => this.sendCommand(ctx, target, method, params),
    getTargets: (ctx) => this.getTargets(ctx)
  }

  /** An extension was unloaded: its sessions end quietly (there is no one to tell). */
  unload(extensionId: string): void {
    for (const attachment of [...this.attachments.values()]) {
      if (attachment.extensionId === extensionId) this.end(attachment, null)
    }
  }

  /** Sessions open right now, for diagnostics and tests. */
  attachedTabs(extensionId?: string): number[] {
    return [...this.attachments.values()]
      .filter((a) => extensionId === undefined || a.extensionId === extensionId)
      .map((a) => a.tabId)
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  private attach(ctx: ApiContext, rawTarget: unknown, rawVersion: unknown): void {
    this.requirePermission(ctx)
    const target = validated(() => normalizeDebuggee(rawTarget))
    const version = typeof rawVersion === 'string' ? rawVersion : ''
    const refusedVersion = protocolVersionRefusal(version)
    if (refusedVersion) throw new ApiError(refusedVersion)
    const { tabId, tab } = this.tabOf(target)
    const refused = attachRefusal(tab.url, ctx.extensionId)
    if (refused) throw new ApiError(refused)
    const wc = this.host.model.webContentsOf(tab)
    if (!wc || wc.isDestroyed()) throw new ApiError(ERROR_CANNOT_ATTACH)
    for (const other of this.attachments.values()) {
      if (other.tabId === tabId) throw new ApiError(ERROR_ALREADY_ATTACHED(tabId))
    }
    const dbg: PageDebugger = wc.debugger
    const shared = dbg.isAttached()
    if (!shared) {
      try {
        dbg.attach(version)
      } catch {
        throw new ApiError(ERROR_ALREADY_ATTACHED(tabId))
      }
    }
    const source: Debuggee = { tabId }
    const onMessage = (
      _event: unknown,
      method: string,
      params: unknown,
      sessionId?: string
    ): void => {
      const from: Debuggee = sessionId ? { ...source, sessionId } : source
      this.host.dispatch(ctx.extensionId, 'debugger', 'onEvent', [from, method, params ?? {}])
    }
    const onDetach = (): void => {
      const attachment = this.attachments.get(this.key(ctx.extensionId, tabId))
      if (attachment) this.end(attachment, 'target_closed')
    }
    const onDestroyed = (): void => onDetach()
    dbg.on('message', onMessage)
    dbg.on('detach', onDetach)
    wc.once('destroyed', onDestroyed)
    const attachment: Attachment = {
      extensionId: ctx.extensionId,
      tabId,
      wc,
      dbg,
      shared,
      off: () => {
        dbg.off('message', onMessage)
        dbg.off('detach', onDetach)
        if (!wc.isDestroyed()) wc.off('destroyed', onDestroyed)
      }
    }
    this.attachments.set(this.key(ctx.extensionId, tabId), attachment)
  }

  private detach(ctx: ApiContext, rawTarget: unknown): void {
    this.requirePermission(ctx)
    const target = validated(() => normalizeDebuggee(rawTarget))
    // Own detach: the session goes unless someone else holds it; no `onDetach` (Chrome's rule).
    this.end(this.attachmentOf(ctx, target), null)
  }

  private async sendCommand(
    ctx: ApiContext,
    rawTarget: unknown,
    rawMethod: unknown,
    rawParams: unknown
  ): Promise<unknown> {
    this.requirePermission(ctx)
    const target = validated(() => normalizeDebuggee(rawTarget))
    if (typeof rawMethod !== 'string' || rawMethod === '') {
      throw new ApiError("Error at parameter 'method': Value must be a string.")
    }
    const params = rawParams === undefined || rawParams === null ? {} : rawParams
    if (!isRecord(params))
      throw new ApiError("Error at parameter 'commandParams': Value must be an object.")
    const attachment = this.attachmentOf(ctx, target)
    try {
      const result: unknown = await attachment.dbg.sendCommand(rawMethod, params, target.sessionId)
      return result ?? {}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ApiError(commandErrorMessage(message))
    }
  }

  private getTargets(ctx: ApiContext): DebuggerTargetInfo[] {
    this.requirePermission(ctx)
    const attached = new Set(this.attachedTabs())
    return this.host.model.allTabs().map((tab) => {
      const tabId = this.host.model.chromeTabId(tab)
      const info: DebuggerTargetInfo = {
        type: 'page',
        id: tabTargetId(tabId),
        tabId,
        attached:
          attached.has(tabId) ||
          (this.host.model.webContentsOf(tab)?.debugger.isAttached() ?? false),
        title: tab.title,
        url: tab.url
      }
      if (tab.favicon) info.faviconUrl = tab.favicon
      return info
    })
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private requirePermission(ctx: ApiContext): void {
    if (!this.host.grants(ctx.extensionId).permissions.includes('debugger')) {
      throw new ApiError(ERROR_PERMISSION)
    }
  }

  /** The tab a `Debuggee` names; other target kinds (extension pages, workers) are not attachable here. */
  private tabOf(target: Debuggee): { tabId: number; tab: Tab } {
    let tabId = target.tabId
    if (tabId === undefined && target.targetId !== undefined) {
      const named = tabIdOfTarget(target.targetId)
      if (named === null) throw new ApiError(ERROR_TARGET_NOT_FOUND)
      tabId = named
    }
    if (tabId === undefined) throw new ApiError(ERROR_CANNOT_ATTACH)
    const tab = this.host.model.zenTab(tabId)
    if (!tab) throw new ApiError(ERROR_NO_TAB(tabId))
    return { tabId, tab }
  }

  private attachmentOf(ctx: ApiContext, target: Debuggee): Attachment {
    let tabId = target.tabId
    if (tabId === undefined && target.targetId !== undefined) {
      tabId = tabIdOfTarget(target.targetId) ?? undefined
    }
    if (tabId === undefined) throw new ApiError(ERROR_CANNOT_ATTACH)
    const attachment = this.attachments.get(this.key(ctx.extensionId, tabId))
    if (!attachment) throw new ApiError(ERROR_NOT_ATTACHED(tabId))
    return attachment
  }

  /**
   * The session is over. With a reason it ended from outside (the tab closed, another client
   * took the debugger) and the extension hears `onDetach`; without one the extension ended it
   * (`detach`, or it was unloaded) and the engine's session goes too, unless the extension had
   * only shared a session Zenium's own holders opened.
   */
  private end(attachment: Attachment, reason: DetachReason | null): void {
    attachment.off()
    this.attachments.delete(this.key(attachment.extensionId, attachment.tabId))
    if (reason === null) {
      if (!attachment.shared && !attachment.wc.isDestroyed() && attachment.dbg.isAttached()) {
        try {
          attachment.dbg.detach()
        } catch {
          // The engine dropped it first: nothing to undo.
        }
      }
      return
    }
    if (this.host.loaded(attachment.extensionId)) {
      this.host.dispatch(attachment.extensionId, 'debugger', 'onDetach', [
        { tabId: attachment.tabId },
        reason
      ])
    }
  }

  private key(extensionId: string, tabId: number): string {
    return `${extensionId}:${tabId}`
  }
}
