/**
 * The translation engine worker: Bergamot (marian-nmt compiled to WebAssembly, MPL-2.0) for the
 * translations and fastText's lid.176 model for language identification, both off the UI thread.
 *
 * Runs as a Web Worker of the chrome document on every host (see `shared/translateEngine.ts` for
 * the protocol). Every byte it needs arrives as an `ArrayBuffer` or as a URL of the chrome's own
 * origin, so the worker never touches the network of a page or the model CDN itself.
 */
import bergamotGlue from '@browsermt/bergamot-translator/worker/bergamot-translator-worker.js?raw'
import fastTextFactory from 'fasttext.wasm.js/dist/core/fastText.common.js'
import type {
  ByteSource,
  DetectionResult,
  EngineAssets,
  EngineRequest,
  EngineResponse,
  EngineResults,
  LanguagePair,
  ModelFiles
} from '@shared/translateEngine'

// ---------------------------------------------------------------------------
// Bergamot's embind surface (the subset used here)
// ---------------------------------------------------------------------------

interface EmVector<T> {
  size(): number
  get(index: number): T
  push_back(value: T): void
  delete(): void
}

interface AlignedMemory {
  getByteArrayView(): Uint8Array
  delete(): void
}

interface TranslationModel {
  delete(): void
}

interface TranslationResponse {
  getTranslatedText(): string
  getOriginalText(): string
}

interface ResponseOptions {
  alignment: boolean
  html: boolean
  qualityScores: boolean
}

interface BlockingService {
  translate(
    model: TranslationModel,
    input: EmVector<string>,
    options: EmVector<ResponseOptions>
  ): EmVector<TranslationResponse>
  translateViaPivoting(
    first: TranslationModel,
    second: TranslationModel,
    input: EmVector<string>,
    options: EmVector<ResponseOptions>
  ): EmVector<TranslationResponse>
}

type WasmFallback = (...args: number[]) => number

interface BergamotModule {
  AlignedMemory: new (size: number, alignment: number) => AlignedMemory
  AlignedMemoryList: new () => EmVector<AlignedMemory>
  VectorString: new () => EmVector<string>
  VectorResponseOptions: new () => EmVector<ResponseOptions>
  BlockingService: new (options: { cacheSize: number }) => BlockingService
  TranslationModel: new (
    config: string,
    model: AlignedMemory,
    shortlist: AlignedMemory,
    vocabs: EmVector<AlignedMemory>,
    qualityModel: AlignedMemory | null
  ) => TranslationModel
  asm?: Record<string, WasmFallback>
  wasmBinary?: ArrayBuffer
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance) => void
  ) => Record<string, never>
  onRuntimeInitialized?: () => void
  onAbort?: (what: unknown) => void
  print?: (text: string) => void
  printErr?: (text: string) => void
}

/**
 * The wasm imports the int8 GEMM kernels under `wasm_gemm`; Firefox links its native module
 * there, everyone else points the symbols at the fallbacks compiled into the binary itself.
 */
const GEMM_FALLBACKS: Record<string, string> = {
  int8_prepare_a: 'int8PrepareAFallback',
  int8_prepare_b: 'int8PrepareBFallback',
  int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
  int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
  int8_prepare_bias: 'int8PrepareBiasFallback',
  int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
  int8_select_columns_of_b: 'int8SelectColumnsOfBFallback'
}

/** marian's settings for a Bergamot model in the browser (Firefox uses the same). */
const MODEL_CONFIG = [
  'beam-size: 1',
  'normalize: 1.0',
  'word-penalty: 0',
  'cpu-threads: 0',
  'gemm-precision: int8shiftAlphaAll',
  'skip-cost: true',
  'alignment: soft',
  'quiet: true',
  'quiet-translation: true',
  'max-length-break: 128',
  'mini-batch-words: 1024',
  'workspace: 128',
  'max-length-factor: 2.0',
  ''
].join('\n')

/** The version string the glue carries (`BERGAMOT_VERSION_FULL`), without instantiating anything. */
function bergamotVersion(): string {
  const match = /BERGAMOT_VERSION_FULL\s*=\s*"([^"]+)"/.exec(bergamotGlue)
  return match ? match[1] : 'unknown'
}

async function bytesOf(source: ByteSource): Promise<ArrayBuffer> {
  if (typeof source !== 'string') return source
  const response = await fetch(source)
  if (!response.ok) throw new Error(`could not read ${source} (HTTP ${response.status})`)
  return response.arrayBuffer()
}

function instantiateBergamot(wasm: ArrayBuffer): Promise<BergamotModule> {
  return new Promise<BergamotModule>((resolve, reject) => {
    const module: BergamotModule = {} as BergamotModule
    module.wasmBinary = wasm
    module.print = () => undefined
    module.printErr = (text) => console.warn('[zenium translate] bergamot:', text)
    module.onAbort = (what) => reject(new Error(`Bergamot aborted: ${String(what)}`))
    module.instantiateWasm = (imports, receive) => {
      const gemm: Record<string, WasmFallback> = {}
      for (const [name, fallback] of Object.entries(GEMM_FALLBACKS)) {
        gemm[name] = (...args: number[]) => {
          const fn = module.asm?.[fallback]
          if (!fn) throw new Error(`Bergamot: missing GEMM fallback ${fallback}`)
          return fn(...args)
        }
      }
      WebAssembly.instantiate(wasm, { ...imports, wasm_gemm: gemm })
        .then((result) => receive(result.instance))
        .catch(reject)
      return {}
    }
    module.onRuntimeInitialized = () => resolve(module)
    try {
      // The glue is a classic Emscripten script that binds to a global `Module`; running it as a
      // function body with that name as its parameter keeps it out of the worker's global scope.
      new Function('Module', bergamotGlue)(module)
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

type FastTextModule = Awaited<ReturnType<typeof fastTextFactory>>
type FastTextCore = InstanceType<FastTextModule['FastText']>

const LID_FILE = '/lid.176.ftz'

class Engine {
  private assets: EngineAssets | null = null
  private bergamot: Promise<BergamotModule> | null = null
  private service: BlockingService | null = null
  private lid: Promise<FastTextCore> | null = null
  private readonly models = new Map<string, TranslationModel>()

  init(assets: EngineAssets): EngineResults['init'] {
    this.assets = assets
    // Language identification is needed on almost every page load; start it now. Bergamot's
    // runtime waits for the first model so pages that are never translated do not pay for it.
    void this.identifier().catch(() => undefined)
    return { bergamotVersion: bergamotVersion() }
  }

  private identifier(): Promise<FastTextCore> {
    if (!this.lid) {
      const assets = this.requireAssets()
      this.lid = (async () => {
        const [wasm, model] = await Promise.all([bytesOf(assets.fastTextWasm), bytesOf(assets.lid)])
        const module = await fastTextFactory({ wasmBinary: wasm })
        module.FS.writeFile(LID_FILE, new Uint8Array(model))
        const core = new module.FastText()
        core.loadModel(LID_FILE)
        return core
      })()
      this.lid.catch(() => {
        this.lid = null
      })
    }
    return this.lid
  }

  private runtime(): Promise<BergamotModule> {
    if (!this.bergamot) {
      const assets = this.requireAssets()
      this.bergamot = bytesOf(assets.bergamotWasm).then(instantiateBergamot)
      this.bergamot.catch(() => {
        this.bergamot = null
      })
    }
    return this.bergamot
  }

  private requireAssets(): EngineAssets {
    if (!this.assets) throw new Error('the engine has not been initialised')
    return this.assets
  }

  async load(pair: LanguagePair, files: ModelFiles): Promise<null> {
    const key = pairKey(pair)
    if (this.models.has(key)) return null
    const [module, model, lex, ...vocabs] = await Promise.all([
      this.runtime(),
      bytesOf(files.model),
      bytesOf(files.lex),
      ...files.vocabs.map(bytesOf)
    ])
    if (!this.service) this.service = new module.BlockingService({ cacheSize: 0 })
    const aligned = (bytes: ArrayBuffer, alignment: number): AlignedMemory => {
      const memory = new module.AlignedMemory(bytes.byteLength, alignment)
      memory.getByteArrayView().set(new Uint8Array(bytes))
      return memory
    }
    const vocabList = new module.AlignedMemoryList()
    for (const vocab of vocabs) vocabList.push_back(aligned(vocab, 64))
    const translationModel = new module.TranslationModel(
      MODEL_CONFIG,
      aligned(model, 256),
      aligned(lex, 64),
      vocabList,
      null
    )
    this.models.set(key, translationModel)
    return null
  }

  unload(pair: LanguagePair): null {
    const key = pairKey(pair)
    const model = this.models.get(key)
    if (model) {
      this.models.delete(key)
      model.delete()
    }
    return null
  }

  async translate(
    route: LanguagePair[],
    texts: string[],
    html: boolean
  ): Promise<EngineResults['translate']> {
    if (texts.length === 0) return []
    const module = await this.runtime()
    const service = this.service
    if (!service) throw new Error('no translation model is loaded')
    const models = route.map((pair) => {
      const model = this.models.get(pairKey(pair))
      if (!model) throw new Error(`model ${pair.from}-${pair.to} is not loaded`)
      return model
    })
    if (models.length === 0 || models.length > 2)
      throw new Error(`a route needs one or two models, got ${models.length}`)
    const run = (batch: string[]): string[] => {
      const input = new module.VectorString()
      const options = new module.VectorResponseOptions()
      for (const text of batch) {
        input.push_back(text)
        options.push_back({ alignment: false, html, qualityScores: false })
      }
      try {
        const responses =
          models.length === 2
            ? service.translateViaPivoting(models[0], models[1], input, options)
            : service.translate(models[0], input, options)
        const out: string[] = []
        for (let i = 0; i < batch.length; i++) out.push(responses.get(i).getTranslatedText())
        responses.delete()
        return out
      } finally {
        input.delete()
        options.delete()
      }
    }
    try {
      return run(texts)
    } catch (error) {
      // One malformed fragment (Bergamot's HTML parser is strict) must not sink the whole batch:
      // retry item by item and hand back null for the ones that still fail.
      if (texts.length === 1) {
        console.warn('[zenium translate] segment failed:', errorMessage(error))
        return [null]
      }
      const results: (string | null)[] = []
      for (const text of texts) {
        try {
          results.push(run([text])[0])
        } catch (single) {
          console.warn('[zenium translate] segment failed:', errorMessage(single))
          results.push(null)
        }
      }
      return results
    }
  }

  async detect(text: string): Promise<DetectionResult> {
    const core = await this.identifier()
    // fastText reads one line; newlines would end the sample early.
    const sample = text.replace(/\s+/g, ' ').trim().slice(0, 4000)
    if (sample.length === 0) return { language: null, confidence: 0, second: null }
    const predictions = core.predict(sample, 3, 0)
    const read = (index: number): { language: string; confidence: number } | null => {
      if (index >= predictions.size()) return null
      const [probability, label] = predictions.get(index)
      return { language: label.replace('__label__', ''), confidence: probability }
    }
    const top = read(0)
    const second = read(1)
    predictions.delete()
    if (!top) return { language: null, confidence: 0, second: null }
    return { language: top.language, confidence: top.confidence, second }
  }
}

function pairKey(pair: LanguagePair): string {
  return `${pair.from}>${pair.to}`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'number') return `Bergamot exception ${error}`
  return String(error)
}

// ---------------------------------------------------------------------------
// Message loop: requests run one after another (Bergamot is synchronous anyway)
// ---------------------------------------------------------------------------

const engine = new Engine()
let queue: Promise<void> = Promise.resolve()

function reply(message: EngineResponse): void {
  ;(self as unknown as { postMessage(message: EngineResponse): void }).postMessage(message)
}

async function handle(request: EngineRequest): Promise<void> {
  try {
    let result: EngineResults[EngineRequest['op']]
    switch (request.op) {
      case 'init':
        result = engine.init(request.assets)
        break
      case 'load':
        result = await engine.load(request.pair, request.files)
        break
      case 'unload':
        result = engine.unload(request.pair)
        break
      case 'translate':
        result = await engine.translate(request.route, request.texts, request.html)
        break
      case 'detect':
        result = await engine.detect(request.text)
        break
    }
    reply({ id: request.id, ok: true, result })
  } catch (error) {
    reply({ id: request.id, ok: false, error: errorMessage(error) })
  }
}

self.addEventListener('message', (event: MessageEvent<EngineRequest>) => {
  const request = event.data
  queue = queue.then(() => handle(request))
})
