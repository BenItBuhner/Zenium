import type { TranslateModelInfo } from '../../shared/translate'
import type { LanguagePair, ModelFiles } from '../../shared/translateEngine'
import type { TranslateModelStore } from '../platform'
import { pairKey, type ModelFile, type ModelRecord, type ModelRegistry } from './registry'

/** Progress of a model download: bytes so far out of the record's total. */
export type DownloadProgress = (received: number, total: number) => void

/**
 * `<from>_<to>_<version>_<type>.<ext>`: everything the manager needs to recognise an installed
 * model comes from the file name, so a directory listing is the whole inventory.
 */
export function modelFileName(record: ModelRecord, file: ModelFile): string {
  const ext =
    file.type === 'model' || file.type === 'lex' || file.type === 'qualityModel' ? 'bin' : 'spm'
  return `${record.from}_${record.to}_${record.version}_${file.type}.${ext}`
}

export interface ParsedModelFileName {
  from: string
  to: string
  version: string
  type: string
}

export function parseModelFileName(name: string): ParsedModelFileName | null {
  const match = /^([^_]+)_([^_]+)_([^_]+)_([a-zA-Z]+)\.(bin|spm)$/.exec(name)
  if (!match) return null
  return { from: match[1], to: match[2], version: match[3], type: match[4] }
}

/**
 * Keeps the registry's models on the device: knows which are installed, downloads the missing
 * ones with progress and integrity checks, and removes them again. One download per pair at a
 * time; concurrent callers share it.
 */
export class ModelManager {
  private files = new Map<string, number>()
  private listed = false
  private readonly downloads = new Map<string, Promise<void>>()

  constructor(
    readonly registry: ModelRegistry,
    private readonly store: TranslateModelStore
  ) {}

  /** Read the store's inventory (once, then after every change). */
  async refresh(): Promise<void> {
    const entries = await this.store.list()
    this.files = new Map(entries.map((entry) => [entry.name, entry.size]))
    this.listed = true
  }

  private async ensureListed(): Promise<void> {
    if (!this.listed) await this.refresh()
  }

  /** Whether every file of `record` is present with the size the registry states. */
  isInstalled(record: ModelRecord): boolean {
    return record.files.every((file) => this.files.get(modelFileName(record, file)) === file.size)
  }

  /** Registry records whose files are all on the device. */
  installed(): ModelRecord[] {
    return this.registry.all().filter((record) => this.isInstalled(record))
  }

  /** Bytes of every stored file, including leftovers of superseded versions. */
  totalBytes(): number {
    let sum = 0
    for (const size of this.files.values()) sum += size
    return sum
  }

  /** Every pair the registry offers, flagged with whether it is on the device. */
  info(): TranslateModelInfo[] {
    return this.registry.all().map((record) => ({
      from: record.from,
      to: record.to,
      version: record.version,
      bytes: record.bytes,
      installed: this.isInstalled(record)
    }))
  }

  /** Total bytes the models of `route` that are not installed yet would download. */
  bytesToDownload(route: LanguagePair[]): number {
    let sum = 0
    for (const pair of route) {
      const record = this.registry.find(pair)
      if (record && !this.isInstalled(record)) sum += record.bytes
    }
    return sum
  }

  /**
   * Make sure the model for `pair` is on the device, downloading what is missing. Progress counts
   * bytes across the record's files; a failure removes the partial results.
   */
  async ensure(
    pair: LanguagePair,
    onProgress?: DownloadProgress,
    signal?: AbortSignal
  ): Promise<void> {
    await this.ensureListed()
    const record = this.registry.find(pair)
    if (!record) throw new Error(`no translation model for ${pair.from} to ${pair.to}`)
    if (this.isInstalled(record)) return
    const key = pairKey(pair)
    let running = this.downloads.get(key)
    if (!running) {
      running = this.download(record, onProgress, signal).finally(() => this.downloads.delete(key))
      this.downloads.set(key, running)
    }
    await running
  }

  private async download(
    record: ModelRecord,
    onProgress: DownloadProgress | undefined,
    signal: AbortSignal | undefined
  ): Promise<void> {
    let done = 0
    const written: string[] = []
    try {
      for (const file of record.files) {
        const name = modelFileName(record, file)
        if (this.files.get(name) === file.size) {
          done += file.size
          onProgress?.(done, record.bytes)
          continue
        }
        await this.store.download(
          { url: file.url, name, size: file.size, sha256: file.sha256 },
          (received) => onProgress?.(Math.min(done + received, record.bytes), record.bytes),
          signal
        )
        written.push(name)
        this.files.set(name, file.size)
        done += file.size
        onProgress?.(done, record.bytes)
      }
    } catch (error) {
      if (written.length > 0) {
        await this.store.delete(written).catch(() => undefined)
        for (const name of written) this.files.delete(name)
      }
      throw error
    }
  }

  /** The stored files of an installed model, as the engine worker takes them. */
  async files_(pair: LanguagePair): Promise<ModelFiles> {
    const record = this.registry.find(pair)
    if (!record || !this.isInstalled(record))
      throw new Error(`model ${pair.from}-${pair.to} is not installed`)
    const byType = new Map<string, Promise<ModelFiles['model']>>()
    for (const file of record.files)
      byType.set(file.type, this.store.source(modelFileName(record, file)))
    const model = byType.get('model')
    const lex = byType.get('lex')
    if (!model || !lex) throw new Error(`model ${pair.from}-${pair.to} is incomplete`)
    const vocabKeys = byType.has('vocab') ? ['vocab'] : ['srcvocab', 'trgvocab']
    const vocabs = await Promise.all(
      vocabKeys.map((type) => {
        const source = byType.get(type)
        if (!source) throw new Error(`model ${pair.from}-${pair.to} lacks its ${type}`)
        return source
      })
    )
    return { model: await model, lex: await lex, vocabs }
  }

  /** Delete a model's files (whatever version is stored for the pair). */
  async remove(pair: LanguagePair): Promise<void> {
    await this.ensureListed()
    const names = [...this.files.keys()].filter((name) => {
      const parsed = parseModelFileName(name)
      return parsed !== null && parsed.from === pair.from && parsed.to === pair.to
    })
    if (names.length === 0) return
    await this.store.delete(names)
    for (const name of names) this.files.delete(name)
  }

  /** Files that belong to no current registry record (older versions, aborted downloads). */
  stale(): string[] {
    const current = new Set<string>()
    for (const record of this.registry.all())
      for (const file of record.files) current.add(modelFileName(record, file))
    return [...this.files.keys()].filter((name) => !current.has(name))
  }

  /** Remove `stale()` files; the registry moved on and the engine will not load them again. */
  async prune(): Promise<string[]> {
    await this.ensureListed()
    const names = this.stale()
    if (names.length > 0) {
      await this.store.delete(names)
      for (const name of names) this.files.delete(name)
    }
    return names
  }
}
