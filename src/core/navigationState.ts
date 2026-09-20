import type { ClosedEntry, ClosedTabEntry, NavigationSnapshot } from '../shared/types'
import type { StoreIO } from './platform'
import { isKeepableHostState } from './session'

/**
 * The host-state sidecar of the back/forward stacks.
 *
 * A stack's `hostState` (Android's `WebView.saveState` bundle, base64, up to 64 KB) is the one
 * part of a `NavigationSnapshot` that does not belong in `state.json`: that document is rewritten
 * on every commit, twice (`state.json.bak`), and on Android it is the boot payload. So the blobs
 * live here, one document per tab – `navigation/<tabId>.json` – written on a timer of their own,
 * and `state.json` carries the stacks without them (`BrowserState.toPersisted` strips the field).
 * In memory nothing changes: `BrowserState.tabNavigation`, `TabManager.pendingNavigation` and the
 * recently-closed entries keep whole snapshots, so within a run a restore never comes here.
 *
 * A document names the list it describes by a fingerprint of the entry URLs and the index
 * (`navigationListFingerprint`): the blob goes back only onto that very list. A tab whose
 * snapshot has no blob – every desktop tab, a private tab, a truncated list – has no document,
 * and one it had is removed. There is no backup: a lost or corrupt blob is the URL fallback,
 * nothing worse. `StoreIO` cannot list a folder, so `navigation/index.json` keeps the ids that
 * have a document, for the sweep at load (`load`).
 */

/** The dirty set is written this long after its first change (one timer, not one per tab). */
export const NAVIGATION_STATE_WRITE_DELAY_MS = 3000

export const NAVIGATION_STATE_VERSION = 1

export const NAVIGATION_STATE_FOLDER = 'navigation'

/** The ids that have a document, so the load sweep can find orphans (`StoreIO` cannot list). */
export const NAVIGATION_STATE_INDEX = `${NAVIGATION_STATE_FOLDER}/index.json`

/** `navigation/<tabId>.json`. */
export interface NavigationStateDocument {
  version: typeof NAVIGATION_STATE_VERSION
  /** `navigationListFingerprint` of the stack the blob describes. */
  list: string
  hostState: string
}

export interface NavigationStateIndex {
  version: typeof NAVIGATION_STATE_VERSION
  ids: string[]
}

/** The stack a tab's document is to describe right now: the open tab's, a closed entry's, or none. */
export type NavigationResolver = (tabId: string) => NavigationSnapshot | null | undefined

export function navigationDocumentName(tabId: string): string {
  return `${NAVIGATION_STATE_FOLDER}/${tabId}.json`
}

/** Tab ids are `tab_<uuid>`; anything else (a corrupt document's) never becomes a file name. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id)
}

/** cyrb53 (bryc, public domain): a fast 53-bit non-cryptographic hash. */
function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * The name of a list: a short hex hash over the entry URLs in order and the current index
 * (length-prefixed, so two lists never read the same). Titles and page state are not part of
 * it – they change under a list the blob still describes.
 */
export function navigationListFingerprint(
  snapshot: Pick<NavigationSnapshot, 'entries' | 'index'>
): string {
  let text = String(snapshot.index)
  for (const entry of snapshot.entries) text += `\n${entry.url.length}:${entry.url}`
  return cyrb53(text).toString(16)
}

/** The snapshot as `state.json` carries it: without the blob (the same object when it has none). */
export function withoutHostState(snapshot: NavigationSnapshot): NavigationSnapshot
export function withoutHostState(snapshot: NavigationSnapshot | null): NavigationSnapshot | null
export function withoutHostState(snapshot: NavigationSnapshot | null): NavigationSnapshot | null {
  if (!snapshot || snapshot.hostState === undefined) return snapshot
  const copy = { ...snapshot }
  delete copy.hostState
  return copy
}

/** The closed entries as `state.json` carries them: every tab's stack without its blob. */
export function withoutClosedHostState(entries: ClosedEntry[]): ClosedEntry[] {
  let out: ClosedEntry[] | null = null
  for (let i = 0; i < entries.length; i++) {
    const stripped = withoutClosedEntryHostState(entries[i])
    if (stripped === entries[i]) continue
    out ??= [...entries]
    out[i] = stripped
  }
  return out ?? entries
}

function withoutClosedEntryHostState(entry: ClosedEntry): ClosedEntry {
  if (entry.kind === 'tab') {
    const navigation = withoutHostState(entry.navigation)
    return navigation === entry.navigation ? entry : { ...entry, navigation }
  }
  let tabs: ClosedTabEntry[] | null = null
  for (let i = 0; i < entry.tabs.length; i++) {
    const t = entry.tabs[i]
    const navigation = withoutHostState(t.navigation)
    if (navigation === t.navigation) continue
    tabs ??= [...entry.tabs]
    tabs[i] = { ...t, navigation }
  }
  return tabs ? { ...entry, tabs } : entry
}

/** The ids of the tabs the closed entries hold (a window entry's tabs included). */
export function closedTabIds(entries: Iterable<ClosedEntry>): string[] {
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'tab') ids.push(entry.tab.id)
    else for (const t of entry.tabs) ids.push(t.tab.id)
  }
  return ids
}

/** The stack the recently-closed list holds for `tabId`, or null when no entry has the tab. */
export function closedNavigationOf(
  entries: Iterable<ClosedEntry>,
  tabId: string
): NavigationSnapshot | null {
  for (const entry of entries) {
    if (entry.kind === 'tab') {
      if (entry.tab.id === tabId) return entry.navigation
    } else {
      for (const t of entry.tabs) if (t.tab.id === tabId) return t.navigation
    }
  }
  return null
}

/** One write (`text`) or removal (`null`) of a document; `id` is the tab's, null for the index. */
interface Op {
  id: string | null
  name: string
  text: string | null
}

export class NavigationStateStore {
  /** Tabs whose document may be out of date; resolved when the timer fires. */
  private readonly dirty = new Set<string>()
  /** The `(list, hostState)` pair each document holds, so the same pair is not written twice. */
  private readonly written = new Map<string, { list: string; hostState: string }>()
  /** Ids that have a document, as far as this run knows (the index at load, then every write). */
  private readonly ids = new Set<string>()
  /** The ids the index on disk lists (sorted, joined); `null` once a write of it failed. */
  private indexOnDisk: string | null = ''
  /** Tabs whose document was asked for this run: the join happens once per tab. */
  private readonly joined = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private frozen = false
  /** The asynchronous writes and removals, in order. */
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly io: StoreIO,
    private readonly resolve: NavigationResolver,
    private readonly delayMs: number = NAVIGATION_STATE_WRITE_DELAY_MS
  ) {}

  /**
   * Once at load, after `state.json` was read: take the index in and remove the documents of
   * ids that `referenced` (the open tabs with a stack and the recently-closed tabs) does not
   * name. Documents themselves are not read here – one at a time, when a tab is restored
   * (`hostStateFor`). A missing or corrupt index means nothing to sweep.
   */
  load(referenced: ReadonlySet<string>): void {
    this.ids.clear()
    this.written.clear()
    this.joined.clear()
    this.dirty.clear()
    const listed = this.readIndex()
    if (listed === null) {
      this.indexOnDisk = ''
      return
    }
    // An index with entries that are not ids is rewritten at the next fire.
    this.indexOnDisk = listed.clean ? indexKey(listed.ids) : null
    const orphans: Op[] = []
    for (const id of listed.ids) {
      if (referenced.has(id)) this.ids.add(id)
      else orphans.push({ id, name: navigationDocumentName(id), text: null })
    }
    if (orphans.length > 0) this.run(orphans)
    // The index shrinks by the swept ids at the next fire.
    if (orphans.length > 0 || !listed.clean) this.schedule()
  }

  /**
   * The stack of `tabId` changed hands or content: its document is brought up to date at the
   * next fire – written when the resolved snapshot carries a blob and the pair is new, removed
   * when the snapshot has none (or there is no snapshot: the tab is gone and no closed entry
   * holds its id).
   */
  touch(tabId: string): void {
    if (this.frozen) return
    this.dirty.add(tabId)
    this.schedule()
  }

  /**
   * The blob for a stack about to be replayed without one, from the tab's document – when the
   * document describes this very list. Read once per tab per run; a missing or corrupt document
   * or another list's blob gives nothing, and the host loads the current entry as it does today.
   */
  hostStateFor(
    tabId: string,
    snapshot: Pick<NavigationSnapshot, 'entries' | 'index'>
  ): string | undefined {
    if (this.joined.has(tabId) || !isSafeId(tabId)) return undefined
    this.joined.add(tabId)
    const doc = this.readDocument(tabId)
    if (doc === null) return undefined
    // Whatever the index said, there is a document: a later removal must know.
    this.ids.add(tabId)
    this.written.set(tabId, { list: doc.list, hostState: doc.hostState })
    return doc.list === navigationListFingerprint(snapshot) ? doc.hostState : undefined
  }

  /** Write the dirty set now; resolves once the documents have landed. */
  async flush(): Promise<void> {
    if (this.frozen) return
    this.cancelTimer()
    this.run(this.plan())
    await this.chain
  }

  /**
   * Shutdown: the dirty set's documents are written synchronously. A removal has no synchronous
   * form (`StoreIO.remove`); it goes asynchronously, and a document it did not reach is caught by
   * the sweep of the next load or by the fingerprint check.
   */
  flushSync(): void {
    if (this.frozen) return
    this.cancelTimer()
    for (const op of this.plan()) {
      if (op.text === null) this.run([op])
      else this.writeSync(op)
    }
  }

  /** Nothing is written from here on (the profile is frozen after the final write of a quit). */
  freeze(): void {
    this.frozen = true
    this.cancelTimer()
    this.dirty.clear()
  }

  private schedule(): void {
    if (this.timer !== null || this.frozen) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.run(this.plan())
    }, this.delayMs)
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Turn the dirty set into the writes and removals that bring the folder up to date; the index
   * goes first, so a crash between the two leaves at worst an index entry without a document
   * (harmless) rather than a document the sweep never hears of.
   */
  private plan(): Op[] {
    const ops: Op[] = []
    for (const id of this.dirty) {
      if (!isSafeId(id)) continue
      const snapshot = this.resolve(id)
      const hostState = snapshot?.hostState
      if (!snapshot || !isKeepableHostState(hostState)) {
        this.written.delete(id)
        if (this.ids.delete(id)) ops.push({ id, name: navigationDocumentName(id), text: null })
        continue
      }
      const list = navigationListFingerprint(snapshot)
      const last = this.written.get(id)
      if (last && last.list === list && last.hostState === hostState) continue
      this.written.set(id, { list, hostState })
      this.ids.add(id)
      const doc: NavigationStateDocument = { version: NAVIGATION_STATE_VERSION, list, hostState }
      ops.push({ id, name: navigationDocumentName(id), text: JSON.stringify(doc) })
    }
    this.dirty.clear()
    const index = this.indexText()
    if (index !== null) ops.unshift({ id: null, name: NAVIGATION_STATE_INDEX, text: index })
    return ops
  }

  /** The index document when the id set differs from what is on disk, else null. */
  private indexText(): string | null {
    const ids = [...this.ids].sort()
    const key = ids.join('\n')
    if (key === this.indexOnDisk) return null
    this.indexOnDisk = key
    const index: NavigationStateIndex = { version: NAVIGATION_STATE_VERSION, ids }
    return JSON.stringify(index)
  }

  private run(ops: Op[]): void {
    for (const op of ops) {
      this.chain = this.chain
        .then(() => this.apply(op))
        .catch((error: unknown) => {
          this.failed(op, error)
        })
    }
  }

  private async apply(op: Op): Promise<void> {
    if (op.text !== null) {
      await this.io.write(op.name, op.text)
    } else if (this.io.remove) {
      await this.io.remove(op.name)
    } else {
      // Hosts without `remove` get the tombstone convention: not a document, so never joined.
      await this.io.write(op.name, '{}')
    }
  }

  private writeSync(op: Op): void {
    if (op.text === null) return
    try {
      this.io.writeSync(op.name, op.text)
    } catch (error) {
      this.failed(op, error)
    }
  }

  /** Forget what a failed operation would have made true, so the next fire tries again. */
  private failed(op: Op, error: unknown): void {
    console.warn(`[zenium] navigation state: could not update ${op.name}:`, error)
    if (op.id === null) {
      this.indexOnDisk = null
      return
    }
    this.written.delete(op.id)
    // A document that would not go stays listed, for the sweep of a later load.
    if (op.text === null) this.ids.add(op.id)
    this.indexOnDisk = null
  }

  /** The ids the index lists; `clean` when every entry was an id and none twice. */
  private readIndex(): { ids: string[]; clean: boolean } | null {
    const raw = this.parse(NAVIGATION_STATE_INDEX) as Partial<NavigationStateIndex> | null
    if (!raw || raw.version !== NAVIGATION_STATE_VERSION || !Array.isArray(raw.ids)) return null
    const ids = new Set<string>()
    for (const id of raw.ids) if (typeof id === 'string' && isSafeId(id)) ids.add(id)
    return { ids: [...ids], clean: ids.size === raw.ids.length }
  }

  private readDocument(tabId: string): NavigationStateDocument | null {
    const raw = this.parse(navigationDocumentName(tabId)) as Partial<NavigationStateDocument> | null
    if (!raw || raw.version !== NAVIGATION_STATE_VERSION) return null
    if (typeof raw.list !== 'string' || !isKeepableHostState(raw.hostState)) return null
    return { version: NAVIGATION_STATE_VERSION, list: raw.list, hostState: raw.hostState }
  }

  private parse(name: string): unknown {
    try {
      const text = this.io.readSync(name)
      if (text === null || text === '') return null
      return JSON.parse(text) as unknown
    } catch (error) {
      console.warn(`[zenium] navigation state: could not read ${name}:`, error)
      return null
    }
  }
}

function indexKey(ids: readonly string[]): string {
  return [...ids].sort().join('\n')
}
