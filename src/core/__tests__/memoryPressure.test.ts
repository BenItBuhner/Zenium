import { describe, expect, it } from 'vitest'
import {
  DISCARD_BATCH,
  discardShare,
  planMemoryPressureDiscard,
  protectedReason,
  RECENTLY_AUDIBLE_MS,
  RECENTLY_SHOWN_MS,
  type SleepCandidate,
  sleepExemption
} from '../memoryPressure'

const NOW = 1_800_000_000_000

/** A hidden, quiet page shown an hour ago: eligible at every level unless `over` says otherwise. */
function page(id: string, over: Partial<SleepCandidate> = {}): SleepCandidate {
  return {
    id,
    url: `https://${id}.example/`,
    lastActiveAt: NOW - 60 * 60_000,
    visible: false,
    audible: false,
    quietAt: null,
    capturing: false,
    formEdited: false,
    loading: false,
    devtools: false,
    driven: false,
    ...over
  }
}

describe('the memory-pressure discard plan (OS-37)', () => {
  it("takes Chrome's share per level: a quarter, a half, all – rounded up, none of nothing", () => {
    expect(discardShare('moderate', 8)).toBe(2)
    expect(discardShare('low', 8)).toBe(4)
    expect(discardShare('critical', 8)).toBe(8)
    // Rounded up: one hidden page still sleeps at the mildest signal.
    expect(discardShare('moderate', 1)).toBe(1)
    expect(discardShare('low', 3)).toBe(2)
    expect(discardShare('moderate', 0)).toBe(0)
    expect(discardShare('critical', 0)).toBe(0)
  })

  it('sleeps the pages shown longest ago first', () => {
    const tabs = [
      page('c', { lastActiveAt: NOW - 3 * 60_000 }),
      page('a', { lastActiveAt: NOW - 30 * 60_000 }),
      page('d', { lastActiveAt: NOW - 2 * 60_000 }),
      page('b', { lastActiveAt: NOW - 10 * 60_000 })
    ]
    expect(planMemoryPressureDiscard(tabs, 'low', [], NOW)).toEqual(['a', 'b'])
    expect(planMemoryPressureDiscard(tabs, 'moderate', [], NOW)).toEqual(['a'])
    expect(planMemoryPressureDiscard(tabs, 'critical', [], NOW)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never sleeps a shown page, one being heard, or one that just went quiet', () => {
    expect(protectedReason(page('shown', { visible: true }), NOW)).toBe('visible')
    expect(protectedReason(page('radio', { audible: true }), NOW)).toBe('audible')
    // Between two songs: quiet for less than the grace.
    expect(protectedReason(page('paused', { quietAt: NOW - RECENTLY_AUDIBLE_MS + 1 }), NOW)).toBe(
      'recently-audible'
    )
    // Quiet for the whole grace: eligible again.
    expect(protectedReason(page('done', { quietAt: NOW - RECENTLY_AUDIBLE_MS }), NOW)).toBeNull()
  })

  it('never sleeps a live capture, a typed-into form, a loading page, DevTools or a driven page', () => {
    expect(protectedReason(page('cam', { capturing: true }), NOW)).toBe('capturing')
    expect(protectedReason(page('form', { formEdited: true }), NOW)).toBe('form')
    expect(protectedReason(page('load', { loading: true }), NOW)).toBe('loading')
    expect(protectedReason(page('dev', { devtools: true }), NOW)).toBe('devtools')
    expect(protectedReason(page('agent', { driven: true }), NOW)).toBe('driven')
    expect(protectedReason(page('plain'), NOW)).toBeNull()
  })

  it('the protections hold at every level, critical included', () => {
    for (const level of ['moderate', 'low', 'critical'] as const) {
      const tabs = [
        page('shown', { visible: true }),
        page('radio', { audible: true }),
        page('cam', { capturing: true }),
        page('form', { formEdited: true }),
        page('load', { loading: true }),
        page('dev', { devtools: true }),
        page('agent', { driven: true }),
        page('plain')
      ]
      expect(planMemoryPressureDiscard(tabs, level, [], NOW)).toEqual(['plain'])
    }
  })

  it('leaves the page the user just left alone, at every level', () => {
    const recent = page('recent', { lastActiveAt: NOW - RECENTLY_SHOWN_MS + 1 })
    const older = page('older', { lastActiveAt: NOW - RECENTLY_SHOWN_MS })
    expect(sleepExemption(recent, 'moderate', [], NOW)).toBe('recently-shown')
    expect(sleepExemption(recent, 'critical', [], NOW)).toBe('recently-shown')
    expect(sleepExemption(older, 'critical', [], NOW)).toBeNull()
    expect(planMemoryPressureDiscard([recent, older], 'critical', [], NOW)).toEqual(['older'])
  })

  it('holds the never-sleep list below critical and drops it there', () => {
    const mail = page('mail', { url: 'https://mail.google.com/mail/u/0/' })
    const excluded = ['Google.com']
    expect(sleepExemption(mail, 'moderate', ['google.com'], NOW)).toBe('listed')
    expect(sleepExemption(mail, 'low', ['google.com'], NOW)).toBe('listed')
    // The process is about to be killed: the listed page would go too, and comes back on focus.
    expect(sleepExemption(mail, 'critical', ['google.com'], NOW)).toBeNull()
    // The plan lower-cases the list as the settings store it.
    expect(planMemoryPressureDiscard([mail, page('plain')], 'low', excluded, NOW)).toEqual([
      'plain'
    ])
    expect(planMemoryPressureDiscard([mail, page('plain')], 'critical', excluded, NOW)).toEqual([
      'mail',
      'plain'
    ])
  })

  it('reads the share over the eligible pages, not over every page', () => {
    // Eight pages, four protected: low sleeps half of the four eligible, the oldest two.
    const tabs = [
      page('shown', { visible: true }),
      page('radio', { audible: true }),
      page('cam', { capturing: true }),
      page('recent', { lastActiveAt: NOW - 1_000 }),
      page('e1', { lastActiveAt: NOW - 4 * 60_000 }),
      page('e2', { lastActiveAt: NOW - 3 * 60_000 }),
      page('e3', { lastActiveAt: NOW - 2 * 60_000 }),
      page('e4', { lastActiveAt: NOW - 90_000 })
    ]
    expect(planMemoryPressureDiscard(tabs, 'low', [], NOW)).toEqual(['e1', 'e2'])
    expect(planMemoryPressureDiscard(tabs, 'moderate', [], NOW)).toEqual(['e1'])
  })

  it('the batch is small: a few destroys per main-thread task', () => {
    expect(DISCARD_BATCH).toBeLessThanOrEqual(3)
  })
})
