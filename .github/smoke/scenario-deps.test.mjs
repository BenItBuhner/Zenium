import { describe, expect, it } from 'vitest'
import { BOOT_PROFILE_SCENARIOS, skipReason, skippedEntries } from './scenario-deps.mjs'

const step = (name, ok) => ({ name, ok, ms: 1 })
const bootWith = (...steps) => ({ boot: { session: { steps } } })
const bootPassed = bootWith(
  step('launch', true),
  step('onboarding', true),
  step('window', true),
  step('new-tab-fixture', true),
  step('quit', true)
)

describe('skipReason', () => {
  it('lets every scenario run after a boot past onboarding', () => {
    for (const name of ['restore', 'crash', 'walkthrough', 'clear-on-exit', 'scale', 'dark']) {
      expect(skipReason(name, bootPassed)).toBeNull()
    }
  })
  it("names boot's onboarding step for the scenarios that relaunch boot's profile", () => {
    const failed = bootWith(step('launch', true), step('onboarding', false), step('quit', true))
    expect(skipReason('restore', failed)).toBe('onboarding')
    expect(skipReason('crash', failed)).toBe('onboarding')
  })
  it("names boot's launch when it failed (nothing behind it ran)", () => {
    const failed = bootWith(step('launch', false))
    expect(skipReason('restore', failed)).toBe('launch')
    expect(skipReason('crash', failed)).toBe('launch')
    expect(skipReason('restore', { boot: { fatal: 'harness crashed before the launch' } })).toBe(
      'launch'
    )
  })
  it('does not skip for boot failures past onboarding (the profile is past it)', () => {
    const quitFailed = bootWith(step('launch', true), step('onboarding', true), step('quit', false))
    expect(skipReason('restore', quitFailed)).toBeNull()
    expect(skipReason('crash', quitFailed)).toBeNull()
  })
  it('never skips the scenarios on their own profiles, nor anything in a run without boot', () => {
    const failed = bootWith(step('launch', true), step('onboarding', false))
    for (const name of ['walkthrough', 'clear-on-exit', 'scale', 'dark', 'boot']) {
      expect(skipReason(name, failed)).toBeNull()
    }
    expect(skipReason('restore', {})).toBeNull()
    expect(skipReason('restore', undefined)).toBeNull()
  })
})

describe('skippedEntries', () => {
  it('records one entry per session the scenario would have written', () => {
    expect(skippedEntries('restore', 'onboarding').map(([name]) => name)).toEqual(['restore'])
    expect(skippedEntries('crash', 'onboarding').map(([name]) => name)).toEqual([
      'crash',
      'crash-restore'
    ])
    expect(Object.keys(BOOT_PROFILE_SCENARIOS)).toEqual(['restore', 'crash'])
  })
  it('says which step of boot is to blame, without steps or failures of its own', () => {
    const [[, entry]] = skippedEntries('restore', 'onboarding')
    expect(entry.skipped).toBe('onboarding')
    expect(entry.note).toMatch(/boot's onboarding step failed/)
    expect(entry.note).toMatch(/restore relaunches/)
    expect(entry.session).toBeUndefined()
    expect(entry.fatal).toBeUndefined()
  })
})
