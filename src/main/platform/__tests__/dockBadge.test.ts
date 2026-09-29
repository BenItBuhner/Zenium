import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBadge } from '../../../shared/appBadge'

/*
 * The dock badge's one owner (MW-51): the downloads' unseen count and the installed apps' badges
 * share the macOS dock badge and the Linux launcher count, and the arbiter decides what the icon
 * shows – the downloads count while it is up, the apps' saturated sum otherwise, a flag as • or
 * 1, nothing when nothing – writing a figure only when it changes. Windows has no app-wide badge.
 */

const dock = { setBadge: vi.fn() }
const setBadgeCount = vi.fn()
vi.mock('electron', () => ({
  app: {
    get dock() {
      return dockPresent ? dock : undefined
    },
    setBadgeCount
  }
}))
let dockPresent = true

const { DockBadge } = await import('../dockBadge')

const count = (value: number): AppBadge => ({ kind: 'count', value })
const FLAG: AppBadge = { kind: 'flag' }

/** Every label written to the dock, in order. */
const labels = (): string[] => dock.setBadge.mock.calls.map((c) => c[0] as string)
/** Every count set on the launcher, in order. */
const counts = (): number[] => setBadgeCount.mock.calls.map((c) => c[0] as number)

describe('DockBadge', () => {
  beforeEach(() => {
    dock.setBadge.mockClear()
    setBadgeCount.mockClear()
    dockPresent = true
  })

  it('on macOS shows the downloads count as before: each new completion, then nothing on focus', () => {
    const badge = new DockBadge(() => 'darwin')
    badge.setDownloads(1)
    badge.setDownloads(2)
    badge.setDownloads(0)
    expect(labels()).toEqual(['1', '2', ''])
    expect(counts()).toEqual([])
  })

  it('on macOS shows the apps’ counts summed, 99+ past the maximum, • for a flag alone, nothing when none', () => {
    const badge = new DockBadge(() => 'darwin')
    badge.setApp('a', count(3))
    badge.setApp('b', count(4))
    badge.setApp('a', null)
    // A flag beside a count adds nothing to the count.
    badge.setApp('c', FLAG)
    badge.setApp('b', null)
    badge.setApp('c', null)
    expect(labels()).toEqual(['3', '7', '4', '•', ''])
    badge.setApp('a', count(60))
    badge.setApp('b', count(50))
    expect(labels().at(-1)).toBe('99+')
    expect(badge.label()).toBe('99+')
  })

  it('lets the downloads count stand while it is up, and brings the apps’ badge back after', () => {
    const badge = new DockBadge(() => 'darwin')
    badge.setApp('a', count(5))
    badge.setDownloads(1)
    badge.setDownloads(2)
    // The apps' badge changing under the downloads count changes nothing shown.
    badge.setApp('a', count(6))
    badge.setDownloads(0)
    badge.setApp('a', null)
    expect(labels()).toEqual(['5', '1', '2', '6', ''])
  })

  it('writes a figure only when it changes, and nothing at all for clearing what never showed', () => {
    const badge = new DockBadge(() => 'darwin')
    badge.setApp('a', null)
    badge.setDownloads(0)
    expect(labels()).toEqual([])
    badge.setApp('a', count(2))
    badge.setApp('a', { kind: 'count', value: 2 })
    badge.setApp('b', FLAG)
    expect(labels()).toEqual(['2'])
    // No dock (a build without one): nothing to write to, nothing thrown.
    dockPresent = false
    badge.setApp('a', count(3))
    expect(labels()).toEqual(['2'])
  })

  it('on Linux sets the launcher count: the downloads count first, the apps’ sum (unsaturated) next, 1 for a flag', () => {
    const badge = new DockBadge(() => 'linux')
    badge.setApp('a', count(3))
    badge.setApp('b', count(120))
    badge.setApp('a', null)
    badge.setApp('b', null)
    badge.setApp('c', FLAG)
    // One unseen download over a flag is the same 1 on the launcher: nothing to write.
    badge.setDownloads(1)
    badge.setDownloads(0)
    badge.setApp('c', null)
    expect(counts()).toEqual([3, 123, 120, 0, 1, 0])
    expect(labels()).toEqual([])
    expect(badge.count()).toBe(0)
  })

  it('on Linux clearing what never showed writes nothing', () => {
    const badge = new DockBadge(() => 'linux')
    badge.setDownloads(0)
    badge.setApp('a', null)
    expect(counts()).toEqual([])
  })

  it('on Windows writes nothing: the taskbar has each window’s own overlay instead', () => {
    const badge = new DockBadge(() => 'win32')
    badge.setApp('a', count(3))
    badge.setDownloads(2)
    expect(labels()).toEqual([])
    expect(counts()).toEqual([])
    // The rule is still answerable, for whoever asks.
    expect(badge.label()).toBe('2')
    expect(badge.count()).toBe(2)
  })
})
