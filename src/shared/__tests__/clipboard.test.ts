import { describe, expect, it } from 'vitest'
import { copyConfirmation } from '../clipboard'

const chip = { clipboardChip: true }
const noChip = { clipboardChip: false }

describe('copyConfirmation', () => {
  it('toasts on Android below 13, where the OS shows no clipboard chip', () => {
    expect(copyConfirmation('android', noChip, 'Link copied')).toBe('Link copied')
    expect(copyConfirmation('android', noChip, 'Image copied')).toBe('Image copied')
  })

  it('stays quiet on Android 13+, where the clipboard chip already says so', () => {
    expect(copyConfirmation('android', chip, 'Link copied')).toBeNull()
    expect(copyConfirmation('android', chip, 'Link copied', 'Copied URL')).toBeNull()
  })

  it('keeps desktop silent, whatever it reports about a chip', () => {
    for (const os of ['linux', 'win32', 'darwin'] as const) {
      expect(copyConfirmation(os, noChip, 'Link copied')).toBeNull()
      expect(copyConfirmation(os, chip, 'Link copied')).toBeNull()
    }
  })

  it('keeps the toast desktop always had, in its own words', () => {
    expect(copyConfirmation('linux', noChip, 'Link copied', 'Copied URL')).toBe('Copied URL')
    expect(
      copyConfirmation('darwin', noChip, 'Link copied as Markdown', 'Copied URL as Markdown')
    ).toBe('Copied URL as Markdown')
    // On Android the same copy follows the Android rule, not desktop's wording.
    expect(copyConfirmation('android', noChip, 'Link copied', 'Copied URL')).toBe('Link copied')
  })
})
