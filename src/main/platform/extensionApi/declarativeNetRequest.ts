import { rm } from 'node:fs/promises'
import {
  createDeclarativeNetRequestApi,
  type DeclarativeNetRequestApi,
  type RegexOptions,
  type TestMatchRequestDetails
} from '../../../core/extensions/dnr/api'
import type { RequestMethod, ResourceType } from '../../../core/extensions/dnr/rules'
import {
  routeDecision,
  type EngineDecision,
  type RuleSink
} from '../../../core/extensions/dnr/sink'
import {
  DnrState,
  createGlobalStaticRulePool,
  type DnrExtensionInfo,
  type ExtensionActionOptions,
  type GetRulesFilter,
  type MatchRecord,
  type MatchedRulesFilter,
  type RequestDetails,
  type UpdateRuleOptions,
  type UpdateRulesetOptions,
  type UpdateStaticRulesOptions
} from '../../../core/extensions/dnr/state'
import { DnrTranslator } from '../../../core/extensions/dnr/translate'
import type { ActionApi } from './action'
import type { ActiveTabGrants } from './activeTab'
import { createDnrFileIO, dnrStateFile } from './dnrIo'
import {
  ApiError,
  isRecord,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

interface Entry {
  state: DnrState
  api: DeclarativeNetRequestApi
  unsubscribe: Array<() => void>
}

const DNR_PERMISSIONS = ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess']

/**
 * `chrome.declarativeNetRequest` for the browser layer: one `DnrState` per loaded extension that
 * holds the permission (static `rule_resources` read from the install directory, the persisted
 * record under `<userData>/zen/extension-dnr/<id>.json`), the routed API over it, and a
 * `DnrTranslator` keeping the rule sink in step with every state change. The sink is the
 * in-memory adapter in `dnrSink.ts` until the blocking engine lands; `recordDecision` is the entry
 * point the engine's decisions will take back into the matched-rule log, the action counts and
 * `onRuleMatchedDebug`. Manifest rulesets marked `enabled` are active from the first load.
 */
export class DeclarativeNetRequestHostApi {
  private readonly entries = new Map<string, Entry>()
  private readonly translator: DnrTranslator
  private readonly pool = createGlobalStaticRulePool()
  /** One sync at a time per extension, in order. */
  private readonly syncing = new Map<string, Promise<void>>()

  constructor(
    private readonly host: ApiHost,
    readonly sink: RuleSink,
    private readonly action: ActionApi,
    private readonly activeTab: ActiveTabGrants,
    private readonly stateDir: string
  ) {
    this.translator = new DnrTranslator(sink, { now: Date.now })
  }

  readonly handlers: NamespaceHandlers = {
    updateDynamicRules: (ctx, o) => this.call(ctx, (api) => api.updateDynamicRules(ruleUpdate(o))),
    getDynamicRules: (ctx, f) => this.call(ctx, (api) => api.getDynamicRules(rulesFilter(f))),
    updateSessionRules: (ctx, o) => this.call(ctx, (api) => api.updateSessionRules(ruleUpdate(o))),
    getSessionRules: (ctx, f) => this.call(ctx, (api) => api.getSessionRules(rulesFilter(f))),
    updateEnabledRulesets: (ctx, o) =>
      this.call(ctx, (api) => api.updateEnabledRulesets(rulesetUpdate(o))),
    getEnabledRulesets: (ctx) => this.call(ctx, (api) => api.getEnabledRulesets()),
    updateStaticRules: (ctx, o) => this.call(ctx, (api) => api.updateStaticRules(staticOptions(o))),
    getDisabledRuleIds: (ctx, o) =>
      this.call(ctx, (api) => api.getDisabledRuleIds({ rulesetId: staticOptions(o).rulesetId })),
    getAvailableStaticRuleCount: (ctx) =>
      this.call(ctx, (api) => api.getAvailableStaticRuleCount()),
    getMatchedRules: (ctx, f) => this.call(ctx, (api) => api.getMatchedRules(matchedFilter(f))),
    setExtensionActionOptions: (ctx, o) =>
      this.call(ctx, (api) => api.setExtensionActionOptions(actionOptions(o))),
    isRegexSupported: (ctx, o) => this.call(ctx, (api) => api.isRegexSupported(regexOptions(o))),
    testMatchOutcome: (ctx, r) =>
      this.call(ctx, (api) => {
        if (!api.testMatchOutcome) {
          throw new ApiError('testMatchOutcome is only available for unpacked extensions.')
        }
        return api.testMatchOutcome(testRequest(r))
      })
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** An extension loaded: build its state when it holds the permission, then mirror its sets. */
  load(ext: LoadedExtension): void {
    const grants = this.host.grants(ext.id)
    if (!grants.permissions.some((p) => DNR_PERMISSIONS.includes(p))) return
    if (this.entries.has(ext.id)) return
    const io = createDnrFileIO({
      installDir: ext.path,
      stateFile: dnrStateFile(this.stateDir, ext.id)
    })
    const info: DnrExtensionInfo = {
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      ruleResources: ext.manifest.declarative_net_request?.rule_resources ?? [],
      permissions: grants.permissions,
      isUnpacked: ext.unpacked
    }
    const state = new DnrState(info, {
      ...io,
      globalStaticRulePool: this.pool,
      isValidTabId: (tabId) => this.host.model.zenTab(tabId) !== undefined,
      hasActiveTabAccess: (tabId) => this.activeTab.hasGrantForTab(ext.id, tabId),
      onActionCount: (tabId, count) =>
        this.action.setBadgeTextFor(ext.id, tabId, count > 0 ? String(count) : ''),
      warn: (message) => console.warn(`[zen] declarativeNetRequest ${ext.id}: ${message}`)
    })
    const entry: Entry = { state, api: createDeclarativeNetRequestApi(state), unsubscribe: [] }
    entry.unsubscribe.push(state.onChange(() => this.sync(ext.id)))
    entry.unsubscribe.push(
      state.onRuleMatchedDebug((debug) =>
        this.host.dispatch(ext.id, 'declarativeNetRequest', 'onRuleMatchedDebug', [debug])
      )
    )
    this.entries.set(ext.id, entry)
    state.load().catch((error: unknown) => {
      console.warn(`[zen] declarativeNetRequest ${ext.id}: rulesets failed to load`, error)
    })
  }

  unload(extensionId: string): void {
    const entry = this.entries.get(extensionId)
    if (!entry) return
    for (const off of entry.unsubscribe) off()
    entry.state.dispose()
    this.entries.delete(extensionId)
    this.syncing.delete(extensionId)
    this.translator.remove(extensionId).catch(() => undefined)
  }

  /** Gone for good: the persisted record goes with it. */
  uninstalled(extensionId: string): void {
    this.unload(extensionId)
    rm(dnrStateFile(this.stateDir, extensionId), { force: true }).catch(() => undefined)
  }

  /** The install order changed (Chrome ranks newer extensions' rules above older ones'). */
  installOrderChanged(): void {
    this.translator.setInstallOrder(this.installOrder()).catch(() => undefined)
  }

  // ---------------------------------------------------------------------------
  // Tabs and decisions
  // ---------------------------------------------------------------------------

  tabNavigated(tabId: number): void {
    for (const entry of this.entries.values()) entry.state.onTabNavigated(tabId)
  }

  tabRemoved(tabId: number): void {
    for (const entry of this.entries.values()) entry.state.onTabRemoved(tabId)
  }

  /**
   * The engine applied a rule: `routeDecision` names the extension and rule; the record feeds
   * `getMatchedRules`, the action count and `onRuleMatchedDebug`. Nothing calls this until the
   * blocking engine reports its decisions (see `dnrSink.ts`).
   */
  recordDecision(
    decision: EngineDecision,
    context: { tabId: number; actionType?: MatchRecord['actionType']; request?: RequestDetails }
  ): void {
    const routed = routeDecision(decision)
    if (!routed) return
    const entry = this.entries.get(routed.extensionId)
    if (!entry) return
    const match: MatchRecord = {
      ruleId: routed.ruleId,
      rulesetId: routed.rulesetId,
      tabId: context.tabId
    }
    if (context.actionType !== undefined) match.actionType = context.actionType
    if (context.request !== undefined) match.request = context.request
    entry.state.recordMatch(match)
  }

  /** The states currently mirrored, for diagnostics and tests. */
  extensionIds(): string[] {
    return [...this.entries.keys()]
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async call<T>(
    ctx: ApiContext,
    run: (api: DeclarativeNetRequestApi) => T | Promise<T>
  ): Promise<T> {
    const entry = this.entries.get(ctx.extensionId)
    if (!entry) {
      throw new ApiError("The 'declarativeNetRequest' permission is required.")
    }
    try {
      return await run(entry.api)
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(error instanceof Error ? error.message : String(error))
    }
  }

  private sync(extensionId: string): void {
    const entry = this.entries.get(extensionId)
    if (!entry) return
    const previous = this.syncing.get(extensionId) ?? Promise.resolve()
    const run = previous
      .then(async () => {
        if (this.entries.get(extensionId) !== entry) return
        const rank = this.installOrder().indexOf(extensionId)
        const report = await this.translator.sync(
          entry.state.translateInput(rank < 0 ? undefined : rank)
        )
        if (report.skipped.length > 0) {
          console.info(
            `[zen] declarativeNetRequest ${extensionId}: ${report.skipped.length} rule(s) the engine cannot evaluate were left out`
          )
        }
      })
      .catch((error: unknown) => {
        console.warn(`[zen] declarativeNetRequest ${extensionId}: sync failed`, error)
      })
    this.syncing.set(extensionId, run)
  }

  /** Extensions using the API, most recently installed first. */
  private installOrder(): string[] {
    return this.host.browser.extensions
      .list()
      .filter((info) => this.entries.has(info.id))
      .sort((a, b) => b.installedAt - a.installedAt)
      .map((info) => info.id)
  }
}

// ---------------------------------------------------------------------------
// Argument shapes: the state validates rules and ids; these settle the container types.
// ---------------------------------------------------------------------------

function record(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new ApiError('Invalid options.')
  return raw
}

function integerList(raw: unknown, name: string): number[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new ApiError(`Invalid value for '${name}'.`)
  const out: number[] = []
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ApiError(`Invalid value for '${name}'.`)
    }
    out.push(value)
  }
  return out
}

function stringList(raw: unknown, name: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new ApiError(`Invalid value for '${name}'.`)
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') throw new ApiError(`Invalid value for '${name}'.`)
    out.push(value)
  }
  return out
}

function ruleUpdate(raw: unknown): UpdateRuleOptions {
  const options = record(raw)
  const out: UpdateRuleOptions = {}
  const remove = integerList(options.removeRuleIds, 'removeRuleIds')
  if (remove) out.removeRuleIds = remove
  if (options.addRules !== undefined && options.addRules !== null) {
    if (!Array.isArray(options.addRules)) throw new ApiError("Invalid value for 'addRules'.")
    out.addRules = options.addRules as unknown[]
  }
  return out
}

function rulesFilter(raw: unknown): GetRulesFilter | undefined {
  if (raw === undefined || raw === null) return undefined
  const out: GetRulesFilter = {}
  const ids = integerList(record(raw).ruleIds, 'ruleIds')
  if (ids) out.ruleIds = ids
  return out
}

function rulesetUpdate(raw: unknown): UpdateRulesetOptions {
  const options = record(raw)
  const out: UpdateRulesetOptions = {}
  const disable = stringList(options.disableRulesetIds, 'disableRulesetIds')
  if (disable) out.disableRulesetIds = disable
  const enable = stringList(options.enableRulesetIds, 'enableRulesetIds')
  if (enable) out.enableRulesetIds = enable
  return out
}

function staticOptions(raw: unknown): UpdateStaticRulesOptions {
  const options = record(raw)
  if (typeof options.rulesetId !== 'string') {
    throw new ApiError("Missing required property 'rulesetId'.")
  }
  const out: UpdateStaticRulesOptions = { rulesetId: options.rulesetId }
  const disable = integerList(options.disableRuleIds, 'disableRuleIds')
  if (disable) out.disableRuleIds = disable
  const enable = integerList(options.enableRuleIds, 'enableRuleIds')
  if (enable) out.enableRuleIds = enable
  return out
}

function matchedFilter(raw: unknown): MatchedRulesFilter | undefined {
  if (raw === undefined || raw === null) return undefined
  const options = record(raw)
  const out: MatchedRulesFilter = {}
  if (options.tabId !== undefined && options.tabId !== null) {
    if (typeof options.tabId !== 'number' || !Number.isInteger(options.tabId)) {
      throw new ApiError("Invalid value for 'tabId'.")
    }
    out.tabId = options.tabId
  }
  if (options.minTimeStamp !== undefined && options.minTimeStamp !== null) {
    if (typeof options.minTimeStamp !== 'number')
      throw new ApiError("Invalid value for 'minTimeStamp'.")
    out.minTimeStamp = options.minTimeStamp
  }
  return out
}

function actionOptions(raw: unknown): ExtensionActionOptions {
  const options = record(raw)
  const out: ExtensionActionOptions = {}
  if (options.displayActionCountAsBadgeText !== undefined) {
    if (typeof options.displayActionCountAsBadgeText !== 'boolean') {
      throw new ApiError("Invalid value for 'displayActionCountAsBadgeText'.")
    }
    out.displayActionCountAsBadgeText = options.displayActionCountAsBadgeText
  }
  if (options.tabUpdate !== undefined && options.tabUpdate !== null) {
    const update = record(options.tabUpdate)
    if (
      typeof update.tabId !== 'number' ||
      !Number.isInteger(update.tabId) ||
      typeof update.increment !== 'number' ||
      !Number.isInteger(update.increment)
    ) {
      throw new ApiError("Invalid value for 'tabUpdate'.")
    }
    out.tabUpdate = { tabId: update.tabId, increment: update.increment }
  }
  return out
}

function regexOptions(raw: unknown): RegexOptions {
  const options = record(raw)
  if (typeof options.regex !== 'string') throw new ApiError("Missing required property 'regex'.")
  const out: RegexOptions = { regex: options.regex }
  if (typeof options.isCaseSensitive === 'boolean') out.isCaseSensitive = options.isCaseSensitive
  if (typeof options.requireCapturing === 'boolean') out.requireCapturing = options.requireCapturing
  return out
}

function testRequest(raw: unknown): TestMatchRequestDetails {
  const options = record(raw)
  if (typeof options.url !== 'string') throw new ApiError("Missing required property 'url'.")
  if (typeof options.type !== 'string') throw new ApiError("Missing required property 'type'.")
  const out: TestMatchRequestDetails = { url: options.url, type: options.type as ResourceType }
  if (typeof options.initiator === 'string') out.initiator = options.initiator
  if (typeof options.method === 'string') out.method = options.method as RequestMethod
  if (typeof options.tabId === 'number') out.tabId = options.tabId
  if (isRecord(options.responseHeaders)) {
    out.responseHeaders = options.responseHeaders as TestMatchRequestDetails['responseHeaders']
  }
  return out
}
