import { describe, expect, it } from 'vitest'
import { Diagnostics, formatDuration, summarize } from '../diagnostics'

describe('Diagnostics', () => {
  it('counts calls and errors per tool and reports latency percentiles over the window', () => {
    let now = 1000
    const d = new Diagnostics(() => now)
    for (let i = 1; i <= 100; i++) {
      const end = d.begin('browser_snapshot')
      now += i
      end(i % 10 === 0 ? `failed ${i}` : null)
    }
    const end = d.begin('zen_status')
    now += 5
    end()
    const snap = d.snapshot({ live: 2, parked: 1 })
    expect(snap.calls).toEqual({ total: 101, errors: 10, inFlight: 0 })
    expect(snap.tools.browser_snapshot.calls).toBe(100)
    expect(snap.tools.browser_snapshot.errors).toBe(10)
    expect(snap.tools.browser_snapshot.p50Ms).toBe(50)
    expect(snap.tools.browser_snapshot.p95Ms).toBe(95)
    expect(snap.tools.browser_snapshot.maxMs).toBe(100)
    expect(snap.tools.zen_status).toEqual({ calls: 1, errors: 0, p50Ms: 5, p95Ms: 5, maxMs: 5 })
    expect(snap.recentErrors).toHaveLength(10)
    expect(snap.recentErrors[9].message).toBe('failed 100')
    expect(snap.sessions.live).toBe(2)
    expect(snap.sessions.parked).toBe(1)
    expect(snap.uptimeMs).toBe(now - 1000)
  })

  it('keeps only the last window of samples and the last twenty errors', () => {
    const d = new Diagnostics(() => 0)
    for (let i = 0; i < 500; i++) d.begin('t')(`e${i}`)
    const snap = d.snapshot({ live: 0, parked: 0 })
    expect(snap.tools.t.calls).toBe(500)
    expect(snap.recentErrors).toHaveLength(20)
    expect(snap.recentErrors[0].message).toBe('e480')
  })

  it('an end called twice counts once, and in-flight calls show while running', () => {
    const d = new Diagnostics(() => 0)
    const end = d.begin('t')
    expect(d.snapshot({ live: 0, parked: 0 }).calls.inFlight).toBe(1)
    end()
    end('again')
    const snap = d.snapshot({ live: 0, parked: 0 })
    expect(snap.calls).toEqual({ total: 1, errors: 0, inFlight: 0 })
  })

  it('summarizes in one line', () => {
    let now = 0
    const d = new Diagnostics(() => now)
    d.sessions.created = 3
    d.sessions.ended = 1
    const end = d.begin('browser_navigate')
    now = 2500
    end()
    now = 125_000
    const line = summarize(d.snapshot({ live: 2, parked: 1 }))
    expect(line).toBe(
      'up 2 min; sessions 2 live (1 parked), 3 created, 1 ended, 0 resumed after loss, 0 unknown; calls 1 (0 errors, 0 running); slowest: browser_navigate p95 2500 ms'
    )
    expect(formatDuration(59_000)).toBe('59 s')
    expect(formatDuration(3_600_000 * 2 + 60_000 * 5)).toBe('2 h 5 min')
  })
})
