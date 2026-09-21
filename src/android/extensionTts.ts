import {
  ERROR_NO_PERMISSION,
  TtsError,
  TtsQueue,
  normalizeSpeakOptions,
  normalizeUtterance,
  type EngineDriver,
  type EngineEvent,
  type EngineSpeakOptions,
  type TtsEvent,
  type TtsEventType,
  type TtsVoice,
  type Utterance
} from '@core/extensions/api/tts'
import {
  SPEECH_INTERRUPTED,
  type SpeechHost,
  type SpeechHostEvent,
  type SpeechUtteranceOptions
} from '@core/platform'
import type { ReadAloudVoice } from '@shared/readAloud'

/**
 * `chrome.tts` on the phone: Chrome's queue (`TtsQueue`, the desktop's too) over the device's
 * speech engine as read aloud already reaches it – the core's `SpeechHost` (`Platform.speech`,
 * Kotlin's `ReadAloud.kt` over `TextToSpeech`). One engine for both speakers, as Chrome's one
 * `TtsController` serves its own read aloud and every extension: an extension's utterance pauses
 * the player when it is reading (the newcomer interrupts, in Chrome's rules; the player's Play
 * takes over again), and read aloud starting stops the extension's speech with an `interrupted`
 * (the host reports what a flush or a stop took from the engine).
 *
 * `speak` answers at once and the utterance's events go back to the calling context alone, as
 * `tts.onEvent(token, event)` deliveries the shim turns into `options.onEvent`; `stop`, `pause`,
 * `resume` and `isSpeaking` are global, `getVoices` lists the engine's voices in Chrome's shape.
 * The engine has no pause, so `pause` stops it at the word being spoken (the last `word` boundary
 * the engine reported) and `resume` speaks the rest of the text from that word, the events
 * `pause` and `resume` carrying the character index, as Chrome's platforms with a real pause do;
 * without word boundaries the utterance resumes from its start.
 */

/** What the driver needs of the runtime: the engine, the events out, the permission and the player. */
export interface TtsHost {
  speech(): SpeechHost | undefined
  hasPermission(extensionId: string): boolean
  /** Whether the endpoint that asked to speak is still there (its events are dropped when it is not: no wake for them). */
  endpointAlive(endpointId: string): boolean
  /**
   * `tts.onEvent(token, event)` to the one endpoint that called `speak`; `web`: the utterance is
   * a page's Web Speech one, and the event goes to its `speechSynthesis.onEvent` instead.
   */
  emit(extensionId: string, endpointId: string, args: unknown[], web: boolean): void
  /** `tts.onVoicesChanged` to every extension with the permission, `speechSynthesis.onVoicesChanged` to every page. */
  voicesChanged(): void
  /** Read aloud is speaking: the player pauses before the extension's utterance starts. */
  readAloudPlaying(): boolean
  pauseReadAloud(): void
}

/** What an Android engine's voice can report (`TtsVoice.eventTypes`): word boundaries where the engine gives ranges. */
export const ANDROID_TTS_EVENT_TYPES: readonly TtsEventType[] = [
  'start',
  'end',
  'word',
  'interrupted',
  'cancelled',
  'error',
  'pause',
  'resume'
]

export const ERROR_NO_ENGINE = 'No speech engine is available on this device.'

/** The utterance ids the driver hands the engine: apart from read aloud's (`ra-…`) on the one event stream. */
const UTTERANCE_PREFIX = 'ext-tts:'

/** A read-aloud voice (the engine's, `id` = `Voice.getName()`) as Chrome lists it. */
export function ttsVoiceFrom(voice: ReadAloudVoice): TtsVoice {
  return {
    voiceName: voice.id,
    lang: voice.lang,
    remote: !voice.local,
    eventTypes: [...ANDROID_TTS_EVENT_TYPES]
  }
}

/** Chrome's `SpeakOptions` as the speech host takes them (`voiceName` is the engine's voice name, read aloud's id). */
export function speechOptionsFrom(options: EngineSpeakOptions): SpeechUtteranceOptions {
  const out: SpeechUtteranceOptions = {
    voiceId: options.voiceName ?? null,
    lang: options.lang ?? '',
    rate: options.rate ?? 1
  }
  if (options.pitch !== undefined) out.pitch = options.pitch
  if (options.volume !== undefined) out.volume = options.volume
  return out
}

/** The utterance the engine has, or is paused on: the text, where the spoken segment starts, the last word boundary in it. */
interface Speaking {
  id: number
  text: string
  options: EngineSpeakOptions
  /** Counts the segments spoken (0 the whole text, one more per resume), naming the engine's utterance. */
  segment: number
  /** Where in `text` the current segment starts. */
  offset: number
  /** The start of the last word the engine reported within the segment. */
  boundary: number
  paused: boolean
}

/**
 * The queue's one-utterance engine over the speech host. Events for anything but the segment
 * being spoken are stale (a paused segment's own stop report, an earlier utterance's) and dropped.
 */
export class SpeechHostDriver implements EngineDriver {
  private speaking: Speaking | null = null
  private subscribed: SpeechHost | null = null

  constructor(
    private readonly host: Pick<TtsHost, 'speech' | 'readAloudPlaying' | 'pauseReadAloud'>,
    private readonly report: (id: number, event: EngineEvent) => void,
    /** Another speaker took the engine: the queue empties (`interrupted`, `cancelled`) without stopping the newcomer. */
    private readonly interrupted: () => void
  ) {}

  /** The engine, listened to once it exists (read aloud's host is built at boot; tests hand one in later). */
  private engine(): SpeechHost | undefined {
    const speech = this.host.speech()
    if (speech && this.subscribed !== speech) {
      this.subscribed = speech
      speech.onEvent((utteranceId, event) => this.onHostEvent(utteranceId, event))
    }
    return speech
  }

  speak(id: number, text: string, options: EngineSpeakOptions): void {
    const engine = this.engine()
    if (!engine) {
      // The queue already holds the utterance as current: the failure reaches it on the next turn.
      queueMicrotask(() =>
        this.report(id, { type: 'error', charIndex: 0, errorMessage: ERROR_NO_ENGINE })
      )
      return
    }
    this.speaking = { id, text, options, segment: 0, offset: 0, boundary: 0, paused: false }
    this.speakSegment(engine, this.speaking)
  }

  cancel(): void {
    const speaking = this.speaking
    if (!speaking) return
    this.speaking = null
    if (!speaking.paused) this.engine()?.stop()
  }

  pause(): void {
    const speaking = this.speaking
    if (!speaking || speaking.paused) return
    speaking.paused = true
    this.engine()?.stop()
    this.report(speaking.id, { type: 'pause', charIndex: speaking.offset + speaking.boundary })
  }

  resume(): void {
    const speaking = this.speaking
    if (!speaking || !speaking.paused) return
    const engine = this.engine()
    if (!engine) return
    speaking.paused = false
    speaking.offset += speaking.boundary
    speaking.boundary = 0
    speaking.segment += 1
    this.report(speaking.id, { type: 'resume', charIndex: speaking.offset })
    this.speakSegment(engine, speaking)
  }

  /** What the engine is on right now, for tests and the findings. */
  current(): { id: number; paused: boolean; offset: number } | null {
    const s = this.speaking
    return s ? { id: s.id, paused: s.paused, offset: s.offset } : null
  }

  private speakSegment(engine: SpeechHost, speaking: Speaking): void {
    if (this.host.readAloudPlaying()) this.host.pauseReadAloud()
    engine.speak(
      utteranceIdOf(speaking),
      speaking.text.slice(speaking.offset),
      speechOptionsFrom(speaking.options)
    )
  }

  private onHostEvent(utteranceId: string, event: SpeechHostEvent): void {
    const speaking = this.speaking
    if (!speaking || utteranceId !== utteranceIdOf(speaking)) return
    switch (event.type) {
      case 'start':
        // A resumed segment starting is no new start of the utterance (Chrome sends `resume` alone).
        if (speaking.segment === 0) this.report(speaking.id, { type: 'start', charIndex: 0 })
        return
      case 'word': {
        speaking.boundary = Math.max(0, event.charIndex ?? 0)
        const word: EngineEvent = { type: 'word', charIndex: speaking.offset + speaking.boundary }
        if (event.length !== undefined) word.length = event.length
        this.report(speaking.id, word)
        return
      }
      case 'end':
        this.speaking = null
        this.report(speaking.id, { type: 'end' })
        return
      case 'error':
        if (event.message === SPEECH_INTERRUPTED) {
          // Our own pause stopped the engine: the report about it is nothing new.
          if (speaking.paused) return
          this.speaking = null
          this.interrupted()
          return
        }
        this.speaking = null
        this.report(speaking.id, {
          type: 'error',
          charIndex: speaking.offset + speaking.boundary,
          errorMessage: event.message || 'synthesis-failed'
        })
        return
    }
  }
}

function utteranceIdOf(speaking: Speaking): string {
  return `${UTTERANCE_PREFIX}${speaking.id}:${speaking.segment}`
}

/** `chrome.tts` for the Android runtime: the namespace's calls, and the events back to whoever spoke. */
export class AndroidTts {
  private readonly queue: TtsQueue
  private readonly driver: SpeechHostDriver
  private nextId = 1
  /** The endpoint each utterance came from (`Utterance.owner` is the extension): its events go there. */
  private readonly askers = new Map<
    number,
    { extensionId: string; endpointId: string; web: boolean }
  >()
  private voicesWatched: SpeechHost | null = null

  constructor(private readonly host: TtsHost) {
    this.driver = new SpeechHostDriver(
      host,
      (id, event) => this.queue.engineEvent(id, event),
      () => this.queue.stop()
    )
    this.queue = new TtsQueue(this.driver, (utterance, event) => this.deliver(utterance, event))
  }

  /**
   * A `chrome.tts` call, or (`web`) the same call from a page's `speechSynthesis`
   * (extensionSpeechSynthesis.ts): the Web Speech API needs no permission, as in Chrome, and
   * its utterances share the one queue and engine with `chrome.tts` and read aloud.
   */
  call(
    extensionId: string,
    endpointId: string,
    method: string,
    args: unknown[],
    web = false
  ): unknown {
    if (!web && !this.host.hasPermission(extensionId)) throw new Error(ERROR_NO_PERMISSION)
    switch (method) {
      case 'speak':
        this.speak(extensionId, endpointId, args[0], args[1], args[2], web)
        return undefined
      case 'stop':
        this.queue.stop()
        return undefined
      case 'pause':
        this.queue.pause()
        return undefined
      case 'resume':
        this.queue.resume()
        return undefined
      case 'isSpeaking':
        return this.queue.isSpeaking()
      case 'getVoices':
        return this.voices()
    }
    throw new Error(
      `${web ? 'speechSynthesis' : 'chrome.tts'}.${method} is not implemented on Zenium for Android`
    )
  }

  /** The extension went away (disabled, removed): its speech stops and its queued utterances go without a word. */
  forget(extensionId: string): void {
    this.queue.removeOwner(extensionId)
    for (const [id, asker] of [...this.askers])
      if (asker.extensionId === extensionId) this.askers.delete(id)
  }

  /** The engine's voices in Chrome's shape; none without an engine. */
  async voices(): Promise<TtsVoice[]> {
    const speech = this.host.speech()
    if (!speech) return []
    this.watchVoices(speech)
    const voices = await speech.voices()
    return voices.map(ttsVoiceFrom)
  }

  /** What the driver is on, for the debug stats and tests. */
  speaking(): { id: number; paused: boolean; offset: number } | null {
    return this.driver.current()
  }

  private watchVoices(speech: SpeechHost): void {
    if (this.voicesWatched === speech) return
    this.voicesWatched = speech
    speech.onVoicesChanged(() => this.host.voicesChanged())
  }

  private speak(
    extensionId: string,
    endpointId: string,
    rawUtterance: unknown,
    rawOptions: unknown,
    rawToken: unknown,
    web: boolean
  ): void {
    let text: string
    let options: Utterance['options']
    try {
      text = normalizeUtterance(rawUtterance)
      options = normalizeSpeakOptions(rawOptions)
    } catch (error) {
      if (error instanceof TtsError) throw new Error(error.message)
      throw error
    }
    const id = this.nextId++
    this.askers.set(id, { extensionId, endpointId, web })
    this.queue.speak({
      id,
      text,
      options,
      owner: extensionId,
      token: typeof rawToken === 'string' ? rawToken : null
    })
  }

  private deliver(utterance: Utterance, event: TtsEvent): void {
    const asker = this.askers.get(utterance.id)
    if (event.isFinalEvent) this.askers.delete(utterance.id)
    if (utterance.token === null || asker === undefined) return
    if (!this.host.endpointAlive(asker.endpointId)) return
    this.host.emit(utterance.owner, asker.endpointId, [utterance.token, event], asker.web)
  }
}
