/**
 * `chrome.tts`, the pure part: Chrome's `SpeakOptions` validation with its error strings, the
 * `TtsEvent` and `TtsVoice` shapes, and the utterance queue with Chrome's `TtsController`
 * semantics (interrupt unless `enqueue`, pause holds new utterances, final events pop the next
 * one) over an engine that speaks one utterance at a time.
 */

export const TTS_EVENT_TYPES = [
  'start',
  'end',
  'word',
  'sentence',
  'marker',
  'interrupted',
  'cancelled',
  'error',
  'pause',
  'resume'
] as const

export type TtsEventType = (typeof TTS_EVENT_TYPES)[number]

/** After one of these nothing more is said about the utterance. */
const FINAL_EVENT_TYPES: ReadonlySet<TtsEventType> = new Set([
  'end',
  'interrupted',
  'cancelled',
  'error'
])

export interface TtsEvent {
  type: TtsEventType
  charIndex: number
  /** `word` / `sentence`: how many characters the boundary spans. */
  length?: number
  errorMessage?: string
  isFinalEvent: boolean
}

/** What the engine reports about the utterance it is speaking; the queue fills the rest in. */
export interface EngineEvent {
  type: TtsEventType
  charIndex?: number
  length?: number
  errorMessage?: string
}

export interface TtsVoice {
  voiceName: string
  lang: string
  remote: boolean
  extensionId?: string
  eventTypes: TtsEventType[]
}

export interface SpeakOptions {
  enqueue: boolean
  voiceName?: string
  lang?: string
  rate?: number
  pitch?: number
  volume?: number
  requiredEventTypes?: TtsEventType[]
  desiredEventTypes?: TtsEventType[]
}

/** What the engine needs of the options: voice choice and prosody. */
export type EngineSpeakOptions = Pick<
  SpeakOptions,
  'voiceName' | 'lang' | 'rate' | 'pitch' | 'volume'
>

export const MAX_UTTERANCE_LENGTH = 32_768

export const ERROR_UTTERANCE_TOO_LONG = 'Utterance length is too long.'
export const ERROR_INVALID_RATE = 'Invalid rate.'
export const ERROR_INVALID_PITCH = 'Invalid pitch.'
export const ERROR_INVALID_VOLUME = 'Invalid volume.'
export const ERROR_INVALID_LANG = 'Invalid lang.'
export const ERROR_INVALID_OPTIONS = 'Invalid options'
export const ERROR_NO_PERMISSION = "The extension does not have the 'tts' permission."

export class TtsError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeUtterance(raw: unknown): string {
  if (typeof raw !== 'string') throw new TtsError(ERROR_INVALID_OPTIONS)
  if (raw.length > MAX_UTTERANCE_LENGTH) throw new TtsError(ERROR_UTTERANCE_TOO_LONG)
  return raw
}

function numberIn(raw: unknown, min: number, max: number, error: string): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new TtsError(error)
  }
  return raw
}

function eventTypes(raw: unknown, key: string): TtsEventType[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new TtsError(`${ERROR_INVALID_OPTIONS}: ${key}`)
  const out: TtsEventType[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !(TTS_EVENT_TYPES as readonly string[]).includes(value)) {
      throw new TtsError(`${ERROR_INVALID_OPTIONS}: ${key}`)
    }
    out.push(value as TtsEventType)
  }
  return out
}

/** Chrome's checks, in Chrome's words; `gender` and `extensionId` are accepted and ignored. */
export function normalizeSpeakOptions(raw: unknown): SpeakOptions {
  if (raw === undefined || raw === null) return { enqueue: false }
  if (!isRecord(raw)) throw new TtsError(ERROR_INVALID_OPTIONS)
  const options: SpeakOptions = { enqueue: raw.enqueue === true }
  if (raw.enqueue !== undefined && typeof raw.enqueue !== 'boolean') {
    throw new TtsError(`${ERROR_INVALID_OPTIONS}: enqueue`)
  }
  if (raw.voiceName !== undefined) {
    if (typeof raw.voiceName !== 'string') throw new TtsError(`${ERROR_INVALID_OPTIONS}: voiceName`)
    if (raw.voiceName) options.voiceName = raw.voiceName
  }
  if (raw.lang !== undefined) {
    if (typeof raw.lang !== 'string') throw new TtsError(`${ERROR_INVALID_OPTIONS}: lang`)
    if (raw.lang) {
      if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(raw.lang))
        throw new TtsError(ERROR_INVALID_LANG)
      options.lang = raw.lang
    }
  }
  const rate = numberIn(raw.rate, 0.1, 10, ERROR_INVALID_RATE)
  if (rate !== undefined) options.rate = rate
  const pitch = numberIn(raw.pitch, 0, 2, ERROR_INVALID_PITCH)
  if (pitch !== undefined) options.pitch = pitch
  const volume = numberIn(raw.volume, 0, 1, ERROR_INVALID_VOLUME)
  if (volume !== undefined) options.volume = volume
  const required = eventTypes(raw.requiredEventTypes, 'requiredEventTypes')
  if (required) options.requiredEventTypes = required
  const desired = eventTypes(raw.desiredEventTypes, 'desiredEventTypes')
  if (desired) options.desiredEventTypes = desired
  return options
}

export function engineOptions(options: SpeakOptions): EngineSpeakOptions {
  const out: EngineSpeakOptions = {}
  if (options.voiceName !== undefined) out.voiceName = options.voiceName
  if (options.lang !== undefined) out.lang = options.lang
  if (options.rate !== undefined) out.rate = options.rate
  if (options.pitch !== undefined) out.pitch = options.pitch
  if (options.volume !== undefined) out.volume = options.volume
  return out
}

// ---------------------------------------------------------------------------
// The wire between the host and the hidden speech page
// ---------------------------------------------------------------------------

export const TTS_COMMAND_CHANNEL = 'zen-tts:command'
export const TTS_REPORT_CHANNEL = 'zen-tts:report'

export type SpeechCommand =
  | ({ kind: 'speak'; id: number; text: string } & EngineSpeakOptions)
  | { kind: 'cancel' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'voices' }

export type SpeechReport =
  | { kind: 'ready'; voices: TtsVoice[] }
  | { kind: 'voices'; voices: TtsVoice[] }
  | { kind: 'event'; id: number; event: EngineEvent }

/** What a `speechSynthesis` voice can report, as `TtsVoice.eventTypes`. */
export const WEB_SPEECH_EVENT_TYPES: readonly TtsEventType[] = [
  'start',
  'end',
  'word',
  'sentence',
  'marker',
  'interrupted',
  'cancelled',
  'error',
  'pause',
  'resume'
]

/** A `speechSynthesis` voice as Chrome lists it. */
export function voiceFromWebSpeech(voice: {
  name: string
  lang: string
  localService: boolean
}): TtsVoice {
  return {
    voiceName: voice.name,
    lang: voice.lang,
    remote: !voice.localService,
    eventTypes: [...WEB_SPEECH_EVENT_TYPES]
  }
}

/**
 * The `speechSynthesis` voice for an utterance: the one named, else the first whose language
 * matches (`en-US` before `en`), else none (the engine's default).
 */
export function pickWebSpeechVoice<V extends { name: string; lang: string }>(
  voices: readonly V[],
  options: EngineSpeakOptions
): V | null {
  if (options.voiceName) {
    const named = voices.find((v) => v.name === options.voiceName)
    if (named) return named
  }
  if (options.lang) {
    const wanted = options.lang.toLowerCase().replace(/_/g, '-')
    const exact = voices.find((v) => v.lang.toLowerCase().replace(/_/g, '-') === wanted)
    if (exact) return exact
    const primary = wanted.split('-')[0]
    const same = voices.find(
      (v) => v.lang.toLowerCase().replace(/_/g, '-').split('-')[0] === primary
    )
    if (same) return same
  }
  return null
}

/** A `SpeechSynthesisUtterance` event, as the queue's `EngineEvent`. */
export function engineEventFromWebSpeech(
  type: string,
  detail: { charIndex?: number; charLength?: number; name?: string; error?: string }
): EngineEvent | null {
  const at = detail.charIndex ?? 0
  switch (type) {
    case 'start':
      return { type: 'start', charIndex: at }
    case 'end':
      return { type: 'end' }
    case 'error':
      return { type: 'error', charIndex: at, errorMessage: detail.error ?? 'synthesis-failed' }
    case 'boundary': {
      const event: EngineEvent = {
        type: detail.name === 'sentence' ? 'sentence' : 'word',
        charIndex: at
      }
      if (detail.charLength !== undefined) event.length = detail.charLength
      return event
    }
    case 'mark':
      return { type: 'marker', charIndex: at }
    case 'pause':
      return { type: 'pause', charIndex: at }
    case 'resume':
      return { type: 'resume', charIndex: at }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface Utterance {
  id: number
  text: string
  options: SpeakOptions
  /** Who asked (an extension id); its utterances go when it does. */
  owner: string
  /** The caller's handle for `options.onEvent`, null when it gave none. */
  token: string | null
}

/** The one-utterance-at-a-time engine the queue drives. */
export interface EngineDriver {
  speak(id: number, text: string, options: EngineSpeakOptions): void
  /** Stop the utterance being spoken, if any. */
  cancel(): void
  pause(): void
  resume(): void
}

/**
 * Chrome's `TtsController` rules: a new utterance interrupts what is speaking (`interrupted`)
 * and empties the queue (`cancelled`) unless it asks to `enqueue`; while paused, new utterances
 * wait; `stop` empties everything and lifts the pause; a final event from the engine moves on
 * to the next utterance. Events pass through the utterance's `desiredEventTypes` filter and
 * get `charIndex` and `isFinalEvent` filled in.
 */
export class TtsQueue {
  private current: Utterance | null = null
  private pending: Utterance[] = []
  private paused = false

  constructor(
    private readonly engine: EngineDriver,
    private readonly emit: (utterance: Utterance, event: TtsEvent) => void
  ) {}

  speak(utterance: Utterance): void {
    if (this.paused || (this.current !== null && utterance.options.enqueue)) {
      this.pending.push(utterance)
      return
    }
    this.stop()
    this.speakNow(utterance)
  }

  stop(): void {
    const current = this.current
    const pending = this.pending
    this.current = null
    this.pending = []
    this.paused = false
    if (current) {
      this.engine.cancel()
      this.fire(current, { type: 'interrupted' })
    }
    for (const utterance of pending) this.fire(utterance, { type: 'cancelled' })
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    if (this.current) this.engine.pause()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (this.current) this.engine.resume()
    else this.next()
  }

  isSpeaking(): boolean {
    return this.current !== null
  }

  isPaused(): boolean {
    return this.paused
  }

  /** What the engine says about utterance `id`; anything but the current one is stale. */
  engineEvent(id: number, event: EngineEvent): void {
    const current = this.current
    if (!current || current.id !== id) return
    const final = FINAL_EVENT_TYPES.has(event.type)
    if (final) this.current = null
    this.fire(current, event)
    if (final) this.next()
  }

  /** An owner went away: its speech stops, its queued utterances are dropped without a word. */
  removeOwner(owner: string): void {
    this.pending = this.pending.filter((u) => u.owner !== owner)
    if (this.current?.owner === owner) {
      this.current = null
      this.engine.cancel()
      this.next()
    }
  }

  private next(): void {
    if (this.paused || this.current) return
    const utterance = this.pending.shift()
    if (utterance) this.speakNow(utterance)
  }

  private speakNow(utterance: Utterance): void {
    this.current = utterance
    this.engine.speak(utterance.id, utterance.text, engineOptions(utterance.options))
  }

  private fire(utterance: Utterance, event: EngineEvent): void {
    const desired = utterance.options.desiredEventTypes
    if (desired && desired.length > 0 && !desired.includes(event.type)) return
    const full: TtsEvent = {
      type: event.type,
      charIndex: event.charIndex ?? (event.type === 'end' ? utterance.text.length : 0),
      isFinalEvent: FINAL_EVENT_TYPES.has(event.type)
    }
    if (event.length !== undefined) full.length = event.length
    if (event.errorMessage !== undefined) full.errorMessage = event.errorMessage
    this.emit(utterance, full)
  }
}
