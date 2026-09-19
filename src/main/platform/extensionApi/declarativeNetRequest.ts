import { rm } from 'node:fs/promises'
import type { Decision } from '../../../core/blocking/rules'
import {
  createDeclarativeNetRequestApi,
  type DeclarativeNetRequestApi
} from '../../../core/extensions/dnr/api'
import {
  actionOptions,
  matchedActionType,
  matchedFilter,
  regexOptions,
  ruleUpdate,
  rulesFilter,
  rulesetUpdate,
  staticOptions,
  testRequest
} from '../../../core/extensions/dnr/args'
import { routeDecision } from '../../../core/extensions/dnr/sink'
import {
  DnrState,
  createGlobalStaticRulePool,
  UNKNOWN_TAB_ID,
  type DnrExtensionInfo,
  type RequestDetails
} from '../../../core/extensions/dnr/state'
import { DnrTranslator } from '../../../core/extensions/dnr/translate'
import type { WebRequestBase } from '../blocking'
import type { ActionApi } from './action'
import type { ActiveTabGrants } from './activeTab'
import { createDnrFileIO, dnrStateFile } from './dnrIo'
import type { ScopedRuleSink } from './dnrSink'
import {
  ApiError,
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
 * `DnrTranslator` keeping the rule sink (the request-blocking engine, see `dnrSink.ts`) in step
 * with every state change; `decided` takes the engine's decisions back into the matched-rule log,
 * the action counts and `onRuleMatchedDebug`. Manifest rulesets marked `enabled` are active from
 * the first load. The sink scopes every set to the sessions the extension is loaded into;
 * `sessionsChanged` keeps that scope current.
 */
export class DeclarativeNetRequestHostApi {
  private readonly entries = new Map<string, Entry>()
  private readonly translator: DnrTranslator
  private readonly pool = createGlobalStaticRulePool()
  /** One sync at a time per extension, in order. */
  private readonly syncing = new Map<string, Promise<void>>()

  constructor(
    private readonly host: ApiHost,
    readonly sink: ScopedRuleSink,
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

  /**
   * The sessions an extension is loaded into changed (a container came or went, the user
   * allowed it in private windows): its sets in the engine follow.
   */
  sessionsChanged(extensionId: string): void {
    if (!this.entries.has(extensionId)) return
    this.sink.rescope(extensionId)
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
   * The engine decided a request by a named rule (`ElectronBlocking.onDecision`): when the rule
   * is an extension's, the record feeds `getMatchedRules`, the action count (allow rules do not
   * count) and, for unpacked extensions, `onRuleMatchedDebug` with Chrome's request details.
   */
  decided(base: WebRequestBase, decision: Decision): void {
    const routed = routeDecision(decision)
    if (!routed) return
    const entry = this.entries.get(routed.extensionId)
    if (!entry) return
    const tab = base.tabId === null ? undefined : this.host.model.tab(base.tabId)
    const tabId = tab ? this.host.model.chromeTabId(tab) : UNKNOWN_TAB_ID
    const request: RequestDetails = {
      requestId: base.requestId,
      url: base.url,
      method: base.method,
      frameId: base.frameId,
      parentFrameId: base.parentFrameId,
      tabId,
      type: base.resourceType
    }
    if (base.initiator !== null) request.initiator = base.initiator
    entry.state.recordMatch({
      ruleId: routed.ruleId,
      rulesetId: routed.rulesetId,
      tabId,
      actionType: matchedActionType(decision),
      request
    })
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
        await this.translator.sync(entry.state.translateInput(rank < 0 ? undefined : rank))
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
