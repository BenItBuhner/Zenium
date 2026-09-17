/**
 * The message protocol between the translation core and the engine worker.
 *
 * The worker runs Bergamot (marian-nmt compiled to WebAssembly) and fastText's language
 * identifier off the UI thread. It always lives in the chrome: a Web Worker of the chrome renderer
 * on desktop (the core in Electron's main process relays through the window's IPC channel) and a
 * Web Worker of the chrome WebView on Android (where the core runs in the same document). Both
 * speak this protocol; `core/translate/engine.ts` drives it and `renderer/translate/engineWorker.ts`
 * implements it.
 */

export interface LanguagePair {
  from: string
  to: string
}

/**
 * Bytes the worker needs: either the bytes themselves or a URL the worker may fetch. Hosts decide
 * which: Electron reads files in the main process and ships `ArrayBuffer`s over IPC (a renderer
 * loaded from `file:` cannot fetch), Android fetches from the app's asset origin.
 */
export type ByteSource = ArrayBuffer | string

/** The runtime the worker instantiates (shipped with the app, never downloaded). */
export interface EngineAssets {
  /** `bergamot-translator-worker.wasm` (MPL-2.0). */
  bergamotWasm: ByteSource
  /** `fastText.common.wasm` from fasttext.wasm.js (MIT). */
  fastTextWasm: ByteSource
  /** fastText's compressed language identification model `lid.176.ftz` (CC-BY-SA-3.0). */
  lid: ByteSource
}

/**
 * The files of one translation model. Vocabularies are one shared file for most models and a
 * source/target pair for a few; Bergamot takes them as a list either way.
 */
export interface ModelFiles {
  model: ByteSource
  lex: ByteSource
  vocabs: ByteSource[]
}

export interface DetectionResult {
  /** fastText's label (Wikipedia code, e.g. `en`, `no`, `zh`), or null when nothing scored. */
  language: string | null
  /** Probability of the top label, 0..1. */
  confidence: number
  /** Runner-up label and probability, for margin checks. */
  second: { language: string; confidence: number } | null
}

export type EngineRequest =
  | { id: number; op: 'init'; assets: EngineAssets }
  | { id: number; op: 'load'; pair: LanguagePair; files: ModelFiles }
  | { id: number; op: 'unload'; pair: LanguagePair }
  | {
      id: number
      op: 'translate'
      /** One pair for a direct model, two when pivoting through English. */
      route: LanguagePair[]
      texts: string[]
      /** Treat the texts as HTML fragments and keep their markup in place. */
      html: boolean
    }
  | { id: number; op: 'detect'; text: string }

export type EngineOp = EngineRequest['op']

/** What each operation resolves with. */
export interface EngineResults {
  init: { bergamotVersion: string }
  load: null
  unload: null
  /** One entry per input text; null where Bergamot rejected the fragment (it stays untranslated). */
  translate: (string | null)[]
  detect: DetectionResult
}

export type EngineResponse =
  | { id: number; ok: true; result: EngineResults[EngineOp] }
  | { id: number; ok: false; error: string }

/** A started worker as the host hands it to the core. */
export interface EngineTransport {
  post(message: EngineRequest): void
  onMessage(listener: (message: EngineResponse) => void): void
  /** The worker died or threw outside a request; every pending request fails. */
  onError(listener: (message: string) => void): void
  terminate(): void
}

/** Starts an engine worker; the core creates one lazily and lets it go when idle. */
export type EngineTransportFactory = () => EngineTransport

// ---------------------------------------------------------------------------
// Electron relay: main process ⇄ chrome renderer ⇄ worker
// ---------------------------------------------------------------------------

/**
 * What the main process sends the chrome renderer over the `translate.engine` event. Unlike the
 * rest of `Events` this payload is not JSON: model files travel as `ArrayBuffer`s (structured
 * clone). `engineId` tells one relayed worker from the next after a window closes.
 */
export type EngineRelayRequest =
  | { engineId: number; op: 'request'; request: EngineRequest }
  | { engineId: number; op: 'terminate' }

/** The renderer's answer, sent back through the `translate.engineResponse` command. */
export type EngineRelayResponse =
  | { engineId: number; op: 'response'; response: EngineResponse }
  | { engineId: number; op: 'error'; error: string }

/** Copy `bytes` into a fresh `ArrayBuffer` the worker can own outright. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}
