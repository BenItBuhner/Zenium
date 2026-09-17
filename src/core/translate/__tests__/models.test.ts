import { describe, expect, it } from 'vitest'
import type { TranslateModelDownload, TranslateModelStore } from '../../platform'
import type { ByteSource } from '../../../shared/translateEngine'
import { ModelManager, modelFileName, parseModelFileName } from '../models'
import { ModelRegistry } from '../registry'
import type { PackedModel } from '../registryTypes'

const PACKED: PackedModel[] = [
  {
    f: 'es',
    o: 'en',
    v: '1.0',
    x: [
      { t: 'model', s: 10, h: 'a'.repeat(64), l: 'esen/1.0/model.bin' },
      { t: 'lex', s: 20, h: 'b'.repeat(64), l: 'esen/1.0/lex.bin' },
      { t: 'vocab', s: 30, h: 'c'.repeat(64), l: 'esen/1.0/vocab.spm' }
    ]
  },
  {
    f: 'en',
    o: 'de',
    v: '1.0',
    x: [
      { t: 'model', s: 10, h: 'a'.repeat(64), l: 'ende/1.0/model.bin' },
      { t: 'lex', s: 20, h: 'b'.repeat(64), l: 'ende/1.0/lex.bin' },
      { t: 'srcvocab', s: 5, h: 'c'.repeat(64), l: 'ende/1.0/src.spm' },
      { t: 'trgvocab', s: 5, h: 'd'.repeat(64), l: 'ende/1.0/trg.spm' }
    ]
  }
]

/** An in-memory store that can be told to fail or stall a download. */
class MemoryStore implements TranslateModelStore {
  files = new Map<string, number>()
  downloads: string[] = []
  deleted: string[] = []
  failAt: string | null = null
  gate: Promise<void> | null = null

  async list(): Promise<{ name: string; size: number }[]> {
    return [...this.files].map(([name, size]) => ({ name, size }))
  }

  async download(
    file: TranslateModelDownload,
    onProgress: (received: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    this.downloads.push(file.name)
    if (this.gate) await this.gate
    if (signal?.aborted) {
      const error = new Error('cancelled')
      error.name = 'AbortError'
      throw error
    }
    if (this.failAt === file.name) throw new Error('checksum mismatch')
    onProgress(Math.floor(file.size / 2))
    onProgress(file.size)
    this.files.set(file.name, file.size)
  }

  async delete(names: string[]): Promise<void> {
    for (const name of names) {
      this.deleted.push(name)
      this.files.delete(name)
    }
  }

  async source(name: string): Promise<ByteSource> {
    return `store://${name}`
  }
}

describe('model file names', () => {
  it('round-trip through the registry record', () => {
    const registry = new ModelRegistry(PACKED)
    const record = registry.find({ from: 'es', to: 'en' })!
    const names = record.files.map((file) => modelFileName(record, file))
    expect(names).toEqual(['es_en_1.0_model.bin', 'es_en_1.0_lex.bin', 'es_en_1.0_vocab.spm'])
    expect(parseModelFileName(names[2])).toEqual({
      from: 'es',
      to: 'en',
      version: '1.0',
      type: 'vocab'
    })
    expect(parseModelFileName('zh-Hans_en_1.0_model.bin')?.from).toBe('zh-Hans')
    expect(parseModelFileName('random.txt')).toBeNull()
    expect(parseModelFileName('es_en_1.0_model.bin.part')).toBeNull()
  })
})

describe('ModelManager', () => {
  it('downloads the missing files of a pair with progress and reports it installed', async () => {
    const store = new MemoryStore()
    const manager = new ModelManager(new ModelRegistry(PACKED), store)
    await manager.refresh()
    const pair = { from: 'es', to: 'en' }
    expect(manager.isInstalled(manager.registry.find(pair)!)).toBe(false)
    expect(manager.bytesToDownload([pair])).toBe(60)
    const progress: number[] = []
    await manager.ensure(pair, (received, total) => progress.push(received * 1000 + total))
    expect(store.downloads).toEqual([
      'es_en_1.0_model.bin',
      'es_en_1.0_lex.bin',
      'es_en_1.0_vocab.spm'
    ])
    expect(progress.at(-1)).toBe(60 * 1000 + 60)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(manager.isInstalled(manager.registry.find(pair)!)).toBe(true)
    expect(manager.bytesToDownload([pair])).toBe(0)
    expect(manager.installed().map((m) => `${m.from}-${m.to}`)).toEqual(['es-en'])
    expect(manager.info().find((m) => m.from === 'en')?.installed).toBe(false)
    expect(manager.totalBytes()).toBe(60)
    // Already installed: nothing is fetched again.
    await manager.ensure(pair)
    expect(store.downloads).toHaveLength(3)
  })

  it('skips files that are already there and resumes a half-installed pair', async () => {
    const store = new MemoryStore()
    store.files.set('es_en_1.0_model.bin', 10)
    const manager = new ModelManager(new ModelRegistry(PACKED), store)
    await manager.ensure({ from: 'es', to: 'en' })
    expect(store.downloads).toEqual(['es_en_1.0_lex.bin', 'es_en_1.0_vocab.spm'])
  })

  it('shares one download between concurrent callers', async () => {
    const store = new MemoryStore()
    let open!: () => void
    store.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const manager = new ModelManager(new ModelRegistry(PACKED), store)
    const pair = { from: 'es', to: 'en' }
    const first = manager.ensure(pair)
    const second = manager.ensure(pair)
    await Promise.resolve()
    open()
    await Promise.all([first, second])
    expect(store.downloads).toEqual([
      'es_en_1.0_model.bin',
      'es_en_1.0_lex.bin',
      'es_en_1.0_vocab.spm'
    ])
  })

  it('removes what it wrote when a later file fails', async () => {
    const store = new MemoryStore()
    store.failAt = 'es_en_1.0_vocab.spm'
    const manager = new ModelManager(new ModelRegistry(PACKED), store)
    await expect(manager.ensure({ from: 'es', to: 'en' })).rejects.toThrow('checksum mismatch')
    expect(store.deleted).toEqual(['es_en_1.0_model.bin', 'es_en_1.0_lex.bin'])
    expect(store.files.size).toBe(0)
    expect(manager.installed()).toEqual([])
  })

  it('aborts on request', async () => {
    const store = new MemoryStore()
    const manager = new ModelManager(new ModelRegistry(PACKED), store)
    const controller = new AbortController()
    controller.abort()
    await expect(
      manager.ensure({ from: 'es', to: 'en' }, undefined, controller.signal)
    ).rejects.toThrow('cancelled')
    expect(store.files.size).toBe(0)
  })

  it('hands the engine the stored files, with split vocabularies in source-target order', async () => {
    const store = new MemoryStore()
    const manager = new ModelManager(new ModelRegistry(PACKED), store)
    await manager.ensure({ from: 'en', to: 'de' })
    const files = await manager.files_({ from: 'en', to: 'de' })
    expect(files).toEqual({
      model: 'store://en_de_1.0_model.bin',
      lex: 'store://en_de_1.0_lex.bin',
      vocabs: ['store://en_de_1.0_srcvocab.spm', 'store://en_de_1.0_trgvocab.spm']
    })
    await expect(manager.files_({ from: 'es', to: 'en' })).rejects.toThrow('not installed')
  })

  it('removes a pair and prunes files the registry no longer lists', async () => {
    const store = new MemoryStore()
    store.files.set('es_en_0.9_model.bin', 10)
    store.files.set('es_en_0.9_lex.bin', 20)
    store.files.set('es_en_0.9_vocab.spm', 30)
    store.files.set('fr_en_1.0_model.bin', 10)
    const manager = new ModelManager(new ModelRegistry(PACKED), store)
    await manager.ensure({ from: 'es', to: 'en' })
    expect(manager.stale().sort()).toEqual([
      'es_en_0.9_lex.bin',
      'es_en_0.9_model.bin',
      'es_en_0.9_vocab.spm',
      'fr_en_1.0_model.bin'
    ])
    const pruned = await manager.prune()
    expect(pruned).toHaveLength(4)
    expect(manager.installed().map((m) => m.from)).toEqual(['es'])
    await manager.remove({ from: 'es', to: 'en' })
    expect(manager.installed()).toEqual([])
    expect(store.files.size).toBe(0)
    await expect(manager.ensure({ from: 'xx', to: 'en' })).rejects.toThrow('no translation model')
  })
})
