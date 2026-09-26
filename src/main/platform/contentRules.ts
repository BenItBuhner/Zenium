/**
 * The desktop host of the per-site content settings that act in the request engine and at
 * document start (`src/core/contentRules.ts`):
 *
 * - Images (PS-63): {@link ContentRulesHandler} cancels every `image` request of a page whose
 *   site is set to block images – as Chrome's `IMAGES` content setting stops the renderer from
 *   fetching them – right after the lookalike hold and ahead of the rule engine, so a blocked
 *   image costs no rule evaluation. The question is one map lookup by the top document's site.
 * - PDF documents (PS-68's setting, `pdf`): a document or frame response of `application/pdf`
 *   from a site set to download PDFs gets `Content-Disposition: attachment` at `onHeadersReceived`,
 *   which turns Chromium's viewer navigation into a download the downloads service takes
 *   (Chrome's "Download PDFs").
 * - The page-world guards (sensors, third-party sign-in, payment handlers): the page preload's
 *   one document-start ask carries which of them the top document's site is refused (the
 *   `guards` field of `documentStart.ts`'s answer, provided by {@link attachContentGuards}) and
 *   the preload installs `installContentGuards` in the main world.
 *
 * JavaScript (PS-64) is the view's own: `TabView` in `views.ts` switches script execution off
 * through the debugger's `Emulation.setScriptExecutionDisabled` as a navigation starts.
 */
import type { IpcMainEvent, Session } from 'electron'
import type { PermissionRequestDetails } from '../../core/permissions'
import type { ContentGuardId } from '../../shared/contentGuards'
import type { ContentRuleId } from '../../shared/contentRules'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { registerDocumentStartProvider } from './documentStart'
import {
  HANDLER_ORDER,
  applyResponseHeaderOps,
  type BeforeRequestResult,
  type HeadersReceivedResult,
  type HostRequest,
  type RequestHandler
} from './webRequest'

/** The core's answers (`ContentRulesService`), as the handler and the document-start provider need them. */
export interface ContentRulesLookup {
  allows(id: ContentRuleId | 'pdf', url: string, details?: PermissionRequestDetails): boolean
  blockedGuards(url: string, details?: PermissionRequestDetails): ContentGuardId[]
}

/** The request's container, as the core reads a private container's own answers by it. */
export function requestDetails(containerId: string): PermissionRequestDetails | undefined {
  return containerId === PRIVATE_CONTAINER_ID ? { privateContainerId: containerId } : undefined
}

export class ContentRulesHandler implements RequestHandler {
  readonly id = 'content-rules'
  readonly order = HANDLER_ORDER.contentRules

  constructor(private readonly rules: ContentRulesLookup) {}

  /** A page that blocks images fetches none: its `image` requests end here. */
  onBeforeRequest(request: HostRequest): BeforeRequestResult {
    const { ctx } = request
    if (ctx.type !== 'image') return undefined
    const page = ctx.documentUrl ?? ctx.initiator
    if (!page || !/^(https?|file):/i.test(page)) return undefined
    if (this.rules.allows('images', page, requestDetails(request.containerId))) return undefined
    return { cancel: true }
  }

  /** A PDF a site set to "download" serves as a document becomes a download. */
  onHeadersReceived(
    request: HostRequest,
    headers: Record<string, string[]>
  ): HeadersReceivedResult | undefined {
    const { ctx } = request
    if (ctx.type !== 'main_frame' && ctx.type !== 'sub_frame') return undefined
    if (!/^https?:/i.test(ctx.url) || !isPdfResponse(headers)) return undefined
    if (this.rules.allows('pdf', ctx.url, requestDetails(request.containerId))) return undefined
    applyResponseHeaderOps(headers, [
      { header: 'Content-Disposition', operation: 'set', value: 'attachment' }
    ])
    return undefined
  }
}

/** Whether the response is a PDF document the engine would show in its viewer. */
export function isPdfResponse(headers: Record<string, string[]>): boolean {
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-type') continue
    return values.some((value) => /^\s*application\/pdf\b/i.test(value))
  }
  return false
}

/**
 * The `guards` field of the page preload's document-start answer: which guarded rows the top
 * document's site is refused. Answered from the sender's page (the tab's `WebContents`, whose
 * URL is the top document's, for a frame too – Chrome keys these settings by the embedding
 * site), with the private container's own answers where the page is a private window's.
 */
export function attachContentGuards(
  rules: ContentRulesLookup,
  containerOf: (ses: Session) => string | undefined
): void {
  registerDocumentStartProvider('guards', (event) => guardsForSender(rules, event, containerOf))
}

/** The sender's answer: its top document's site, in its container (the session's). */
export function guardsForSender(
  rules: ContentRulesLookup,
  event: Pick<IpcMainEvent, 'sender'>,
  containerOf: (ses: Session) => string | undefined
): ContentGuardId[] {
  try {
    const wc = event.sender
    if (!wc || wc.isDestroyed()) return []
    const url = wc.getURL()
    if (!/^(https?|file):/i.test(url)) return []
    const containerId = containerOf(wc.session)
    return rules.blockedGuards(url, containerId ? requestDetails(containerId) : undefined)
  } catch {
    return []
  }
}
