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
 */
export class ElectronSpeechHost implements SpeechHost {
  private nextId = -1
  private current: { id: number; utteranceId: string } | null = null
  private readonly listeners: Array<(utteranceId: string, event: SpeechHostEvent) => void> = []

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
    if (this.current) this.engine.cancel()
    const id = this.nextId--
    this.current = { id, utteranceId }
    this.engine.speak(id, text, {
      ...(options.voiceId ? { voiceName: options.voiceId } : {}),
      ...(options.lang ? { lang: options.lang } : {}),
      rate: sanitizeReadAloudRate(options.rate)
    })
  }

  stop(): void {
    if (!this.current) return
    this.current = null
    this.engine.cancel()
  }

  pause(): void {
    if (this.current) this.engine.pause()
  }

  resume(): void {
    if (this.current) this.engine.resume()
  }

  onEvent(listener: (utteranceId: string, event: SpeechHostEvent) => void): void {
    this.listeners.push(listener)
  }

  private onEngineEvent(id: number, event: EngineEvent): void {
    const current = this.current
    if (!current || current.id !== id) return
    const mapped = speechHostEvent(event)
    if (!mapped) return
    if (mapped.type === 'end' || mapped.type === 'error') this.current = null
    for (const listener of this.listeners) listener(current.utteranceId, mapped)
  }
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
