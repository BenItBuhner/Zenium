import type { SpeechHost, SpeechHostEvent, SpeechUtteranceOptions } from '../../core/platform'
import type { EngineEvent, TtsVoice } from '../../core/extensions/api/tts'
import { sanitizeReadAloudRate, type ReadAloudVoice } from '../../shared/readAloud'
import type { SpeechEngine } from './extensionApi/tts'

/**
 * Read aloud's speech host on the desktop (`Platform.speech`): an adapter over the `chrome.tts`
 * engine – the hidden page holding Chromium's `speechSynthesis` (`extensionApi/ttsBridge.ts`),
 * shared with the extension API rather than a second hidden page. One utterance at a time:
 * `speak` cancels what is speaking first (`speechSynthesis.speak` would queue behind it), and
 * events for anything but the current utterance are dropped, the cancelled one's `interrupted`
 * error included. Utterance ids are negative so they never meet the extension queue's (1, 2, …)
 * on the one event stream.
 *
 * Word boundaries are estimated where the engine offers none (`WordBoundaryEstimate`): Chromium's
 * speech-dispatcher backend on Linux (`tts_linux.cc`) never emits `boundary` events, so read
 * aloud's word follow would never run there. A voice that has reported a boundary is left to the
 * engine for good; for any other, the host arms a timer at the first word's expected end on
 * `start` and, if no boundary has arrived by then, emits `word` events for the utterance's
 * whitespace-delimited words at their character-proportional times, over a chars-per-second
 * estimate per voice and rate (`SpeakingRateModel`) that each finished utterance's measured
 * `start`→`end` calibrates. Whatever remains is emitted, in order, just before `end`; `error`,
 * `stop` and a new `speak` drop the schedule, `pause` and `resume` suspend and continue it. The
 * events are the engine's shape (`charIndex` / `length`); the core cannot tell them apart.
 */
export class ElectronSpeechHost implements SpeechHost {
  private nextId = -1
  private current: CurrentUtterance | null = null
  private readonly listeners: Array<(utteranceId: string, event: SpeechHostEvent) => void> = []
  /** What each voice has been seen to do about word boundaries (`voiceKey`). */
  private readonly boundaries = new Map<string, 'engine' | 'none'>()
  readonly rates = new SpeakingRateModel()

  constructor(private readonly engine: SpeechEngine) {
    engine.onEvent((id, event) => this.onEngineEvent(id, event))
  }

  async voices(): Promise<ReadAloudVoice[]> {
    const voices = await this.engine.voices()
    return voices.map(voiceFromTts)
  }

  /** The engine lists again (`speechSynthesis.getVoices()` anew) for a re-ask after an empty first answer. */
  async refreshVoices(): Promise<ReadAloudVoice[]> {
    const voices = this.engine.refreshVoices
      ? await this.engine.refreshVoices()
      : await this.engine.voices()
    return voices.map(voiceFromTts)
  }

  onVoicesChanged(listener: () => void): void {
    this.engine.onVoicesChanged(listener)
  }

  speak(utteranceId: string, text: string, options: SpeechUtteranceOptions): void {
    if (this.current) {
      this.dropEstimate(this.current)
      this.engine.cancel()
    }
    const id = this.nextId--
    const rate = sanitizeReadAloudRate(options.rate)
    this.current = {
      id,
      utteranceId,
      text,
      voice: voiceKey(options),
      rate,
      startedAt: null,
      pausedAt: null,
      pausedMs: 0,
      reported: false,
      estimate: null
    }
    this.engine.speak(id, text, {
      ...(options.voiceId ? { voiceName: options.voiceId } : {}),
      ...(options.lang ? { lang: options.lang } : {}),
      rate,
      ...(options.pitch !== undefined ? { pitch: options.pitch } : {}),
      ...(options.volume !== undefined ? { volume: options.volume } : {})
    })
  }

  stop(): void {
    if (!this.current) return
    this.dropEstimate(this.current)
    this.current = null
    this.engine.cancel()
  }

  pause(): void {
    if (!this.current) return
    this.suspendEstimate(this.current)
    this.engine.pause()
  }

  resume(): void {
    if (!this.current) return
    this.engine.resume()
    this.continueEstimate(this.current)
  }

  onEvent(listener: (utteranceId: string, event: SpeechHostEvent) => void): void {
    this.listeners.push(listener)
  }

  private onEngineEvent(id: number, event: EngineEvent): void {
    const current = this.current
    if (!current || current.id !== id) return
    switch (event.type) {
      case 'pause':
        this.suspendEstimate(current)
        return
      case 'resume':
        this.continueEstimate(current)
        return
    }
    const mapped = speechHostEvent(event)
    if (!mapped) return
    const now = Date.now()
    switch (mapped.type) {
      case 'start':
        // The speaking is measured from here; a pause that began before it (the user pausing
        // as the engine was still getting the utterance ready) counts from here too.
        current.startedAt = now
        current.pausedMs = 0
        if (current.pausedAt !== null) current.pausedAt = now
        this.deliver(current, mapped)
        if (this.current === current) this.armEstimate(current, now)
        return
      case 'word':
        // The engine reports boundaries for this voice: its own are the truth, from now on.
        current.reported = true
        this.boundaries.set(current.voice, 'engine')
        this.dropEstimate(current)
        this.deliver(current, mapped)
        return
      case 'end': {
        if (current.startedAt !== null) {
          this.rates.observe(current.voice, current.rate, current.text.length, spoken(current, now))
          if (!current.reported && !this.boundaries.has(current.voice))
            this.boundaries.set(current.voice, 'none')
        }
        // The words the estimate still owes, before the end (the last word no later than it).
        if (current.estimate) this.emitDue(current, Infinity)
        this.dropEstimate(current)
        this.current = null
        this.deliver(current, mapped)
        return
      }
      case 'error':
        this.dropEstimate(current)
        this.current = null
        this.deliver(current, mapped)
        return
    }
  }

  private deliver(current: CurrentUtterance, event: SpeechHostEvent): void {
    for (const listener of this.listeners) listener(current.utteranceId, event)
  }

  /**
   * The utterance started: unless the voice reports boundaries, wait for the first word's
   * expected end to see whether one comes (a voice that never has is not waited for again).
   */
  private armEstimate(current: CurrentUtterance, now: number): void {
    const known = this.boundaries.get(current.voice)
    if (known === 'engine' || current.reported) return
    const words = wordSpans(current.text)
    if (words.length === 0) return
    current.estimate = {
      words,
      next: 0,
      charsPerSecond: this.rates.charsPerSecond(current.voice, current.rate),
      timer: null
    }
    if (known === 'none') {
      this.advanceEstimate(current, now)
      return
    }
    const first = words[0]
    this.scheduleEstimate(
      current,
      ((first.charIndex + first.length) * 1000) / current.estimate.charsPerSecond
    )
  }

  /** Emit the words due by now and wait for the next; nothing while paused. */
  private advanceEstimate(current: CurrentUtterance, now: number): void {
    const estimate = current.estimate
    if (!estimate || current.pausedAt !== null) return
    const elapsed = spoken(current, now)
    this.emitDue(current, elapsed)
    if (this.current !== current || !current.estimate) return
    const next = estimate.words[estimate.next]
    if (!next) {
      current.estimate = null
      return
    }
    this.scheduleEstimate(current, wordDueMs(next, estimate.charsPerSecond) - elapsed)
  }

  private scheduleEstimate(current: CurrentUtterance, inMs: number): void {
    const estimate = current.estimate
    if (!estimate) return
    if (estimate.timer !== null) clearTimeout(estimate.timer)
    estimate.timer = setTimeout(
      () => {
        estimate.timer = null
        if (this.current === current) this.advanceEstimate(current, Date.now())
      },
      Math.max(0, Math.ceil(inMs))
    )
  }

  /** The words whose time has come (all of them for `Infinity`), in order, as `word` events. */
  private emitDue(current: CurrentUtterance, elapsedMs: number): void {
    const estimate = current.estimate
    if (!estimate) return
    while (this.current === current && current.estimate === estimate) {
      const word = estimate.words[estimate.next]
      if (!word || wordDueMs(word, estimate.charsPerSecond) > elapsedMs + 1) return
      estimate.next++
      this.deliver(current, { type: 'word', charIndex: word.charIndex, length: word.length })
    }
  }

  private suspendEstimate(current: CurrentUtterance): void {
    if (current.pausedAt !== null) return
    current.pausedAt = Date.now()
    const estimate = current.estimate
    if (estimate && estimate.timer !== null) {
      clearTimeout(estimate.timer)
      estimate.timer = null
    }
  }

  private continueEstimate(current: CurrentUtterance): void {
    if (current.pausedAt === null) return
    const now = Date.now()
    current.pausedMs += now - current.pausedAt
    current.pausedAt = null
    if (current.estimate) this.advanceEstimate(current, now)
  }

  private dropEstimate(current: CurrentUtterance): void {
    const estimate = current.estimate
    if (!estimate) return
    if (estimate.timer !== null) clearTimeout(estimate.timer)
    current.estimate = null
  }
}

/** The utterance the host is speaking, and what it knows of its timing. */
interface CurrentUtterance {
  id: number
  utteranceId: string
  text: string
  /** The voice's key in the host's memory (`voiceKey`). */
  voice: string
  rate: number
  /** `Date.now()` at the engine's `start`; null until then. */
  startedAt: number | null
  /** `Date.now()` at the pause under way; null while speaking. */
  pausedAt: number | null
  /** Time spent paused before the pause under way. */
  pausedMs: number
  /** Whether the engine has reported a word boundary for this utterance. */
  reported: boolean
  estimate: WordBoundaryEstimate | null
}

/** The schedule of estimated word boundaries for an utterance (`ElectronSpeechHost`). */
interface WordBoundaryEstimate {
  words: WordSpan[]
  /** The next word to emit. */
  next: number
  charsPerSecond: number
  timer: ReturnType<typeof setTimeout> | null
}

/** How long the utterance has been speaking (pauses left out) at `now`. */
function spoken(current: CurrentUtterance, now: number): number {
  const since = current.startedAt === null ? 0 : now - current.startedAt
  const paused = current.pausedMs + (current.pausedAt === null ? 0 : now - current.pausedAt)
  return Math.max(0, since - paused)
}

/** When a word is expected to begin, from the utterance's `start`, at a speaking rate. */
function wordDueMs(word: WordSpan, charsPerSecond: number): number {
  return (word.charIndex * 1000) / charsPerSecond
}

/** The voice an utterance speaks with, as the host remembers what it does: the id, or the engine's default for the language. */
function voiceKey(options: SpeechUtteranceOptions): string {
  return options.voiceId ?? `lang:${options.lang}`
}

/** A word of an utterance as a `word` event names it. */
export interface WordSpan {
  charIndex: number
  length: number
}

/** The whitespace-delimited words of an utterance, in order, with their spans. */
export function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = []
  const words = /\S+/g
  for (let match = words.exec(text); match !== null; match = words.exec(text))
    spans.push({ charIndex: match.index, length: match[0].length })
  return spans
}

/** Characters per second a voice is taken to speak at rate 1 until it has been measured. */
export const DEFAULT_CHARS_PER_SECOND = 15
/** How far each measured utterance moves the estimate (an exponential moving average). */
const CALIBRATION_WEIGHT = 0.5
/** Utterances shorter than this, in characters or in time, say more about the engine's latency than its pace. */
const MIN_MEASURED_CHARS = 8
const MIN_MEASURED_MS = 250
const MIN_CHARS_PER_SECOND = 1
const MAX_CHARS_PER_SECOND = 100

/**
 * How fast each voice speaks at each rate, in characters per second: the default scaled by the
 * rate until an utterance of the voice at that rate has ended, then the measured pace, moved by
 * half of each further measurement (`start`→`end`, pauses left out). Short utterances are not
 * measured: the engine's fixed latency dominates them.
 */
export class SpeakingRateModel {
  private readonly measured = new Map<string, number>()

  charsPerSecond(voice: string, rate: number): number {
    return this.measured.get(rateKey(voice, rate)) ?? DEFAULT_CHARS_PER_SECOND * rate
  }

  /** An utterance of `chars` characters by `voice` at `rate` took `ms` of speaking. */
  observe(voice: string, rate: number, chars: number, ms: number): void {
    if (chars < MIN_MEASURED_CHARS || ms < MIN_MEASURED_MS) return
    const measured = Math.min(
      MAX_CHARS_PER_SECOND,
      Math.max(MIN_CHARS_PER_SECOND, (chars * 1000) / ms)
    )
    const key = rateKey(voice, rate)
    const previous = this.measured.get(key)
    this.measured.set(
      key,
      previous === undefined ? measured : previous + CALIBRATION_WEIGHT * (measured - previous)
    )
  }
}

function rateKey(voice: string, rate: number): string {
  return `${voice}\n${rate}`
}

/** A `chrome.tts` voice as read aloud lists it: the name is the id, `remote` is `!local`. */
export function voiceFromTts(voice: TtsVoice): ReadAloudVoice {
  return { id: voice.voiceName, name: voice.voiceName, lang: voice.lang, local: !voice.remote }
}

/**
 * The engine's event as the speech host's: `word` boundaries with their span, `end`, `error`
 * (an interruption by another speaker counts as one, so the core does not wait for an `end`
 * that never comes); `sentence`, `marker`, `pause` and `resume` say nothing the core needs.
 */
export function speechHostEvent(event: EngineEvent): SpeechHostEvent | null {
  switch (event.type) {
    case 'start':
      return { type: 'start' }
    case 'word': {
      const word: SpeechHostEvent = { type: 'word', charIndex: event.charIndex ?? 0 }
      if (event.length !== undefined) word.length = event.length
      return word
    }
    case 'end':
      return { type: 'end' }
    case 'error':
      return { type: 'error', message: event.errorMessage || 'synthesis-failed' }
    case 'interrupted':
    case 'cancelled':
      return { type: 'error', message: event.type }
    default:
      return null
  }
}
