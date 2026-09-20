import { describe, expect, it, vi } from 'vitest'
import { READ_ALOUD_RATES, type ReadAloudState, type ReadAloudVoice } from '@shared/readAloud'

vi.mock('@renderer/lib/api', () => ({ run: vi.fn(), cmd: vi.fn() }))

import { run } from '@renderer/lib/api'
import {
  describeRate,
  errorText,
  formatProgress,
  formatRate,
  nextRate,
  READ_ALOUD_RATE_SIZER,
  READ_ALOUD_RATE_STEPS,
  voiceOptions,
  voiceRow
} from '../readAloud'

/*
 * What the docked read-aloud player shows and offers, as functions of the model's state
 * (`UIState.readAloud`, services' `ReadAloudService`): the speed chip's ladder, the progress
 * line, the error line and the voice picker's rows.
 */

function session(over: Partial<ReadAloudState> = {}): ReadAloudState {
  return {
    tabId: 't1',
    status: 'playing',
    source: 'page',
    title: 'Why coffee tastes different at altitude',
    lang: 'en-GB',
    sentenceIndex: 8,
    sentenceCount: 42,
    word: null,
    rate: 1,
    voiceId: null,
    highlight: 'both',
    ...over
  }
}

const VOICES: ReadAloudVoice[] = [
  {
    id: 'en-gb-1',
    name: 'English (UK) 1',
    lang: 'en-GB',
    local: true,
    quality: 'high',
    default: true
  },
  { id: 'en-us-1', name: 'English (US) 1', lang: 'en-US', local: false, quality: 'high' },
  { id: 'de-de-1', name: 'Deutsch 1', lang: 'de-DE', local: true, quality: 'normal' },
  { id: 'en-au-1', name: 'English (AU) 1', lang: 'en_AU', local: true, quality: 'low' }
]

describe('the speed chip', () => {
  it('has the model’s rungs up to 2× (Chrome’s ladder; Edge’s range)', () => {
    expect(READ_ALOUD_RATE_STEPS).toEqual([0.5, 0.8, 1, 1.2, 1.5, 2])
    expect(READ_ALOUD_RATE_STEPS.every((r) => READ_ALOUD_RATES.includes(r))).toBe(true)
  })

  it('cycles 1× → 1.2× → 1.5× → 2× → 0.5× → 0.8× → 1×', () => {
    const seen: number[] = []
    let rate = 1
    for (let i = 0; i < READ_ALOUD_RATE_STEPS.length; i++) {
      seen.push(rate)
      rate = nextRate(rate)
    }
    expect(seen).toEqual([1, 1.2, 1.5, 2, 0.5, 0.8])
    expect(rate).toBe(1)
  })

  it('steps a rate from between the rungs to the first above it, and one past the top to .5×', () => {
    expect(nextRate(1.25)).toBe(1.5)
    expect(nextRate(0.6)).toBe(0.8)
    expect(nextRate(3)).toBe(0.5)
    expect(nextRate(4)).toBe(0.5)
  })

  it('formats the rate as typed, with the multiplication sign', () => {
    expect(formatRate(1)).toBe('1×')
    expect(formatRate(1.2)).toBe('1.2×')
    expect(formatRate(0.5)).toBe('0.5×')
    expect(formatRate(1.5)).toBe('1.5×')
  })

  it('names the chip for a screen reader by the setting and the value as said (§9.34)', () => {
    expect(describeRate(1)).toBe('Speed, 1 times')
    expect(describeRate(1.2)).toBe('Speed, 1.2 times')
    expect(describeRate(0.5)).toBe('Speed, 0.5 times')
    // The painted label never leaks its glyph into the name.
    for (const rate of READ_ALOUD_RATE_STEPS) expect(describeRate(rate)).not.toContain('×')
  })

  it('sizes the chip by its widest label, so every rung is as wide or narrower', () => {
    expect(READ_ALOUD_RATE_SIZER).toBe('0.5×')
    for (const rate of READ_ALOUD_RATE_STEPS) {
      expect(formatRate(rate).length).toBeLessThanOrEqual(READ_ALOUD_RATE_SIZER.length)
    }
  })
})

describe('the progress line', () => {
  it('shows the sentence being read over the count', () => {
    expect(formatProgress(session())).toBe('9 / 42')
    expect(formatProgress(session({ sentenceIndex: 41 }))).toBe('42 / 42')
  })

  it('is empty before the count is known or the first sentence has begun, and never past the count', () => {
    expect(formatProgress(session({ sentenceIndex: -1, sentenceCount: 0 }))).toBe('')
    expect(formatProgress(session({ sentenceIndex: -1 }))).toBe('')
    expect(formatProgress(session({ sentenceIndex: 0 }))).toBe('1 / 42')
    expect(formatProgress(session({ sentenceIndex: 60 }))).toBe('42 / 42')
  })

  it('names the model’s errors in the reader’s words', () => {
    expect(errorText('no-voice')).toBe('No voice for this language')
    expect(errorText('no-text')).toBe('Nothing to read on this page')
    expect(errorText('synthesis')).toBe('Couldn’t read this page')
    expect(errorText(undefined)).toBe('Couldn’t read this page')
  })
})

describe('the voice picker', () => {
  it('lists the text’s language first (by base language, either separator), the rest under one heading', () => {
    const options = voiceOptions(VOICES, 'en-GB')
    expect(options.map((o) => o.value)).toEqual(['en-gb-1', 'en-us-1', 'en-au-1', 'de-de-1'])
    expect(options.slice(0, 3).every((o) => o.group === undefined)).toBe(true)
    expect(options[3]!.group).toBe('Other languages')
  })

  it('describes where a voice runs and its quality when it is not the usual one', () => {
    const options = voiceOptions(VOICES, 'en')
    expect(options.find((o) => o.value === 'en-gb-1')!.description).toBe(
      'On this device · High quality'
    )
    expect(options.find((o) => o.value === 'en-us-1')!.description).toBe(
      'Needs a network · High quality'
    )
    expect(options.find((o) => o.value === 'de-de-1')!.description).toBe('On this device')
    expect(options.find((o) => o.value === 'en-au-1')!.description).toBe(
      'On this device · Low quality'
    )
  })

  it('is one waiting row before the list arrives, one saying so with no voices', () => {
    expect(voiceRow(session(), null).options).toEqual([{ value: '', label: 'Loading voices…' }])
    expect(voiceRow(session(), { voices: [], byLanguage: {} }).options).toEqual([
      { value: '', label: 'No voices installed' }
    ])
  })

  it('marks the session’s voice, else the model’s default for the language, and sets the voice on a pick', () => {
    const result = { voices: VOICES, byLanguage: { 'en-GB': 'en-gb-1' } }
    expect(voiceRow(session({ voiceId: 'en-us-1' }), result).value).toBe('en-us-1')
    expect(voiceRow(session(), result).value).toBe('en-gb-1')
    const row = voiceRow(session(), result)
    row.onChange('de-de-1')
    expect(run).toHaveBeenCalledWith('readAloud.setVoice', { voiceId: 'de-de-1' })
    vi.mocked(run).mockClear()
    row.onChange('')
    expect(run).not.toHaveBeenCalled()
  })
})
