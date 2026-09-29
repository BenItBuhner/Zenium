import { matchesUrlFilter, normalizeUrlFilter, type UrlFilter } from './urlFilter'

/**
 * `chrome.declarativeContent`: rules an extension registers once (`onPageChanged.addRules`)
 * that the browser evaluates against every tab's page – conditions (`PageStateMatcher`: the
 * page's URL as an `events.UrlFilter`, CSS selectors matched in the page, the page bookmarked)
 * and actions (`ShowAction` / `ShowPageAction`: the toolbar action shown on that tab while a
 * rule holds, over an `action.disable()`; `SetIcon`: the icon for that tab). Chrome keeps the
 * rules in `ExtensionPrefs` across sessions and drops them at uninstall alone (an update's
 * unload takes them from memory, the load reads them back; `rules_registry.cc`), so an
 * extension registers them in `runtime.onInstalled` (Story Saver: `chrome.action.disable()`,
 * then one rule showing the action on instagram.com, facebook.com and web.whatsapp.com).
 *
 * This module is the platform-neutral part: the rules' validation as Chrome's
 * (`content_condition.cc`, `content_action.cc`, `rules_registry.cc` – its words), their ids
 * (`_<n>_` where the extension gave none) and priorities (100 where none), and their
 * evaluation against a URL. A host stores them per extension and applies the actions.
 *
 * What a host cannot evaluate is stated here: a `css` condition needs the page's DOM asked for
 * its selectors at every change, an `isBookmarked` one the bookmark store – a condition carrying
 * either is NEVER satisfied on such a host (Chrome evaluates both); `SetIcon` is accepted and
 * kept for `getRules`, drawn by hosts that draw per-tab icons.
 */

export const PAGE_STATE_MATCHER = 'declarativeContent.PageStateMatcher'
/**
 * The one show word: `new ShowPageAction()` (deprecated since Chrome 97) constructs it too –
 * Chrome's renderer maps both constructors to `ShowAction`, and its action factory knows no
 * `declarativeContent.ShowPageAction` (a rule written with that word by hand is refused as an
 * invalid instanceType, here as there).
 */
export const SHOW_ACTION = 'declarativeContent.ShowAction'
export const SET_ICON = 'declarativeContent.SetIcon'
/** Never left Chrome's dev channel ("not supported on stable builds"); refused as Chrome stable refuses it. */
export const REQUEST_CONTENT_SCRIPT = 'declarativeContent.RequestContentScript'

/** `RulesRegistry::DEFAULT_PRIORITY`. */
export const DEFAULT_PRIORITY = 100

export type DeclarativeActionType = typeof SHOW_ACTION | typeof SET_ICON

export interface PageStateCondition {
  pageUrl?: UrlFilter
  css?: string[]
  isBookmarked?: boolean
}

/** What the rules' owner has, for the checks that depend on it. */
export interface RuleOwner {
  /** A toolbar action in the manifest (`action`, `browser_action` or `page_action`): `ShowAction` and `SetIcon` need one. */
  hasAction: boolean
  /** The `bookmarks` permission: an `isBookmarked` condition needs it. */
  hasBookmarks: boolean
}

/** The binding's shape of an error in the `rules` argument. */
function ruleError(index: number, message: string): Error {
  return new Error(`Error at parameter 'rules': Error at index ${index}: ${message}`)
}

/** One rule as a host keeps it (and `getRules` answers it, with the `instanceType` words back on). */
export interface PersistedRule {
  id: string
  priority: number
  conditions: PageStateCondition[]
  actions: DeclarativeActionType[]
  tags?: string[]
}

const CONDITION_ATTRIBUTES: ReadonlySet<string> = new Set([
  'instanceType',
  'pageUrl',
  'css',
  'isBookmarked'
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The rules of one `addRules` call, checked and filled in as the binding's `events.Rule` schema,
 * `RulesRegistry::AddRules` and the content registry's condition and action parsers do, in
 * Chrome's words: an id the extension gave must be new against `existing` and within the call
 * ("Id … was used multiple times."), one it did not give is minted (`nextId`), a missing
 * priority is 100; every condition a `PageStateMatcher` of known attributes of the right types
 * (`isBookmarked` needs the `bookmarks` permission), every action a known type the extension
 * can carry (`ShowAction` and `SetIcon` need a toolbar action in the manifest). The whole call
 * fails on the first fault, as Chrome's does, and nothing of it is added.
 */
export function checkRules(
  raw: unknown,
  existing: readonly PersistedRule[],
  nextId: () => string,
  owner: RuleOwner
): PersistedRule[] {
  if (!Array.isArray(raw))
    throw new Error(
      `Error at parameter 'rules': Invalid type: expected array, found ${raw === null ? 'null' : typeof raw}.`
    )
  const ids = new Set(existing.map((rule) => rule.id))
  const rules: PersistedRule[] = []
  raw.forEach((item, index) => {
    if (!isObject(item))
      throw ruleError(index, `Invalid type: expected events.Rule, found ${typeof item}.`)
    let id: string
    if (item.id === undefined || item.id === null) id = nextId()
    else if (typeof item.id === 'string') id = item.id
    else
      throw ruleError(
        index,
        `Error at property 'id': Invalid type: expected string, found ${typeof item.id}.`
      )
    if (ids.has(id)) throw new Error(`Id ${id} was used multiple times.`)
    ids.add(id)
    let priority = DEFAULT_PRIORITY
    if (item.priority !== undefined && item.priority !== null) {
      if (typeof item.priority !== 'number' || !Number.isInteger(item.priority))
        throw ruleError(
          index,
          `Error at property 'priority': Invalid type: expected integer, found ${typeof item.priority}.`
        )
      priority = item.priority
    }
    if (!Array.isArray(item.conditions))
      throw ruleError(index, "Missing required property 'conditions'.")
    if (!Array.isArray(item.actions)) throw ruleError(index, "Missing required property 'actions'.")
    const rule: PersistedRule = {
      id,
      priority,
      conditions: item.conditions.map((condition) => checkCondition(condition, owner)),
      actions: item.actions.map((action) => checkAction(action, owner))
    }
    if (Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === 'string'))
      rule.tags = item.tags as string[]
    rules.push(rule)
  })
  return rules
}

function invalidAttribute(name: string): Error {
  return new Error(`Attribute '${name}' has an invalid type`)
}

function checkCondition(raw: unknown, owner: RuleOwner): PageStateCondition {
  if (!isObject(raw)) throw new Error('A condition has to be a dictionary.')
  if (raw.instanceType === undefined) throw new Error('A condition had no instanceType')
  if (raw.instanceType !== PAGE_STATE_MATCHER)
    throw new Error('Expected a condition of type declarativeContent.PageStateMatcher')
  for (const key of Object.keys(raw)) {
    if (!CONDITION_ATTRIBUTES.has(key)) throw new Error(`Unknown condition attribute '${key}'`)
  }
  const condition: PageStateCondition = {}
  if (raw.pageUrl !== undefined) {
    const filter = isObject(raw.pageUrl) ? normalizeUrlFilter(raw.pageUrl) : null
    if (!filter) throw invalidAttribute('pageUrl')
    condition.pageUrl = filter
  }
  if (raw.css !== undefined) {
    if (!Array.isArray(raw.css) || !raw.css.every((selector) => typeof selector === 'string'))
      throw invalidAttribute('css')
    condition.css = raw.css as string[]
  }
  if (raw.isBookmarked !== undefined) {
    if (typeof raw.isBookmarked !== 'boolean') throw invalidAttribute('isBookmarked')
    if (!owner.hasBookmarks)
      throw new Error("Property 'isBookmarked' requires 'bookmarks' permission")
    condition.isBookmarked = raw.isBookmarked
  }
  return condition
}

function checkAction(raw: unknown, owner: RuleOwner): DeclarativeActionType {
  if (!isObject(raw)) throw new Error('An action has to be a dictionary.')
  if (raw.instanceType === undefined) throw new Error('Action is missing instanceType')
  switch (raw.instanceType) {
    case SHOW_ACTION:
      if (!owner.hasAction)
        throw new Error("Can't use declarativeContent.ShowAction without an action")
      return SHOW_ACTION
    case SET_ICON:
      if (!owner.hasAction)
        throw new Error("Can't use declarativeContent.SetIcon without a page or browser action")
      return SET_ICON
    default:
      throw new Error(`An action has an invalid instanceType: ${String(raw.instanceType)}`)
  }
}

/** `getRules`' shape of a kept rule: Chrome's `events.Rule`, the `instanceType` words on each part. */
export function ruleForExtension(rule: PersistedRule): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: rule.id,
    priority: rule.priority,
    conditions: rule.conditions.map((condition) => ({
      instanceType: PAGE_STATE_MATCHER,
      ...condition
    })),
    actions: rule.actions.map((instanceType) => ({ instanceType }))
  }
  if (rule.tags) out.tags = rule.tags
  return out
}

/**
 * The rules `removeRules(ids)` leaves: those not named; every one gone when no ids were given
 * (Chrome's `removeRules(undefined)`, the reset extensions run in `onInstalled` before they add).
 */
export function withoutRules(
  rules: readonly PersistedRule[],
  ids: readonly string[] | undefined
): PersistedRule[] {
  if (ids === undefined) return []
  const gone = new Set(ids)
  return rules.filter((rule) => !gone.has(rule.id))
}

/** The rules `getRules(ids)` answers: the named ones, or all of them without ids. */
export function selectRules(
  rules: readonly PersistedRule[],
  ids: readonly string[] | undefined
): PersistedRule[] {
  if (ids === undefined) return [...rules]
  const wanted = new Set(ids)
  return rules.filter((rule) => wanted.has(rule.id))
}

/**
 * Whether a condition holds for a page at `url` on a host that reads URLs alone: a
 * `PageStateMatcher` with no attribute matches every page (Chrome's); its `pageUrl` must
 * match; a `css` or `isBookmarked` attribute is never satisfied here (stated above).
 */
export function conditionHolds(condition: PageStateCondition, url: string): boolean {
  if (condition.css !== undefined || condition.isBookmarked !== undefined) return false
  return condition.pageUrl === undefined || matchesUrlFilter(url, condition.pageUrl)
}

/** Chrome's rule: a rule holds when ANY of its conditions does (an empty list never holds). */
export function ruleHolds(rule: PersistedRule, url: string): boolean {
  return rule.conditions.some((condition) => conditionHolds(condition, url))
}

/**
 * The action types the rules holding for `url` apply, in one set (one show, however many rules
 * ask for it – what `ExtensionAction::DeclarativeShow`'s count comes to: the tab shown or not).
 */
export function actionsFor(
  rules: readonly PersistedRule[],
  url: string
): Set<DeclarativeActionType> {
  const out = new Set<DeclarativeActionType>()
  for (const rule of rules) {
    if (!ruleHolds(rule, url)) continue
    for (const action of rule.actions) out.add(action)
  }
  return out
}

/**
 * The rules a host stored, read back (`OnExtensionLoaded`'s read of `ExtensionPrefs`): a stored
 * rule that lost its shape is dropped rather than trusted.
 */
export function persistedRulesFrom(raw: unknown): PersistedRule[] {
  if (!Array.isArray(raw)) return []
  const rules: PersistedRule[] = []
  for (const item of raw) {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.priority !== 'number')
      continue
    if (!Array.isArray(item.conditions) || !Array.isArray(item.actions)) continue
    const conditions: PageStateCondition[] = []
    for (const condition of item.conditions) {
      if (!isObject(condition)) continue
      const out: PageStateCondition = {}
      if (isObject(condition.pageUrl)) out.pageUrl = condition.pageUrl as UrlFilter
      if (Array.isArray(condition.css)) out.css = condition.css.filter((s) => typeof s === 'string')
      if (typeof condition.isBookmarked === 'boolean') out.isBookmarked = condition.isBookmarked
      conditions.push(out)
    }
    const actions = item.actions.filter(
      (action): action is DeclarativeActionType => action === SHOW_ACTION || action === SET_ICON
    )
    const rule: PersistedRule = { id: item.id, priority: item.priority, conditions, actions }
    if (Array.isArray(item.tags)) rule.tags = item.tags.filter((tag) => typeof tag === 'string')
    rules.push(rule)
  }
  return rules
}

/** `_<n>_`, `RulesRegistry::ToId`'s spelling of a minted rule id; `n` counts up per extension. */
export function mintedRuleId(n: number): string {
  return `_${n}_`
}

/** The next count a minted id may take: past every `_<n>_` a kept rule already carries. */
export function nextMintedCount(rules: readonly PersistedRule[]): number {
  let next = 0
  for (const rule of rules) {
    const match = /^_(\d+)_$/.exec(rule.id)
    if (match) next = Math.max(next, Number(match[1]) + 1)
  }
  return next
}
