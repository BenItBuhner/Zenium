import { describe, expect, it } from 'vitest'
import type { StoreIO } from '../../platform'
import { RuleEngine } from '../engine'
import { INDEX_FILE, RuleSetStore, fileNameFor, type IndexFile } from '../store'

/** In-memory `StoreIO` with the optional `exists` / `remove` the store prefers. */
export function memoryIo(
  initial: Record<string, string> = {}
): StoreIO & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    },
    exists: (name) => files.has(name),
    remove: async (name) => {
      files.delete(name)
    }
  }
}

/** A minimal `StoreIO` as an older host might offer: no `exists`, no `remove`. */
function basicIo(initial: Record<string, string> = {}): StoreIO & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    }
  }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

function index(io: { files: Map<string, string> }): IndexFile {
  return JSON.parse(io.files.get(INDEX_FILE) ?? '{"version":1,"sets":[]}') as IndexFile
}

describe('fileNameFor', () => {
  it('keeps safe ids and makes unsafe ones unique', () => {
    expect(fileNameFor('easylist')).toBe('easylist.json')
    expect(fileNameFor('custom-0a1b2c3d')).toBe('custom-0a1b2c3d.json')
    const a = fileNameFor('builtin:site-exceptions')
    const b = fileNameFor('builtin/site-exceptions')
    expect(a).toMatch(/^builtin_site-exceptions-[0-9a-f]{8}\.json$/)
    expect(a).not.toBe(b)
  })
})

describe('RuleSetStore', () => {
  it('writes structured sets into the index and text sets into their own files', async () => {
    const io = memoryIo()
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    engine.setRuleSet({
      id: 'dnr-ext',
      source: 'dnr',
      priority: 5,
      enabled: true,
      version: '1.2',
      rules: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '||a^' } }]
    })
    engine.setRuleSet({
      id: 'easylist',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      updatedAt: 1000,
      attribution: { name: 'EasyList', url: 'https://easylist.to/', licence: 'GPL-3.0' },
      filterText: '||ads.example^\n@@||cdn.example^'
    })
    await store.flush()
    await flush()

    const idx = index(io)
    expect(idx.version).toBe(1)
    expect(idx.sets.map((s) => s.id)).toEqual(['dnr-ext', 'easylist'])
    expect(idx.sets[0]).toMatchObject({
      rules: [{ id: 1 }],
      hasFilterText: false,
      filterCount: 0,
      version: '1.2'
    })
    expect(idx.sets[0].file).toBeUndefined()
    expect(idx.sets[1]).toMatchObject({
      hasFilterText: true,
      filterCount: 2,
      file: 'easylist.json',
      updatedAt: 1000
    })
    expect(idx.sets[1].rules).toBeUndefined()
    const doc = JSON.parse(io.files.get('blocking/easylist.json') ?? '{}') as {
      filterText?: string
      id?: string
    }
    expect(doc.id).toBe('easylist')
    expect(doc.filterText).toBe('||ads.example^\n@@||cdn.example^')
    expect(store.readFilterText('easylist')).toBe('||ads.example^\n@@||cdn.example^')
    expect(store.readFilterText('dnr-ext')).toBeNull()
    expect(store.filePathFor('easylist')).toBe('blocking/easylist.json')
  })

  it('round-trips through load into a fresh engine with the counts intact', async () => {
    const io = memoryIo()
    const first = new RuleEngine()
    const store1 = new RuleSetStore(io)
    store1.load()
    store1.attach(first)
    first.setRuleSet({
      id: 'text',
      source: 'filter-list',
      priority: 1,
      enabled: false,
      filterText: '||a^\n||b^\n||c^'
    })
    first.setRuleSet({
      id: 'rules',
      source: 'user',
      priority: 10,
      enabled: true,
      rules: [{ id: 1, action: { type: 'allow' }, condition: { requestDomains: ['ok.example'] } }]
    })
    await store1.flush()
    await flush()

    const store2 = new RuleSetStore(io)
    const loaded = store2.load()
    expect(loaded.map((l) => [l.set.id, l.hasFilterText, l.filterCount])).toEqual([
      ['text', true, 3],
      ['rules', false, 0]
    ])
    expect(loaded[0].set.filterText).toBeUndefined()
    expect(loaded[0].set.enabled).toBe(false)
    expect(store2.ids()).toEqual(['text', 'rules'])

    const second = new RuleEngine()
    store2.attach(second)
    for (const l of loaded)
      second.setRuleSet(l.set, {
        persisted: true,
        filterCount: l.filterCount,
        hasFilterText: l.hasFilterText
      })
    expect(second.summary('text')).toMatchObject({
      hasFilterText: true,
      filterCount: 3,
      enabled: false
    })
    expect(
      second.decide({ url: 'https://ok.example/', type: 'script', method: 'GET' }).action
    ).toBe('allow')
    expect(
      second.decide({ url: 'https://ok.example/', type: 'script', method: 'GET' }).matched?.setId
    ).toBe('rules')
    // Re-registering persisted sets did not rewrite the text file.
    expect(store2.readFilterText('text')).toBe('||a^\n||b^\n||c^')
    await store2.flush()
    expect(index(io).sets.find((s) => s.id === 'text')).toMatchObject({
      hasFilterText: true,
      filterCount: 3,
      file: 'text.json'
    })
  })

  it('keeps a set’s partition scope in the index and restores it', async () => {
    const io = memoryIo()
    const first = new RuleEngine()
    const store1 = new RuleSetStore(io)
    store1.load()
    store1.attach(first)
    first.setRuleSet({
      id: 'ext:abc:static:one',
      source: 'dnr',
      priority: 2000,
      enabled: true,
      partitions: ['default'],
      rules: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '||ads.example^' } }]
    })
    first.setRuleSet({
      id: 'easylist',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      rules: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '||tracker.example^' } }]
    })
    await store1.flush()
    expect(index(io).sets.map((s) => [s.id, s.partitions])).toEqual([
      ['ext:abc:static:one', ['default']],
      ['easylist', undefined]
    ])

    // A re-scope is a persisted change: the index follows without a rewrite of the content.
    first.setPartitions('ext:abc:static:one', ['default', 'work'])
    await store1.flush()
    expect(index(io).sets[0].partitions).toEqual(['default', 'work'])

    const store2 = new RuleSetStore(io)
    const loaded = store2.load()
    expect(loaded.map((l) => l.set.partitions)).toEqual([['default', 'work'], undefined])
    const second = new RuleEngine()
    for (const l of loaded) second.setRuleSet(l.set, { persisted: true })
    const ad = (partition: string): Parameters<RuleEngine['decide']>[0] => ({
      url: 'https://ads.example/x.js',
      type: 'script',
      method: 'GET',
      partition
    })
    expect(second.decide(ad('work')).action).toBe('block')
    expect(second.decide(ad('private')).action).toBe('allow')

    // A hand-edited index with junk in the list keeps the strings only.
    const raw = index(io)
    ;(raw.sets[0] as { partitions?: unknown }).partitions = ['default', 7, null]
    io.files.set(INDEX_FILE, JSON.stringify(raw))
    expect(new RuleSetStore(io).load()[0].set.partitions).toEqual(['default'])
  })

  it('drops the text bookkeeping when the text file has gone missing', async () => {
    const io = memoryIo()
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    engine.setRuleSet({
      id: 'text',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      filterText: '||a^'
    })
    await store.flush()
    await flush()
    io.files.delete('blocking/text.json')
    const loaded = new RuleSetStore(io).load()
    expect(loaded).toEqual([
      {
        set: { id: 'text', source: 'filter-list', priority: 1, enabled: true },
        filterCount: 0,
        hasFilterText: false
      }
    ])
  })

  it('keeps the file across enable flips and metadata updates and removes it with the set', async () => {
    const io = memoryIo()
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    engine.setRuleSet({
      id: 'text',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      filterText: '||a^'
    })
    await store.flush()
    await flush()
    engine.setEnabled('text', false)
    engine.setMetadata('text', { version: '9', updatedAt: 5 })
    await store.flush()
    expect(io.files.has('blocking/text.json')).toBe(true)
    expect(index(io).sets[0]).toMatchObject({
      enabled: false,
      version: '9',
      updatedAt: 5,
      hasFilterText: true,
      filterCount: 1,
      file: 'text.json'
    })

    // Replacing the set without text removes the stale file.
    engine.setRuleSet({ id: 'text', source: 'filter-list', priority: 1, enabled: true })
    await store.flush()
    await flush()
    expect(io.files.has('blocking/text.json')).toBe(false)
    expect(index(io).sets[0]).toMatchObject({ hasFilterText: false, filterCount: 0 })

    engine.setRuleSet({
      id: 'text',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      filterText: '||b^'
    })
    engine.removeRuleSet('text')
    await store.flush()
    await flush()
    expect(io.files.has('blocking/text.json')).toBe(false)
    expect(index(io).sets).toEqual([])
  })

  it('falls back to reads and tombstones on hosts without exists / remove', async () => {
    const io = basicIo()
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    engine.setRuleSet({
      id: 'text',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      filterText: '||a^'
    })
    await store.flush()
    await flush()
    expect(new RuleSetStore(io).load()[0].hasFilterText).toBe(true)
    engine.removeRuleSet('text')
    await store.flush()
    await flush()
    expect(io.files.get('blocking/text.json')).toBe('{}')
    store.detach()
    engine.setRuleSet({ id: 'after', source: 'dnr', priority: 5, enabled: true })
    await store.flush()
    expect(index(io).sets).toEqual([])
  })

  it('ignores corrupt or foreign index files', () => {
    expect(new RuleSetStore(memoryIo({ [INDEX_FILE]: 'not json' })).load()).toEqual([])
    expect(new RuleSetStore(memoryIo({ [INDEX_FILE]: '{"version":2,"sets":[]}' })).load()).toEqual(
      []
    )
    expect(
      new RuleSetStore(
        memoryIo({
          [INDEX_FILE]:
            '{"version":1,"sets":[null,{"id":"x"},{"id":"ok","source":"dnr","priority":5}]}'
        })
      ).load()
    ).toEqual([
      {
        set: { id: 'ok', source: 'dnr', priority: 5, enabled: true },
        filterCount: 0,
        hasFilterText: false
      }
    ])
  })

  it('flushes synchronously on shutdown', () => {
    const io = memoryIo()
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    engine.setRuleSet({ id: 'dnr', source: 'dnr', priority: 5, enabled: true, rules: [] })
    expect(io.files.has(INDEX_FILE)).toBe(false)
    store.flushSync()
    expect(index(io).sets.map((s) => s.id)).toEqual(['dnr'])
  })
})
