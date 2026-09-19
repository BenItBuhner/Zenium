import { describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn() }))
vi.mock('../ui', () => ({ pushToast: vi.fn() }))

import {
  featureVersion,
  shouldShowDefaultBrowserPrompt,
  wantsDefaultBrowserBanner
} from '../defaultBrowser'

describe('featureVersion', () => {
  it('keeps major.minor and drops the patch and pre-release parts', () => {
    expect(featureVersion('0.3.7')).toBe('0.3')
    expect(featureVersion('1.2.0-beta.3')).toBe('1.2')
    expect(featureVersion('v0.4.0')).toBe('0.4')
    expect(featureVersion(' 10.20.30 ')).toBe('10.20')
  })

  it('returns the trimmed input when it is not a version', () => {
    expect(featureVersion(' dev ')).toBe('dev')
    expect(featureVersion('')).toBe('')
  })
})

describe('shouldShowDefaultBrowserPrompt', () => {
  it('asks when the strip was never answered', () => {
    expect(shouldShowDefaultBrowserPrompt(null, '0.3.7')).toBe(true)
  })

  it('stays away for the release it was answered in and its patch releases', () => {
    expect(shouldShowDefaultBrowserPrompt('0.3.7', '0.3.7')).toBe(false)
    expect(shouldShowDefaultBrowserPrompt('0.3.7', '0.3.9')).toBe(false)
    expect(shouldShowDefaultBrowserPrompt('0.3.7', '0.3.8-beta.1')).toBe(false)
  })

  it('asks once more with the next feature release', () => {
    expect(shouldShowDefaultBrowserPrompt('0.3.7', '0.4.0')).toBe(true)
    expect(shouldShowDefaultBrowserPrompt('0.3.7', '1.0.0')).toBe(true)
  })

  it('treats a downgrade as a different feature release', () => {
    expect(shouldShowDefaultBrowserPrompt('0.4.0', '0.3.7')).toBe(true)
  })
})

describe('wantsDefaultBrowserBanner', () => {
  /** Just the fields the rule reads; the rest of the window state is not its business. */
  function state(over: {
    isDefault?: boolean | null
    dismissed?: string | null
    kind?: 'synced' | 'unsynced' | 'private'
    onboardingDone?: boolean
    capability?: boolean
    platform?: UIState['platform']
  }): UIState {
    return {
      version: '0.3.21',
      platform: over.platform ?? 'linux',
      capabilities: { defaultBrowser: over.capability ?? true },
      // `null` is a real value here (the host has not answered), so no `??`.
      defaultBrowser: { isDefault: 'isDefault' in over ? over.isDefault : false, prompt: null },
      window: { kind: over.kind ?? 'synced' },
      settings: {
        onboardingDone: over.onboardingDone ?? true,
        defaultBrowserPromptDismissed: over.dismissed ?? null
      }
    } as unknown as UIState
  }

  it('shows once the OS said another browser has the role', () => {
    expect(wantsDefaultBrowserBanner(state({}))).toBe(true)
  })

  it('never while the answer is pending, when Zenium is the default, or without the capability', () => {
    expect(wantsDefaultBrowserBanner(state({ isDefault: null }))).toBe(false)
    expect(wantsDefaultBrowserBanner(state({ isDefault: true }))).toBe(false)
    expect(wantsDefaultBrowserBanner(state({ capability: false }))).toBe(false)
  })

  it('stays out of private windows and out of onboarding', () => {
    expect(wantsDefaultBrowserBanner(state({ kind: 'private' }))).toBe(false)
    expect(wantsDefaultBrowserBanner(state({ onboardingDone: false }))).toBe(false)
    expect(wantsDefaultBrowserBanner(state({ kind: 'unsynced' }))).toBe(true)
  })

  it('remembers the answer for the feature release it was given in', () => {
    expect(wantsDefaultBrowserBanner(state({ dismissed: '0.3.20' }))).toBe(false)
    expect(wantsDefaultBrowserBanner(state({ dismissed: '0.2.9' }))).toBe(true)
  })

  it('leaves Android to the campaign of the promo sheet and the top banner', () => {
    expect(wantsDefaultBrowserBanner(state({ platform: 'android' }))).toBe(false)
    for (const platform of ['linux', 'win32', 'darwin'] as const)
      expect(wantsDefaultBrowserBanner(state({ platform }))).toBe(true)
  })
})
