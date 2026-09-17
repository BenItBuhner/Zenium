import { describe, expect, it } from 'vitest'
import { formatBytes, formatDate, relativeTime } from '../format'
import { warningGlyph } from '../warningGlyph'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

describe('relativeTime', () => {
  it('rounds down to the coarsest unit that reads naturally', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now')
    expect(relativeTime(NOW - 60_000, NOW)).toBe('1 minute ago')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago')
    expect(relativeTime(NOW - 3_600_000, NOW)).toBe('1 hour ago')
    expect(relativeTime(NOW - 7 * 3_600_000, NOW)).toBe('7 hours ago')
    expect(relativeTime(NOW - 30 * 3_600_000, NOW)).toBe('yesterday')
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago')
  })

  it('falls back to the date after a week and never goes negative', () => {
    expect(relativeTime(NOW - 9 * 86_400_000, NOW)).toBe(formatDate(NOW - 9 * 86_400_000))
    expect(relativeTime(NOW + 60_000, NOW)).toBe('just now')
  })
})

describe('formatBytes', () => {
  it('uses one decimal under 10 and none above', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(840 * 1024)).toBe('840 KB')
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB')
    expect(formatBytes(24 * 1024 * 1024)).toBe('24 MB')
    expect(formatBytes(-1)).toBe('')
  })
})

describe('warningGlyph', () => {
  it('maps the common Chrome warnings', () => {
    expect(warningGlyph('Read and change all your data on all websites')).toBe('globe')
    expect(warningGlyph('Read your browsing history')).toBe('history')
    expect(warningGlyph('Manage your downloads')).toBe('download')
    expect(warningGlyph('Display notifications')).toBe('bell')
    expect(warningGlyph('Read and modify data you copy and paste')).toBe('clipboard')
    expect(warningGlyph('Manage your apps, extensions, and themes')).toBe('puzzle')
    expect(warningGlyph('Block content on any page')).toBe('shield')
    expect(warningGlyph('Read and change your bookmarks')).toBe('bookmark')
    expect(warningGlyph('Change your privacy-related settings')).toBe('lock')
    expect(warningGlyph('Detect your physical location')).toBe('map-pin')
    expect(warningGlyph('Communicate with cooperating native applications')).toBe('terminal')
    expect(warningGlyph('Identify and eject storage devices')).toBe('hard-drive')
    expect(warningGlyph('Read and change your data on example.com')).toBe('globe')
  })

  it('falls back to a key for anything unknown', () => {
    expect(warningGlyph('Something new Chrome invented')).toBe('key-round')
  })
})
