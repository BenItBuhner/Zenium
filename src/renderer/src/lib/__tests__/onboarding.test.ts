import { describe, expect, it } from 'vitest'
import { isTouchOnly, tourFeatures, tourSteps } from '../onboarding'

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
