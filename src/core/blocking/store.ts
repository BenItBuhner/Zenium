/**
 * Persistence of rule sets under `blocking/` in the profile, as JSON both engines read:
 *
 * - `blocking/index.json` – one summary per set (`IndexEntry`): metadata, the partitions it is
 *   scoped to, how many structured rules it has and the name and version tag of the document
 *   that holds them, and – instead of the filter text – `hasFilterText` plus the `file` that
 *   holds it. Summaries only: the index stays a few kilobytes whatever the sets carry.
 * - `blocking/sets/<name>.json` – the structured rules of one set (`SetDocument`), written when
 *   the rules change and never otherwise. With uBlock Origin Lite installed this is where the
 *   megabytes live, one document per set, so a dynamic-rule update rewrites one small file.
 * - `blocking/<name>.json` – the full {@link RuleSet} of one set with its filter text.
 *
 * Every document is serialised the same way for the same state (one key order, `JSON.stringify`),
 * so a host that skips a write of the bytes it already holds (`AndroidStoreIO`) skips the index
 * rewrite of a start, and the store itself skips a set document whose tag has not changed. Set
 * documents and text files land before the index that names them (the index write waits for
 * them; a synchronous flush writes them synchronously first), so a reader that follows the index
 * never finds it ahead of the files.
 *
 * An index of the previous shape (`version: 1`, every set's rules inline) is migrated on first
 * load: the rules are split into set documents, the index is rewritten as summaries, and nothing
 * is deleted – a process that dies before the new index lands leaves the old one, whole, for the
 * next start to migrate again.
 *
 * The store is a subscriber of the engine: `setRuleSet` writes, `removeRuleSet` deletes. Filter
 * text is written once and never kept in memory by the core; hosts that need it again (the
 * desktop text matcher at startup) read it back through {@link RuleSetStore.readFilterText}.
 */
import type { StoreIO, StoreWriteOptions } from '../platform'
import { JsonStore } from '../store/JsonStore'
import type { Rule, RuleSet, RuleSetAttribution, RuleSetChange, RuleSetSource } from './rules'
import type { RuleEngine } from './engine'
import { countNetworkFilters } from './lists'

export const BLOCKING_DIR = 'blocking'
export const INDEX_FILE = `${BLOCKING_DIR}/index.json`
/** The set documents' folder, relative to the profile (`Storage.BLOCKING_SETS_DIR` on Android). */
export const SETS_DIR = `${BLOCKING_DIR}/sets`
/** The shape of `blocking/index.json` this store writes; `1` (rules inline) is read and migrated. */
export const INDEX_VERSION = 2

/** One entry of `blocking/index.json`: a set's summary, its content in the files it names. */
export interface IndexEntry {
  id: string
  source: RuleSetSource
  priority: number
  enabled: boolean
  version?: string
  updatedAt?: number
  attribution?: RuleSetAttribution
  /** Session partitions the set is scoped to (see `RuleSet.partitions`); absent: every one. */
  partitions?: string[]
  /** Structured rules in the set's document; 0 when it has none (and no document). */
  ruleCount: number
  /** Document under `blocking/` with the set's rules (`sets/<name>.json`), present when `ruleCount > 0`. */
  document?: string
  /** Version tag of the document's bytes ({@link tagOf}); present with `document`. */
  tag?: string
  hasFilterText: boolean
  filterCount: number
  /** File under `blocking/` with the full set (present when `hasFilterText`). */
  file?: string
}

export interface IndexFile {
  version: typeof INDEX_VERSION
  sets: IndexEntry[]
}

/** `blocking/sets/<name>.json`: the structured rules of one set. */
export interface SetDocument {
  id: string
  rules: Rule[]
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

/** The set document's name for a set id, relative to `blocking/` (`sets/<fileNameFor(id)>`). */
export function documentNameFor(id: string): string {
  return `sets/${fileNameFor(id)}`
}

/**
 * The version tag of a document's text: its length and two 32-bit hashes of it (FNV-1a and a
 * djb2 variant, one pass). Cheap enough for a megabyte document on every emission, and what the
 * Kotlin `IndexReader` keys an unchanged set's compiled rules by – so it must change whenever
 * the bytes do, and not otherwise.
 */
export function tagOf(text: string): string {
  let a = 2166136261
  let b = 5381
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 16777619)
    b = Math.imul(b, 33) ^ c
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
  return `${text.length.toString(16)}-${hex(a)}${hex(b)}`
}

/** The text of a set document, always in this key order. */
export function documentText(id: string, rules: readonly Rule[]): string {
  const doc: SetDocument = { id, rules: rules as Rule[] }
  return JSON.stringify(doc)
}

/** A `version: 1` entry, as the store wrote it before the set documents. */
interface LegacyEntry extends Omit<IndexEntry, 'ruleCount' | 'document' | 'tag'> {
  rules?: Rule[]
}

/** A set's metadata: an entry without its content bookkeeping. */
type Summary = Pick<
  IndexEntry,
  'id' | 'source' | 'priority' | 'enabled' | 'version' | 'updatedAt' | 'attribution' | 'partitions'
>

/** The metadata of a set, in the key order every entry is written in. */
function summaryOf(set: {
  id: string
  source: RuleSetSource
  priority: number
  enabled: boolean
  version?: string
  updatedAt?: number
  attribution?: RuleSetAttribution
  partitions?: readonly string[]
}): Summary {
  const summary: Summary = {
    id: set.id,
    source: set.source,
    priority: set.priority,
    enabled: set.enabled
  }
  if (set.version !== undefined) summary.version = set.version
  if (set.updatedAt !== undefined) summary.updatedAt = set.updatedAt
  if (set.attribution) summary.attribution = { ...set.attribution }
  if (set.partitions) summary.partitions = [...set.partitions]
  return summary
}

/** `summaryOf` plus the content bookkeeping, in the written key order. */
function entryOf(
  summary: Summary,
  rules: { ruleCount: number; document?: string; tag?: string },
  text: { hasFilterText: boolean; filterCount: number; file?: string }
): IndexEntry {
  return {
    ...summaryOf(summary),
    ruleCount: rules.ruleCount,
    ...(rules.document !== undefined ? { document: rules.document } : {}),
    ...(rules.tag !== undefined ? { tag: rules.tag } : {}),
    hasFilterText: text.hasFilterText,
    filterCount: text.filterCount,
    ...(text.file !== undefined ? { file: text.file } : {})
  }
}

export class RuleSetStore {
  private readonly index: JsonStore<IndexFile>
  private entries = new Map<string, IndexEntry>()
  private unsubscribe: (() => void) | null = null
  /** Set-document and text-file writes and removals started and not landed yet (see `whenSettled`). */
  private readonly inflight = new Set<Promise<void>>()
  /** Per document, the write or removal that must land before the next one of it starts. */
  private readonly chains = new Map<string, Promise<void>>()
  /** The text of every document write that has not landed yet, for a synchronous flush. */
  private readonly pending = new Map<string, { text: string; seq: number }>()
  private seq = 0
  /** An index write was asked for since `whenSettled` last flushed. */
  private indexDirty = false
  /** Asynchronous index writes waiting for the documents they name to land. */
  private indexWaiting = 0
  /** Synchronous index writes so far; one supersedes every asynchronous write still waiting. */
  private indexSyncWrites = 0

  constructor(private readonly io: StoreIO) {
    this.index = new JsonStore<IndexFile>(this.indexIo(), INDEX_FILE, 200)
  }

  /**
   * The index's writes go through here: an asynchronous one starts once every document write or
   * removal in flight has landed, a synchronous one (shutdown) writes them synchronously first.
   * So the index never names a document or a tag that is not on disk yet. An asynchronous write
   * that a synchronous one overtook while it waited is dropped: the index on disk is newer than
   * the one it holds, and the shutdown that wrote it waits for nothing else.
   */
  private indexIo(): StoreIO {
    return {
      readSync: (name) => this.io.readSync(name),
      write: async (name, text, options?: StoreWriteOptions) => {
        const before = this.indexSyncWrites
        this.indexWaiting++
        try {
          await Promise.all([...this.inflight])
        } finally {
          this.indexWaiting--
        }
        if (this.indexSyncWrites !== before) return
        await this.io.write(name, text, options)
      },
      writeSync: (name, text, options?: StoreWriteOptions) => {
        this.landPendingSync()
        this.indexSyncWrites++
        this.io.writeSync(name, text, options)
      }
    }
  }

  /**
   * Read the index. A set whose document is missing or is not its document is dropped with a
   * warning; one whose text file has gone missing is reported without text. An index of the
   * previous shape is migrated: its inline rules go to set documents (written now), and the
   * summaries-only index follows them.
   */
  load(): LoadedSet[] {
    const data: unknown = this.index.readSync()
    const out: LoadedSet[] = []
    this.entries = new Map()
    if (!isRecord(data) || !Array.isArray(data.sets)) return out
    const version = data.version
    if (version !== 1 && version !== INDEX_VERSION) return out
    const legacy = version === 1
    let migrated = 0
    for (const raw of data.sets as unknown[]) {
      const parsed = parseEntry(raw)
      if (!parsed) continue
      const { entry, inlineRules } = parsed
      let rules: Rule[] | undefined
      if (legacy && inlineRules && inlineRules.length > 0) {
        const text = documentText(entry.id, inlineRules)
        entry.ruleCount = inlineRules.length
        entry.document = documentNameFor(entry.id)
        entry.tag = tagOf(text)
        this.enqueue(`${BLOCKING_DIR}/${entry.document}`, text)
        rules = inlineRules
        migrated++
      } else if (!legacy && entry.document !== undefined) {
        const read = this.readDocument(entry.id, entry.document)
        if (!read) {
          const why = this.exists(`${BLOCKING_DIR}/${entry.document}`)
            ? 'is not a readable document of this set'
            : 'is missing'
          console.warn(`[zenium] blocking set ${entry.id} dropped: ${entry.document} ${why}`)
          continue
        }
        rules = read.rules
        entry.ruleCount = rules.length
        if (entry.tag !== read.tag) {
          console.warn(
            `[zenium] blocking set ${entry.id}: ${entry.document} is not the version the index names; using it`
          )
          entry.tag = read.tag
        }
      } else {
        entry.ruleCount = 0
        delete entry.document
        delete entry.tag
      }
      if (entry.hasFilterText && (!entry.file || !this.exists(`${BLOCKING_DIR}/${entry.file}`))) {
        entry.hasFilterText = false
        entry.filterCount = 0
        delete entry.file
      }
      const rebuilt = entryOf(entry, entry, entry)
      this.entries.set(rebuilt.id, rebuilt)
      out.push({
        set: this.toRuleSet(rebuilt, rules),
        filterCount: rebuilt.filterCount,
        hasFilterText: rebuilt.hasFilterText
      })
    }
    if (legacy) {
      console.info(`[zenium] blocking index migrated: ${migrated} set document(s) split out of it`)
      this.writeIndex()
    }
    return out
  }

  /** The rules of a set document, with the tag of its bytes; null when missing or not the set's. */
  private readDocument(id: string, document: string): { rules: Rule[]; tag: string } | null {
    const raw = this.io.readSync(`${BLOCKING_DIR}/${document}`)
    if (raw === null || raw === '') return null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed) || parsed.id !== id || !Array.isArray(parsed.rules)) return null
      return { rules: parsed.rules as Rule[], tag: tagOf(raw) }
    } catch {
      return null
    }
  }

  /** Ids in the index (whether or not the engine has them yet). */
  ids(): string[] {
    return [...this.entries.keys()]
  }

  /** The file name a set's text is (or would be) stored under, relative to the profile. */
  filePathFor(id: string): string {
    return `${BLOCKING_DIR}/${this.entries.get(id)?.file ?? fileNameFor(id)}`
  }

  /** The set document's path for a set id, relative to the profile. */
  documentPathFor(id: string): string {
    return `${BLOCKING_DIR}/${this.entries.get(id)?.document ?? documentNameFor(id)}`
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
      if (entry.file) this.enqueue(`${BLOCKING_DIR}/${entry.file}`, null)
      if (entry.document) this.enqueue(`${BLOCKING_DIR}/${entry.document}`, null)
      this.writeIndex()
      return
    }
    const set = change.set
    if (!set) return
    const previous = this.entries.get(set.id)
    const rules: { ruleCount: number; document?: string; tag?: string } = { ruleCount: 0 }
    const text: { hasFilterText: boolean; filterCount: number; file?: string } = {
      hasFilterText: false,
      filterCount: 0
    }
    const structured = set.rules ?? []
    if (structured.length > 0) {
      if (change.persisted && previous?.document && previous.ruleCount === structured.length) {
        // The document is on disk as it is (startup, an enable / disable flip, a re-scope):
        // its name and tag stay, and megabytes of rules are neither serialised nor hashed.
        rules.ruleCount = previous.ruleCount
        rules.document = previous.document
        rules.tag = previous.tag
      } else {
        const body = documentText(set.id, structured)
        const tag = tagOf(body)
        const document = previous?.document ?? documentNameFor(set.id)
        rules.ruleCount = structured.length
        rules.document = document
        rules.tag = tag
        // Only a set whose bytes changed is rewritten: a re-emission of the same rules is free.
        if (previous?.document !== document || previous.tag !== tag) {
          this.enqueue(`${BLOCKING_DIR}/${document}`, body)
        }
      }
    } else if (previous?.document) {
      this.enqueue(`${BLOCKING_DIR}/${previous.document}`, null)
    }
    if (change.persisted) {
      // Content already on disk (startup, a bundled snapshot the host copied in, an enable /
      // disable flip): the engine's summary says whether there is text, the file name stays.
      const summary = change.summary
      text.hasFilterText = summary ? summary.hasFilterText : (previous?.hasFilterText ?? false)
      text.filterCount = summary ? summary.filterCount : (previous?.filterCount ?? 0)
      if (text.hasFilterText) text.file = previous?.file ?? fileNameFor(set.id)
    } else if (set.filterText && set.filterText.length > 0) {
      text.hasFilterText = true
      text.filterCount = countNetworkFilters(set.filterText)
      text.file = fileNameFor(set.id)
      this.enqueue(`${BLOCKING_DIR}/${text.file}`, JSON.stringify(set))
    } else if (previous?.file) {
      this.enqueue(`${BLOCKING_DIR}/${previous.file}`, null)
    }
    this.entries.set(set.id, entryOf(summaryOf(set), rules, text))
    this.writeIndex()
  }

  /**
   * Write (`text`) or remove (`null`) a document in the background. The first one for a name
   * starts now (a host whose write lands synchronously, like the tests' and Android's mirror,
   * has the bytes before this returns); a later one for the same name starts after the earlier
   * has landed, so two quick changes of one set land in order. A failure is logged, not thrown.
   */
  private enqueue(name: string, text: string | null): void {
    const previous = this.chains.get(name)
    const seq = ++this.seq
    if (text !== null) this.pending.set(name, { text, seq })
    else this.pending.delete(name)
    const start = (): Promise<void> =>
      text !== null ? this.io.write(name, text) : this.remove(name)
    let started: Promise<void>
    if (previous) started = previous.then(start)
    else {
      try {
        started = start()
      } catch (error) {
        started = Promise.reject(error)
      }
    }
    const work: Promise<void> = started
      .catch((error: unknown) => {
        console.warn('[zenium] blocking store write failed:', error)
      })
      .finally(() => {
        if (this.pending.get(name)?.seq === seq) this.pending.delete(name)
        this.inflight.delete(work)
        if (this.chains.get(name) === work) this.chains.delete(name)
      })
    this.chains.set(name, work)
    this.inflight.add(work)
  }

  private async remove(name: string): Promise<void> {
    if (this.io.remove) await this.io.remove(name)
    else await this.io.write(name, '{}')
  }

  /**
   * Shutdown: every document write still in flight is made synchronously now, so the index that
   * follows names nothing that is not on disk. The asynchronous write of the same bytes lands
   * later, or never; either way the file holds them.
   */
  private landPendingSync(): void {
    for (const [name, { text }] of this.pending) {
      try {
        this.io.writeSync(name, text)
      } catch (error) {
        console.warn(`[zenium] blocking store could not write ${name}:`, error)
      }
    }
    this.pending.clear()
  }

  private writeIndex(): void {
    this.indexDirty = true
    this.index.write({ version: INDEX_VERSION, sets: [...this.entries.values()] })
  }

  flush(): Promise<void> {
    return this.index.flush()
  }

  /**
   * Shutdown: the documents in flight land synchronously, then the index. An index write still
   * waiting for its documents holds an older index than the entries are now, and would land
   * behind this one: the entries are written as they are, and that write is dropped.
   */
  flushSync(): void {
    this.landPendingSync()
    if (this.indexWaiting > 0) this.writeIndex()
    this.index.flushSync()
  }

  /**
   * Resolves once everything the store has been asked to write has landed: the index's pending
   * document is written now rather than after its debounce, and the documents' writes and
   * removals in flight are waited for – including what a change during the wait added.
   */
  async whenSettled(): Promise<void> {
    do {
      this.indexDirty = false
      await this.index.flush()
      await Promise.all([...this.inflight])
    } while (this.inflight.size > 0 || this.indexDirty)
  }

  private toRuleSet(entry: IndexEntry, rules: Rule[] | undefined): RuleSet {
    const set: RuleSet = {
      id: entry.id,
      source: entry.source,
      priority: entry.priority,
      enabled: entry.enabled
    }
    if (rules && rules.length > 0) set.rules = rules
    if (entry.version !== undefined) set.version = entry.version
    if (entry.updatedAt !== undefined) set.updatedAt = entry.updatedAt
    if (entry.attribution) set.attribution = entry.attribution
    if (entry.partitions) set.partitions = [...entry.partitions]
    return set
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * One raw entry of either index shape as a summary (its content bookkeeping as written; the
 * loader checks the files), plus the inline rules a `version: 1` entry carried. Null for an
 * entry that is not one (no id, no numeric priority).
 */
function parseEntry(raw: unknown): { entry: IndexEntry; inlineRules?: Rule[] } | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.priority !== 'number') return null
  const legacy = raw as unknown as LegacyEntry & Partial<IndexEntry>
  const entry: IndexEntry = {
    id: legacy.id,
    source: legacy.source,
    priority: legacy.priority,
    enabled: legacy.enabled !== false,
    ruleCount: typeof legacy.ruleCount === 'number' ? legacy.ruleCount : 0,
    hasFilterText: legacy.hasFilterText === true,
    filterCount: typeof legacy.filterCount === 'number' ? legacy.filterCount : 0
  }
  if (typeof legacy.version === 'string') entry.version = legacy.version
  if (typeof legacy.updatedAt === 'number') entry.updatedAt = legacy.updatedAt
  if (legacy.attribution) entry.attribution = legacy.attribution
  if (Array.isArray(legacy.partitions)) {
    entry.partitions = legacy.partitions.filter((p): p is string => typeof p === 'string')
  }
  if (typeof legacy.document === 'string' && legacy.document.length > 0)
    entry.document = legacy.document
  if (typeof legacy.tag === 'string') entry.tag = legacy.tag
  if (typeof legacy.file === 'string') entry.file = legacy.file
  const inlineRules = Array.isArray(legacy.rules) ? legacy.rules : undefined
  return inlineRules ? { entry, inlineRules } : { entry }
}
