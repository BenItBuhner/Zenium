import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CHARS_PER_SECOND,
  ElectronSpeechHost,
  SpeakingRateModel,
  speechHostEvent,
  voiceFromTts,
  wordSpans
} from '../speech'
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

/**
 * Word boundaries where the engine offers none (Linux's speech-dispatcher backend fires `start`
 * and `end` alone): estimated from the utterance's words at character-proportional times, the
 * engine's own boundaries winning whenever they exist.
 */
describe('ElectronSpeechHost’s estimated word boundaries', () => {
  // "The quick brown fox jumps over the lazy dog." – its words begin at these offsets.
  const PANGRAM = 'The quick brown fox jumps over the lazy dog.'
  const STARTS = [0, 4, 10, 16, 20, 26, 31, 35, 40]
  const EN: { voiceId: string; lang: string; rate: number } = {
    voiceId: 'English (America) espeak-ng',
    lang: 'en-US',
    rate: 1
  }
  /** When each word is due at the default pace (15 chars/s at rate 1), in ms from `start`. */
  const due = (charIndex: number, charsPerSecond = DEFAULT_CHARS_PER_SECOND): number =>
    (charIndex * 1000) / charsPerSecond
  const words = (events: Array<[string, SpeechHostEvent]>): number[] =>
    events.filter(([, e]) => e.type === 'word').map(([, e]) => e.charIndex ?? -1)
  const types = (events: Array<[string, SpeechHostEvent]>): string[] =>
    events.map(([, e]) => e.type)

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the first word’s expected end, then emits the words in order at their proportional times, the rest before end', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    expect(types(events)).toEqual(['start'])
    // Nothing until the first word ("The", 3 characters: 200 ms) should have ended – a voice
    // that reports boundaries would have sent the first by then.
    vi.advanceTimersByTime(199)
    expect(words(events)).toEqual([])
    vi.advanceTimersByTime(1)
    expect(words(events)).toEqual([0])
    // Each word as its character offset comes round at 15 chars/s.
    vi.advanceTimersByTime(due(4) - 200 - 1)
    expect(words(events)).toEqual([0])
    vi.advanceTimersByTime(2)
    expect(words(events)).toEqual([0, 4])
    vi.advanceTimersByTime(due(16) - due(4))
    expect(words(events)).toEqual([0, 4, 10, 16])
    // The engine ends the utterance early: what is owed comes first, in order, then the end.
    engine.emit(engine.lastId, { type: 'end' })
    expect(words(events)).toEqual(STARTS)
    expect(types(events).at(-1)).toBe('end')
    expect(events.at(-2)?.[1]).toEqual({ type: 'word', charIndex: 40, length: 4 })
    // Nothing after the end.
    vi.advanceTimersByTime(10_000)
    expect(events).toHaveLength(1 + STARTS.length + 1)
    expect(events.every(([id]) => id === 'ra1')).toBe(true)
  })

  it('runs the whole schedule to its last word when the engine takes longer than estimated', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(due(40) + 5)
    expect(words(events)).toEqual(STARTS)
    vi.advanceTimersByTime(5000)
    expect(words(events)).toEqual(STARTS)
    engine.emit(engine.lastId, { type: 'end' })
    expect(types(events).at(-1)).toBe('end')
    expect(events).toHaveLength(1 + STARTS.length + 1)
  })

  it('a real boundary makes the voice the engine’s for good: no estimate now, none for its later utterances', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(50)
    engine.emit(engine.lastId, { type: 'word', charIndex: 0, length: 3 })
    vi.advanceTimersByTime(5000)
    expect(events.slice(1)).toEqual([['ra1', { type: 'word', charIndex: 0, length: 3 }]])
    engine.emit(engine.lastId, { type: 'end' })
    // The next utterance of the same voice is not even waited for.
    h.speak('ra2', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(10_000)
    expect(events.filter(([id]) => id === 'ra2').map(([, e]) => e.type)).toEqual(['start'])
    engine.emit(engine.lastId, { type: 'end' })
    expect(types(events.filter(([id]) => id === 'ra2'))).toEqual(['start', 'end'])
    // Another voice is still estimated.
    h.speak('ra3', PANGRAM, { ...EN, voiceId: 'Other' })
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(due(10) + 1)
    expect(words(events.filter(([id]) => id === 'ra3'))).toEqual([0, 4, 10])
  })

  it('a real boundary that arrives after the estimate began stops it there', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(due(4) + 1)
    expect(words(events)).toEqual([0, 4])
    engine.emit(engine.lastId, { type: 'word', charIndex: 10, length: 5 })
    vi.advanceTimersByTime(10_000)
    expect(words(events)).toEqual([0, 4, 10])
    engine.emit(engine.lastId, { type: 'end' })
    expect(words(events)).toEqual([0, 4, 10])
  })

  it('calibrates the voice’s pace from each finished utterance, per rate, and starts a known silent voice’s words at once', () => {
    const { engine, host: h, events } = host()
    expect(h.rates.charsPerSecond(EN.voiceId, 1)).toBe(15)
    h.speak('ra1', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    // 44 characters in 1 467 ms: 30 chars/s, twice the default.
    vi.advanceTimersByTime(1467)
    engine.emit(engine.lastId, { type: 'end' })
    expect(h.rates.charsPerSecond(EN.voiceId, 1)).toBeCloseTo(30, 1)
    // Another rate of the same voice has its own estimate, the default until measured.
    expect(h.rates.charsPerSecond(EN.voiceId, 1.5)).toBe(22.5)
    // The voice has been through an utterance without a boundary: the first word comes with
    // start, and the rest at the measured pace.
    h.speak('ra2', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    const second = (): number[] => words(events.filter(([id]) => id === 'ra2'))
    expect(second()).toEqual([0])
    vi.advanceTimersByTime(Math.floor(due(4, 30)) - 1)
    expect(second()).toEqual([0])
    vi.advanceTimersByTime(3)
    expect(second()).toEqual([0, 4])
    vi.advanceTimersByTime(due(40, 30) - due(4, 30))
    expect(second()).toEqual(STARTS)
    // A slower measurement moves the estimate halfway (44 characters in 2 933 ms: 15 chars/s).
    vi.advanceTimersByTime(2933 - due(40, 30))
    engine.emit(engine.lastId, { type: 'end' })
    expect(h.rates.charsPerSecond(EN.voiceId, 1)).toBeCloseTo(22.5, 0)
  })

  it('stop, a new utterance and an error drop the schedule', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(due(4) + 1)
    expect(words(events)).toEqual([0, 4])
    h.stop()
    vi.advanceTimersByTime(10_000)
    expect(words(events)).toEqual([0, 4])
    engine.emit(-1, { type: 'cancelled' })
    expect(events).toHaveLength(3)

    h.speak('ra2', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(due(4) + 1)
    h.speak('ra3', PANGRAM, EN)
    engine.emit(-2, { type: 'interrupted' })
    vi.advanceTimersByTime(10_000)
    expect(events.filter(([id]) => id === 'ra2').map(([, e]) => e.type)).toEqual([
      'start',
      'word',
      'word'
    ])
    // ra3 never started: nothing of its own.
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(due(4) + 1)
    engine.emit(engine.lastId, { type: 'error', errorMessage: 'synthesis-failed' })
    vi.advanceTimersByTime(10_000)
    expect(types(events.filter(([id]) => id === 'ra3'))).toEqual(['start', 'word', 'word', 'error'])
  })

  it('pause suspends the schedule and resume continues it where it stood; the pause is left out of the measurement', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', PANGRAM, EN)
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(due(4) + 1)
    expect(words(events)).toEqual([0, 4])
    h.pause()
    engine.emit(engine.lastId, { type: 'pause' })
    vi.advanceTimersByTime(60_000)
    expect(words(events)).toEqual([0, 4])
    h.resume()
    engine.emit(engine.lastId, { type: 'resume' })
    // "brown" (offset 10) is due 667 ms into the speaking, of which 268 had gone by.
    vi.advanceTimersByTime(due(10) - due(4) - 3)
    expect(words(events)).toEqual([0, 4])
    vi.advanceTimersByTime(3)
    expect(words(events)).toEqual([0, 4, 10])
    // The end measures the speaking alone: 44 characters in 2 933 ms of it is the default pace.
    vi.advanceTimersByTime(2933 - due(10))
    engine.emit(engine.lastId, { type: 'end' })
    expect(h.rates.charsPerSecond(EN.voiceId, 1)).toBeCloseTo(15, 0)
    expect(types(events).at(-1)).toBe('end')
    expect(words(events)).toEqual(STARTS)
  })

  it('a pause before the engine starts does not count against the speaking', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', PANGRAM, EN)
    h.pause()
    vi.advanceTimersByTime(5000)
    h.resume()
    vi.advanceTimersByTime(100)
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(due(4) + 1)
    expect(words(events)).toEqual([0, 4])
    // Paused again across the start: the schedule waits, then goes on from the start.
    h.speak('ra2', PANGRAM, EN)
    h.pause()
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(5000)
    expect(events.filter(([id]) => id === 'ra2').map(([, e]) => e.type)).toEqual(['start'])
    h.resume()
    vi.advanceTimersByTime(due(4) + 1)
    expect(words(events.filter(([id]) => id === 'ra2'))).toEqual([0, 4])
  })

  it('an utterance without words is not estimated, and a voice with no id is remembered by its language', () => {
    const { engine, host: h, events } = host()
    h.speak('ra1', '   ', { voiceId: null, lang: 'fr', rate: 1 })
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(10_000)
    engine.emit(engine.lastId, { type: 'end' })
    expect(types(events)).toEqual(['start', 'end'])
    h.speak('ra2', 'Bonjour tout le monde.', { voiceId: null, lang: 'fr', rate: 1 })
    engine.emit(engine.lastId, { type: 'start' })
    engine.emit(engine.lastId, { type: 'word', charIndex: 0, length: 7 })
    engine.emit(engine.lastId, { type: 'end' })
    // The language's default voice reports boundaries: not estimated afterwards.
    h.speak('ra3', 'Bonjour tout le monde.', { voiceId: null, lang: 'fr', rate: 1 })
    engine.emit(engine.lastId, { type: 'start' })
    vi.advanceTimersByTime(10_000)
    expect(types(events.filter(([id]) => id === 'ra3'))).toEqual(['start'])
  })
})

describe('wordSpans and SpeakingRateModel', () => {
  it('lists the whitespace-delimited words with their spans, in order', () => {
    expect(wordSpans('  Hello,  wide\tworld.\n')).toEqual([
      { charIndex: 2, length: 6 },
      { charIndex: 10, length: 4 },
      { charIndex: 15, length: 6 }
    ])
    expect(wordSpans('')).toEqual([])
    expect(wordSpans(' \n\t')).toEqual([])
    expect(wordSpans('one')).toEqual([{ charIndex: 0, length: 3 }])
  })

  it('starts at the default scaled by the rate, takes the first measurement, then moves halfway to each next', () => {
    const model = new SpeakingRateModel()
    expect(model.charsPerSecond('v', 1)).toBe(15)
    expect(model.charsPerSecond('v', 2)).toBe(30)
    model.observe('v', 1, 40, 2000)
    expect(model.charsPerSecond('v', 1)).toBe(20)
    model.observe('v', 1, 40, 1000)
    expect(model.charsPerSecond('v', 1)).toBe(30)
    // Per voice and rate.
    expect(model.charsPerSecond('v', 2)).toBe(30)
    expect(model.charsPerSecond('w', 1)).toBe(15)
  })

  it('does not measure an utterance too short to say anything, and keeps a measurement within reason', () => {
    const model = new SpeakingRateModel()
    model.observe('v', 1, 3, 1000)
    model.observe('v', 1, 40, 100)
    expect(model.charsPerSecond('v', 1)).toBe(15)
    model.observe('v', 1, 4000, 250)
    expect(model.charsPerSecond('v', 1)).toBe(100)
    model.observe('w', 1, 8, 60_000)
    expect(model.charsPerSecond('w', 1)).toBe(1)
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
