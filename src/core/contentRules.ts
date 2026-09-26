/**
 * The per-site content settings the hosts enforce at the load path (PS-63 images, PS-64
 * JavaScript, PS-59 insecure content, the sensors, third-party sign-in and payment-handler
 * rows). Every decision is `PermissionService.resolve`'s – an extension's rule
 * (`chrome.contentSettings`, the override provider) over the user's answers over the defaults:
 * the desktop host asks it straight (its request handlers, its per-view script switch, the
 * page-world guards), the Android host asks it per navigation (`resolveAll`, every row's answer
 * for the destination at once, since its `WebSettings` must be set before the request leaves).
 * The `ContentRules` document this service also pushes (`TabViewHost.setContentRules`) is the
 * store's part alone – defaults and sites – and is the Android host's fallback for a
 * navigation the core could not be asked about, and its defaults.
 */
import type { Browser } from './browser'
import type { PermissionRequestDetails } from './permissions'
import {
  CONTENT_RULE_IDS,
  EMPTY_CONTENT_RULES,
  blockedGuardsFor,
  isContentRuleId,
  type ContentRuleId,
  type ContentRules,
  type ResolvedContentRules
} from '../shared/contentRules'
import type { ContentDecision } from '../shared/contentSettings'

export class ContentRulesService {
  private pushed: string | null = null
  private unsubscribe: (() => void) | null = null
  private running = false

  constructor(private readonly browser: Browser) {}

  /**
   * After the permission store is read: the first document, then one per change of a row. An
   * extension's rules changing (`overridesChanged`, no origin) and a private container's own
   * answer (`container` set) alter no line of the document, so those pushes are forced: the
   * Android host drops the answers it remembered on any push.
   */
  start(): void {
    this.running = true
    this.unsubscribe = this.browser.permissions.subscribe((change) => {
      if (isContentRuleId(change.permission))
        this.push(change.origin === null || change.container !== undefined)
    })
    this.push()
  }

  stop(): void {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Whether the store has been read and the first document pushed: before that, answers are the defaults'. */
  get started(): boolean {
    return this.running
  }

  /** The document as the hosts get it: every row's effective default and its sites. */
  rules(): ContentRules {
    const permissions = this.browser.permissions
    const out = { ...EMPTY_CONTENT_RULES }
    for (const id of CONTENT_RULE_IDS) {
      const fallback = permissions.effectiveDefault(id)
      const sites: Record<string, ContentDecision> = {}
      for (const { origin, decision } of permissions.listForPermission(id)) sites[origin] = decision
      out[id] = { default: fallback === 'ask' ? EMPTY_CONTENT_RULES[id].default : fallback, sites }
    }
    return out
  }

  /**
   * Whether `id` is allowed for a page at `url`: the site's answer, an extension's rule, the
   * default – `PermissionService.resolve`, so a private container's own answers are read too.
   * `pdf` is the desktop request engine's row (deny = "download PDFs").
   */
  allows(id: ContentRuleId | 'pdf', url: string, details?: PermissionRequestDetails): boolean {
    return this.browser.permissions.resolve(id, url, details) !== 'deny'
  }

  /** The guarded rows a document of the page at `url` is refused (the page-world guards). */
  blockedGuards(url: string, details?: PermissionRequestDetails): ContentRuleId[] {
    return blockedGuardsFor(this.rulesFor(url, details), url)
  }

  /**
   * Every row's effective answer for a page at `url` at once – the Android host's question per
   * navigation, answered as `allows` answers each row (an extension's rule first, then the
   * site's answer in the tab's own container, then the default), so the WebView's `WebSettings`
   * and the document's guards read the same word the desktop's handlers would.
   */
  resolveAll(url: string, details?: PermissionRequestDetails): ResolvedContentRules {
    const out = {} as ResolvedContentRules
    for (const id of CONTENT_RULE_IDS) out[id] = this.allows(id, url, details)
    return out
  }

  /**
   * The rules as one page sees them (the desktop's guards ask per document): the resolved
   * decision of every row under the page's own site, so private answers count there too.
   */
  private rulesFor(url: string, details?: PermissionRequestDetails): ContentRules {
    const out = { ...EMPTY_CONTENT_RULES }
    for (const id of CONTENT_RULE_IDS) {
      const decision = this.browser.permissions.resolve(id, url, details)
      out[id] = { default: decision === 'deny' ? 'deny' : 'allow', sites: {} }
    }
    return out
  }

  /**
   * Hand the hosts the document when it changed (a host without the hook is asked directly);
   * `force` pushes an unchanged one, the signal that the answers resolve differently now.
   */
  push(force = false): void {
    const host = this.browser.platform.views.setContentRules
    if (!host) return
    const rules = this.rules()
    const signature = JSON.stringify(rules)
    if (!force && signature === this.pushed) return
    this.pushed = signature
    host.call(this.browser.platform.views, rules)
  }
}
