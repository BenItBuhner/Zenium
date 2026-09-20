import { describe, expect, it } from 'vitest'
import {
  chromiumHistoryVisits,
  chromiumTransition,
  dedupeVisits,
  firefoxHistoryVisits,
  firefoxTransition,
  safariHistoryVisits
} from '../history'
import { historyImportSink } from '../historySink'
import { coreDataToEpochMs, prTimeToEpochMs, webkitToEpochMs } from '../time'
import {
  chromiumHistorySchema,
  firefoxPlacesSchema,
  memoryDatabase,
  safariHistorySchema
} from './helpers'

const NOW = Date.UTC(2026, 8, 20)
const WEBKIT_OFFSET_US = 11_644_473_600_000_000
const webkit = (ms: number): number => ms * 1000 + WEBKIT_OFFSET_US
const T0 = Date.UTC(2024, 0, 17, 21, 20)

describe('epochs', () => {
  it('converts WebKit, PRTime and Core Data stamps to epoch milliseconds', () => {
    expect(webkitToEpochMs('13350000000000000', NOW)).toBe(1705526400000)
    expect(webkitToEpochMs(13350000000000000, NOW)).toBe(1705526400000)
    expect(prTimeToEpochMs(1_690_000_000_000_000, NOW)).toBe(1_690_000_000_000)
    expect(prTimeToEpochMs(BigInt(1_690_000_000_000_000), NOW)).toBe(1_690_000_000_000)
    // 2024-05-06T07:08:09Z is 736672089 seconds after 2001-01-01.
    expect(coreDataToEpochMs(736672089, NOW)).toBe(Date.UTC(2024, 4, 6, 7, 8, 9))
    expect(coreDataToEpochMs(736672089.25, NOW)).toBe(Date.UTC(2024, 4, 6, 7, 8, 9, 250))
  })

  it('returns undefined for zero, unparseable and implausible stamps', () => {
    expect(webkitToEpochMs('0', NOW)).toBeUndefined()
    expect(webkitToEpochMs(null, NOW)).toBeUndefined()
    expect(webkitToEpochMs('nope', NOW)).toBeUndefined()
    // 1601: before anything plausible.
    expect(webkitToEpochMs(1000, NOW)).toBeUndefined()
    // Ten days into the future.
    expect(webkitToEpochMs(webkit(NOW + 10 * 86_400_000), NOW)).toBeUndefined()
    expect(prTimeToEpochMs(-5, NOW)).toBeUndefined()
    expect(coreDataToEpochMs(0, NOW)).toBeUndefined()
  })
})

describe('Chrome / Edge History', () => {
  it('maps PageTransition cores and qualifiers to HistoryTransition', () => {
    expect(chromiumTransition(0)).toBe('link')
    expect(chromiumTransition(1)).toBe('typed')
    expect(chromiumTransition(2)).toBe('link')
    expect(chromiumTransition(3)).toBeNull()
    expect(chromiumTransition(4)).toBeNull()
    expect(chromiumTransition(5)).toBe('typed')
    expect(chromiumTransition(6)).toBe('other')
    expect(chromiumTransition(7)).toBe('link')
    expect(chromiumTransition(8)).toBe('reload')
    // CHAIN_START | CHAIN_END on TYPED, the way an address bar entry lands.
    expect(chromiumTransition(0x30000001)).toBe('typed')
    // Chrome stores the 32-bit word signed: SERVER_REDIRECT | CHAIN_END | LINK is negative.
    expect(chromiumTransition(-1610612736)).toBe('redirect')
    expect(chromiumTransition(BigInt(-1610612736))).toBe('redirect')
    expect(chromiumTransition(0x40000000 | 1)).toBe('redirect')
    expect(chromiumTransition(99)).toBe('other')
    expect(chromiumTransition('x')).toBe('other')
  })

  it('reads urls + visits in time order, skipping hidden pages and subframes', () => {
    const db = memoryDatabase((native) => {
      chromiumHistorySchema(native)
      const url = native.prepare(
        'INSERT INTO urls(id, url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      url.run(1, 'https://zenium.app/', 'Zenium', 2, 1, webkit(T0 + 60_000), 0)
      url.run(2, 'https://www.chromium.org/Home/', 'Chromium', 1, 0, webkit(T0 + 30_000), 0)
      url.run(3, 'https://ads.example/frame', '', 1, 0, webkit(T0 + 45_000), 0)
      url.run(4, 'https://hidden.example/', 'Hidden', 1, 0, webkit(T0 + 50_000), 1)
      url.run(5, 'chrome://newtab/', 'New Tab', 1, 0, webkit(T0 + 55_000), 0)
      const visit = native.prepare(
        'INSERT INTO visits(id, url, visit_time, from_visit, transition) VALUES (?, ?, ?, ?, ?)'
      )
      visit.run(1, 1, webkit(T0), 0, 0x30000001) // TYPED | CHAIN_START | CHAIN_END
      visit.run(2, 2, webkit(T0 + 30_000), 1, 0x30000000) // LINK
      visit.run(3, 3, webkit(T0 + 45_000), 2, 0x30000003) // AUTO_SUBFRAME
      visit.run(4, 4, webkit(T0 + 50_000), 0, 0) // hidden url
      visit.run(5, 5, webkit(T0 + 55_000), 0, 6) // chrome://
      visit.run(6, 1, webkit(T0 + 60_000), 0, 8) // RELOAD
      visit.run(7, 1, webkit(T0 + 90_000), 0, -1610612736) // SERVER_REDIRECT | CHAIN_END | LINK
    })
    const result = chromiumHistoryVisits(db, NOW)
    db.close()
    expect(result.visits).toEqual([
      { url: 'https://zenium.app/', title: 'Zenium', at: T0, transition: 'typed' },
      {
        url: 'https://www.chromium.org/Home/',
        title: 'Chromium',
        at: T0 + 30_000,
        transition: 'link'
      },
      { url: 'https://zenium.app/', title: 'Zenium', at: T0 + 60_000, transition: 'reload' },
      { url: 'https://zenium.app/', title: 'Zenium', at: T0 + 90_000, transition: 'redirect' }
    ])
    expect(result.skipped).toBe(3)
  })
})

describe('Firefox places.sqlite history', () => {
  it('maps TRANSITION_* codes and skips embeds, downloads and framed links', () => {
    expect(firefoxTransition(1)).toBe('link')
    expect(firefoxTransition(2)).toBe('typed')
    expect(firefoxTransition(3)).toBe('link')
    expect(firefoxTransition(4)).toBeNull()
    expect(firefoxTransition(5)).toBe('redirect')
    expect(firefoxTransition(6)).toBe('redirect')
    expect(firefoxTransition(7)).toBeNull()
    expect(firefoxTransition(8)).toBeNull()
    expect(firefoxTransition(9)).toBe('reload')
    expect(firefoxTransition(42)).toBe('other')
  })

  it('reads moz_historyvisits joined to moz_places, PRTime to milliseconds', () => {
    const db = memoryDatabase((native) => {
      firefoxPlacesSchema(native)
      const place = native.prepare(
        'INSERT INTO moz_places(id, url, title, hidden, guid) VALUES (?, ?, ?, ?, ?)'
      )
      place.run(1, 'https://www.mozilla.org/', 'Mozilla', 0, 'p1')
      place.run(2, 'https://zenium.app/', null, 0, 'p2')
      place.run(3, 'https://tracker.example/pixel', '', 1, 'p3')
      place.run(4, 'about:newtab', 'New Tab', 0, 'p4')
      const visit = native.prepare(
        'INSERT INTO moz_historyvisits(id, from_visit, place_id, visit_date, visit_type) VALUES (?, ?, ?, ?, ?)'
      )
      visit.run(1, 0, 1, (T0 + 5000) * 1000, 2)
      visit.run(2, 1, 2, T0 * 1000, 1)
      visit.run(3, 0, 3, (T0 + 1000) * 1000, 4)
      visit.run(4, 0, 4, (T0 + 2000) * 1000, 1)
      visit.run(5, 2, 2, (T0 + 9000) * 1000, 5)
    })
    const result = firefoxHistoryVisits(db, NOW)
    db.close()
    expect(result.visits).toEqual([
      { url: 'https://zenium.app/', title: '', at: T0, transition: 'link' },
      { url: 'https://www.mozilla.org/', title: 'Mozilla', at: T0 + 5000, transition: 'typed' },
      { url: 'https://zenium.app/', title: '', at: T0 + 9000, transition: 'redirect' }
    ])
    expect(result.skipped).toBe(2)
  })
})

describe('Safari History.db', () => {
  it('reads history_visits joined to history_items, Core Data seconds to milliseconds', () => {
    const coreData = (ms: number): number => ms / 1000 - 978_307_200
    const db = memoryDatabase((native) => {
      safariHistorySchema(native)
      const item = native.prepare(
        'INSERT INTO history_items(id, url, visit_count, daily_visit_counts, should_recompute_derived_visit_counts, visit_count_score) VALUES (?, ?, ?, ?, ?, ?)'
      )
      item.run(1, 'https://www.apple.com/', 2, new Uint8Array(0), 0, 100)
      item.run(2, 'https://zenium.app/', 1, new Uint8Array(0), 0, 50)
      item.run(3, 'https://down.example/', 1, new Uint8Array(0), 0, 0)
      const visit = native.prepare(
        'INSERT INTO history_visits(id, history_item, visit_time, title, load_successful, redirect_source) VALUES (?, ?, ?, ?, ?, ?)'
      )
      visit.run(1, 1, coreData(T0), 'Apple', 1, null)
      visit.run(2, 2, coreData(T0 + 1000), 'Zenium', 1, null)
      visit.run(3, 1, coreData(T0 + 2000), 'Apple (redirected)', 1, 2)
      visit.run(4, 3, coreData(T0 + 3000), null, 0, null)
    })
    const result = safariHistoryVisits(db, NOW)
    db.close()
    expect(result.visits).toEqual([
      { url: 'https://www.apple.com/', title: 'Apple', at: T0, transition: 'link' },
      { url: 'https://zenium.app/', title: 'Zenium', at: T0 + 1000, transition: 'link' },
      {
        url: 'https://www.apple.com/',
        title: 'Apple (redirected)',
        at: T0 + 2000,
        transition: 'redirect'
      }
    ])
    expect(result.skipped).toBe(1)
  })
})

describe('dedupeVisits and the history sink', () => {
  it('orders oldest first and drops a repeated (url, time)', () => {
    const visits = [
      { url: 'https://a.example/', title: 'A', at: T0 + 10, transition: 'link' as const },
      { url: 'https://a.example/', title: 'A', at: T0, transition: 'typed' as const },
      { url: 'https://a.example/', title: 'A', at: T0 + 10, transition: 'link' as const },
      { url: 'https://b.example/', title: 'B', at: T0 + 10, transition: 'link' as const }
    ]
    const result = dedupeVisits(visits)
    expect(result.duplicates).toBe(1)
    expect(result.visits.map((v) => [v.url, v.at])).toEqual([
      ['https://a.example/', T0],
      ['https://a.example/', T0 + 10],
      ['https://b.example/', T0 + 10]
    ])
  })

  it('finds the bulk API on the history service only once it exists (the feature check)', () => {
    expect(historyImportSink(null)).toBeNull()
    expect(historyImportSink({ visit: () => undefined })).toBeNull()
    const sink = { importVisits: () => ({ added: 1, skipped: 0 }) }
    expect(historyImportSink(sink)).toBe(sink)
  })
})
