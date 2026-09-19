import { describe, expect, it } from 'vitest'
import {
  VOICE_HALO_FULL,
  VOICE_HALO_REST,
  isNoMatch,
  newVoiceSession,
  reduceVoice,
  voiceDestination,
  voiceErrorMessage,
  voiceHaloScale,
  voiceInput,
  voiceSearchAvailable,
  voiceSessionOver,
  voiceStartMessage,
  type VoiceEvent,
  type VoiceSession
} from '../voice'

function play(events: VoiceEvent[], from: VoiceSession = newVoiceSession()): VoiceSession {
  return events.reduce(reduceVoice, from)
}

describe('voiceDestination: the transcript -> submit decision', () => {
  it('navigates to a transcript that reads as an address', () => {
    expect(voiceDestination('example.com')).toEqual({ kind: 'navigate', url: 'https://example.com' })
    expect(voiceDestination('https://zenium.app/docs')).toEqual({
      kind: 'navigate',
      url: 'https://zenium.app/docs'
    })
    expect(voiceDestination('localhost:3000')).toEqual({ kind: 'navigate', url: 'http://localhost:3000' })
  })

  it('searches everything else through the default engine', () => {
    expect(voiceDestination('weather in london')).toEqual({ kind: 'search', query: 'weather in london' })
    expect(voiceDestination('how tall is the eiffel tower')).toEqual({
      kind: 'search',
      query: 'how tall is the eiffel tower'
    })
    // Words with a dot in the middle of a sentence are a sentence, not a host.
    expect(voiceDestination('what is example.com about')).toEqual({
      kind: 'search',
      query: 'what is example.com about'
    })
  })

  it('normalises the words as the address bar would take them', () => {
    expect(voiceInput('  weather   in\nlondon ')).toBe('weather in london')
    expect(voiceDestination('  weather   in london ')).toEqual({ kind: 'search', query: 'weather in london' })
  })

  it('has nowhere to go for a transcript with no words', () => {
    expect(voiceDestination('')).toBeNull()
    expect(voiceDestination('   ')).toBeNull()
  })
})

describe('voiceSearchAvailable: the availability flag', () => {
  it('follows the host capability the recogniser check sets', () => {
    expect(voiceSearchAvailable({ voiceSearch: true })).toBe(true)
    expect(voiceSearchAvailable({ voiceSearch: false })).toBe(false)
  })
})

describe('reduceVoice: the overlay state machine', () => {
  it('starts waiting for the microphone and listens once the recogniser is ready', () => {
    const session = newVoiceSession()
    expect(session).toEqual({ phase: 'starting', transcript: '', level: 0, error: null })
    expect(reduceVoice(session, { kind: 'ready' }).phase).toBe('listening')
    expect(reduceVoice(session, { kind: 'begin' }).phase).toBe('listening')
  })

  it('keeps the level the glyph pulses on, clamped to 0..1', () => {
    const listening = play([{ kind: 'ready' }])
    expect(reduceVoice(listening, { kind: 'rms', level: 0.4 }).level).toBe(0.4)
    expect(reduceVoice(listening, { kind: 'rms', level: 7 }).level).toBe(1)
    expect(reduceVoice(listening, { kind: 'rms', level: -3 }).level).toBe(0)
    expect(reduceVoice(listening, { kind: 'rms', level: Number.NaN }).level).toBe(0)
  })

  it('takes a partial transcript as the body copy and keeps the last one heard over an empty one', () => {
    const heard = play([{ kind: 'ready' }, { kind: 'partial', text: 'weather in' }])
    expect(heard).toMatchObject({ phase: 'heard', transcript: 'weather in' })
    expect(reduceVoice(heard, { kind: 'partial', text: '   ' })).toBe(heard)
    expect(reduceVoice(heard, { kind: 'partial', text: 'weather in london' }).transcript).toBe(
      'weather in london'
    )
  })

  it('moves to finishing at the end of speech, the halo at rest, and ignores levels from then on', () => {
    const finishing = play([{ kind: 'ready' }, { kind: 'rms', level: 0.8 }, { kind: 'end' }])
    expect(finishing).toMatchObject({ phase: 'finishing', level: 0 })
    expect(reduceVoice(finishing, { kind: 'rms', level: 0.9 })).toBe(finishing)
  })

  it('is done with the final transcript, which replaces the partial one', () => {
    const done = play([
      { kind: 'ready' },
      { kind: 'partial', text: 'weather in' },
      { kind: 'end' },
      { kind: 'result', text: ' weather in london ' }
    ])
    expect(done).toEqual({ phase: 'done', transcript: 'weather in london', level: 0, error: null })
    expect(voiceSessionOver(done)).toBe(true)
  })

  it('reads a result with no words, a no-match and a speech timeout as Didn\u2019t catch that', () => {
    expect(play([{ kind: 'ready' }, { kind: 'result', text: '' }]).phase).toBe('no-match')
    expect(play([{ kind: 'ready' }, { kind: 'error', error: 'no-match' }]).phase).toBe('no-match')
    expect(play([{ kind: 'ready' }, { kind: 'error', error: 'speech-timeout' }]).phase).toBe('no-match')
    expect(isNoMatch('no-match')).toBe(true)
    expect(isNoMatch('network')).toBe(false)
  })

  it('fails with the error the toast reports for everything else', () => {
    const failed = play([{ kind: 'ready' }, { kind: 'error', error: 'network' }])
    expect(failed).toMatchObject({ phase: 'failed', error: 'network', level: 0 })
    expect(voiceSessionOver(failed)).toBe(true)
  })

  it('is cancelled when the host aborts the session', () => {
    const cancelled = play([{ kind: 'ready' }, { kind: 'partial', text: 'weath' }, { kind: 'aborted' }])
    expect(cancelled).toMatchObject({ phase: 'cancelled', level: 0 })
    expect(voiceSessionOver(cancelled)).toBe(true)
  })

  it('changes nothing once the session is over: a late level, a late error, a late result', () => {
    const done = play([{ kind: 'ready' }, { kind: 'result', text: 'weather' }])
    expect(reduceVoice(done, { kind: 'rms', level: 0.5 })).toBe(done)
    expect(reduceVoice(done, { kind: 'error', error: 'client' })).toBe(done)
    expect(reduceVoice(done, { kind: 'result', text: 'something else' })).toBe(done)
    const cancelled = play([{ kind: 'aborted' }])
    expect(reduceVoice(cancelled, { kind: 'result', text: 'weather' })).toBe(cancelled)
  })
})

describe('the halo and the messages', () => {
  it('scales the halo from resting on the glyph to a little over twice it', () => {
    expect(voiceHaloScale(0)).toBe(VOICE_HALO_REST)
    expect(voiceHaloScale(1)).toBe(VOICE_HALO_FULL)
    expect(voiceHaloScale(0.5)).toBeCloseTo((VOICE_HALO_REST + VOICE_HALO_FULL) / 2)
    expect(voiceHaloScale(4)).toBe(VOICE_HALO_FULL)
  })

  it('leaves no message when the recogniser is listening, and one for each refusal', () => {
    expect(voiceStartMessage('listening')).toBeNull()
    expect(voiceStartMessage('denied')).toMatch(/microphone/i)
    expect(voiceStartMessage('denied-permanently')).toMatch(/turned off for Zenium/)
    expect(voiceStartMessage('unavailable')).toMatch(/not available/)
  })

  it('names the errors the user can do something about and has one line for the rest', () => {
    expect(voiceErrorMessage('network')).toMatch(/internet/)
    expect(voiceErrorMessage('busy')).toMatch(/another app/)
    expect(voiceErrorMessage('permissions')).toMatch(/microphone/i)
    expect(voiceErrorMessage('language')).toMatch(/language/)
    expect(voiceErrorMessage('client')).toBe(voiceErrorMessage('unknown'))
  })
})
