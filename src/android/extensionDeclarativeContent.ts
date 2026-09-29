import {
  SHOW_ACTION,
  actionsFor,
  checkRules,
  mintedRuleId,
  nextMintedCount,
  persistedRulesFrom,
  ruleForExtension,
  selectRules,
  withoutRules,
  type PersistedRule
} from '@core/extensions/api/declarativeContent'
import type { AttachedExtension } from './extensionApi'

export const DECLARATIVE_CONTENT_PERMISSION = 'declarativeContent'
export const DECLARATIVE_CONTENT_NO_PERMISSION_ERROR =
  "The extension does not have the 'declarativeContent' permission."
/** The one declarative event the namespace has; the shim names it first in every rule call. */
const PAGE_CHANGED = 'onPageChanged'

/** What the rules need from the runtime: the extensions, their tabs' pages, the store. */
export interface DeclarativeContentHost {
  attached(id: string): AttachedExtension | undefined
  /** The URL the page in the tab reads as to `ext`, or null for a tab it may not see (or none). */
  pageUrl(ext: AttachedExtension, chromeTabId: number): string | null
  /** The rules kept for the extension across sessions (Chrome's `ExtensionPrefs`), and their store. */
  persistedRules(id: string): unknown
  persistRules(id: string, rules: PersistedRule[]): void
  /** The rules changed: what the toolbar shows for the tabs may have. */
  changed(): void
}

/**
 * `chrome.declarativeContent` on the phone: the rules of `onPageChanged` kept per extension
 * across worker starts and sessions (Chrome's `RulesRegistry` over `ExtensionPrefs` – an update
 * or a disable keeps them, an uninstall alone drops them, so an extension registers them in
 * `runtime.onInstalled`: Story Saver's `action.disable()` then one rule showing it on its three
 * sites), checked and answered in Chrome's words (`core/extensions/api/declarativeContent.ts`),
 * and evaluated against a tab's page where the action's state is read: a rule with a `ShowAction`
 * holding for the tab's URL shows the toolbar action on that tab over a global `action.disable()`
 * and under the tab's own `enable` / `disable` – `ExtensionAction::GetIsVisible`'s order. Chrome
 * evaluates at every navigation and keeps the result per tab; the phone's toolbar re-reads the
 * state at every commit of the model, so the evaluation runs from the tab's current URL when
 * asked, to the same answer.
 *
 * Stated: a `css` or `isBookmarked` condition never holds here (the page's DOM is not asked for
 * its selectors, the bookmark store not consulted); `SetIcon` is accepted and kept for `getRules`,
 * not drawn (the phone's toolbar shows the manifest's icon, as `action.setIcon` does not draw).
 */
export class AndroidDeclarativeContent {
  /** id → the stored value last read and the rules parsed from it (the store hands the same array until it changes). */
  private readonly parsed = new Map<string, { raw: unknown; rules: PersistedRule[] }>()

  constructor(private readonly host: DeclarativeContentHost) {}

  /**
   * Whether a rule shows the extension's action on the tab right now (`declarative_show_count_`
   * as shown or not): the tab's page must match a rule carrying a `ShowAction`.
   */
  showsAction(ext: AttachedExtension, chromeTabId: number): boolean {
    const rules = this.rules(ext.record.id)
    if (rules.length === 0) return false
    const url = this.host.pageUrl(ext, chromeTabId)
    return url !== null && actionsFor(rules, url).has(SHOW_ACTION)
  }

  /**
   * The shim's `onPageChanged.addRules(rules)`, `removeRules(ids?)` and `getRules(ids?)`, the
   * event's name first in `args`: the added rules come back filled in (ids, priorities), a
   * removal answers nothing, a read the rules asked for – every fault in Chrome's words.
   */
  call(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    if (!this.holdsPermission(ext)) throw new Error(DECLARATIVE_CONTENT_NO_PERMISSION_ERROR)
    if (args[0] !== PAGE_CHANGED)
      throw new Error(`chrome.declarativeContent has no event named ${String(args[0])}.`)
    const id = ext.record.id
    const rules = this.rules(id)
    switch (method) {
      case 'addRules': {
        let count = nextMintedCount(rules)
        const added = checkRules(args[1], rules, () => mintedRuleId(count++), {
          hasAction: Boolean(ext.manifest.action),
          hasBookmarks: this.holdsPermission(ext, 'bookmarks')
        })
        this.store(id, [...rules, ...added])
        return added.map(ruleForExtension)
      }
      case 'removeRules': {
        const next = withoutRules(rules, ruleIds(args[1]))
        if (next.length !== rules.length) this.store(id, next)
        return undefined
      }
      case 'getRules':
        return selectRules(rules, ruleIds(args[1])).map(ruleForExtension)
      default:
        throw new Error(
          `chrome.declarativeContent.onPageChanged.${method} is not implemented on Zenium for Android`
        )
    }
  }

  private store(id: string, rules: PersistedRule[]): void {
    this.host.persistRules(id, rules)
    this.parsed.delete(id)
    this.host.changed()
  }

  private rules(id: string): PersistedRule[] {
    const raw = this.host.persistedRules(id)
    const cached = this.parsed.get(id)
    if (cached && cached.raw === raw) return cached.rules
    const rules = persistedRulesFrom(raw)
    this.parsed.set(id, { raw, rules })
    return rules
  }

  private holdsPermission(
    ext: AttachedExtension,
    permission = DECLARATIVE_CONTENT_PERMISSION
  ): boolean {
    return (
      ext.manifest.permissions.includes(permission) ||
      ext.manifest.optionalPermissions.includes(permission)
    )
  }
}

/** `ruleIdentifiers`, optional: the shim passes what it was given; anything but a list of strings is "none given". */
function ruleIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((id): id is string => typeof id === 'string')
}
