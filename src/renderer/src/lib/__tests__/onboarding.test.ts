import { describe, expect, it } from 'vitest'
import type { UIState, WindowChrome, WindowKind } from '@shared/types'
import { onboardingCovers, phoneSteps, tourSteps } from '../onboarding'

describe('onboardingCovers', () => {
  const state = (
    onboardingDone: boolean,
    kind: WindowKind = 'synced',
    chrome: WindowChrome = 'full'
  ): Pick<UIState, 'settings' | 'window'> =>
    ({ settings: { onboardingDone }, window: { kind, chrome } }) as Pick<
      UIState,
      'settings' | 'window'
    >

  it("is the tour over the profile's window before it is done – the terms the shells mount it on", () => {
    expect(onboardingCovers(state(false))).toBe(true)
    expect(onboardingCovers(state(true))).toBe(false)
  })

  it('never a blank or private window, a popup or a web app window', () => {
    expect(onboardingCovers(state(false, 'unsynced'))).toBe(false)
    expect(onboardingCovers(state(false, 'private'))).toBe(false)
    expect(onboardingCovers(state(false, 'synced', 'popup'))).toBe(false)
    expect(onboardingCovers(state(false, 'synced', 'app'))).toBe(false)
  })
})

describe('tourSteps', () => {
  it("is Zen's tour on a desktop with sync", () => {
    expect(tourSteps({ sync: true })).toEqual(['welcome', 'look', 'search', 'essentials', 'sync'])
  })

  it('drops the sync step where the host has no sync (FRE-03)', () => {
    expect(tourSteps({ sync: false })).toEqual(['welcome', 'look', 'search', 'essentials'])
  })

  it('offers the import after the search engine once another browser was found (ID-23), and not otherwise', () => {
    expect(tourSteps({ sync: true }, true)).toEqual([
      'welcome',
      'look',
      'search',
      'import',
      'essentials',
      'sync'
    ])
    expect(tourSteps({ sync: true }, false)).not.toContain('import')
    expect(tourSteps({ sync: true })).not.toContain('import')
  })
})

describe('phoneSteps', () => {
  it('asks about the browser role where the host has one Zenium does not hold', () => {
    expect(phoneSteps({ defaultBrowser: true, isDefault: false })).toEqual([
      'welcome',
      'look',
      'search',
      'default'
    ])
    expect(phoneSteps({ defaultBrowser: true, isDefault: null })).toContain('default')
  })

  it('skips the step when Zenium already is the default', () => {
    expect(phoneSteps({ defaultBrowser: true, isDefault: true })).toEqual([
      'welcome',
      'look',
      'search'
    ])
  })

  it('skips the step on hosts without a browser role', () => {
    expect(phoneSteps({ defaultBrowser: false, isDefault: false })).toEqual([
      'welcome',
      'look',
      'search'
    ])
  })
})
