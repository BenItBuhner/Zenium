import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import { rowsFromEntries } from '../historyAdapter'

describe('rowsFromEntries', () => {
  it('turns a per-URL aggregate into one visit at its last visit, keyed by URL', () => {
    const entries: HistoryEntry[] = [
      {
        url: 'https://example.com/a',
        title: 'Example',
        visitCount: 3,
        lastVisit: 1_700_000_000_000,
        favicon: 'https://example.com/favicon.ico'
      },
      { url: 'https://example.com/b', title: '', visitCount: 1, lastVisit: 1, favicon: null }
    ]
    expect(rowsFromEntries(entries)).toEqual([
      {
        id: 'https://example.com/a',
        url: 'https://example.com/a',
        title: 'Example',
        favicon: 'https://example.com/favicon.ico',
        visitTime: 1_700_000_000_000
      },
      {
        id: 'https://example.com/b',
        url: 'https://example.com/b',
        title: 'https://example.com/b',
        favicon: null,
        visitTime: 1
      }
    ])
  })

  it('keeps the input order', () => {
    const entries: HistoryEntry[] = ['z', 'a', 'm'].map((k) => ({
      url: `https://${k}.example/`,
      title: k,
      visitCount: 1,
      lastVisit: 0,
      favicon: null
    }))
    expect(rowsFromEntries(entries).map((r) => r.title)).toEqual(['z', 'a', 'm'])
  })
})
