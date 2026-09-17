import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThrottledValue } from '../throttle'

describe('ThrottledValue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits immediately then coalesces to 10/s', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const t = new ThrottledValue<string>(100, (v) => seen.push(v))
    t.push('a')
    t.push('b')
    t.push('c')
    expect(seen).toEqual(['a'])
    vi.advanceTimersByTime(99)
    expect(seen).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['a', 'c'])
    t.dispose()
  })
})
