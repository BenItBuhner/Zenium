import { INDEX_FILE } from '@core/blocking/store'
import type { StoreIO, StoreWriteOptions } from '@core/platform'
import type { Bridge } from './bridge'

/**
 * Documents cross the bridge in pieces of this many characters. One bridge call carrying a
 * document whole has Kotlin hold several copies of the text at once (the call's JSON, the
 * tokenizer's buffer, the parsed value; for a read, the text and its JSON-quoted answer); a
 * filter-list extension's `chrome.storage` runs to tens of megabytes, past the debug heap. A
 * piece is sent once the one before it has landed, so one piece (and its copies) is on the Java
 * heap at a time. The host's `storage.read` answers a document up to this size whole (one call,
 * as ever) and a bigger one as `{ token }`, read in pieces from there (`Storage.INLINE_READ_BYTES`).
 */
export const CHUNK_CHARS = 1 << 20

/** The host's answer to `storage.read`: the text, nothing, or a document to be read in pieces. */
type ReadAnswer = string | { token: number } | null | undefined

/**
 * One document read through the bridge, whatever its size: the text, or `null` when the host has
 * none (or the read failed midway – a document torn in half is not a document). The pre-handoff
 * path, for the store and for the boot's fallback (`handoff.ts`) alike.
 */
export function readDocument(bridge: Bridge, name: string): string | null {
  const answer = bridge.callSync<ReadAnswer>('storage.read', { name })
  if (typeof answer === 'string') return answer
  if (!answer || typeof answer !== 'object' || typeof answer.token !== 'number') return null
  const { token } = answer
  const parts: string[] = []
  for (;;) {
    const chunk = bridge.callSync<string | null | undefined>('storage.readChunk', {
      token,
      maxChars: CHUNK_CHARS
    })
    // null: the end, the reader closed. Anything else: the read failed midway.
    if (chunk === null) return parts.join('')
    if (typeof chunk !== 'string') {
      bridge.callSync('storage.readEnd', { token })
      return null
    }
    parts.push(chunk)
  }
}

/**
 * The root documents (and the rule-set index) arrive with the boot payload and are mirrored in
 * memory; documents in a folder – the filter lists' text under `blocking/`, the extensions'
 * storage under `ext-storage/`, megabytes each – stay on disk and are read through the bridge
 * when asked for, in pieces past {@link CHUNK_CHARS}.
 *
 * Two things keep the boot path to one transfer per document (`BootHandoff.kt`, `handoff.ts`):
 *
 *  - Documents the payload deferred for their size come in by file ({@link adopt}) before the
 *    core starts, and the core's synchronous read at start finds them here, once: a folder
 *    document (a Safe Browsing feed's prefix table) is handed over and let go of, so the chrome
 *    does not hold a second copy of the megabytes the service keeps. A Safe Browsing document is
 *    never mirrored, whatever its size: a feed that arrives small and grows with its first
 *    refresh would otherwise park its whole text here for the rest of the process.
 *  - A write of the very bytes the mirror already holds goes nowhere. The engine writes its index
 *    back at start (every set it loaded is set again) with the text it was booted with; sending
 *    it through the bridge had the Kotlin host rewrite the file and rebuild its request engine
 *    from it – the same bytes, a third time. The mirror follows a write once the host has
 *    landed it, so a write the host could not make (the promise rejects) is not remembered as
 *    made, and a retry of the same bytes goes through.
 *
 * The mirror is a cache of the disk, never the other way round: a document the payload listed
 * as deferred and that the core reads before its file has arrived ({@link adopt} not yet called)
 * is read through the bridge – the pre-handoff path – rather than reported absent, and a root
 * name the payload did not carry at all (`state.json.bak`, kept by the host for the stores that
 * ask for a backup) is asked of the host too. A document is absent only when the host says so.
 */
export class AndroidStoreIO implements StoreIO {
  /** Deferred folder documents, held until the core reads them. */
  private readonly handed = new Map<string, string>()
  /** Deferred documents the payload announced and that have not arrived yet (`adopt`). */
  private readonly pending: Set<string>
  /** Deferred documents the core read through the bridge before they arrived: `adopt` leaves them be. */
  private readonly served = new Set<string>()

  constructor(
    private readonly bridge: Bridge,
    private readonly files: Record<string, string>,
    deferred: ReadonlyArray<{ name: string }> = []
  ) {
    this.pending = new Set(deferred.map((doc) => doc.name))
    // A folder document the payload inlined (a Safe Browsing feed still small) is handed to its
    // service like a deferred one, not mirrored.
    for (const name of Object.keys(files)) {
      if (!this.mirrored(name)) {
        this.handed.set(name, files[name])
        delete files[name]
      }
    }
  }

  /**
   * Root documents and the rule-set index live in the mirror; every other document stays on
   * disk. So does a backup (`state.json.bak`): the host rotates it under a write of its document,
   * which the mirror would not see, and the core reads it once, when the document is gone.
   */
  private mirrored(name: string): boolean {
    if (name.endsWith('.bak')) return false
    return !name.includes('/') || name === INDEX_FILE
  }

  /**
   * The documents the boot payload deferred, fetched (`fetchDeferredDocuments`); before the core
   * starts. One the core already read through the bridge, or wrote, keeps what the core has:
   * the fetched copy may predate that write.
   */
  adopt(documents: Record<string, string>): void {
    for (const [name, text] of Object.entries(documents)) {
      this.pending.delete(name)
      if (this.served.has(name) || name in this.files || this.handed.has(name)) continue
      if (this.mirrored(name)) this.files[name] = text
      else this.handed.set(name, text)
    }
  }

  readSync(name: string): string | null {
    const cached = this.files[name]
    if (cached !== undefined) return cached
    const handed = this.handed.get(name)
    if (handed !== undefined) {
      this.handed.delete(name)
      return handed
    }
    if (this.pending.has(name)) {
      // Read before its file arrived: the pre-handoff path, and the fetched copy is not wanted.
      this.pending.delete(name)
      this.served.add(name)
    }
    const text = readDocument(this.bridge, name)
    if (text !== null && this.mirrored(name)) this.files[name] = text
    return text
  }

  exists(name: string): boolean {
    if (name in this.files || this.handed.has(name)) return true
    return this.bridge.callSync<boolean | undefined>('storage.exists', { name }) === true
  }

  async write(name: string, text: string, options?: StoreWriteOptions): Promise<void> {
    if (this.unchanged(name, text)) return
    const backup = options?.backup === true
    if (text.length <= CHUNK_CHARS) {
      await this.bridge.call('storage.write', { name, text, backup })
    } else {
      // In pieces, each landing on the host's storage thread before the next is sent; a piece
      // that does not land aborts the write, and the document is as it was.
      const token = await this.bridge.call<number>('storage.writeBegin', { name, backup })
      try {
        for (let at = 0; at < text.length; at += CHUNK_CHARS) {
          await this.bridge.call('storage.writeChunk', {
            token,
            text: text.slice(at, at + CHUNK_CHARS)
          })
        }
        await this.bridge.call('storage.writeEnd', { token })
      } catch (error) {
        this.bridge.send('storage.writeAbort', { token })
        throw error
      }
    }
    this.remember(name, text)
  }

  writeSync(name: string, text: string, options?: StoreWriteOptions): void {
    if (this.unchanged(name, text)) return
    const backup = options?.backup === true
    // The host answers `true` once the file is replaced; anything else (it threw, and the bridge
    // reports a failed synchronous call as no answer) leaves the file – and the mirror – as they were.
    const landed =
      text.length <= CHUNK_CHARS
        ? this.bridge.callSync<boolean | undefined>('storage.writeSync', { name, text, backup }) ===
          true
        : this.writeSyncInPieces(name, text, backup)
    if (!landed) {
      console.warn(`[zen] the host could not write ${name}`)
      return
    }
    this.remember(name, text)
  }

  /** The last-chance write of a big document, in pieces on the bridge thread; whether it landed. */
  private writeSyncInPieces(name: string, text: string, backup: boolean): boolean {
    const token = this.bridge.callSync<number | undefined>('storage.writeBegin', { name, backup })
    if (typeof token !== 'number') return false
    let landed = true
    for (let at = 0; landed && at < text.length; at += CHUNK_CHARS) {
      landed =
        this.bridge.callSync<boolean | undefined>('storage.writeChunk', {
          token,
          text: text.slice(at, at + CHUNK_CHARS)
        }) === true
    }
    landed =
      landed && this.bridge.callSync<boolean | undefined>('storage.writeEnd', { token }) === true
    if (!landed) this.bridge.callSync('storage.writeAbort', { token })
    return landed
  }

  /** The mirror holds these very bytes: the file does too (it was read from, or written with, them). */
  private unchanged(name: string, text: string): boolean {
    return this.files[name] === text
  }

  /**
   * The host has the bytes on disk: the mirror follows; a copy still held for a first read is
   * stale, and so would be the fetched copy of a deferred document that has yet to arrive
   * ({@link adopt} leaves a written name alone, mirrored or not).
   */
  private remember(name: string, text: string): void {
    this.pending.delete(name)
    this.served.add(name)
    if (this.mirrored(name)) this.files[name] = text
    else this.handed.delete(name)
  }

  async remove(name: string): Promise<void> {
    delete this.files[name]
    this.handed.delete(name)
    this.pending.delete(name)
    await this.bridge.call('storage.remove', { name })
  }
}
