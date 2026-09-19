import { INDEX_FILE } from '@core/blocking/store'
import type { StoreIO } from '@core/platform'
import type { Bridge } from './bridge'

/**
 * Documents cross the bridge in pieces of this many characters. One bridge call carrying a
 * document whole has Kotlin hold several copies of the text at once (the call's JSON, the
 * tokenizer's buffer, the parsed value); a filter-list extension's `chrome.storage` runs to tens
 * of megabytes, past the debug heap. A piece is sent once the one before it has landed, so one
 * piece (and its copies) is on the Java heap at a time.
 */
export const CHUNK_CHARS = 1 << 20

/**
 * The root documents (and the small rule-set index) arrive with the boot payload and are
 * mirrored in memory; documents in a folder – the filter lists' text under `blocking/`, the
 * extensions' storage under `ext-storage/`, megabytes each – stay on disk and are read through
 * the bridge when asked for, in pieces.
 */
export class AndroidStoreIO implements StoreIO {
  constructor(
    private readonly bridge: Bridge,
    private readonly files: Record<string, string>
  ) {}

  private mirrored(name: string): boolean {
    return !name.includes('/') || name === INDEX_FILE || name in this.files
  }

  readSync(name: string): string | null {
    const cached = this.files[name]
    if (cached !== undefined) return cached
    if (!name.includes('/')) return null
    const token = this.bridge.callSync<number | null | undefined>('storage.readBegin', { name })
    if (typeof token !== 'number') return null
    const parts: string[] = []
    for (;;) {
      const chunk = this.bridge.callSync<string | null | undefined>('storage.readChunk', {
        token,
        maxChars: CHUNK_CHARS
      })
      // null: the end, the reader closed. Anything else: the read failed midway.
      if (chunk === null) return parts.join('')
      if (typeof chunk !== 'string') {
        this.bridge.callSync('storage.readEnd', { token })
        return null
      }
      parts.push(chunk)
    }
  }

  exists(name: string): boolean {
    if (name in this.files) return true
    return this.bridge.callSync<boolean | undefined>('storage.exists', { name }) === true
  }

  async write(name: string, text: string): Promise<void> {
    if (this.mirrored(name)) this.files[name] = text
    if (text.length <= CHUNK_CHARS) {
      await this.bridge.call('storage.write', { name, text })
      return
    }
    const token = await this.bridge.call<number>('storage.writeBegin', { name })
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

  writeSync(name: string, text: string): void {
    if (this.mirrored(name)) this.files[name] = text
    if (text.length <= CHUNK_CHARS) {
      this.bridge.callSync('storage.writeSync', { name, text })
      return
    }
    const token = this.bridge.callSync<number | undefined>('storage.writeBegin', { name })
    if (typeof token !== 'number') throw new Error(`cannot write ${name}`)
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
    if (!landed) {
      this.bridge.callSync('storage.writeAbort', { token })
      throw new Error(`writing ${name} failed`)
    }
  }

  async remove(name: string): Promise<void> {
    delete this.files[name]
    await this.bridge.call('storage.remove', { name })
  }
}
