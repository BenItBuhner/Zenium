import { app, BrowserWindow, net, type WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  TranslateHost,
  TranslateModelDownload,
  TranslateModelStore
} from '../../core/platform'
import type {
  ByteSource,
  EngineAssets,
  EngineRelayRequest,
  EngineRelayResponse,
  EngineResponse,
  EngineTransport
} from '../../shared/translateEngine'
import { toArrayBuffer } from '../../shared/translateEngine'

/** Runtime binaries shipped inside the app package (read from `node_modules` or the asar). */
const ASSET_FILES = {
  bergamotWasm: '@browsermt/bergamot-translator/worker/bergamot-translator-worker.wasm',
  fastTextWasm: 'fasttext.wasm.js/dist/core/fastText.common.wasm',
  lid: 'fasttext.wasm.js/dist/models/language-identification/assets/lid.176.ftz'
} as const

/** Only names the model manager produces (`<from>_<to>_<version>_<type>.<ext>`) touch the disk. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

async function readAsset(specifier: string): Promise<ArrayBuffer> {
  const bytes = await readFile(require.resolve(specifier))
  return toArrayBuffer(bytes)
}

/**
 * Model files under `<userData>/zen/translate/`. Downloads stream to a `.part` file while the
 * SHA-256 is computed, and only a complete file with the registry's checksum is renamed into
 * place, so a listing of the directory is always an inventory of usable models.
 */
export class FileModelStore implements TranslateModelStore {
  /**
   * `userAgent` names the product plainly (`Zenium/<version>`): the attachment CDN answers 406
   * to Chromium-style browser user agents, and the download is not a page load anyway.
   */
  constructor(
    readonly dir: string,
    private readonly userAgent: string
  ) {}

  async list(): Promise<{ name: string; size: number }[]> {
    await mkdir(this.dir, { recursive: true })
    const names = await readdir(this.dir)
    const out: { name: string; size: number }[] = []
    for (const name of names) {
      if (!SAFE_NAME.test(name) || name.endsWith('.part')) continue
      try {
        const info = await stat(join(this.dir, name))
        if (info.isFile()) out.push({ name, size: info.size })
      } catch {
        /* removed meanwhile */
      }
    }
    return out
  }

  async download(
    file: TranslateModelDownload,
    onProgress: (received: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (!SAFE_NAME.test(file.name)) throw new Error(`refusing to store ${file.name}`)
    if (!/^https:\/\//i.test(file.url)) throw new Error('refusing a non-https model download')
    await mkdir(this.dir, { recursive: true })
    const target = join(this.dir, file.name)
    const partial = `${target}.part`
    const response = await net.fetch(file.url, {
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/octet-stream', 'User-Agent': this.userAgent }
    })
    if (!response.ok || !response.body)
      throw new Error(`the model download failed (HTTP ${response.status})`)
    const hash = createHash('sha256')
    let received = 0
    try {
      const out = createWriteStream(partial)
      const finished = new Promise<void>((resolve, reject) => {
        out.on('finish', resolve)
        out.on('error', reject)
      })
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (signal?.aborted) throw abortError()
        hash.update(value)
        received += value.byteLength
        if (received > file.size)
          throw new Error('the model file is larger than the registry states')
        if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve))
        onProgress(received)
      }
      out.end()
      await finished
      if (received !== file.size)
        throw new Error(`the model file is ${received} bytes, the registry lists ${file.size}`)
      const hex = hash.digest('hex')
      if (hex.toLowerCase() !== file.sha256.toLowerCase())
        throw new Error('the model file is corrupt (checksum mismatch)')
      await rename(partial, target)
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async delete(names: string[]): Promise<void> {
    for (const name of names) {
      if (!SAFE_NAME.test(name)) continue
      await rm(join(this.dir, name), { force: true })
    }
  }

  async source(name: string): Promise<ByteSource> {
    if (!SAFE_NAME.test(name)) throw new Error(`unknown model file ${name}`)
    return toArrayBuffer(await readFile(join(this.dir, name)))
  }
}

function abortError(): Error {
  const error = new Error('cancelled')
  error.name = 'AbortError'
  return error
}

/**
 * A worker that lives in a chrome window's renderer. The main process has no Web Workers, so
 * requests go out over the `translate.engine` event and answers return through the
 * `translate.engineResponse` command (`renderer/translate/engine.ts` does the other half).
 */
class RelayedEngine implements EngineTransport {
  private readonly messageListeners: ((message: EngineResponse) => void)[] = []
  private readonly errorListeners: ((message: string) => void)[] = []
  private ended = false
  private readonly onDestroyed = (): void =>
    this.fail('the window running the translation engine was closed')

  constructor(
    readonly engineId: number,
    private readonly webContents: WebContents,
    private readonly release: () => void
  ) {
    webContents.once('destroyed', this.onDestroyed)
  }

  post(message: EngineRequest): void {
    if (this.ended) throw new Error('the translation engine was stopped')
    const payload: EngineRelayRequest = { engineId: this.engineId, op: 'request', request: message }
    this.webContents.send('zen:event', 'translate.engine', payload)
  }

  onMessage(listener: (message: EngineResponse) => void): void {
    this.messageListeners.push(listener)
  }

  onError(listener: (message: string) => void): void {
    this.errorListeners.push(listener)
  }

  terminate(): void {
    if (this.ended) return
    this.ended = true
    this.webContents.removeListener('destroyed', this.onDestroyed)
    if (!this.webContents.isDestroyed()) {
      const payload: EngineRelayRequest = { engineId: this.engineId, op: 'terminate' }
      this.webContents.send('zen:event', 'translate.engine', payload)
    }
    this.release()
  }

  receive(response: EngineRelayResponse): void {
    if (this.ended) return
    if (response.op === 'error') {
      this.fail(response.error)
      return
    }
    for (const listener of this.messageListeners) listener(response.response)
  }

  private fail(message: string): void {
    if (this.ended) return
    for (const listener of this.errorListeners) listener(message)
    this.terminate()
  }
}

type EngineRequest = EngineRelayRequest extends { op: 'request'; request: infer R } ? R : never

export class ElectronTranslateHost implements TranslateHost {
  readonly models: FileModelStore
  readonly locales: readonly string[]
  private readonly engines = new Map<number, RelayedEngine>()
  private nextEngineId = 1

  constructor(
    userDataDir: string,
    /** The chrome renderer that should run the next engine worker. */
    private readonly chromeWebContents: () => WebContents | null
  ) {
    this.models = new FileModelStore(
      join(userDataDir, 'zen', 'translate'),
      `Zenium/${app.getVersion()}`
    )
    this.locales = preferredLocales()
  }

  createEngine(): EngineTransport {
    const webContents = this.chromeWebContents()
    if (!webContents || webContents.isDestroyed())
      throw new Error('Zenium needs an open window to translate.')
    const engineId = this.nextEngineId++
    const engine = new RelayedEngine(engineId, webContents, () => this.engines.delete(engineId))
    this.engines.set(engineId, engine)
    return engine
  }

  async assets(): Promise<EngineAssets> {
    const [bergamotWasm, fastTextWasm, lid] = await Promise.all([
      readAsset(ASSET_FILES.bergamotWasm),
      readAsset(ASSET_FILES.fastTextWasm),
      readAsset(ASSET_FILES.lid)
    ])
    return { bergamotWasm, fastTextWasm, lid }
  }

  onRelayResponse(response: EngineRelayResponse): void {
    this.engines.get(response.engineId)?.receive(response)
  }
}

/** The chrome renderer to run engines in: the focused Zen window, else any live one. */
export function focusedChromeWebContents(isZenWindow: (id: number) => boolean): WebContents | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && isZenWindow(focused.webContents.id))
    return focused.webContents
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && isZenWindow(win.webContents.id)) return win.webContents
  }
  return null
}

function preferredLocales(): string[] {
  try {
    const languages = app.getPreferredSystemLanguages()
    if (languages.length > 0) return languages
  } catch {
    /* not available before ready on some platforms */
  }
  return [app.getLocale() || 'en']
}
