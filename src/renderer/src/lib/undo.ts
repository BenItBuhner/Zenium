/**
 * Deletes that can be taken back. A row swiped away disappears at once, but the command that
 * really removes it runs only after a grace period – the toast's "Undo" cancels it. The model
 * is pure over an injected clock and timer so the timing is testable; one shared instance
 * (`undoableDeletes`) outlives the panel that scheduled a delete, so closing the panel or
 * backgrounding the app never loses a decision the user already made.
 */

export const UNDO_DELAY_MS = 5000

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface UndoHandle {
  readonly token: number
  /** Put the items back; false when the delete has already gone through. */
  undo(): boolean
  /** Run the delete now instead of waiting (a second delete supersedes the first, say). */
  commit(): void
}

interface Pending {
  token: number
  keys: string[]
  commit: () => void
  handle: unknown
}

export class UndoableDeletes {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly timers: Timers = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  ) {}

  /**
   * Hide `keys` now and run `commit` after `delayMs` unless undone. Keys are opaque ids the
   * panel uses to filter its rows (`isPending`).
   */
  schedule(keys: readonly string[], commit: () => void, delayMs = UNDO_DELAY_MS): UndoHandle {
    const token = ++this.seq
    const entry: Pending = { token, keys: [...keys], commit, handle: null }
    entry.handle = this.timers.set(() => this.fire(token), delayMs)
    this.pending.set(token, entry)
    this.notify()
    return {
      token,
      undo: () => this.undo(token),
      commit: () => this.fire(token)
    }
  }

  /** Whether a key is hidden waiting for its delete to go through. */
  isPending(key: string): boolean {
    for (const entry of this.pending.values()) if (entry.keys.includes(key)) return true
    return false
  }

  /** Every key currently hidden. */
  pendingKeys(): Set<string> {
    const keys = new Set<string>()
    for (const entry of this.pending.values()) for (const key of entry.keys) keys.add(key)
    return keys
  }

  /** Run every pending delete now (the app is going to the background). */
  flush(): void {
    for (const token of [...this.pending.keys()]) this.fire(token)
  }

  /** Called whenever the set of hidden keys changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private undo(token: number): boolean {
    const entry = this.pending.get(token)
    if (!entry) return false
    this.timers.clear(entry.handle)
    this.pending.delete(token)
    this.notify()
    return true
  }

  private fire(token: number): void {
    const entry = this.pending.get(token)
    if (!entry) return
    this.timers.clear(entry.handle)
    this.pending.delete(token)
    entry.commit()
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The app-wide instance; deletes survive the panel that scheduled them. */
export const undoableDeletes = new UndoableDeletes()

// A backgrounded WebView may never come back: settle what the user already decided.
const flags = globalThis as unknown as { __zenUndoWired?: boolean }
if (!flags.__zenUndoWired && typeof document !== 'undefined') {
  flags.__zenUndoWired = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') undoableDeletes.flush()
  })
  window.addEventListener('pagehide', () => undoableDeletes.flush())
}
