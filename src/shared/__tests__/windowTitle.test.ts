import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatWindowTitle, TITLE_UPDATE_INTERVAL_MS, TitleThrottle } from '../windowTitle'

describe('formatWindowTitle', () => {
  it('suffixes the active tab title with the product name', () => {
    expect(formatWindowTitle('Example Domain', false)).toBe('Example Domain - Zenium')
  })

  it('marks private windows', () => {
    expect(formatWindowTitle('Example Domain', true)).toBe('Example Domain - Zenium (Private)')
  })

  it('shows the bare product name with no active tab or an untitled one', () => {
    expect(formatWindowTitle(null, false)).toBe('Zenium')
    expect(formatWindowTitle(undefined, false)).toBe('Zenium')
    expect(formatWindowTitle('', false)).toBe('Zenium')
    expect(formatWindowTitle('   ', false)).toBe('Zenium')
    expect(formatWindowTitle(null, true)).toBe('Zenium (Private)')
  })

  it('trims whitespace around the tab title', () => {
    expect(formatWindowTitle('  Docs \n', false)).toBe('Docs - Zenium')
  })
})

describe('TitleThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function throttle(initial: string | null = null): { applied: string[]; t: TitleThrottle } {
    const applied: string[] = []
    const t = new TitleThrottle(
      (title) => applied.push(title),
      initial,
      () => Date.now()
    )
    return { applied, t }
  }

  it('applies the first title at once', () => {
    const { applied, t } = throttle()
    t.set('A - Zenium')
    expect(applied).toEqual(['A - Zenium'])
  })

  it('drops a title equal to the one the window already carries', () => {
    const { applied, t } = throttle('Zenium')
    t.set('Zenium')
    expect(applied).toEqual([])
    t.set('A - Zenium')
    vi.advanceTimersByTime(TITLE_UPDATE_INTERVAL_MS)
    t.set('A - Zenium')
    expect(applied).toEqual(['A - Zenium'])
  })

  it('coalesces a burst inside the interval into one trailing apply of the latest title', () => {
    const { applied, t } = throttle()
    t.set('1')
    vi.advanceTimersByTime(10)
    t.set('2')
    vi.advanceTimersByTime(10)
    t.set('3')
    vi.advanceTimersByTime(10)
    t.set('4')
    expect(applied).toEqual(['1'])
    vi.advanceTimersByTime(TITLE_UPDATE_INTERVAL_MS - 30)
    expect(applied).toEqual(['1', '4'])
  })

  it('never applies more than ten titles a second under a continuous stream', () => {
    const appliedAt: number[] = []
    const t = new TitleThrottle(
      () => appliedAt.push(Date.now()),
      null,
      () => Date.now()
    )
    for (let ms = 0; ms < 3000; ms += 5) {
      t.set(`title ${ms}`)
      vi.advanceTimersByTime(5)
    }
    expect(appliedAt.length).toBeGreaterThanOrEqual(30)
    // Any eleven consecutive applies span at least a second: at most ten fall in any 1 s window.
    for (let i = 0; i + 10 < appliedAt.length; i++)
      expect(appliedAt[i + 10] - appliedAt[i]).toBeGreaterThanOrEqual(1000)
  })

  it('does not lose the last title of a burst', () => {
    const { applied, t } = throttle()
    for (let ms = 0; ms < 1000; ms += 5) {
      t.set(`title ${ms}`)
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(TITLE_UPDATE_INTERVAL_MS)
    expect(applied.at(-1)).toBe('title 995')
  })

  it('applies at once again after the interval has passed', () => {
    const { applied, t } = throttle()
    t.set('1')
    vi.advanceTimersByTime(TITLE_UPDATE_INTERVAL_MS)
    t.set('2')
    expect(applied).toEqual(['1', '2'])
  })

  it('skips the trailing apply when the burst ends on the applied title', () => {
    const { applied, t } = throttle()
    t.set('1')
    t.set('2')
    t.set('1')
    vi.advanceTimersByTime(TITLE_UPDATE_INTERVAL_MS)
    expect(applied).toEqual(['1'])
  })

  it('cancel drops a pending trailing update', () => {
    const { applied, t } = throttle()
    t.set('1')
    t.set('2')
    t.cancel()
    vi.advanceTimersByTime(TITLE_UPDATE_INTERVAL_MS)
    expect(applied).toEqual(['1'])
  })
})
