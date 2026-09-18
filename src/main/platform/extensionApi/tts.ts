import {
  ERROR_NO_PERMISSION,
  TtsError,
  TtsQueue,
  normalizeSpeakOptions,
  normalizeUtterance,
  type EngineDriver,
  type EngineEvent,
  type TtsVoice,
  type Utterance
} from '../../../core/extensions/api/tts'
import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/**
 * The platform's speech: one utterance at a time (the queue lives in `TtsQueue`), events about
 * the utterance being spoken, and the voices on offer.
 */
export interface SpeechEngine extends EngineDriver {
  voices(): Promise<TtsVoice[]>
  onEvent(listener: (id: number, event: EngineEvent) => void): void
  onVoicesChanged(listener: () => void): void
}

/**
 * `chrome.tts` over the platform's speech engine. `speak` queues with Chrome's rules and answers
 * at once; the utterance's events go back to the calling context as `tts.onEvent(token, event)`
 * deliveries, which the shim turns into the `options.onEvent` callback. `stop` / `pause` /
 * `resume` are global, as in Chrome. An extension's utterances leave the queue when it unloads.
 */
export class TtsApi {
  private readonly queue: TtsQueue
  private nextId = 1

  constructor(
    private readonly host: ApiHost,
    private readonly engine: SpeechEngine
  ) {
    this.queue = new TtsQueue(engine, (utterance, event) => {
      if (utterance.token === null) return
      this.host.dispatch(utterance.owner, 'tts', 'onEvent', [utterance.token, event])
    })
    engine.onEvent((id, event) => this.queue.engineEvent(id, event))
    engine.onVoicesChanged(() =>
      this.host.broadcast('tts', 'onVoicesChanged', (ext) => (this.allowed(ext.id) ? [] : null))
    )
  }

  readonly handlers: NamespaceHandlers = {
    speak: (ctx, utterance, options, token) => this.speak(ctx, utterance, options, token),
    stop: (ctx) => {
      this.requirePermission(ctx)
      this.queue.stop()
    },
    pause: (ctx) => {
      this.requirePermission(ctx)
      this.queue.pause()
    },
    resume: (ctx) => {
      this.requirePermission(ctx)
      this.queue.resume()
    },
    isSpeaking: (ctx) => {
      this.requirePermission(ctx)
      return this.queue.isSpeaking()
    },
    getVoices: (ctx) => {
      this.requirePermission(ctx)
      return this.engine.voices()
    }
  }

  unload(extensionId: string): void {
    this.queue.removeOwner(extensionId)
  }

  private allowed(extensionId: string): boolean {
    return this.host.grants(extensionId).permissions.includes('tts')
  }

  private requirePermission(ctx: ApiContext): void {
    if (!this.allowed(ctx.extensionId)) throw new ApiError(ERROR_NO_PERMISSION)
  }

  private speak(
    ctx: ApiContext,
    rawUtterance: unknown,
    rawOptions: unknown,
    rawToken: unknown
  ): void {
    this.requirePermission(ctx)
    let text: string
    let options: Utterance['options']
    try {
      text = normalizeUtterance(rawUtterance)
      options = normalizeSpeakOptions(rawOptions)
    } catch (error) {
      if (error instanceof TtsError) throw new ApiError(error.message)
      throw error
    }
    this.queue.speak({
      id: this.nextId++,
      text,
      options,
      owner: ctx.extensionId,
      token: typeof rawToken === 'string' ? rawToken : null
    })
  }
}
