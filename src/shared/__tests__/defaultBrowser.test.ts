import { describe, expect, it } from 'vitest'
import type { DefaultBrowserPromoState, DefaultBrowserPrompt } from '../types'
import {
  BANNER_GAP_SESSIONS,
  DEFAULT_PROMO_STATE,
  PROMO_FIRST_SESSION,
  PROMO_MAX_DISMISSALS,
  PROMO_REPEAT_SESSIONS,
  beginSession,
  decidePrompt,
  dismissPrompt,
  markBannerShown,
  markRequested,
  markSheetShown,
  sanitizePromoState,
  sheetDue
} from '../defaultBrowser'

/**
 * Play the campaign through `count` sessions the way the core does: a session starts, the
 * prompt that is due is shown and remembered, and `answer` decides what the user does with it.
 * Returns which prompt came up in each session (index 0 = session 1).
 */
function play(
  count: number,
  answer: (prompt: DefaultBrowserPrompt, session: number) => 'not-now' | 'set' | 'close' | 'ignore',
  start: DefaultBrowserPromoState = DEFAULT_PROMO_STATE
): { shown: DefaultBrowserPrompt[]; state: DefaultBrowserPromoState } {
  let state = start
  const shown: DefaultBrowserPrompt[] = []
  for (let i = 0; i < count; i++) {
    state = beginSession(state)
    const prompt = decidePrompt(state, false)
    shown.push(prompt)
    if (prompt === 'sheet') state = markSheetShown(state)
    if (prompt === 'banner') state = markBannerShown(state)
    if (!prompt) continue
    const what = answer(prompt, state.sessions)
    if (what === 'set') state = markRequested(state)
    else if (what === 'not-now') state = dismissPrompt(state, 'sheet')
    else if (what === 'close') state = dismissPrompt(state, 'banner')
  }
  return { shown, state }
}

describe('default browser promo rules', () => {
  it('shows the sheet in the third session and nothing before it', () => {
    const { shown } = play(PROMO_FIRST_SESSION, () => 'not-now')
    expect(shown).toEqual([null, null, 'sheet'])
  })

  it('never prompts while the browser is the default, or before the host has answered', () => {
    let state = DEFAULT_PROMO_STATE
    for (let i = 0; i < PROMO_FIRST_SESSION; i++) state = beginSession(state)
    expect(sheetDue(state)).toBe(true)
    expect(decidePrompt(state, true)).toBeNull()
    expect(decidePrompt(state, null)).toBeNull()
    expect(decidePrompt(state, false)).toBe('sheet')
  })

  it('repeats the sheet after the cooldown when it was dismissed, then stops after three', () => {
    const { shown, state } = play(40, (prompt) => (prompt === 'sheet' ? 'not-now' : 'close'))
    const sheets = shown.flatMap((p, i) => (p === 'sheet' ? [i + 1] : []))
    expect(sheets).toEqual([
      PROMO_FIRST_SESSION,
      PROMO_FIRST_SESSION + PROMO_REPEAT_SESSIONS,
      PROMO_FIRST_SESSION + 2 * PROMO_REPEAT_SESSIONS
    ])
    expect(sheets).toHaveLength(PROMO_MAX_DISMISSALS)
    expect(state.dismissals).toBe(PROMO_MAX_DISMISSALS)
    // Once given up on, neither prompt returns.
    expect(shown.slice(PROMO_FIRST_SESSION + 2 * PROMO_REPEAT_SESSIONS)).not.toContain('sheet')
    expect(shown.slice(PROMO_FIRST_SESSION + 2 * PROMO_REPEAT_SESSIONS)).not.toContain('banner')
  })

  it('does not bring the sheet back in the same session it was shown', () => {
    let state = DEFAULT_PROMO_STATE
    for (let i = 0; i < PROMO_FIRST_SESSION; i++) state = beginSession(state)
    state = markSheetShown(state)
    expect(decidePrompt(state, false)).not.toBe('sheet')
  })

  it('ends the campaign for good once "Set as default" was chosen', () => {
    const { shown } = play(30, (prompt) => (prompt === 'sheet' ? 'set' : 'close'))
    expect(shown.filter(Boolean)).toEqual(['sheet'])
  })

  it('fills the sessions between sheets with the banner, every other session', () => {
    const { shown } = play(PROMO_FIRST_SESSION + PROMO_REPEAT_SESSIONS, (prompt) =>
      prompt === 'sheet' ? 'not-now' : 'close'
    )
    const banners = shown.flatMap((p, i) => (p === 'banner' ? [i + 1] : []))
    expect(banners[0]).toBe(PROMO_FIRST_SESSION + 1)
    for (let i = 1; i < banners.length; i++) {
      expect(banners[i] - banners[i - 1]).toBe(BANNER_GAP_SESSIONS)
    }
    expect(shown[PROMO_FIRST_SESSION + PROMO_REPEAT_SESSIONS - 1]).toBe('sheet')
  })

  it('keeps the banner away until the sheet has been shown once', () => {
    const { shown } = play(PROMO_FIRST_SESSION - 1, () => 'ignore')
    expect(shown).not.toContain('banner')
  })

  it('closing the banner is not a dismissal of the sheet', () => {
    let state = DEFAULT_PROMO_STATE
    for (let i = 0; i < PROMO_FIRST_SESSION + 1; i++) state = beginSession(state)
    state = markSheetShown({ ...state, promptedAt: PROMO_FIRST_SESSION })
    state = dismissPrompt(state, 'banner')
    expect(state.dismissals).toBe(0)
    expect(state.bannerAt).toBe(state.sessions)
  })

  it('coerces whatever was on disk into a valid record', () => {
    expect(sanitizePromoState(undefined)).toEqual(DEFAULT_PROMO_STATE)
    expect(sanitizePromoState('garbage')).toEqual(DEFAULT_PROMO_STATE)
    expect(
      sanitizePromoState({
        sessions: 4.7,
        promptedAt: 3,
        dismissals: -2,
        done: 'yes',
        bannerAt: Number.NaN
      })
    ).toEqual({ sessions: 4, promptedAt: 3, dismissals: 0, done: false, bannerAt: null })
    expect(sanitizePromoState({ done: true, promptedAt: 0 }).done).toBe(true)
    expect(sanitizePromoState({ promptedAt: 0 }).promptedAt).toBe(0)
  })
})
