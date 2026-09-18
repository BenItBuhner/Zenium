import { describe, expect, it } from 'vitest'
import { DEFAULT_NEW_TAB_SETTINGS, DEFAULT_SETTINGS, sanitizeNewTabSettings } from '../defaults'

describe('new tab settings', () => {
  it('ship enabled, most visited over the space gradient, greeting off', () => {
    expect(DEFAULT_SETTINGS.newTab).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(DEFAULT_NEW_TAB_SETTINGS).toEqual({
      enabled: true,
      shortcuts: 'most-visited',
      background: 'space',
      greeting: false
    })
  })

  it('fills missing keys from the defaults', () => {
    expect(sanitizeNewTabSettings(undefined)).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(sanitizeNewTabSettings({})).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(sanitizeNewTabSettings({ enabled: false })).toEqual({
      ...DEFAULT_NEW_TAB_SETTINGS,
      enabled: false
    })
  })

  it('keeps known values and drops unknown ones', () => {
    expect(
      sanitizeNewTabSettings({ shortcuts: 'custom', background: 'image', greeting: true })
    ).toEqual({ enabled: true, shortcuts: 'custom', background: 'image', greeting: true })
    expect(sanitizeNewTabSettings({ shortcuts: 'tiles', background: 3, greeting: 'yes' })).toEqual(
      DEFAULT_NEW_TAB_SETTINGS
    )
  })
})
