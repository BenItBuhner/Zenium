/**
 * Persistence of rule sets under `blocking/` in the profile, as JSON both engines read:
 *
 * - `blocking/index.json` – every set with its structured rules inline and, instead of the
 *   filter text, `hasFilterText` plus the `file` that holds it.
 * - `blocking/<file>` – the full {@link RuleSet} of one set, filter text included.
 *
 * The store is a subscriber of the engine: `setRuleSet` writes, `removeRuleSet` deletes. Filter
 * text is written once and never kept in memory by the core; hosts that need it again (the
 * desktop text matcher at startup) read it back through {@link RuleSetStore.readFilterText}.
 */
import type { StoreIO } from '../platform'
import { JsonStore } from '../store/JsonStore'
import type { Rule, RuleSet, RuleSetAttribution, RuleSetChange, RuleSetSource } from './rules'
import type { RuleEngine } from './engine'
import { countNetworkFilters } from './lists'

export const BLOCKING_DIR = 'blocking'
export const INDEX_FILE = `${BLOCKING_DIR}/index.json`

/** One entry of `blocking/index.json`. */
export interface IndexEntry {
  id: string
  source: RuleSetSource
  priority: number
  enabled: boolean
  version?: string
  updatedAt?: number
  attribution?: RuleSetAttribution
  rules?: Rule[]
  hasFilterText: boolean
  filterCount: number
  /** File under `blocking/` with the full set (present when `hasFilterText`). */
  file?: string
}

export interface IndexFile {
  version: 1
  sets: IndexEntry[]
}

/** A set as loaded from the index: the engine gets `set`, the counts avoid re-reading the text. */
export interface LoadedSet {
  set: RuleSet
  filterCount: number
  hasFilterText: boolean
}

/** File name for a set id: safe characters kept, the rest replaced, made unique with a hash. */
export function fileNameFor(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === id) return `${id}.json`
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return `${safe}-${h.toString(16).padStart(8, '0')}.json`
}

export class RuleSetStore {
  private readonly index: JsonStore<IndexFile>
  private entries = new Map<string, IndexEntry>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly io: StoreIO) {
    this.index = new JsonStore<IndexFile>(io, INDEX_FILE, 200)
  }

  /** Read the index; sets whose text file has gone missing are reported without text. */
  load(): LoadedSet[] {
    const data = this.index.readSync()
    const out: LoadedSet[] = []
    this.entries = new Map()
    if (!data || data.version !== 1 || !Array.isArray(data.sets)) return out
    for (const raw of data.sets) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.priority !== 'number') continue
      const entry: IndexEntry = {
        id: raw.id,
        source: raw.source,
        priority: raw.priority,
        enabled: raw.enabled !== false,
        hasFilterText: raw.hasFilterText === true,
        filterCount: typeof raw.filterCount === 'number' ? raw.filterCount : 0
      }
      if (typeof raw.version === 'string') entry.version = raw.version
      if (typeof raw.updatedAt === 'number') entry.updatedAt = raw.updatedAt
      if (raw.attribution) entry.attribution = raw.attribution
      if (Array.isArray(raw.rules)) entry.rules = raw.rules
      if (typeof raw.file === 'string') entry.file = raw.file
      if (entry.hasFilterText && (!entry.file || !this.exists(`${BLOCKING_DIR}/${entry.file}`))) {
        entry.hasFilterText = false
        entry.filterCount = 0
        delete entry.file
      }
      this.entries.set(entry.id, entry)
      out.push({
        set: this.toRuleSet(entry),
        filterCount: entry.filterCount,
        hasFilterText: entry.hasFilterText
      })
    }
    return out
  }

  /** Ids in the index (whether or not the engine has them yet). */
  ids(): string[] {
    return [...this.entries.keys()]
  }

  /** The file name a set's text is (or would be) stored under, relative to the profile. */
  filePathFor(id: string): string {
    return `${BLOCKING_DIR}/${this.entries.get(id)?.file ?? fileNameFor(id)}`
  }

  private exists(name: string): boolean {
    if (this.io.exists) return this.io.exists(name)
    return this.io.readSync(name) !== null
  }

  entry(id: string): IndexEntry | undefined {
    return this.entries.get(id)
  }

  /** The filter text of a set, read from its file (null when the set has none). */
  readFilterText(id: string): string | null {
    const entry = this.entries.get(id)
    if (!entry?.hasFilterText || !entry.file) return null
    const raw = this.io.readSync(`${BLOCKING_DIR}/${entry.file}`)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as { filterText?: unknown }
      return typeof parsed.filterText === 'string' ? parsed.filterText : null
    } catch {
      return null
    }
  }

  /** Mirror every change of `engine` to disk. */
  attach(engine: RuleEngine): void {
    this.unsubscribe?.()
    this.unsubscribe = engine.subscribe((change) => this.onChange(change))
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private onChange(change: RuleSetChange): void {
    if (change.kind === 'remove') {
      const entry = this.entries.get(change.id)
      if (!entry) return
      this.entries.delete(change.id)
      if (entry.file) void this.remove(`${BLOCKING_DIR}/${entry.file}`)
      this.writeIndex()
      return
    }
    const set = change.set
    if (!set) return
    const previous = this.entries.get(set.id)
    const entry: IndexEntry = {
      id: set.id,
      source: set.source,
      priority: set.priority,
      enabled: set.enabled,
      hasFilterText: false,
      filterCount: 0
    }
    if (set.version !== undefined) entry.version = set.version
    if (set.updatedAt !== undefined) entry.updatedAt = set.updatedAt
    if (set.attribution) entry.attribution = { ...set.attribution }
    if (set.rules && set.rules.length > 0) entry.rules = set.rules
    if (change.persisted) {
      // Content already on disk (startup, a bundled snapshot the host copied in, an enable /
      // disable flip): the engine's summary says whether there is text, the file name stays.
      const summary = change.summary
      entry.hasFilterText = summary ? summary.hasFilterText : (previous?.hasFilterText ?? false)
      entry.filterCount = summary ? summary.filterCount : (previous?.filterCount ?? 0)
      if (entry.hasFilterText) entry.file = previous?.file ?? fileNameFor(set.id)
    } else if (set.filterText && set.filterText.length > 0) {
      entry.hasFilterText = true
      entry.filterCount = countNetworkFilters(set.filterText)
      entry.file = fileNameFor(set.id)
      void this.io.write(`${BLOCKING_DIR}/${entry.file}`, JSON.stringify(set))
    } else if (previous?.file) {
      void this.remove(`${BLOCKING_DIR}/${previous.file}`)
    }
    this.entries.set(set.id, entry)
    this.writeIndex()
  }

  private async remove(name: string): Promise<void> {
    if (this.io.remove) await this.io.remove(name)
    else await this.io.write(name, '{}')
  }

  private writeIndex(): void {
    this.index.write({ version: 1, sets: [...this.entries.values()] })
  }

  flush(): Promise<void> {
    return this.index.flush()
  }

  flushSync(): void {
    this.index.flushSync()
  }

  private toRuleSet(entry: IndexEntry): RuleSet {
    const set: RuleSet = {
      id: entry.id,
      source: entry.source,
      priority: entry.priority,
      enabled: entry.enabled
    }
    if (entry.rules) set.rules = entry.rules
    if (entry.version !== undefined) set.version = entry.version
    if (entry.updatedAt !== undefined) set.updatedAt = entry.updatedAt
    if (entry.attribution) set.attribution = entry.attribution
    return set
  }
}
