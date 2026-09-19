import { describe, expect, it } from 'vitest'
import { SPRING_SNAPPY, isAtRest, stepSpring, type SpringState } from '../spring'
import {
  VOICE_HALO_FULL,
  VOICE_HALO_REST,
  isNoMatch,
  newVoiceSession,
  reduceVoice,
  voiceErrorMessage,
  voiceHaloDiameter,
  voiceHaloOpacity,
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

describe('voiceInput: the transcript as the address bar takes it', () => {
  it("trims and leaves one space between words; where it goes is urlbar.submit's decision", () => {
    expect(voiceInput('  weather   in london ')).toBe('weather in london')
    expect(voiceInput('example.com\n')).toBe('example.com')
    expect(voiceInput('   ')).toBe('')
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
    expect(play([{ kind: 'ready' }, { kind: 'error', error: 'speech-timeout' }]).phase).toBe(
      'no-match'
    )
    expect(isNoMatch('no-match')).toBe(true)
    expect(isNoMatch('network')).toBe(false)
  })

  it('fails with the error the toast reports for everything else', () => {
    const failed = play([{ kind: 'ready' }, { kind: 'error', error: 'network' }])
    expect(failed).toMatchObject({ phase: 'failed', error: 'network', level: 0 })
    expect(voiceSessionOver(failed)).toBe(true)
  })

  it('is cancelled when the host aborts the session', () => {
    const cancelled = play([
      { kind: 'ready' },
      { kind: 'partial', text: 'weath' },
      { kind: 'aborted' }
    ])
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

/** The spring at 60 fps from one diameter to another: every frame's position until it rests. */
function swell(from: number, to: number): number[] {
  const frames: number[] = []
  let state: SpringState = { x: from, v: 0 }
  while (frames.length < 240) {
    state = stepSpring(state, to, 1 / 60, SPRING_SNAPPY)
    frames.push(state.x)
    if (isAtRest(state, to)) break
  }
  return frames
}

function steps(frames: number[], from: number): number[] {
  return frames.map((x, i) => Math.abs(x - (i === 0 ? from : frames[i - 1]!)))
}

describe('the halo and the messages', () => {
  it('grows the halo from the glyph (20 px) to a 36 px disc with the level', () => {
    expect(voiceHaloDiameter(0)).toBe(VOICE_HALO_REST)
    expect(voiceHaloDiameter(1)).toBe(VOICE_HALO_FULL)
    expect(voiceHaloDiameter(0.5)).toBeCloseTo((VOICE_HALO_REST + VOICE_HALO_FULL) / 2)
    expect(voiceHaloDiameter(4)).toBe(VOICE_HALO_FULL)
    expect(voiceHaloDiameter(-1)).toBe(VOICE_HALO_REST)
  })

  it('draws a diameter as a scale of the 20 px box, and shows nothing of the halo at rest', () => {
    expect(voiceHaloScale(VOICE_HALO_REST)).toBe(1)
    expect(voiceHaloScale(VOICE_HALO_FULL)).toBeCloseTo(1.8)
    expect(voiceHaloOpacity(VOICE_HALO_REST)).toBe(0)
    expect(voiceHaloOpacity(28)).toBeCloseTo(0.5)
    expect(voiceHaloOpacity(VOICE_HALO_FULL)).toBe(1)
    expect(voiceHaloOpacity(40)).toBe(1)
  })

  // The unit matters: `SPRING_SNAPPY` rests at Δ .4 px / 8 px/s (§11), so run in scale units
  // (1 → 1.8) it snaps to the target inside five frames and most level steps land on their first;
  // run in px (20 → 36) the same spring swells and settles over a run of frames.
  it('swells over a run of frames on the shared spring, and never jumps', () => {
    const full = swell(voiceHaloDiameter(0), voiceHaloDiameter(1))
    expect(full.length).toBeGreaterThanOrEqual(12)
    expect(Math.max(...steps(full, voiceHaloDiameter(0)))).toBeLessThanOrEqual(2.1)
    // A level step the throttle lets through (`VoiceLogic.RmsThrottle`, min Δ .04): still a swell.
    const small = swell(voiceHaloDiameter(0.25), voiceHaloDiameter(0.6))
    expect(small.length).toBeGreaterThanOrEqual(6)
    expect(Math.max(...steps(small, voiceHaloDiameter(0.25)))).toBeLessThan(1)
    // The settle back to the glyph mirrors the swell.
    const settle = swell(voiceHaloDiameter(1), voiceHaloDiameter(0))
    expect(settle.length).toBeGreaterThanOrEqual(12)
    expect(settle.at(-1)).toBe(voiceHaloDiameter(0))
  })

  it('would snap in scale units, which is why the spring does not run in them', () => {
    expect(swell(1, 1.8).length).toBeLessThanOrEqual(5)
    expect(swell(1.2, 1.48).length).toBe(1)
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
