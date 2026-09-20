import { describe, expect, it } from 'vitest'
import { ElectronSpeechHost, speechHostEvent, voiceFromTts } from '../speech'
import type { SpeechEngine } from '../extensionApi/tts'
import type { EngineEvent, EngineSpeakOptions, TtsVoice } from '../../../core/extensions/api/tts'
import type { SpeechHostEvent } from '../../../core/platform'

/** The hidden page's `speechSynthesis`, scripted: what it was told, and the events it sends back. */
class FakeEngine implements SpeechEngine {
  spoken: Array<{ id: number; text: string; options: EngineSpeakOptions }> = []
  cancels = 0
  pauses = 0
  resumes = 0
  voiceList: TtsVoice[] = [
    { voiceName: 'Samantha', lang: 'en-US', remote: false, eventTypes: ['start', 'end', 'word'] },
    { voiceName: 'Google français', lang: 'fr-FR', remote: true, eventTypes: ['start', 'end'] }
  ]
  private listeners: Array<(id: number, event: EngineEvent) => void> = []
  private voicesListeners: Array<() => void> = []

  speak(id: number, text: string, options: EngineSpeakOptions): void {
    this.spoken.push({ id, text, options })
  }
  cancel(): void {
    this.cancels++
  }
  pause(): void {
    this.pauses++
  }
  resume(): void {
    this.resumes++
  }
  voices(): Promise<TtsVoice[]> {
    return Promise.resolve(this.voiceList)
  }
  onEvent(listener: (id: number, event: EngineEvent) => void): void {
    this.listeners.push(listener)
  }
  onVoicesChanged(listener: () => void): void {
    this.voicesListeners.push(listener)
  }

  emit(id: number, event: EngineEvent): void {
    for (const l of this.listeners) l(id, event)
  }
  changeVoices(): void {
    for (const l of this.voicesListeners) l()
  }
  get lastId(): number {
    return this.spoken[this.spoken.length - 1].id
  }
}

function host(): {
  engine: FakeEngine
  host: ElectronSpeechHost
  events: Array<[string, SpeechHostEvent]>
} {
  const engine = new FakeEngine()
  const h = new ElectronSpeechHost(engine)
  const events: Array<[string, SpeechHostEvent]> = []
  h.onEvent((utteranceId, event) => events.push([utteranceId, event]))
  return { engine, host: h, events }
}

describe('ElectronSpeechHost', () => {
  it('lists the engine’s voices as read aloud’s, the name as the id, and passes on their changes', async () => {
    const { engine, host: h } = host()
    expect(await h.voices()).toEqual([
      { id: 'Samantha', name: 'Samantha', lang: 'en-US', local: true },
      { id: 'Google français', name: 'Google français', lang: 'fr-FR', local: false }
    ])
    let changes = 0
    h.onVoicesChanged(() => changes++)
    engine.changeVoices()
    expect(changes).toBe(1)
  })

  it('speaks with a negative id, the voice, language and rate; a second utterance cancels the first', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', 'First sentence.', { voiceId: 'Samantha', lang: 'en-US', rate: 1.2 })
    expect(engine.cancels).toBe(0)
    expect(engine.spoken[0]).toEqual({
      id: -1,
      text: 'First sentence.',
      options: { voiceName: 'Samantha', lang: 'en-US', rate: 1.2 }
    })
    engine.emit(-1, { type: 'start' })
    h.speak('ra2', 'Second.', { voiceId: null, lang: 'fr', rate: 1 })
    expect(engine.cancels).toBe(1)
    expect(engine.spoken[1]).toEqual({ id: -2, text: 'Second.', options: { lang: 'fr', rate: 1 } })
    // The cancelled one's farewell is not the new one's error.
    engine.emit(-1, { type: 'interrupted' })
    engine.emit(-2, { type: 'start' })
    expect(events).toEqual([
      ['ra1', { type: 'start' }],
      ['ra2', { type: 'start' }]
    ])
  })

  it('maps the events of the current utterance and drops everyone else’s', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', 'Hello wide world.', { voiceId: 'Samantha', lang: 'en', rate: 1 })
    engine.emit(1, { type: 'start' }) // the extension queue's utterance on the same stream
    engine.emit(-1, { type: 'start' })
    engine.emit(-1, { type: 'word', charIndex: 6, length: 4 })
    engine.emit(-1, { type: 'sentence', charIndex: 0, length: 17 })
    engine.emit(-1, { type: 'word', charIndex: 11 })
    engine.emit(-1, { type: 'end' })
    engine.emit(-1, { type: 'end' }) // nothing more after the end
    expect(events).toEqual([
      ['ra1', { type: 'start' }],
      ['ra1', { type: 'word', charIndex: 6, length: 4 }],
      ['ra1', { type: 'word', charIndex: 11 }],
      ['ra1', { type: 'end' }]
    ])
    // After the end nothing is speaking: the next utterance cancels nothing.
    h.speak('ra2', 'Next.', { voiceId: 'Samantha', lang: 'en', rate: 1 })
    expect(engine.cancels).toBe(0)
  })

  it('reports the engine’s error with its message, and an interruption from elsewhere as one', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', 'One.', { voiceId: null, lang: 'en', rate: 1 })
    engine.emit(-1, { type: 'error', errorMessage: 'synthesis-unavailable' })
    h.speak('ra2', 'Two.', { voiceId: null, lang: 'en', rate: 1 })
    engine.emit(-2, { type: 'interrupted' })
    h.speak('ra3', 'Three.', { voiceId: null, lang: 'en', rate: 1 })
    engine.emit(-3, { type: 'error' })
    expect(events).toEqual([
      ['ra1', { type: 'error', message: 'synthesis-unavailable' }],
      ['ra2', { type: 'error', message: 'interrupted' }],
      ['ra3', { type: 'error', message: 'synthesis-failed' }]
    ])
    // An error ends the utterance: the next one cancels nothing.
    expect(engine.cancels).toBe(0)
  })

  it('stop cancels once and forgets the utterance; pause and resume reach the engine only while one speaks', () => {
    const { engine, host: h, events } = host()
    h.pause()
    h.resume()
    h.stop()
    expect([engine.pauses, engine.resumes, engine.cancels]).toEqual([0, 0, 0])
    h.speak('ra1', 'One.', { voiceId: null, lang: 'en', rate: 1 })
    h.pause()
    h.resume()
    expect([engine.pauses, engine.resumes]).toEqual([1, 1])
    h.stop()
    h.stop()
    expect(engine.cancels).toBe(1)
    engine.emit(-1, { type: 'cancelled' })
    expect(events).toEqual([])
    h.pause()
    expect(engine.pauses).toBe(1)
  })
})

describe('voiceFromTts and speechHostEvent', () => {
  it('a remote voice is not local', () => {
    expect(
      voiceFromTts({ voiceName: 'Cloud', lang: 'de-DE', remote: true, eventTypes: [] })
    ).toEqual({ id: 'Cloud', name: 'Cloud', lang: 'de-DE', local: false })
  })

  it('keeps start, word, end and the errors; says nothing for the rest', () => {
    expect(speechHostEvent({ type: 'start' })).toEqual({ type: 'start' })
    expect(speechHostEvent({ type: 'word', charIndex: 3, length: 2 })).toEqual({
      type: 'word',
      charIndex: 3,
      length: 2
    })
    expect(speechHostEvent({ type: 'word' })).toEqual({ type: 'word', charIndex: 0 })
    expect(speechHostEvent({ type: 'end' })).toEqual({ type: 'end' })
    expect(speechHostEvent({ type: 'cancelled' })).toEqual({ type: 'error', message: 'cancelled' })
    for (const type of ['sentence', 'marker', 'pause', 'resume'] as const) {
      expect(speechHostEvent({ type })).toBeNull()
    }
  })
})
