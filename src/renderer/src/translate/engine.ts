import { onEvent, run } from '@renderer/lib/api'
import type {
  EngineRelayRequest,
  EngineRequest,
  EngineResponse,
  EngineTransport
} from '@shared/translateEngine'

/** The `ArrayBuffer`s of a request, so they move into the worker instead of being copied. */
function transferables(request: EngineRequest): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = []
  const collect = (source: unknown): void => {
    if (source instanceof ArrayBuffer) buffers.push(source)
  }
  if (request.op === 'init') {
    collect(request.assets.bergamotWasm)
    collect(request.assets.fastTextWasm)
    collect(request.assets.lid)
  } else if (request.op === 'load') {
    collect(request.files.model)
    collect(request.files.lex)
    request.files.vocabs.forEach(collect)
  }
  return buffers
}

/** Start the engine worker of this chrome document. */
export function createEngineTransport(): EngineTransport {
  const worker = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' })
  const messageListeners: ((message: EngineResponse) => void)[] = []
  const errorListeners: ((message: string) => void)[] = []
  worker.addEventListener('message', (event: MessageEvent<EngineResponse>) => {
    for (const listener of messageListeners) listener(event.data)
  })
  worker.addEventListener('error', (event) => {
    const message = event.message || 'the translation engine worker failed'
    for (const listener of errorListeners) listener(message)
  })
  return {
    post: (message) => worker.postMessage(message, transferables(message)),
    onMessage: (listener) => void messageListeners.push(listener),
    onError: (listener) => void errorListeners.push(listener),
    terminate: () => worker.terminate()
  }
}

/**
 * Electron: the core lives in the main process, which has no Web Workers; it drives an engine in
 * this window's renderer through the `translate.engine` event and reads the answers back through
 * the `translate.engineResponse` command. Each `engineId` is one worker.
 */
export function startEngineRelay(): void {
  const flags = globalThis as unknown as { __zeniumTranslateRelay?: boolean }
  if (flags.__zeniumTranslateRelay) return
  flags.__zeniumTranslateRelay = true
  const workers = new Map<number, EngineTransport>()
  const engineFor = (engineId: number): EngineTransport => {
    let transport = workers.get(engineId)
    if (transport) return transport
    transport = createEngineTransport()
    transport.onMessage((response) =>
      run('translate.engineResponse', { engineId, op: 'response', response })
    )
    transport.onError((error) => {
      workers.get(engineId)?.terminate()
      workers.delete(engineId)
      run('translate.engineResponse', { engineId, op: 'error', error })
    })
    workers.set(engineId, transport)
    return transport
  }
  onEvent('translate.engine', (message: EngineRelayRequest) => {
    if (message.op === 'terminate') {
      workers.get(message.engineId)?.terminate()
      workers.delete(message.engineId)
      return
    }
    engineFor(message.engineId).post(message.request)
  })
}
