import { describe, expect, it } from 'vitest'
import type { ExtensionErrorEntry } from '@shared/types'
import {
  ERROR_SOURCE_LABELS,
  errorCounts,
  errorDetail,
  errorLocation,
  errorSummary,
  newestFirst
} from '../errorText'

/* The words of the error console, shared by the desktop card and the phone's Errors sheet. */

const ID = 'a'.repeat(32)

function entry(over: Partial<ExtensionErrorEntry>): ExtensionErrorEntry {
  return {
    id: 1,
    level: 'error',
    source: 'worker',
    message: 'boom',
    url: `chrome-extension://${ID}/background.js`,
    line: 12,
    context: null,
    at: 1000,
    lastAt: 1000,
    count: 1,
    ...over
  }
}

const relative = (t: number): string => `t${t}`

describe('the error console’s words', () => {
  it('orders newest first by the latest occurrence, then by id', () => {
    const lines = [
      entry({ id: 1, lastAt: 100 }),
      entry({ id: 2, lastAt: 300 }),
      entry({ id: 3, lastAt: 200 }),
      entry({ id: 4, lastAt: 300 })
    ]
    expect(newestFirst(lines).map((e) => e.id)).toEqual([4, 2, 3, 1])
    // A copy: the console as the host sends it (oldest first) is not touched.
    expect(lines.map((e) => e.id)).toEqual([1, 2, 3, 4])
  })

  it('shortens the extension’s own files to their path and keeps other scripts whole', () => {
    expect(errorLocation(entry({}), ID)).toBe('background.js:12')
    expect(errorLocation(entry({ line: null }), ID)).toBe('background.js')
    expect(errorLocation(entry({ url: `chrome-extension://${ID}/` }), ID)).toBe('/:12')
    expect(errorLocation(entry({ url: 'https://news.example/app.js', line: 3 }), ID)).toBe(
      'https://news.example/app.js:3'
    )
    // Another extension's file is not this one's: it keeps its origin.
    const other = `chrome-extension://${'b'.repeat(32)}/x.js`
    expect(errorLocation(entry({ url: other, line: null }), ID)).toBe(other)
    expect(errorLocation(entry({ url: null }), ID)).toBeNull()
  })

  it('writes the detail line: source · when · ×count · file:line, each part only when it applies', () => {
    expect(errorDetail(entry({}), ID, relative)).toBe('Service worker · t1000 · background.js:12')
    expect(errorDetail(entry({ count: 3, lastAt: 2000 }), ID, relative)).toBe(
      'Service worker · t2000 · ×3 · background.js:12'
    )
    expect(errorDetail(entry({ source: 'load', url: null }), ID, relative)).toBe('Loading · t1000')
    expect(errorDetail(entry({ source: 'page', url: null, count: 1200 }), ID, relative)).toBe(
      'Extension page · t1000 · ×1,200'
    )
    expect(ERROR_SOURCE_LABELS.content).toBe('Content script')
  })

  it('counts lines by level (not repeats) and sums them for the summary', () => {
    const lines = [
      entry({ id: 1, count: 5 }),
      entry({ id: 2, level: 'warning' }),
      entry({ id: 3, level: 'warning', count: 2 })
    ]
    expect(errorCounts(lines)).toEqual({ errors: 1, warnings: 2 })
    expect(errorSummary(lines)).toBe('1 error, 2 warnings')
    expect(errorSummary([entry({})])).toBe('1 error')
    expect(errorSummary([entry({ id: 1 }), entry({ id: 2 })])).toBe('2 errors')
    expect(errorSummary([entry({ level: 'warning' })])).toBe('1 warning')
    expect(errorSummary([])).toBe('None')
  })
})
