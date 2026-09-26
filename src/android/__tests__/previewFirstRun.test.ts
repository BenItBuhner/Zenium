// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { SearchChoiceState, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { PREVIEW_FIRSTRUN_STEPS, parsePreviewSpec } from '../previewSpec'
import { firstRunTaps } from '../previewStates'

/*
 * The preview host's `firstrun=<step>` state (OMN-26): the stills driver reaches one of the
 * phone tour's steps by the footer taps the tour itself offers, and the EEA's choice step – which
 * has no Continue – is left behind with "Skip for now", so a later step is reached with no record
 * written.
 */

const SEED = 0x5eed
const EEA: SearchChoiceState = { region: 'DE', eea: true, required: true, seed: SEED }
const ELSEWHERE: SearchChoiceState = { region: 'US', eea: false, required: false, seed: SEED }

function tour(searchChoice: SearchChoiceState, defaultBrowser: boolean): UIState {
  return {
    platform: 'android',
    capabilities: { defaultBrowser },
    defaultBrowser: { isDefault: false, prompt: null },
    settings: { ...DEFAULT_SETTINGS, onboardingDone: false, searchEngineId: 'google' },
    searchChoice
  } as unknown as UIState
}

describe('parsePreviewSpec: firstrun=<step>', () => {
  it('names one of the tour’s steps, with `then` steps after it', () => {
    expect(PREVIEW_FIRSTRUN_STEPS).toEqual(['welcome', 'look', 'search', 'default'])
    expect(parsePreviewSpec('firstrun=search')).toEqual({ kind: 'firstrun', step: 'search' })
    expect(parsePreviewSpec('firstrun=search&then=tap:Brave')).toEqual({
      kind: 'firstrun',
      step: 'search',
      then: [{ kind: 'tap', text: 'Brave' }]
    })
    expect(parsePreviewSpec('firstrun=default&region=DE')).toEqual({
      kind: 'firstrun',
      step: 'default'
    })
  })

  it('is not a state for a step the tour has not got', () => {
    expect(parsePreviewSpec('firstrun=engine')).not.toMatchObject({ kind: 'firstrun' })
    expect(parsePreviewSpec('firstrun=')).not.toMatchObject({ kind: 'firstrun' })
  })
})

describe('firstRunTaps', () => {
  it('taps Get started, then Continue through the steps before the one asked for', () => {
    expect(firstRunTaps('welcome', tour(ELSEWHERE, true))).toEqual([])
    expect(firstRunTaps('look', tour(ELSEWHERE, true))).toEqual([
      { kind: 'tap', text: 'Get started' }
    ])
    expect(firstRunTaps('search', tour(ELSEWHERE, true))).toEqual([
      { kind: 'tap', text: 'Get started' },
      { kind: 'tap', text: 'Continue' }
    ])
    // Outside the EEA the search step is the plain one and Continue leaves it.
    expect(firstRunTaps('default', tour(ELSEWHERE, true))).toEqual([
      { kind: 'tap', text: 'Get started' },
      { kind: 'tap', text: 'Continue' },
      { kind: 'tap', text: 'Continue' }
    ])
  })

  it('leaves the EEA’s choice step with Skip for now, so no record is written on the way', () => {
    expect(firstRunTaps('default', tour(EEA, true))).toEqual([
      { kind: 'tap', text: 'Get started' },
      { kind: 'tap', text: 'Continue' },
      { kind: 'tap', text: 'Skip for now' }
    ])
    // Reaching the choice step itself taps nothing on it.
    expect(firstRunTaps('search', tour(EEA, true))).toEqual([
      { kind: 'tap', text: 'Get started' },
      { kind: 'tap', text: 'Continue' }
    ])
  })

  it('has no taps for a step the host’s tour leaves out', () => {
    // No browser role to give: the tour has no Default step to reach.
    expect(firstRunTaps('default', tour(EEA, false))).toEqual([])
  })
})
