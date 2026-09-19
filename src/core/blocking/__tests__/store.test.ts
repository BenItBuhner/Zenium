import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreIO } from '../../platform'
import { RuleEngine } from '../engine'
import type { Rule } from '../rules'
import {
  INDEX_FILE,
  INDEX_VERSION,
  RuleSetStore,
  SETS_DIR,
  documentNameFor,
  documentText,
  fileNameFor,
  tagOf,
  type IndexEntry,
  type IndexFile,
  type SetDocument
} from '../store'

/** In-memory `StoreIO` with the optional `exists` / `remove` the store prefers; every write counted. */
export function memoryIo(
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
  return JSON.parse(io.files.get(INDEX_FILE) ?? '{"version":2,"sets":[]}') as IndexFile
}

function document(io: { files: Map<string, string> }, id: string): SetDocument | null {
  const raw = io.files.get(`blocking/${documentNameFor(id)}`)
  return raw === undefined ? null : (JSON.parse(raw) as SetDocument)
}

const block = (id: number, host: string): Rule => ({
  id,
  action: { type: 'block' },
  condition: { urlFilter: `||${host}^` }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fileNameFor', () => {
  it('keeps safe ids and makes unsafe ones unique', () => {
    expect(fileNameFor('easylist')).toBe('easylist.json')
    expect(fileNameFor('custom-0a1b2c3d')).toBe('custom-0a1b2c3d.json')
    const a = fileNameFor('builtin:site-exceptions')
    const b = fileNameFor('builtin/site-exceptions')
    expect(a).toMatch(/^builtin_site-exceptions-[0-9a-f]{8}\.json$/)
    expect(a).not.toBe(b)
    expect(documentNameFor('easylist')).toBe('sets/easylist.json')
    expect(documentNameFor('builtin:site-exceptions')).toBe(`sets/${a}`)
    expect(SETS_DIR).toBe('blocking/sets')
  })
})

describe('tagOf', () => {
  it('is the length and two hashes of the text, and changes with any byte', () => {
    const text = documentText('x', [block(1, 'a.example')])
    expect(tagOf(text)).toMatch(/^[0-9a-f]+-[0-9a-f]{16}$/)
    expect(tagOf(text)).toBe(tagOf(text))
    expect(tagOf(text).split('-')[0]).toBe(text.length.toString(16))
    expect(tagOf(text)).not.toBe(tagOf(text.replace('a.example', 'a.exampl3')))
    expect(tagOf('')).toBe('0-811c9dc500001505')
  })
})

describe('RuleSetStore', () => {
  it('writes summaries into the index, rules into set documents and text sets into their own files', async () => {
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
      updatedAt: 77,
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
    await store.whenSettled()

    const idx = index(io)
    expect(idx.version).toBe(INDEX_VERSION)
    expect(idx.sets.map((s) => s.id)).toEqual(['dnr-ext', 'easylist'])
    const doc = io.files.get('blocking/sets/dnr-ext.json')
    expect(doc).toBe(
      '{"id":"dnr-ext","rules":[{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||a^"}}]}'
    )
    expect(idx.sets[0]).toEqual({
      id: 'dnr-ext',
      source: 'dnr',
      priority: 5,
      enabled: true,
      version: '1.2',
      updatedAt: 77,
      ruleCount: 1,
      document: 'sets/dnr-ext.json',
      tag: tagOf(doc ?? ''),
      hasFilterText: false,
      filterCount: 0
    })
    expect(idx.sets[1]).toEqual({
      id: 'easylist',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      updatedAt: 1000,
      attribution: { name: 'EasyList', url: 'https://easylist.to/', licence: 'GPL-3.0' },
      ruleCount: 0,
      hasFilterText: true,
      filterCount: 2,
      file: 'easylist.json'
    })
    // The summaries carry no rules; the index is small whatever the sets hold.
    expect(JSON.stringify(idx)).not.toContain('urlFilter')
    const text = JSON.parse(io.files.get('blocking/easylist.json') ?? '{}') as {
      filterText?: string
      id?: string
    }
    expect(text.id).toBe('easylist')
    expect(text.filterText).toBe('||ads.example^\n@@||cdn.example^')
    expect(store.readFilterText('easylist')).toBe('||ads.example^\n@@||cdn.example^')
    expect(store.readFilterText('dnr-ext')).toBeNull()
    expect(store.filePathFor('easylist')).toBe('blocking/easylist.json')
    expect(store.documentPathFor('dnr-ext')).toBe('blocking/sets/dnr-ext.json')
    expect(store.documentPathFor('builtin:x')).toBe(`blocking/sets/${fileNameFor('builtin:x')}`)
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
    await store1.whenSettled()

    const store2 = new RuleSetStore(io)
    const loaded = store2.load()
    expect(loaded.map((l) => [l.set.id, l.hasFilterText, l.filterCount])).toEqual([
      ['text', true, 3],
      ['rules', false, 0]
    ])
    expect(loaded[0].set.filterText).toBeUndefined()
    expect(loaded[0].set.enabled).toBe(false)
    expect(loaded[1].set.rules).toEqual([
      { id: 1, action: { type: 'allow' }, condition: { requestDomains: ['ok.example'] } }
    ])
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
    // Re-registering persisted sets rewrote neither the text file nor the set document.
    const before = io.writes.length
    await store2.whenSettled()
    expect(io.writes.slice(before)).toEqual([INDEX_FILE])
    expect(store2.readFilterText('text')).toBe('||a^\n||b^\n||c^')
    expect(index(io).sets.find((s) => s.id === 'text')).toMatchObject({
      hasFilterText: true,
      filterCount: 3,
      file: 'text.json'
    })
    expect(index(io).sets.find((s) => s.id === 'rules')).toMatchObject({
      ruleCount: 1,
      document: 'sets/rules.json'
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
    await store1.whenSettled()
    expect(index(io).sets.map((s) => [s.id, s.partitions])).toEqual([
      ['ext:abc:static:one', ['default']],
      ['easylist', undefined]
    ])
    expect(io.files.has(`blocking/${documentNameFor('ext:abc:static:one')}`)).toBe(true)

    // A re-scope is a persisted change: the index follows without a rewrite of the content.
    const writesBefore = io.writes.length
    first.setPartitions('ext:abc:static:one', ['default', 'work'])
    await store1.whenSettled()
    expect(index(io).sets[0].partitions).toEqual(['default', 'work'])
    expect(io.writes.slice(writesBefore)).toEqual([INDEX_FILE])

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
    await store.whenSettled()
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
    await store.whenSettled()
    engine.setEnabled('text', false)
    engine.setMetadata('text', { version: '9', updatedAt: 5 })
    await store.whenSettled()
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
    await store.whenSettled()
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
    await store.whenSettled()
    expect(io.files.has('blocking/text.json')).toBe(false)
    expect(index(io).sets).toEqual([])
  })

  it('removes a set’s document with the set and when its rules go away', async () => {
    const io = memoryIo()
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    engine.setRuleSet({
      id: 'u',
      source: 'user',
      priority: 10,
      enabled: true,
      rules: [block(1, 'a.example')]
    })
    await store.whenSettled()
    expect(document(io, 'u')?.rules).toHaveLength(1)

    // The same set without rules: the document goes, the summary says so.
    engine.setRuleSet({ id: 'u', source: 'user', priority: 10, enabled: true, rules: [] })
    await store.whenSettled()
    expect(io.files.has('blocking/sets/u.json')).toBe(false)
    expect(index(io).sets[0]).toMatchObject({ id: 'u', ruleCount: 0 })
    expect(index(io).sets[0].document).toBeUndefined()
    expect(index(io).sets[0].tag).toBeUndefined()

    engine.setRuleSet({
      id: 'u',
      source: 'user',
      priority: 10,
      enabled: true,
      rules: [block(1, 'a.example')]
    })
    engine.removeRuleSet('u')
    await store.whenSettled()
    expect(io.files.has('blocking/sets/u.json')).toBe(false)
    expect(index(io).sets).toEqual([])
    // A write followed at once by the removal of the same document landed in that order.
    expect(io.removals.filter((n) => n === 'blocking/sets/u.json')).toHaveLength(2)
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
    engine.setRuleSet({
      id: 'u',
      source: 'user',
      priority: 10,
      enabled: true,
      rules: [block(1, 'a.example')]
    })
    await store.whenSettled()
    const loaded = new RuleSetStore(io).load()
    expect(loaded[0].hasFilterText).toBe(true)
    expect(loaded[1].set.rules).toHaveLength(1)
    engine.removeRuleSet('text')
    engine.removeRuleSet('u')
    await store.whenSettled()
    expect(io.files.get('blocking/text.json')).toBe('{}')
    expect(io.files.get('blocking/sets/u.json')).toBe('{}')
    store.detach()
    engine.setRuleSet({ id: 'after', source: 'dnr', priority: 5, enabled: true })
    await store.flush()
    expect(index(io).sets).toEqual([])
  })

  it('ignores corrupt or foreign index files', () => {
    expect(new RuleSetStore(memoryIo({ [INDEX_FILE]: 'not json' })).load()).toEqual([])
    expect(new RuleSetStore(memoryIo({ [INDEX_FILE]: '{"version":3,"sets":[]}' })).load()).toEqual(
      []
    )
    expect(new RuleSetStore(memoryIo({ [INDEX_FILE]: '{"version":2,"sets":{}}' })).load()).toEqual(
      []
    )
    expect(
      new RuleSetStore(
        memoryIo({
          [INDEX_FILE]:
            '{"version":2,"sets":[null,{"id":"x"},{"id":"ok","source":"dnr","priority":5}]}'
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

  it('flushes synchronously on shutdown, the documents in flight first', async () => {
    // A host whose asynchronous writes land on a later turn, as the desktop's file store does.
    const files = new Map<string, string>()
    const writes: string[] = []
    const io: StoreIO = {
      readSync: (name) => files.get(name) ?? null,
      write: (name, text) =>
        new Promise<void>((resolve) =>
          setImmediate(() => {
            writes.push(`async:${name}`)
            files.set(name, text)
            resolve()
          })
        ),
      writeSync: (name, text) => {
        writes.push(name)
        files.set(name, text)
      },
      exists: (name) => files.has(name)
    }
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    engine.setRuleSet({
      id: 'dnr',
      source: 'dnr',
      priority: 5,
      enabled: true,
      rules: [block(1, 'a.example')]
    })
    engine.setRuleSet({
      id: 'text',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      filterText: '||a^'
    })
    expect(files.has(INDEX_FILE)).toBe(false)
    // The asynchronous writes have not landed: the synchronous flush lands them itself, first.
    store.flushSync()
    expect(writes).toEqual(['blocking/sets/dnr.json', 'blocking/text.json', INDEX_FILE])
    expect(index({ files }).sets.map((s) => [s.id, s.document, s.file])).toEqual([
      ['dnr', 'sets/dnr.json', undefined],
      ['text', undefined, 'text.json']
    ])
    expect(document({ files }, 'dnr')?.rules).toEqual([block(1, 'a.example')])
    // The asynchronous writes land later with the same bytes; nothing is lost or reordered.
    await flush()
    expect(writes.slice(3)).toEqual(['async:blocking/sets/dnr.json', 'async:blocking/text.json'])
    expect(document({ files }, 'dnr')?.rules).toEqual([block(1, 'a.example')])
  })

  it('writes the index after the documents it names, whichever lands first at the host', async () => {
    // A host whose writes complete out of order: the index must still wait for the documents.
    const files = new Map<string, string>()
    const order: string[] = []
    const gates = new Map<string, () => void>()
    const io: StoreIO = {
      readSync: (name) => files.get(name) ?? null,
      write: (name, text) =>
        new Promise<void>((resolve) => {
          gates.set(name, () => {
            files.set(name, text)
            order.push(name)
            resolve()
          })
        }),
      writeSync: (name, text) => {
        files.set(name, text)
        order.push(name)
      },
      exists: (name) => files.has(name)
    }
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    engine.setRuleSet({
      id: 'u',
      source: 'user',
      priority: 10,
      enabled: true,
      rules: [block(1, 'a.example')]
    })
    const settled = store.whenSettled()
    await flush()
    // The document's write is with the host; the index's has not been issued.
    expect([...gates.keys()]).toEqual(['blocking/sets/u.json'])
    gates.get('blocking/sets/u.json')?.()
    await flush()
    await flush()
    expect([...gates.keys()]).toContain(INDEX_FILE)
    gates.get(INDEX_FILE)?.()
    await settled
    expect(order).toEqual(['blocking/sets/u.json', INDEX_FILE])
  })

  it('a shutdown while the index waits for its documents writes both now and drops the waiting write', async () => {
    // The desktop quit on a slow disk: `flushSync`, then `JsonStore.idle()` is waited for. The
    // host's asynchronous writes land when the disk says so; its synchronous ones at once.
    const files = new Map<string, string>()
    const order: string[] = []
    const gates: Array<() => void> = []
    const io: StoreIO = {
      readSync: (name) => files.get(name) ?? null,
      write: (name, text) =>
        new Promise<void>((resolve) => {
          gates.push(() => {
            files.set(name, text)
            order.push(`async:${name}`)
            resolve()
          })
        }),
      writeSync: (name, text) => {
        files.set(name, text)
        order.push(name)
      },
      exists: (name) => files.has(name)
    }
    vi.useFakeTimers()
    try {
      const engine = new RuleEngine()
      const store = new RuleSetStore(io)
      store.load()
      store.attach(engine)
      const u = (rules: Rule[]): void =>
        engine.setRuleSet({ id: 'u', source: 'user', priority: 10, enabled: true, rules })
      u([block(1, 'a.example')])
      // The document's write is with the disk; the index's debounce fired and waits for it.
      await vi.advanceTimersByTimeAsync(250)
      expect(gates).toHaveLength(1)
      expect(files.has(INDEX_FILE)).toBe(false)
      // A last change, then the quit: the newest document and an index naming it land now.
      u([block(1, 'a.example'), block(2, 'b.example')])
      store.flushSync()
      expect(order).toEqual(['blocking/sets/u.json', INDEX_FILE])
      const written = files.get('blocking/sets/u.json') ?? ''
      expect((JSON.parse(written) as SetDocument).rules).toHaveLength(2)
      expect(index({ files }).sets.map((s) => [s.ruleCount, s.tag])).toEqual([[2, tagOf(written)]])
      // The disk catches up: the document's writes land in order, the index write that waited
      // for them is dropped (it holds the older index), and the store settles with the disk in
      // the quit's final state.
      const settled = store.whenSettled()
      for (let i = 0; i < 4 && gates.length > 0; i++) {
        for (const open of gates.splice(0)) open()
        await vi.advanceTimersByTimeAsync(0)
      }
      await settled
      expect(gates).toHaveLength(0)
      expect(order.filter((name) => name.startsWith('async:'))).toEqual([
        'async:blocking/sets/u.json',
        'async:blocking/sets/u.json'
      ])
      expect(files.get('blocking/sets/u.json')).toBe(written)
      expect(index({ files }).sets.map((s) => [s.ruleCount, s.tag])).toEqual([[2, tagOf(written)]])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RuleSetStore: only what changed is written', () => {
  it('rewrites a set document when its rules change and nothing when they do not', async () => {
    const io = memoryIo()
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    const a = (rules: Rule[]): void =>
      engine.setRuleSet({
        id: 'ext:a:_dynamic',
        source: 'dnr',
        priority: 2999,
        enabled: true,
        rules
      })
    const b = (rules: Rule[]): void =>
      engine.setRuleSet({
        id: 'ext:b:static:one',
        source: 'dnr',
        priority: 2998,
        enabled: true,
        rules
      })
    a([block(1, 'a.example')])
    b([block(1, 'b.example'), block(2, 'c.example')])
    await store.whenSettled()
    const docA = `blocking/${documentNameFor('ext:a:_dynamic')}`
    const docB = `blocking/${documentNameFor('ext:b:static:one')}`
    expect(io.writes.sort()).toEqual([INDEX_FILE, docA, docB].sort())
    const indexBytes = io.files.get(INDEX_FILE)
    const bytesB = io.files.get(docB)

    // The translator emits set A again, changed: A's document and the index, nothing else.
    io.writes.length = 0
    a([block(1, 'a.example'), block(2, 'd.example')])
    await store.whenSettled()
    expect(io.writes).toEqual([docA, INDEX_FILE])
    expect(io.files.get(docB)).toBe(bytesB)
    expect(io.files.get(INDEX_FILE)).not.toBe(indexBytes)
    expect(index(io).sets.map((s) => s.ruleCount)).toEqual([2, 2])

    // Emitted again with the same rules: the tag is the same, the document is left alone.
    io.writes.length = 0
    const tagA = index(io).sets[0].tag
    a([block(1, 'a.example'), block(2, 'd.example')])
    b([block(1, 'b.example'), block(2, 'c.example')])
    await store.whenSettled()
    expect(io.writes).toEqual([INDEX_FILE])
    expect(index(io).sets[0].tag).toBe(tagA)
  })

  it('serialises the same state to the same bytes, index and documents alike', async () => {
    const build = async (): Promise<Map<string, string>> => {
      const io = memoryIo()
      const engine = new RuleEngine()
      const store = new RuleSetStore(io)
      store.load()
      store.attach(engine)
      engine.setRuleSet({
        id: 'ext:a:_dynamic',
        source: 'dnr',
        priority: 2999,
        enabled: true,
        version: '2.0',
        updatedAt: 1234,
        partitions: ['default', 'work'],
        attribution: { name: 'A', url: 'https://a.example/', licence: '' },
        rules: [block(1, 'a.example'), block(2, 'd.example')]
      })
      engine.setRuleSet({
        id: 'easylist',
        source: 'filter-list',
        priority: 1,
        enabled: true,
        updatedAt: 1000,
        attribution: { name: 'EasyList', url: 'https://easylist.to/', licence: 'GPL-3.0' },
        filterText: '||ads.example^'
      })
      engine.setRuleSet({
        id: 'builtin:site-exceptions',
        source: 'builtin',
        priority: 900,
        enabled: true,
        rules: [
          {
            id: 1,
            action: { type: 'allowAllRequests' },
            condition: { urlFilter: '|https://news.example/', resourceTypes: ['main_frame'] }
          }
        ]
      })
      await store.whenSettled()
      return io.files
    }
    const first = await build()
    const second = await build()
    expect([...first.keys()].sort()).toEqual([...second.keys()].sort())
    for (const [name, text] of first) expect(second.get(name), name).toBe(text)

    // A restart: what the loader hands back, set again as persisted, writes the very same index.
    const io = memoryIo(Object.fromEntries(first))
    const store = new RuleSetStore(io)
    const loaded = store.load()
    const engine = new RuleEngine()
    store.attach(engine)
    for (const l of loaded)
      engine.setRuleSet(l.set, {
        persisted: true,
        filterCount: l.filterCount,
        hasFilterText: l.hasFilterText
      })
    await store.whenSettled()
    expect(io.writes).toEqual([INDEX_FILE])
    expect(io.files.get(INDEX_FILE)).toBe(first.get(INDEX_FILE))
    for (const [name, text] of first) expect(io.files.get(name), name).toBe(text)
  })
})

describe('RuleSetStore: migration of the inline index', () => {
  /** A `version: 1` index as the store wrote it before the set documents. */
  const legacyIndex = (): string =>
    JSON.stringify({
      version: 1,
      sets: [
        {
          id: 'easylist',
          source: 'filter-list',
          priority: 1,
          enabled: true,
          hasFilterText: true,
          filterCount: 2,
          updatedAt: 1000,
          file: 'easylist.json'
        },
        {
          id: 'ext:abc:static:one',
          source: 'dnr',
          priority: 2999,
          enabled: true,
          hasFilterText: false,
          filterCount: 0,
          version: '1.4',
          updatedAt: 1789633817801,
          partitions: ['default', 'work'],
          rules: [block(1, 'ads.example'), block(2, 'trk.example')]
        },
        {
          id: 'builtin:site-exceptions',
          source: 'builtin',
          priority: 900,
          enabled: true,
          hasFilterText: false,
          filterCount: 0,
          rules: [
            {
              id: 1,
              action: { type: 'allowAllRequests' },
              condition: { urlFilter: '|https://news.example/', resourceTypes: ['main_frame'] }
            }
          ]
        },
        {
          id: 'user',
          source: 'user',
          priority: 10,
          enabled: true,
          hasFilterText: false,
          filterCount: 0,
          rules: []
        }
      ]
    })

  it('splits the inline rules into set documents and rewrites the index as summaries', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const io = memoryIo({
      [INDEX_FILE]: legacyIndex(),
      'blocking/easylist.json': JSON.stringify({
        id: 'easylist',
        filterText: '||ads.example^\n||b^'
      })
    })
    const store = new RuleSetStore(io)
    const loaded = store.load()
    // The engine gets every set with its rules, as before the migration.
    expect(
      loaded.map((l) => [l.set.id, l.set.rules?.length, l.hasFilterText, l.filterCount])
    ).toEqual([
      ['easylist', undefined, true, 2],
      ['ext:abc:static:one', 2, false, 0],
      ['builtin:site-exceptions', 1, false, 0],
      ['user', undefined, false, 0]
    ])
    expect(loaded[1].set.partitions).toEqual(['default', 'work'])
    // Nothing has landed yet; the old index is whole until the documents are.
    expect(io.files.get(INDEX_FILE)).toBe(legacyIndex())
    await store.whenSettled()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('2 set document(s)'))

    // The documents came first, then the index.
    const docExt = `blocking/${documentNameFor('ext:abc:static:one')}`
    const docBuiltin = `blocking/${documentNameFor('builtin:site-exceptions')}`
    expect(io.writes).toEqual([docExt, docBuiltin, INDEX_FILE])
    expect(io.removals).toEqual([])
    expect(document(io, 'ext:abc:static:one')).toEqual({
      id: 'ext:abc:static:one',
      rules: [block(1, 'ads.example'), block(2, 'trk.example')]
    })
    const idx = index(io)
    expect(idx.version).toBe(2)
    expect(idx.sets.map((s) => [s.id, s.ruleCount, s.document])).toEqual([
      ['easylist', 0, undefined],
      ['ext:abc:static:one', 2, documentNameFor('ext:abc:static:one')],
      ['builtin:site-exceptions', 1, documentNameFor('builtin:site-exceptions')],
      ['user', 0, undefined]
    ])
    expect(idx.sets[1].tag).toBe(tagOf(io.files.get(docExt) ?? ''))
    expect(JSON.stringify(idx)).not.toContain('"rules"')
    // The text file was left as it was.
    expect(io.files.get('blocking/easylist.json')).toBe(
      JSON.stringify({ id: 'easylist', filterText: '||ads.example^\n||b^' })
    )
    expect(idx.sets[0]).toMatchObject({
      hasFilterText: true,
      filterCount: 2,
      file: 'easylist.json'
    })

    // A second load is a plain load: nothing is written, the same sets come back.
    io.writes.length = 0
    const again = new RuleSetStore(io)
    const reloaded = again.load()
    await again.whenSettled()
    expect(io.writes).toEqual([])
    expect(reloaded.map((l) => [l.set.id, l.set.rules?.length])).toEqual(
      loaded.map((l) => [l.set.id, l.set.rules?.length])
    )
    expect(reloaded[1].set.rules).toEqual(loaded[1].set.rules)
  })

  it('is idempotent: a migration cut short leaves the old index for the next start to redo', async () => {
    // The documents landed, the index did not (the process went away in between).
    const io = memoryIo({ [INDEX_FILE]: legacyIndex() })
    const cut = new RuleSetStore(io)
    cut.load()
    await Promise.all([...(cut as unknown as { inflight: Set<Promise<void>> }).inflight])
    expect(io.files.has(`blocking/${documentNameFor('ext:abc:static:one')}`)).toBe(true)
    expect(io.files.get(INDEX_FILE)).toBe(legacyIndex())

    // The next start migrates again, to the very same documents and index.
    const io2 = memoryIo({ [INDEX_FILE]: legacyIndex() })
    const first = new RuleSetStore(io2)
    first.load()
    await first.whenSettled()
    const store = new RuleSetStore(io)
    store.load()
    await store.whenSettled()
    expect([...io.files.keys()].sort()).toEqual([...io2.files.keys()].sort())
    for (const [name, text] of io2.files) expect(io.files.get(name), name).toBe(text)
  })

  it('drops a set whose document is missing, or is another set’s, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const io = memoryIo({ [INDEX_FILE]: legacyIndex() })
    const migrating = new RuleSetStore(io)
    migrating.load()
    await migrating.whenSettled()
    io.files.delete(`blocking/${documentNameFor('ext:abc:static:one')}`)
    io.files.set(
      `blocking/${documentNameFor('builtin:site-exceptions')}`,
      documentText('other', [block(1, 'x')])
    )

    const store = new RuleSetStore(io)
    const loaded = store.load()
    expect(loaded.map((l) => l.set.id)).toEqual(['easylist', 'user'])
    expect(store.ids()).toEqual(['easylist', 'user'])
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('ext:abc:static:one dropped: sets/ext_abc_static_one-'),
      expect.stringContaining('builtin:site-exceptions dropped: sets/builtin_site-exceptions-')
    ])
    expect(String(warn.mock.calls[0][0])).toContain('is missing')
    expect(String(warn.mock.calls[1][0])).toContain('is not a readable document of this set')

    // A corrupt document is dropped the same way; the index that follows no longer names any of them.
    warn.mockClear()
    io.files.set(`blocking/${documentNameFor('user')}`, '{"id":"user","rules":[')
    const raw = index(io)
    raw.sets[3] = { ...raw.sets[3], ruleCount: 1, document: documentNameFor('user'), tag: 'x' }
    io.files.set(INDEX_FILE, JSON.stringify(raw))
    const engine = new RuleEngine()
    const again = new RuleSetStore(io)
    const kept = again.load()
    again.attach(engine)
    for (const l of kept) engine.setRuleSet(l.set, { persisted: true })
    await again.whenSettled()
    expect(kept.map((l) => l.set.id)).toEqual(['easylist'])
    expect(warn).toHaveBeenCalledTimes(3)
    expect(String(warn.mock.calls[2][0])).toContain(
      'user dropped: sets/user.json is not a readable document'
    )
    expect(index(io).sets.map((s) => s.id)).toEqual(['easylist'])
  })

  it('takes the document on disk over the tag the index names, and corrects the index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const io = memoryIo({ [INDEX_FILE]: legacyIndex() })
    const migrating = new RuleSetStore(io)
    migrating.load()
    await migrating.whenSettled()
    // The document was rewritten (a later emission) but the index write never landed.
    const doc = `blocking/${documentNameFor('ext:abc:static:one')}`
    const newer = documentText('ext:abc:static:one', [
      block(1, 'ads.example'),
      block(2, 'trk.example'),
      block(3, 'new.example')
    ])
    io.files.set(doc, newer)
    io.writes.length = 0
    const store = new RuleSetStore(io)
    const loaded = store.load()
    expect(loaded[1].set.rules).toHaveLength(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not the version the index names'))
    const engine = new RuleEngine()
    store.attach(engine)
    for (const l of loaded) engine.setRuleSet(l.set, { persisted: true })
    await store.whenSettled()
    const entry = index(io).sets[1] as IndexEntry
    expect(entry.ruleCount).toBe(3)
    expect(entry.tag).toBe(tagOf(newer))
    expect(io.writes).toEqual([INDEX_FILE])
  })
})
