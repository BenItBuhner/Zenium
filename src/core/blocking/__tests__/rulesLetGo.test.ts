import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreIO } from '../../platform'
import { RuleEngine } from '../engine'
import type { RequestContext, Rule, RuleSet, RuleSetChange } from '../rules'
import { INDEX_FILE, RuleSetStore, documentNameFor, tagOf, type IndexFile } from '../store'

/**
 * The phone's last copy of a set's rules: on a host that never decides in JavaScript the engine
 * lets a set's `Rule[]` go once the store confirmed the set document is on disk, and reads the
 * document back on the rare call that wants them (`rulesOf`, a table build after all). A host
 * that decides – a decision made, a text matcher installed – keeps them, as before.
 */

/** In-memory `StoreIO` whose writes land at once; every write and removal recorded. */
function memoryIo(
  initial: Record<string, string> = {}
): StoreIO & { files: Map<string, string>; writes: string[]; removals: string[] } {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  const removals: string[] = []
  return {
    files,
    writes,
    removals,
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      writes.push(name)
      files.set(name, text)
    },
    writeSync: (name, text) => {
      writes.push(name)
      files.set(name, text)
    },
    exists: (name) => files.has(name),
    remove: async (name) => {
      removals.push(name)
      files.delete(name)
    }
  }
}

/**
 * In-memory `StoreIO` whose asynchronous writes of set documents land only when released –
 * `landOne` lands the oldest, `landAll` every one including those a landing starts – and fail
 * for the names in `failing`; the index and anything else lands at once. What a slow disk on
 * the phone looks like to the store.
 */
function gatedIo(): StoreIO & {
  files: Map<string, string>
  writes: string[]
  failing: Set<string>
  queued: () => number
  landOne: () => Promise<void>
  landAll: () => Promise<void>
} {
  const files = new Map<string, string>()
  const writes: string[] = []
  const failing = new Set<string>()
  const queue: (() => void)[] = []
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
  return {
    files,
    writes,
    failing,
    queued: () => queue.length,
    landOne: async () => {
      queue.shift()?.()
      await tick()
    },
    landAll: async () => {
      do {
        while (queue.length > 0) queue.shift()!()
        await tick()
      } while (queue.length > 0)
    },
    readSync: (name) => files.get(name) ?? null,
    write: (name, text) =>
      new Promise<void>((resolve, reject) => {
        const land = (): void => {
          writes.push(name)
          if (failing.has(name)) reject(new Error(`no room for ${name}`))
          else {
            files.set(name, text)
            resolve()
          }
        }
        if (name.startsWith('blocking/sets/')) queue.push(land)
        else land()
      }),
    writeSync: (name, text) => {
      writes.push(name)
      files.set(name, text)
    },
    exists: (name) => files.has(name),
    remove: async (name) => {
      files.delete(name)
    }
  }
}

const block = (id: number, host: string): Rule => ({
  id,
  action: { type: 'block' },
  condition: { urlFilter: `||${host}^` }
})

const rulesV1 = (): Rule[] => [block(1, 'ads.example'), block(2, 'trk.example')]
const rulesV2 = (): Rule[] => [block(1, 'ads.example'), block(3, 'pix.example')]

function set(rules: Rule[], extra: Partial<RuleSet> = {}): RuleSet {
  return { id: 'ext:static', source: 'dnr', priority: 30, enabled: true, rules, ...extra }
}

const ID = 'ext:static'
const DOCUMENT = `blocking/${documentNameFor(ID)}`

const request = (host: string): RequestContext => ({
  url: `https://${host}/a.js`,
  type: 'script',
  method: 'GET',
  initiator: 'https://site.example/',
  documentUrl: 'https://site.example/'
})

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

function indexOf(io: { files: Map<string, string> }): IndexFile {
  return JSON.parse(io.files.get(INDEX_FILE) ?? '{"version":2,"sets":[]}') as IndexFile
}

/** An engine with the store attached, as the blocking service wires them on the phone. */
function phone(io: StoreIO): { engine: RuleEngine; store: RuleSetStore } {
  const store = new RuleSetStore(io)
  const engine = new RuleEngine()
  store.attach(engine)
  return { engine, store }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the phone's last copy: the engine lets a set's rules go once the set document is written", () => {
  it('lets them go only once the write landed, and reads them back on every call without keeping them', async () => {
    const io = gatedIo()
    const { engine, store } = phone(io)
    const rules = rulesV1()
    engine.setRuleSet(set(rules))
    // Handed over, written but not landed: the engine still holds the very array.
    expect(engine.retainsRules(ID)).toBe(true)
    expect(engine.rulesOf(ID)).toBe(rules)
    await flush()
    expect(io.queued()).toBe(1)
    expect(engine.retainsRules(ID)).toBe(true)

    await io.landAll()
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)
    expect(engine.tableOf(ID)).toBeNull()
    // Read back from the document: equal, not the same array, and a new one every call.
    const first = engine.rulesOf(ID)
    expect(first).toEqual(rules)
    expect(first).not.toBe(rules)
    expect(engine.rulesOf(ID)).not.toBe(first)
    expect(engine.retainsRules(ID)).toBe(false)
    // The summary is untouched by the drop.
    expect(engine.summary(ID)).toMatchObject({ id: ID, ruleCount: 2, enabled: true })
    expect(engine.listRuleSets().map((s) => s.id)).toEqual([ID])
  })

  it('keeps them on an engine that decides in JavaScript: a text matcher installed (the desktop)', async () => {
    const io = memoryIo()
    const { engine, store } = phone(io)
    engine.setTextMatcher({ match: () => null })
    const rules = rulesV1()
    engine.setRuleSet(set(rules))
    await store.whenSettled()
    expect(io.files.has(DOCUMENT)).toBe(true)
    expect(engine.retainsRules(ID)).toBe(true)
    expect(engine.rulesOf(ID)).toBe(rules)
    expect(engine.decide(request('ads.example'))).toMatchObject({
      action: 'block',
      matched: { setId: ID, ruleId: 1 }
    })
    expect(engine.tableOf(ID)?.size).toBe(2)
  })

  it('keeps them on an engine that decided before the write landed', async () => {
    const io = gatedIo()
    const { engine, store } = phone(io)
    const rules = rulesV1()
    engine.setRuleSet(set(rules))
    expect(engine.decide(request('trk.example'))).toMatchObject({
      action: 'block',
      matched: { setId: ID, ruleId: 2 }
    })
    await io.landAll()
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(true)
    expect(engine.rulesOf(ID)).toBe(rules)
  })

  it('a set updated after the drop writes its document again and lets the new rules go once that landed', async () => {
    const io = memoryIo()
    const { engine, store } = phone(io)
    engine.setRuleSet(set(rulesV1()))
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)
    const writesBefore = io.writes.filter((w) => w === DOCUMENT).length

    const v2 = rulesV2()
    engine.setRuleSet(set(v2))
    expect(engine.retainsRules(ID)).toBe(true)
    expect(engine.rulesOf(ID)).toBe(v2)
    await store.whenSettled()
    expect(io.writes.filter((w) => w === DOCUMENT).length).toBe(writesBefore + 1)
    expect(engine.retainsRules(ID)).toBe(false)
    expect(engine.rulesOf(ID)).toEqual(v2)
    const entry = indexOf(io).sets.find((s) => s.id === ID)
    expect(entry).toMatchObject({ ruleCount: 2, document: documentNameFor(ID) })
    expect(entry?.tag).toBe(tagOf(io.files.get(DOCUMENT)!))

    // The same rules handed again (an extension re-registered): no write, the document stands,
    // and the fresh array goes too.
    const again = rulesV2()
    engine.setRuleSet(set(again))
    expect(engine.rulesOf(ID)).toBe(again)
    await store.whenSettled()
    expect(io.writes.filter((w) => w === DOCUMENT).length).toBe(writesBefore + 1)
    expect(engine.retainsRules(ID)).toBe(false)
    expect(engine.rulesOf(ID)).toEqual(again)
  })

  it('a decision after the drop builds the table from the rules read back, keeps them with it and decides as a fresh engine does', async () => {
    const io = memoryIo()
    const { engine, store } = phone(io)
    engine.setRuleSet(set(rulesV1()))
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)

    const fresh = new RuleEngine()
    fresh.setRuleSet(set(rulesV1()))
    for (const host of ['ads.example', 'trk.example', 'other.example']) {
      expect(engine.decide(request(host))).toEqual(fresh.decide(request(host)))
      expect(engine.decideLinear(request(host))).toEqual(fresh.decideLinear(request(host)))
    }
    expect(engine.tableOf(ID)?.size).toBe(2)
    // Read back once, for the build, and kept with the table: the table's rows point into them.
    expect(engine.retainsRules(ID)).toBe(true)
    const kept = engine.rulesOf(ID)
    expect(engine.rulesOf(ID)).toBe(kept)
    // The engine decides now: a later set of the same rules is written but never let go.
    const later = rulesV2()
    engine.setRuleSet(set(later))
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(true)
    expect(engine.rulesOf(ID)).toBe(later)
  })

  it('a change of metadata after the drop rides without the rules; the store keeps the document and nothing is read back', async () => {
    const io = memoryIo()
    const { engine, store } = phone(io)
    engine.setRuleSet(set(rulesV1(), { partitions: ['persist:a'] }))
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)
    const document = io.files.get(DOCUMENT)!
    const tag = indexOf(io).sets.find((s) => s.id === ID)?.tag
    const documentWrites = io.writes.filter((w) => w === DOCUMENT).length
    const changes: RuleSetChange[] = []
    engine.subscribe((change) => changes.push(change))
    const readSync = vi.spyOn(io, 'readSync')

    engine.setEnabled(ID, false)
    engine.setPartitions(ID, ['persist:a', 'persist:b'])
    engine.setMetadata(ID, { version: '2' })
    await store.whenSettled()
    expect(changes).toHaveLength(3)
    for (const change of changes) {
      expect(change.persisted).toBe(true)
      expect(change.set?.rules).toBeUndefined()
      expect(change.summary?.ruleCount).toBe(2)
    }
    expect(readSync).not.toHaveBeenCalledWith(DOCUMENT)
    expect(io.writes.filter((w) => w === DOCUMENT).length).toBe(documentWrites)
    expect(io.removals).toEqual([])
    expect(io.files.get(DOCUMENT)).toBe(document)
    expect(indexOf(io).sets.find((s) => s.id === ID)).toMatchObject({
      enabled: false,
      partitions: ['persist:a', 'persist:b'],
      version: '2',
      ruleCount: 2,
      document: documentNameFor(ID),
      tag
    })
    expect(engine.retainsRules(ID)).toBe(false)
    expect(engine.rulesOf(ID)).toEqual(rulesV1())
  })

  it('a write that fails leaves the engine holding the rules', async () => {
    const io = gatedIo()
    io.failing.add(DOCUMENT)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { engine, store } = phone(io)
    const rules = rulesV1()
    engine.setRuleSet(set(rules))
    await io.landAll()
    await store.whenSettled()
    expect(warn).toHaveBeenCalled()
    expect(io.files.has(DOCUMENT)).toBe(false)
    expect(engine.retainsRules(ID)).toBe(true)
    expect(engine.rulesOf(ID)).toBe(rules)
    // The document never stood, so a change of metadata cannot confirm it either.
    engine.setEnabled(ID, false)
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(true)
  })

  it('the landing of an older write drops nothing of the rules a newer setRuleSet holds', async () => {
    const io = gatedIo()
    const { engine, store } = phone(io)
    engine.setRuleSet(set(rulesV1()))
    const v2 = rulesV2()
    engine.setRuleSet(set(v2))
    await flush()
    // The first write lands; the second is chained behind it and has not.
    await io.landOne()
    expect(engine.retainsRules(ID)).toBe(true)
    expect(engine.rulesOf(ID)).toBe(v2)
    await io.landAll()
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)
    expect(engine.rulesOf(ID)).toEqual(v2)
    expect(JSON.parse(io.files.get(DOCUMENT)!)).toEqual({ id: ID, rules: v2 })
  })

  it('a document that cannot be read back reads as no rules, with an error; one of another version is used, with a warning', async () => {
    const io = memoryIo()
    const { engine, store } = phone(io)
    engine.setRuleSet(set(rulesV1()))
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const written = io.files.get(DOCUMENT)!
    io.files.set(DOCUMENT, JSON.stringify({ id: ID, rules: rulesV2() }))
    expect(engine.rulesOf(ID)).toEqual(rulesV2())
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()

    io.files.delete(DOCUMENT)
    expect(engine.rulesOf(ID)).toEqual([])
    expect(error).toHaveBeenCalledTimes(1)
    io.files.set(DOCUMENT, '{not json')
    expect(engine.rulesOf(ID)).toEqual([])
    io.files.set(DOCUMENT, written)
    expect(engine.rulesOf(ID)).toEqual(rulesV1())
    // A table built while the document is unreadable is empty; the summary still counts.
    io.files.delete(DOCUMENT)
    expect(engine.decide(request('ads.example'))).toEqual({ action: 'allow' })
    expect(engine.summary(ID)?.ruleCount).toBe(2)
  })

  it('reads them back after the store detached, and never confirms to an engine it no longer mirrors', async () => {
    const io = memoryIo()
    const { engine, store } = phone(io)
    engine.setRuleSet(set(rulesV1()))
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)
    store.detach()
    expect(engine.rulesOf(ID)).toEqual(rulesV1())

    const other = new RuleEngine()
    store.attach(other)
    const rules = rulesV2()
    other.setRuleSet(set(rules))
    store.detach()
    await store.whenSettled()
    // Detached before the landing: the confirmation is not delivered.
    expect(other.retainsRules(ID)).toBe(true)
    expect(other.rulesOf(ID)).toBe(rules)
  })

  it('a set loaded at start whose document stands is let go on a later tick, as the service wires it', async () => {
    const io = memoryIo()
    {
      const { engine, store } = phone(io)
      engine.setRuleSet(set(rulesV1(), { version: '1' }))
      await store.whenSettled()
    }
    const store = new RuleSetStore(io)
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    const engine = new RuleEngine()
    store.attach(engine)
    for (const l of loaded)
      engine.setRuleSet(l.set, {
        persisted: true,
        filterCount: l.filterCount,
        hasFilterText: l.hasFilterText
      })
    // Inside the notification the engine still holds what it was handed.
    expect(engine.retainsRules(ID)).toBe(true)
    const documentWrites = io.writes.filter((w) => w === DOCUMENT).length
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)
    expect(io.writes.filter((w) => w === DOCUMENT).length).toBe(documentWrites)
    expect(engine.rulesOf(ID)).toEqual(rulesV1())
    expect(engine.summary(ID)).toMatchObject({ ruleCount: 2, version: '1' })
  })

  it('an empty set and a set with no store attached are never let go', async () => {
    const io = memoryIo()
    const { engine, store } = phone(io)
    engine.setRuleSet(set([]))
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(true)
    expect(engine.rulesOf(ID)).toEqual([])

    const alone = new RuleEngine()
    const rules = rulesV1()
    alone.setRuleSet(set(rules))
    await flush()
    expect(alone.retainsRules(ID)).toBe(true)
    expect(alone.rulesOf(ID)).toBe(rules)
    expect(alone.retainsRules('missing')).toBeUndefined()
  })

  it('a removed set leaves nothing to read back, and its document goes', async () => {
    const io = memoryIo()
    const { engine, store } = phone(io)
    engine.setRuleSet(set(rulesV1()))
    await store.whenSettled()
    expect(engine.retainsRules(ID)).toBe(false)
    engine.removeRuleSet(ID)
    await store.whenSettled()
    expect(engine.rulesOf(ID)).toBeUndefined()
    expect(engine.retainsRules(ID)).toBeUndefined()
    expect(io.files.has(DOCUMENT)).toBe(false)
    expect(store.readRules(ID)).toBeNull()
  })
})
