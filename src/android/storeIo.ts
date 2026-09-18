import { INDEX_FILE } from '@core/blocking/store'
import type { StoreIO } from '@core/platform'
import type { Bridge } from './bridge'

/**
 * The root documents (and the small rule-set index) arrive with the boot payload and are
 * mirrored in memory; documents in a folder – the filter lists' text under `blocking/`, megabytes
 * each – stay on disk and are read through the bridge when asked for.
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
    return this.bridge.callSync<string | null | undefined>('storage.read', { name }) ?? null
  }

  exists(name: string): boolean {
    if (name in this.files) return true
    return this.bridge.callSync<boolean | undefined>('storage.exists', { name }) === true
  }

  async write(name: string, text: string): Promise<void> {
    if (this.mirrored(name)) this.files[name] = text
    await this.bridge.call('storage.write', { name, text })
  }

  writeSync(name: string, text: string): void {
    if (this.mirrored(name)) this.files[name] = text
    this.bridge.callSync('storage.writeSync', { name, text })
  }

  async remove(name: string): Promise<void> {
    delete this.files[name]
    await this.bridge.call('storage.remove', { name })
  }
}
