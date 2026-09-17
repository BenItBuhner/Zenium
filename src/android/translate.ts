import type { TranslateHost, TranslateModelDownload, TranslateModelStore } from '@core/platform'
import { createEngineTransport } from '@renderer/translate/engine'
import { newId } from '@shared/ids'
import type { ByteSource, EngineAssets, EngineTransport } from '@shared/translateEngine'
import bergamotWasmUrl from '@browsermt/bergamot-translator/worker/bergamot-translator-worker.wasm?url'
import fastTextWasmUrl from 'fasttext.wasm.js/dist/core/fastText.common.wasm?url'
import lidUrl from 'fasttext.wasm.js/dist/models/language-identification/assets/lid.176.ftz?url'
import type { Bridge } from './bridge'

/** The chrome's origin; Kotlin's `WebViewAssetLoader` serves the app's files under it. */
const APP_ORIGIN = 'https://appassets.androidplatform.net'
/** Path handler (see `ChromeWebView.kt`) that maps to the model directory `files/translate/`. */
const MODELS_PATH = '/translate/'

/** Bytes downloaded so far of one model file (`translate.progress` host event). */
export interface TranslateProgressEvent {
  token: string
  received: number
}

/**
 * Model files in the app's internal storage. Kotlin downloads and verifies them (`Translate.kt`);
 * the worker reads them back over the asset loader, so no bytes cross the bridge.
 */
class AndroidModelStore implements TranslateModelStore {
  private readonly progress = new Map<string, (received: number) => void>()

  constructor(private readonly bridge: Bridge) {}

  async list(): Promise<{ name: string; size: number }[]> {
    const entries = await this.bridge.call<{ name: string; size: number }[] | null>(
      'translate.list'
    )
    return Array.isArray(entries) ? entries : []
  }

  async download(
    file: TranslateModelDownload,
    onProgress: (received: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw abortError()
    const token = newId('model')
    this.progress.set(token, onProgress)
    const cancel = (): void => this.bridge.send('translate.cancel', { token })
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const result = await this.bridge.call<{
        ok: boolean
        cancelled?: boolean
        error?: string
      }>('translate.download', {
        token,
        url: file.url,
        name: file.name,
        size: file.size,
        sha256: file.sha256
      })
      if (result.ok) return
      if (result.cancelled || signal?.aborted) throw abortError()
      throw new Error(result.error || 'the model download failed')
    } finally {
      signal?.removeEventListener('abort', cancel)
      this.progress.delete(token)
    }
  }

  async delete(names: string[]): Promise<void> {
    await this.bridge.call('translate.delete', { names })
  }

  source(name: string): Promise<ByteSource> {
    return Promise.resolve(`${APP_ORIGIN}${MODELS_PATH}${encodeURIComponent(name)}`)
  }

  onProgress(event: TranslateProgressEvent): void {
    this.progress.get(event.token)?.(event.received)
  }
}

function abortError(): Error {
  const error = new Error('cancelled')
  error.name = 'AbortError'
  return error
}

/**
 * Page translation on Android: the core runs in the chrome WebView, so the engine is a plain
 * Web Worker of this document and the runtime binaries are assets of the chrome bundle.
 */
export class AndroidTranslateHost implements TranslateHost {
  readonly models: AndroidModelStore
  readonly locales: readonly string[]

  constructor(bridge: Bridge) {
    this.models = new AndroidModelStore(bridge)
    const languages = typeof navigator === 'undefined' ? [] : [...navigator.languages]
    this.locales = languages.length > 0 ? languages : ['en']
  }

  createEngine(): EngineTransport {
    return createEngineTransport()
  }

  assets(): Promise<EngineAssets> {
    const absolute = (url: string): string => new URL(url, document.baseURI).href
    return Promise.resolve({
      bergamotWasm: absolute(bergamotWasmUrl),
      fastTextWasm: absolute(fastTextWasmUrl),
      lid: absolute(lidUrl)
    })
  }

  onProgress(event: TranslateProgressEvent): void {
    this.models.onProgress(event)
  }
}
