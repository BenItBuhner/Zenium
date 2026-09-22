import { describe, expect, it } from 'vitest'
import type { UIState, WindowChrome, WindowKind } from '@shared/types'
import { isTouchOnly, onboardingCovers, phoneSteps, tourFeatures, tourSteps } from '../onboarding'

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

describe('isTouchOnly', () => {
  it('is a coarse pointer without hover', () => {
    expect(isTouchOnly({ coarse: true, hover: false })).toBe(true)
  })

  it('a mouse or trackpad (hover) counts as keyboard-equipped, whatever the pointer', () => {
    expect(isTouchOnly({ coarse: true, hover: true })).toBe(false)
    expect(isTouchOnly({ coarse: false, hover: true })).toBe(false)
    expect(isTouchOnly({ coarse: false, hover: false })).toBe(false)
  })
})

describe('tourSteps', () => {
  it('shows the full tour on a desktop with sync', () => {
    expect(tourSteps({ sync: true }, false)).toEqual([
      'welcome',
      'look',
      'search',
      'essentials',
      'features',
      'sync',
      'shortcuts'
    ])
  })

  it('drops the sync step where the host has no sync (FRE-03)', () => {
    expect(tourSteps({ sync: false }, false)).not.toContain('sync')
    expect(tourSteps({ sync: false }, false)).toContain('shortcuts')
  })

  it('drops the shortcuts step on touch-only hosts (FRE-06)', () => {
    expect(tourSteps({ sync: true }, true)).not.toContain('shortcuts')
    expect(tourSteps({ sync: true }, true)).toContain('sync')
  })

  it('a touch-only tablet without sync gets the five host-neutral steps', () => {
    expect(tourSteps({ sync: false }, true)).toEqual([
      'welcome',
      'look',
      'search',
      'essentials',
      'features'
    ])
  })

  it('offers the import after the search engine once another browser was found (ID-23), and not otherwise', () => {
    expect(tourSteps({ sync: true }, false, true)).toEqual([
      'welcome',
      'look',
      'search',
      'import',
      'essentials',
      'features',
      'sync',
      'shortcuts'
    ])
    expect(tourSteps({ sync: true }, false, false)).not.toContain('import')
    expect(tourSteps({ sync: true }, false)).not.toContain('import')
  })
})

describe('tourFeatures', () => {
  it('keeps every card with a pointer and sync', () => {
    expect(tourFeatures({ sync: true }, false)).toEqual([
      'spaces',
      'compact',
      'glance',
      'boosts',
      'livefolders',
      'sync'
    ])
  })

  it('drops the Sync card without the capability (FRE-03)', () => {
    expect(tourFeatures({ sync: false }, false)).not.toContain('sync')
  })

  it('drops the hover and modifier-click cards on touch-only hosts (FRE-06)', () => {
    const features = tourFeatures({ sync: true }, true)
    expect(features).not.toContain('compact')
    expect(features).not.toContain('glance')
    expect(features).toEqual(['spaces', 'boosts', 'livefolders', 'sync'])
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
