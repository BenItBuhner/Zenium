import { describe, expect, it } from 'vitest'
import { emulatedColorScheme, emulatedMediaParams } from '../pageColorScheme'
import type { ColorScheme } from '../../../shared/types'

describe('emulatedColorScheme', () => {
  it('emulates an explicit Light or Dark on Linux only', () => {
    expect(emulatedColorScheme('linux', 'dark')).toBe('dark')
    expect(emulatedColorScheme('linux', 'light')).toBe('light')
  })

  it('leaves System to the engine everywhere, and every scheme on the platforms whose engine follows the setting', () => {
    expect(emulatedColorScheme('linux', 'system')).toBeNull()
    const schemes: ColorScheme[] = ['system', 'light', 'dark']
    for (const platform of ['win32', 'darwin', 'freebsd'] as const) {
      for (const scheme of schemes) expect(emulatedColorScheme(platform, scheme)).toBeNull()
    }
  })
})

describe('emulatedMediaParams', () => {
  it('names the prefers-color-scheme feature for an override and sends an empty list to release it', () => {
    expect(emulatedMediaParams('dark')).toEqual({
      features: [{ name: 'prefers-color-scheme', value: 'dark' }]
    })
    expect(emulatedMediaParams('light')).toEqual({
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    })
    expect(emulatedMediaParams(null)).toEqual({ features: [] })
  })
})
