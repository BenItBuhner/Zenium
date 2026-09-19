import { INDEX_FILE } from '@core/blocking/store'
import type { StoreIO } from '@core/platform'
import type { Bridge } from './bridge'

/**
 * The root documents (and the rule-set index) arrive with the boot payload and are mirrored in
 * memory; documents in a folder – the filter lists' text under `blocking/`, megabytes each –
 * stay on disk and are read through the bridge when asked for.
 *
 * Two things keep the boot path to one transfer per document (`BootHandoff.kt`, `handoff.ts`):
 *
 *  - Documents the payload deferred for their size come in by file ({@link adopt}) before the
 *    core starts, and the core's synchronous read at start finds them here, once: a folder
 *    document (a Safe Browsing feed's prefix table) is handed over and let go of, so the chrome
 *    does not hold a second copy of the megabytes the service keeps.
 *  - A write of the very bytes the mirror already holds goes nowhere. The engine writes its index
 *    back at start (every set it loaded is set again) with the text it was booted with; sending
 *    it through the bridge had the Kotlin host rewrite the file and rebuild its request engine
 *    from it – the same bytes, a third time.
 */
export class AndroidStoreIO implements StoreIO {
  /** Deferred folder documents, held until the core reads them. */
  private readonly handed = new Map<string, string>()

  constructor(
    private readonly bridge: Bridge,
    private readonly files: Record<string, string>
  ) {}

  private mirrored(name: string): boolean {
    return !name.includes('/') || name === INDEX_FILE || name in this.files
  }

  /** The documents the boot payload deferred, fetched (`fetchDeferredDocuments`); before the core starts. */
  adopt(documents: Record<string, string>): void {
    for (const [name, text] of Object.entries(documents)) {
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
    if (!name.includes('/')) return null
    return this.bridge.callSync<string | null | undefined>('storage.read', { name }) ?? null
  }

  exists(name: string): boolean {
    if (name in this.files || this.handed.has(name)) return true
    return this.bridge.callSync<boolean | undefined>('storage.exists', { name }) === true
  }

  async write(name: string, text: string): Promise<void> {
    if (this.unchanged(name, text)) return
    if (this.mirrored(name)) this.files[name] = text
    await this.bridge.call('storage.write', { name, text })
  }

  writeSync(name: string, text: string): void {
    if (this.unchanged(name, text)) return
    if (this.mirrored(name)) this.files[name] = text
    this.bridge.callSync('storage.writeSync', { name, text })
  }

  /** The mirror holds these very bytes: the file does too (it was read from, or written with, them). */
  private unchanged(name: string, text: string): boolean {
    return this.files[name] === text
  }

  async remove(name: string): Promise<void> {
    delete this.files[name]
    this.handed.delete(name)
    await this.bridge.call('storage.remove', { name })
  }
}
