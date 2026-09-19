import { describe, expect, it } from 'vitest'
import { RuleEngine } from '@core/blocking/engine'
import type { StoreIO } from '@core/platform'
import { createDnrSink, InMemoryRuleSink } from '@core/extensions/dnr/engineSink'
import { engineSetId } from '@core/extensions/dnr/sink'
import { newRecord, type ExtensionRecord } from '@core/extensions/registry'
import { parseRuntimeManifest } from '@core/extensions/runtime/manifest'
import type { AttachedExtension } from '../extensionApi'
import {
  AndroidDeclarativeNetRequest,
  createAndroidDnrIO,
  dnrStateDoc,
  isUnpackedRecord,
  usesDeclarativeNetRequest,
  UNKNOWN_TAB_ID,
  type DnrHost
} from '../extensionDnr'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const ID2 = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const PATH = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID}/1.0.0`

/** The runtime as the layer sees it: profile documents, the package's files, tabs, the badge. */
class FakeHost implements DnrHost {
  readonly docs = new Map<string, string>()
  readonly files = new Map<string, string>()
  readonly tabs = new Set<number>([1, 2])
  readonly activeTab = new Set<string>()
  readonly badges: Array<{ id: string; tabId: number; text: string }> = []
  readonly emitted: Array<{ id: string; ns: string; name: string; args: unknown[] }> = []
  readonly warnings: string[] = []
  order: string[] = []
  clock = 1_700_000_000_000
  readonly io: StoreIO = {
    readSync: (name) => this.docs.get(name) ?? null,
    write: async (name, text) => {
      this.docs.set(name, text)
    },
    writeSync: (name, text) => {
      this.docs.set(name, text)
    },
    remove: async (name) => {
      this.docs.delete(name)
    }
  }

  now(): number {
    return this.clock
  }

  async readFile(extensionId: string, path: string): Promise<string | null> {
    return this.files.get(`${extensionId}/${path}`) ?? null
  }

  isValidTabId(tabId: number): boolean {
    return this.tabs.has(tabId)
  }

  hasActiveTabAccess(extensionId: string, tabId: number): boolean {
    return this.activeTab.has(`${extensionId}/${tabId}`)
  }

  setBadgeText(id: string, tabId: number, text: string): void {
    this.badges.push({ id, tabId, text })
  }

  emit(id: string, ns: string, name: string, args: unknown[]): void {
    this.emitted.push({ id, ns, name, args })
  }

  installOrder(): string[] {
    return this.order
  }

  warn(message: string): void {
    this.warnings.push(message)
  }
}

function attached(
  host: FakeHost,
  overrides: {
    id?: string
    source?: ExtensionRecord['source']
    permissions?: string[]
    rulesets?: Array<{ id: string; enabled: boolean; path: string }>
    rules?: Record<string, unknown[]>
  } = {}
): AttachedExtension {
  const id = overrides.id ?? ID
  const rulesets = overrides.rulesets ?? [{ id: 'r1', enabled: true, path: 'rules.json' }]
  const rules = overrides.rules ?? {
    'rules.json': [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '||ads.example^' } }]
  }
  for (const [path, list] of Object.entries(rules))
    host.files.set(`${id}/${path}`, JSON.stringify(list))
  const raw = {
    manifest_version: 3,
    name: 'DNR test',
    version: '1.0.0',
    permissions: overrides.permissions ?? [
      'declarativeNetRequest',
      'declarativeNetRequestFeedback'
    ],
    declarative_net_request: { rule_resources: rulesets }
  }
  const record = newRecord({
    id,
    source: overrides.source ?? 'crx',
    path: PATH,
    manifest: raw,
    now: host.clock
  })
  return { record, manifest: parseRuntimeManifest(raw, null), messages: null }
}

function setUp(sinkKind: 'engine' | 'memory' = 'engine'): {
  host: FakeHost
  engine: RuleEngine
  memory: InMemoryRuleSink
  dnr: AndroidDeclarativeNetRequest
  partitions: Map<string, string[]>
} {
  const host = new FakeHost()
  const engine = new RuleEngine()
  const memory = new InMemoryRuleSink()
  const partitions = new Map<string, string[]>()
  const sink =
    sinkKind === 'engine'
      ? createDnrSink(engine, undefined, {
          partitionsOf: (extensionId) => partitions.get(extensionId) ?? ['default']
        })
      : memory
  const dnr = new AndroidDeclarativeNetRequest(host, sink)
  return { host, engine, memory, dnr, partitions }
}

const STATIC = engineSetId(ID, { kind: 'static', rulesetId: 'r1' })
const DYNAMIC = engineSetId(ID, { kind: 'dynamic' })
const SESSION = engineSetId(ID, { kind: 'session' })

describe('AndroidDeclarativeNetRequest: the state IO over the runtime', () => {
  it('reads ruleset files from the package, the record from the profile, and writes it back there', async () => {
    const host = new FakeHost()
    host.files.set(`${ID}/rules.json`, '[]')
    const io = createAndroidDnrIO(host, ID)
    expect(await io.readFile('rules.json')).toBe('[]')
    await expect(io.readFile('missing.json')).rejects.toThrow(/Ruleset file not found/)
    expect(await io.loadState()).toBeUndefined()
    await io.saveState({ version: 1, dynamicRules: [], disabledStaticRuleIds: {} } as never)
    expect(host.docs.has(dnrStateDoc(ID))).toBe(true)
    const loaded = await io.loadState()
    expect(loaded).toBeDefined()
    expect(dnrStateDoc(ID)).toBe(`extension-dnr/${ID}.json`)
  })

  it('knows which extensions use the API and which count as unpacked', () => {
    const host = new FakeHost()
    expect(usesDeclarativeNetRequest(attached(host))).toBe(true)
    expect(
      usesDeclarativeNetRequest(
        attached(host, { permissions: ['declarativeNetRequestWithHostAccess'] })
      )
    ).toBe(true)
    expect(usesDeclarativeNetRequest(attached(host, { permissions: ['storage'] }))).toBe(false)
    expect(isUnpackedRecord({ source: 'unpacked' })).toBe(true)
    expect(isUnpackedRecord({ source: 'zip' })).toBe(true)
    expect(isUnpackedRecord({ source: 'crx' })).toBe(false)
    expect(isUnpackedRecord({ source: 'chrome-web-store' })).toBe(false)
  })
})

describe('AndroidDeclarativeNetRequest: rule sets in the engine', () => {
  it('puts a manifest ruleset marked enabled into the engine on load, scoped to the partitions', async () => {
    const { host, engine, dnr, partitions } = setUp()
    partitions.set(ID, ['default', 'work'])
    const ext = attached(host)
    host.order = [ID]
    dnr.load(ext)
    await dnr.whenSynced(ID)
    expect(engine.summary(STATIC)).toMatchObject({
      source: 'dnr',
      enabled: true,
      ruleCount: 1,
      partitions: ['default', 'work']
    })
    // The engine decides as the Kotlin one will from the same set: blocked in a scoped
    // partition, untouched outside it.
    const ctx = {
      url: 'https://ads.example/a.js',
      type: 'script' as const,
      method: 'GET',
      documentUrl: 'https://site.test/',
      initiator: 'https://site.test'
    }
    expect(engine.decide({ ...ctx, partition: 'default' }).action).toBe('block')
    expect(engine.decide({ ...ctx, partition: 'private' }).action).toBe('allow')
    expect(await dnr.call(ext, 'getEnabledRulesets', [])).toEqual(['r1'])
    expect(dnr.extensionIds()).toEqual([ID])
  })

  it('a ruleset the manifest leaves disabled stays out until updateEnabledRulesets', async () => {
    const { host, engine, dnr } = setUp()
    const ext = attached(host, {
      rulesets: [
        { id: 'r1', enabled: true, path: 'rules.json' },
        { id: 'r2', enabled: false, path: 'more.json' }
      ],
      rules: {
        'rules.json': [
          { id: 1, action: { type: 'block' }, condition: { urlFilter: '||ads.example^' } }
        ],
        'more.json': [
          { id: 1, action: { type: 'block' }, condition: { urlFilter: '||track.example^' } }
        ]
      }
    })
    dnr.load(ext)
    await dnr.whenSynced(ID)
    const r2 = engineSetId(ID, { kind: 'static', rulesetId: 'r2' })
    expect(engine.has(STATIC)).toBe(true)
    expect(engine.has(r2)).toBe(false)
    await dnr.call(ext, 'updateEnabledRulesets', [
      { enableRulesetIds: ['r2'], disableRulesetIds: ['r1'] }
    ])
    await dnr.whenSynced(ID)
    expect(engine.has(STATIC)).toBe(false)
    expect(engine.has(r2)).toBe(true)
    expect(await dnr.call(ext, 'getEnabledRulesets', [])).toEqual(['r2'])
  })

  it('dynamic and session rules become their own sets; dynamic ones persist, session ones do not', async () => {
    const { host, engine, dnr } = setUp()
    const ext = attached(host)
    dnr.load(ext)
    await dnr.whenSynced(ID)
    await dnr.call(ext, 'updateDynamicRules', [
      {
        addRules: [
          { id: 10, action: { type: 'block' }, condition: { urlFilter: '||dyn.example^' } }
        ]
      }
    ])
    await dnr.call(ext, 'updateSessionRules', [
      {
        addRules: [
          {
            id: 20,
            priority: 2,
            action: { type: 'redirect', redirect: { url: 'https://cdn.example/empty.js' } },
            condition: { urlFilter: '||sess.example^', resourceTypes: ['script'] }
          }
        ]
      }
    ])
    await dnr.whenSynced(ID)
    expect(engine.summary(DYNAMIC)?.ruleCount).toBe(1)
    expect(engine.summary(SESSION)?.ruleCount).toBe(1)
    expect(await dnr.call(ext, 'getDynamicRules', [])).toMatchObject([{ id: 10 }])
    expect(await dnr.call(ext, 'getSessionRules', [])).toMatchObject([{ id: 20 }])
    const decision = engine.decide({
      url: 'https://sess.example/x.js',
      type: 'script',
      method: 'GET',
      documentUrl: 'https://site.test/',
      partition: 'default'
    })
    expect(decision.action).toBe('redirect')
    expect(decision.redirectUrl).toBe('https://cdn.example/empty.js')
    // The persisted record holds the dynamic rules: a fresh layer over the same profile
    // restores them, and starts without the session rules.
    const persisted = JSON.parse(host.docs.get(dnrStateDoc(ID)) ?? '{}') as Record<string, unknown>
    expect(persisted.dynamicRules).toMatchObject([{ id: 10 }])
    const again = new RuleEngine()
    const fresh = new AndroidDeclarativeNetRequest(host, createDnrSink(again))
    fresh.load(ext)
    await fresh.whenSynced(ID)
    expect(again.summary(DYNAMIC)?.ruleCount).toBe(1)
    expect(again.has(SESSION)).toBe(false)
    expect(await fresh.call(ext, 'getSessionRules', [])).toEqual([])
  })

  it('removing a dynamic rule removes its set; an empty update leaves nothing behind', async () => {
    const { host, engine, dnr } = setUp()
    const ext = attached(host)
    dnr.load(ext)
    await dnr.whenSynced(ID)
    await dnr.call(ext, 'updateDynamicRules', [
      {
        addRules: [
          { id: 10, action: { type: 'block' }, condition: { urlFilter: '||dyn.example^' } }
        ]
      }
    ])
    await dnr.whenSynced(ID)
    expect(engine.has(DYNAMIC)).toBe(true)
    await dnr.call(ext, 'updateDynamicRules', [{ removeRuleIds: [10] }])
    await dnr.whenSynced(ID)
    expect(engine.has(DYNAMIC)).toBe(false)
  })

  it('unload takes the sets out; uninstalled also deletes the record; a second load is a no-op', async () => {
    const { host, engine, dnr } = setUp()
    const ext = attached(host)
    dnr.load(ext)
    dnr.load(ext)
    await dnr.whenSynced(ID)
    await dnr.call(ext, 'updateDynamicRules', [
      {
        addRules: [
          { id: 10, action: { type: 'block' }, condition: { urlFilter: '||dyn.example^' } }
        ]
      }
    ])
    await dnr.whenSynced(ID)
    expect(host.docs.has(dnrStateDoc(ID))).toBe(true)
    dnr.unload(ID)
    await Promise.resolve()
    expect(engine.has(STATIC)).toBe(false)
    expect(engine.has(DYNAMIC)).toBe(false)
    expect(host.docs.has(dnrStateDoc(ID))).toBe(true)
    expect(dnr.extensionIds()).toEqual([])
    await expect(dnr.call(ext, 'getDynamicRules', [])).rejects.toThrow(/permission is required/)
    dnr.load(ext)
    await dnr.whenSynced(ID)
    await dnr.uninstalled(ID)
    expect(host.docs.has(dnrStateDoc(ID))).toBe(false)
    expect(engine.has(STATIC)).toBe(false)
  })

  it('an extension without the permission has no state and its calls are refused', async () => {
    const { host, engine, dnr } = setUp()
    const ext = attached(host, { permissions: ['storage'] })
    dnr.load(ext)
    await dnr.whenSynced(ID)
    expect(engine.listRuleSets()).toEqual([])
    await expect(dnr.call(ext, 'getEnabledRulesets', [])).rejects.toThrow(/permission is required/)
  })

  it('a newer install ranks above an older one; the order change re-bands the sets', async () => {
    const { host, engine, dnr } = setUp()
    const first = attached(host)
    const second = attached(host, { id: ID2 })
    host.order = [ID]
    dnr.load(first)
    await dnr.whenSynced(ID)
    const before = engine.summary(STATIC)?.priority ?? 0
    host.order = [ID2, ID]
    dnr.load(second)
    await dnr.whenSynced(ID2)
    await dnr.whenSynced(ID)
    const older = engine.summary(STATIC)?.priority ?? 0
    const newer =
      engine.summary(engineSetId(ID2, { kind: 'static', rulesetId: 'r1' }))?.priority ?? 0
    expect(newer).toBeGreaterThan(older)
    expect(older).toBeLessThanOrEqual(before)
  })

  it('sessionsChanged re-scopes every set of the extension without re-sending rules', async () => {
    const { host, engine, dnr, partitions } = setUp()
    const ext = attached(host)
    dnr.load(ext)
    await dnr.whenSynced(ID)
    expect(engine.summary(STATIC)?.partitions).toEqual(['default'])
    partitions.set(ID, ['default', 'private'])
    dnr.sessionsChanged(ID)
    expect(engine.summary(STATIC)?.partitions).toEqual(['default', 'private'])
    // An unknown extension is ignored.
    dnr.sessionsChanged(ID2)
  })
})

describe('AndroidDeclarativeNetRequest: decisions of the engine', () => {
  function decision(
    overrides: Record<string, unknown> = {}
  ): Parameters<AndroidDeclarativeNetRequest['decided']>[0] {
    return {
      tabId: 1,
      requestId: '7',
      url: 'https://ads.example/a.js',
      method: 'GET',
      type: 'script',
      initiator: 'https://site.test',
      mainFrame: false,
      action: 'block',
      matchedSet: STATIC,
      matchedRule: 1,
      ...overrides
    } as Parameters<AndroidDeclarativeNetRequest['decided']>[0]
  }

  it("credits an extension's rule: getMatchedRules sees it, the badge counts it, allow rules do not count", async () => {
    const { host, dnr } = setUp('memory')
    const ext = attached(host)
    dnr.load(ext)
    await dnr.whenSynced(ID)
    await dnr.call(ext, 'setExtensionActionOptions', [{ displayActionCountAsBadgeText: true }])
    expect(dnr.decided(decision())).toBe(true)
    expect(dnr.decided(decision({ requestId: '8', tabId: 2 }))).toBe(true)
    expect(dnr.decided(decision({ requestId: '9', action: 'allow' }))).toBe(true)
    expect(host.badges).toEqual([
      { id: ID, tabId: 1, text: '1' },
      { id: ID, tabId: 2, text: '1' }
    ])
    const matched = (await dnr.call(ext, 'getMatchedRules', [{ tabId: 1 }])) as {
      rulesMatchedInfo: Array<{ rule: { ruleId: number; rulesetId: string }; tabId: number }>
    }
    expect(matched.rulesMatchedInfo).toMatchObject([
      { rule: { ruleId: 1, rulesetId: 'r1' }, tabId: 1 },
      { rule: { ruleId: 1, rulesetId: 'r1' }, tabId: 1 }
    ])
    // A new document in the tab: the count restarts (the badge clears), the matches move to no tab.
    dnr.tabNavigated(1)
    expect(host.badges.at(-1)).toEqual({ id: ID, tabId: 1, text: '' })
    const after = (await dnr.call(ext, 'getMatchedRules', [{ tabId: 1 }])) as {
      rulesMatchedInfo: unknown[]
    }
    expect(after.rulesMatchedInfo).toEqual([])
    dnr.tabRemoved(2)
    expect(dnr.stateOf(ID)?.actionCount(2)).toBe(0)
  })

  it("a higher document generation turns the tab's record over; the same or a lower one does not", async () => {
    const { host, dnr } = setUp('memory')
    const ext = attached(host)
    dnr.load(ext)
    await dnr.whenSynced(ID)
    await dnr.call(ext, 'setExtensionActionOptions', [{ displayActionCountAsBadgeText: true }])
    // The first generation seen is only remembered: nothing of the tab's is on record yet.
    dnr.document(1, 3)
    dnr.decided(decision())
    dnr.decided(decision({ requestId: '8' }))
    expect(dnr.stateOf(ID)?.actionCount(1)).toBe(2)
    // The commit of the same document (its `navigated`, late) changes nothing.
    dnr.document(1, 3)
    expect(dnr.stateOf(ID)?.actionCount(1)).toBe(2)
    // A straggler of the old document, decided on another IO thread, neither.
    dnr.document(1, 2)
    expect(dnr.stateOf(ID)?.actionCount(1)).toBe(2)
    // The next document: the count restarts and the matches belong to no tab.
    dnr.document(1, 4)
    expect(dnr.stateOf(ID)?.actionCount(1)).toBe(0)
    expect(host.badges.at(-1)).toEqual({ id: ID, tabId: 1, text: '' })
    const matched = (await dnr.call(ext, 'getMatchedRules', [{ tabId: 1 }])) as {
      rulesMatchedInfo: unknown[]
    }
    expect(matched.rulesMatchedInfo).toEqual([])
    const all = (await dnr.call(ext, 'getMatchedRules', [{}])) as {
      rulesMatchedInfo: Array<{ tabId: number }>
    }
    expect(all.rulesMatchedInfo.map((m) => m.tabId)).toEqual([-1, -1])
    // Tabs keep their own generations; a closed tab forgets its.
    dnr.document(2, 1)
    dnr.decided(decision({ tabId: 2 }))
    expect(dnr.stateOf(ID)?.actionCount(2)).toBe(1)
    dnr.tabRemoved(2)
    dnr.document(2, 1)
    expect(dnr.stateOf(ID)?.actionCount(2)).toBe(0)
    // No tab, no generation.
    dnr.document(-1, 9)
    expect(dnr.stateOf(ID)?.actionCount(1)).toBe(0)
  })

  it('ignores decisions of other sets, of unknown extensions, and without a rule', async () => {
    const { host, dnr } = setUp('memory')
    dnr.load(attached(host))
    await dnr.whenSynced(ID)
    expect(dnr.decided(decision({ matchedSet: 'builtin:https-only', matchedRule: 1 }))).toBe(false)
    expect(dnr.decided(decision({ matchedSet: 'filter-text', matchedRule: 0 }))).toBe(false)
    expect(
      dnr.decided(decision({ matchedSet: engineSetId(ID2, { kind: 'dynamic' }), matchedRule: 3 }))
    ).toBe(false)
    expect(dnr.decided(decision({ matchedSet: undefined, matchedRule: undefined }))).toBe(false)
    expect(host.badges).toEqual([])
  })

  it('raises onRuleMatchedDebug with Chrome-shaped request details for unpacked extensions only', async () => {
    const { host, dnr } = setUp('memory')
    const packed = attached(host)
    dnr.load(packed)
    await dnr.whenSynced(ID)
    dnr.decided(decision())
    expect(host.emitted).toEqual([])
    dnr.unload(ID)
    const unpacked = attached(host, { source: 'zip' })
    dnr.load(unpacked)
    await dnr.whenSynced(ID)
    dnr.decided(decision({ tabId: 99 }))
    expect(host.emitted).toEqual([
      {
        id: ID,
        ns: 'declarativeNetRequest',
        name: 'onRuleMatchedDebug',
        args: [
          {
            rule: { ruleId: 1, rulesetId: 'r1' },
            request: {
              requestId: '7',
              url: 'https://ads.example/a.js',
              method: 'GET',
              frameId: 0,
              parentFrameId: -1,
              // A tab the runtime does not know is Chrome's "no tab".
              tabId: UNKNOWN_TAB_ID,
              type: 'script',
              initiator: 'https://site.test'
            }
          }
        ]
      }
    ])
  })

  it('testMatchOutcome is for unpacked extensions; isRegexSupported answers for everyone', async () => {
    const { host, dnr } = setUp('memory')
    const packed = attached(host)
    dnr.load(packed)
    await dnr.whenSynced(ID)
    await expect(
      dnr.call(packed, 'testMatchOutcome', [{ url: 'https://ads.example/a.js', type: 'script' }])
    ).rejects.toThrow(/unpacked/)
    expect(await dnr.call(packed, 'isRegexSupported', [{ regex: '^https://a' }])).toEqual({
      isSupported: true
    })
    dnr.unload(ID)
    const unpacked = attached(host, { source: 'unpacked' })
    dnr.load(unpacked)
    await dnr.whenSynced(ID)
    const outcome = (await dnr.call(unpacked, 'testMatchOutcome', [
      { url: 'https://ads.example/a.js', type: 'script', initiator: 'https://site.test' }
    ])) as { matchedRules: Array<{ ruleId: number }> }
    expect(outcome.matchedRules).toMatchObject([{ ruleId: 1 }])
    await expect(dnr.call(unpacked, 'nonsense', [])).rejects.toThrow(/not implemented/)
  })
})
