import type { StoreIO } from '@core/platform'
import type { ExtensionRecord } from '@core/extensions/registry'
import {
  createDeclarativeNetRequestApi,
  type DeclarativeNetRequestApi
} from '@core/extensions/dnr/api'
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
} from '@core/extensions/dnr/args'
import type { ScopedRuleSink } from '@core/extensions/dnr/engineSink'
import { parsePersistedState } from '@core/extensions/dnr/persist'
import { routeDecision, type EngineDecisionAction } from '@core/extensions/dnr/sink'
import {
  DnrState,
  createGlobalStaticRulePool,
  UNKNOWN_TAB_ID,
  type DnrExtensionInfo,
  type DnrPersistedState,
  type DnrStateIO,
  type RequestDetails
} from '@core/extensions/dnr/state'
import { DnrTranslator } from '@core/extensions/dnr/translate'
import type { AttachedExtension } from './extensionApi'

/**
 * `chrome.declarativeNetRequest` for the Android runtime, the phone's twin of the desktop's
 * `DeclarativeNetRequestHostApi` (`src/main/platform/extensionApi/declarativeNetRequest.ts`):
 * one `DnrState` per attached extension that holds the permission (static `rule_resources` read
 * from the install directory through Kotlin, the persisted record at `extension-dnr/<id>.json`
 * in the profile), the routed API over it, and a `DnrTranslator` keeping the rule sink in step
 * with every state change. The sink is the core's request-blocking engine (`engineSink.ts`),
 * whose store mirrors every set to `blocking/index.json`; the Kotlin engine compiles that and
 * answers `shouldInterceptRequest` from it, so an extension's rules cost a request the same
 * microseconds as the built-in lists. Manifest rulesets marked `enabled` are active from the
 * first load.
 *
 * Every set is scoped to the partitions the extension runs in (`DnrSinkScope`: the containers,
 * plus `private` while the user allows the extension there); `sessionsChanged` keeps that scope
 * current, so a private tab's requests never meet an extension's rules unless allowed.
 *
 * Decisions come back through `decided`: the Kotlin engine reports every decision that named an
 * extension's rule (`ext.request`), and the record feeds `getMatchedRules`, the action count of
 * the tab (the badge, through `DnrHost.setBadgeText`) and `onRuleMatchedDebug`. Which document
 * of the tab a decision belongs to is told by the generation Kotlin stamps it with (`document`),
 * not by the order the tab's `navigated` event arrives in.
 */

interface Entry {
  state: DnrState
  api: DeclarativeNetRequestApi
  unsubscribe: Array<() => void>
}

export const DNR_PERMISSIONS = ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess']

/** Where an extension's persisted declarativeNetRequest record lives in the profile. */
export const DNR_STATE_DIR = 'extension-dnr'

export function dnrStateDoc(extensionId: string): string {
  return `${DNR_STATE_DIR}/${extensionId}.json`
}

/** Whether the extension may use the API at all (either permission unlocks the namespace). */
export function usesDeclarativeNetRequest(ext: Pick<AttachedExtension, 'manifest'>): boolean {
  return ext.manifest.permissions.some((p) => DNR_PERMISSIONS.includes(p))
}

/**
 * Chrome gives unpacked extensions `onRuleMatchedDebug` and `testMatchOutcome`. The phone has no
 * folder picker: an unpacked extension arrives as a `.zip` of its folder (`extensionHost.ts`),
 * so a zip sideload counts as unpacked here.
 */
export function isUnpackedRecord(record: Pick<ExtensionRecord, 'source'>): boolean {
  return record.source === 'unpacked' || record.source === 'zip'
}

/** What the declarativeNetRequest layer needs from the runtime. */
export interface DnrHost {
  /** The profile's documents; the persisted record is one of them. */
  readonly io: StoreIO
  now(): number
  /** A file of the extension package by its manifest-relative path (Kotlin reads the install directory); null when it is not there. */
  readFile(extensionId: string, path: string): Promise<string | null>
  /** Whether a Chrome tab id names an open tab. */
  isValidTabId(tabId: number): boolean
  /** Whether `activeTab` is granted for the tab right now. */
  hasActiveTabAccess(extensionId: string, tabId: number): boolean
  /** The action count of a tab changed: the badge shows `text` (empty clears it). */
  setBadgeText(extensionId: string, tabId: number, text: string): void
  /** Raise `chrome.<ns>.<name>` in the extension's contexts. */
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
  /** Extensions using the API, most recently installed first (Chrome ranks newer ones' rules higher). */
  installOrder(): string[]
  warn(message: string): void
}

/** The engine's decision on one request, as the Kotlin observer reports it (`ext.request`). */
export interface EngineDecisionEvent {
  /** Chrome's tab id, or `UNKNOWN_TAB_ID` for a request of no tab. */
  tabId: number
  requestId: string
  url: string
  method: string
  /** `chrome.declarativeNetRequest.ResourceType` name. */
  type: string
  initiator?: string
  mainFrame: boolean
  action: EngineDecisionAction
  matchedSet?: string
  matchedRule?: number
}

/**
 * The state's file IO over the runtime: ruleset files come from the install directory (Kotlin
 * refuses paths that escape it), the persisted record is a profile document.
 */
export function createAndroidDnrIO(
  host: Pick<DnrHost, 'io' | 'readFile'>,
  extensionId: string
): Pick<DnrStateIO, 'readFile' | 'loadState' | 'saveState'> {
  const doc = dnrStateDoc(extensionId)
  return {
    async readFile(path: string): Promise<string> {
      const text = await host.readFile(extensionId, path)
      if (text === null) throw new Error(`Ruleset file not found: ${path}`)
      return text
    },
    async loadState(): Promise<DnrPersistedState | undefined> {
      const text = host.io.readSync(doc)
      return text === null ? undefined : parsePersistedState(text)
    },
    async saveState(state: DnrPersistedState): Promise<void> {
      await host.io.write(doc, JSON.stringify(state))
    }
  }
}

export class AndroidDeclarativeNetRequest {
  private readonly entries = new Map<string, Entry>()
  private readonly translator: DnrTranslator
  private readonly pool = createGlobalStaticRulePool()
  /** One sync at a time per extension, in order. */
  private readonly syncing = new Map<string, Promise<void>>()
  /** Per tab, the document generation its record belongs to (see `document`). */
  private readonly documents = new Map<number, number>()

  constructor(
    private readonly host: DnrHost,
    readonly sink: ScopedRuleSink
  ) {
    this.translator = new DnrTranslator(sink, { now: () => host.now() })
  }

  // ---------------------------------------------------------------------------
  // chrome.declarativeNetRequest.*
  // ---------------------------------------------------------------------------

  call(ext: AttachedExtension, method: string, args: unknown[]): Promise<unknown> {
    const entry = this.entries.get(ext.record.id)
    if (!entry) {
      return Promise.reject(new Error("The 'declarativeNetRequest' permission is required."))
    }
    const api = entry.api
    const o = args[0]
    switch (method) {
      case 'updateDynamicRules':
        return api.updateDynamicRules(ruleUpdate(o))
      case 'getDynamicRules':
        return api.getDynamicRules(rulesFilter(o))
      case 'updateSessionRules':
        return api.updateSessionRules(ruleUpdate(o))
      case 'getSessionRules':
        return api.getSessionRules(rulesFilter(o))
      case 'updateEnabledRulesets':
        return api.updateEnabledRulesets(rulesetUpdate(o))
      case 'getEnabledRulesets':
        return api.getEnabledRulesets()
      case 'updateStaticRules':
        return api.updateStaticRules(staticOptions(o))
      case 'getDisabledRuleIds':
        return api.getDisabledRuleIds({ rulesetId: staticOptions(o).rulesetId })
      case 'getAvailableStaticRuleCount':
        return api.getAvailableStaticRuleCount()
      case 'getMatchedRules':
        return api.getMatchedRules(matchedFilter(o))
      case 'setExtensionActionOptions':
        return api.setExtensionActionOptions(actionOptions(o))
      case 'isRegexSupported':
        return Promise.resolve(api.isRegexSupported(regexOptions(o)))
      case 'testMatchOutcome':
        if (!api.testMatchOutcome) {
          return Promise.reject(
            new Error('testMatchOutcome is only available for unpacked extensions.')
          )
        }
        return api.testMatchOutcome(testRequest(o))
    }
    return Promise.reject(
      new Error(`chrome.declarativeNetRequest.${method} is not implemented on Zenium for Android`)
    )
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** An extension attached: build its state when it holds the permission, then mirror its sets. */
  load(ext: AttachedExtension): void {
    if (!usesDeclarativeNetRequest(ext)) return
    const id = ext.record.id
    if (this.entries.has(id)) return
    const info: DnrExtensionInfo = {
      id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      ruleResources: ext.manifest.rulesets,
      permissions: ext.manifest.permissions,
      isUnpacked: isUnpackedRecord(ext.record)
    }
    const state = new DnrState(info, {
      ...createAndroidDnrIO(this.host, id),
      now: () => this.host.now(),
      globalStaticRulePool: this.pool,
      isValidTabId: (tabId) => this.host.isValidTabId(tabId),
      hasActiveTabAccess: (tabId) => this.host.hasActiveTabAccess(id, tabId),
      onActionCount: (tabId, count) =>
        this.host.setBadgeText(id, tabId, count > 0 ? String(count) : ''),
      warn: (message) => this.host.warn(`declarativeNetRequest ${id}: ${message}`)
    })
    const entry: Entry = { state, api: createDeclarativeNetRequestApi(state), unsubscribe: [] }
    entry.unsubscribe.push(state.onChange(() => this.sync(id)))
    entry.unsubscribe.push(
      state.onRuleMatchedDebug((debug) =>
        this.host.emit(id, 'declarativeNetRequest', 'onRuleMatchedDebug', [debug])
      )
    )
    this.entries.set(id, entry)
    state.load().catch((error: unknown) => {
      this.host.warn(`declarativeNetRequest ${id}: rulesets failed to load: ${String(error)}`)
    })
    // A new extension ranks above the ones before it; the others' bands move down one slot.
    this.installOrderChanged()
  }

  /** The extension detached (disabled, updated, removed): its sets leave the engine. */
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
  async uninstalled(extensionId: string): Promise<void> {
    this.unload(extensionId)
    const doc = dnrStateDoc(extensionId)
    const io = this.host.io
    if (io.remove) await io.remove(doc).catch(() => undefined)
    else if (io.readSync(doc) !== null) await io.write(doc, '{}').catch(() => undefined)
  }

  /** The install order changed (Chrome ranks newer extensions' rules above older ones'). */
  installOrderChanged(): void {
    this.translator.setInstallOrder(this.host.installOrder()).catch(() => undefined)
  }

  /**
   * The partitions an extension's rules apply to changed (a container came or went, the user
   * allowed or denied it in private tabs): its sets in the engine follow.
   */
  sessionsChanged(extensionId: string): void {
    if (!this.entries.has(extensionId)) return
    this.sink.rescope(extensionId)
  }

  // ---------------------------------------------------------------------------
  // Tabs and decisions
  // ---------------------------------------------------------------------------

  /** A tab committed a new document: its matches belong to no tab now and its count restarts. */
  tabNavigated(tabId: number): void {
    for (const entry of this.entries.values()) entry.state.onTabNavigated(tabId)
  }

  /**
   * A decision or a commit of the tab named the document generation it belonged to (Kotlin's
   * `BlockingTab.documentGeneration`: a main-frame request opens the next one on the IO thread
   * that took it, the commit reports it). A higher one than the tab's last is a new document,
   * and the tab's record turns over (`tabNavigated`) before whatever brought the news is
   * recorded – so the first decisions of a page, which the engine takes before the commit has
   * reached the UI thread, count for that page and not for the one before it.
   */
  document(tabId: number, generation: number): void {
    if (tabId === UNKNOWN_TAB_ID) return
    const known = this.documents.get(tabId)
    if (known !== undefined && generation <= known) return
    this.documents.set(tabId, generation)
    if (known !== undefined) this.tabNavigated(tabId)
  }

  tabRemoved(tabId: number): void {
    this.documents.delete(tabId)
    for (const entry of this.entries.values()) entry.state.onTabRemoved(tabId)
  }

  /**
   * The engine decided a request by a named rule: when the rule is an extension's, the record
   * feeds `getMatchedRules`, the action count (allow rules do not count) and, for unpacked
   * extensions, `onRuleMatchedDebug` with Chrome's request details. Returns whether an
   * extension's rule was credited.
   */
  decided(event: EngineDecisionEvent): boolean {
    if (event.matchedSet === undefined || event.matchedRule === undefined) return false
    const routed = routeDecision({
      action: event.action,
      matched: { setId: event.matchedSet, ruleId: event.matchedRule }
    })
    if (!routed) return false
    const entry = this.entries.get(routed.extensionId)
    if (!entry) return false
    const request: RequestDetails = {
      requestId: event.requestId,
      url: event.url,
      method: event.method,
      // WebView's intercept does not name frames: a request is the main frame's or a
      // sub-frame's document (frame ids are the desktop's).
      frameId: 0,
      parentFrameId: -1,
      tabId: event.tabId,
      type: event.type
    }
    if (event.initiator !== undefined) request.initiator = event.initiator
    entry.state.recordMatch({
      ruleId: routed.ruleId,
      rulesetId: routed.rulesetId,
      tabId: event.tabId,
      actionType: matchedActionType(event),
      request
    })
    return true
  }

  /** The states currently mirrored, for diagnostics and tests. */
  extensionIds(): string[] {
    return [...this.entries.keys()]
  }

  /** The state of one extension (tests and the demo's instrumentation). */
  stateOf(extensionId: string): DnrState | undefined {
    return this.entries.get(extensionId)?.state
  }

  /** Settles once the extension's rulesets have loaded and every sync so far has reached the sink. */
  async whenSynced(extensionId: string): Promise<void> {
    const entry = this.entries.get(extensionId)
    if (!entry) return
    await entry.state.load().catch(() => undefined)
    await (this.syncing.get(extensionId) ?? Promise.resolve())
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private sync(extensionId: string): void {
    const entry = this.entries.get(extensionId)
    if (!entry) return
    const previous = this.syncing.get(extensionId) ?? Promise.resolve()
    const run = previous
      .then(async () => {
        if (this.entries.get(extensionId) !== entry) return
        const rank = this.host.installOrder().indexOf(extensionId)
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
        this.host.warn(`declarativeNetRequest ${extensionId}: sync failed: ${String(error)}`)
      })
    this.syncing.set(extensionId, run)
  }
}

export { UNKNOWN_TAB_ID }
