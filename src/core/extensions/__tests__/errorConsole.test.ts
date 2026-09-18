import { describe, expect, it } from 'vitest'
import {
  ERROR_CONSOLE_CAPACITY,
  ERROR_MESSAGE_MAX_LENGTH,
  ExtensionErrorRing,
  attributePageMessage,
  consoleLevel,
  extensionIdOfUrl,
  manifestIssueReport,
  type ExtensionErrorReport
} from '../errorConsole'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function error(message: string, extra: Partial<ExtensionErrorReport> = {}): ExtensionErrorReport {
  return { level: 'error', source: 'worker', message, ...extra }
}

describe('ExtensionErrorRing', () => {
  it('numbers lines from one, oldest first, stamping first and latest occurrence', () => {
    const ring = new ExtensionErrorRing()
    const first = ring.push(error('a'), 1000)
    const second = ring.push(error('b'), 2000)
    expect(first).toMatchObject({ id: 1, message: 'a', at: 1000, lastAt: 1000, count: 1 })
    expect(second).toMatchObject({ id: 2, message: 'b', at: 2000, lastAt: 2000, count: 1 })
    expect(ring.list().map((e) => e.id)).toEqual([1, 2])
    expect(ring.size).toBe(2)
  })

  it('collapses an identical line into a repeat count instead of a new row', () => {
    const ring = new ExtensionErrorRing()
    ring.push(error('boom', { url: 'chrome-extension://x/a.js', line: 3 }), 1000)
    const again = ring.push(error('boom', { url: 'chrome-extension://x/a.js', line: 3 }), 5000)
    expect(again).toMatchObject({ id: 1, count: 2, at: 1000, lastAt: 5000 })
    expect(ring.size).toBe(1)
  })

  it('keeps a line that differs in level, source, script, line or context apart', () => {
    const ring = new ExtensionErrorRing()
    const base = {
      url: 'chrome-extension://x/a.js',
      line: 3,
      context: 'chrome-extension://x/p.html'
    }
    ring.push(error('boom', base), 1)
    ring.push({ ...error('boom', base), level: 'warning' }, 1)
    ring.push({ ...error('boom', base), source: 'page' }, 1)
    ring.push(error('boom', { ...base, url: 'chrome-extension://x/b.js' }), 1)
    ring.push(error('boom', { ...base, line: 4 }), 1)
    ring.push(error('boom', { ...base, context: 'https://example.com/' }), 1)
    expect(ring.size).toBe(6)
  })

  it('a repeat never moves lastAt backwards', () => {
    const ring = new ExtensionErrorRing()
    ring.push(error('a'), 5000)
    expect(ring.push(error('a'), 3000).lastAt).toBe(5000)
  })

  it('drops the oldest lines past its capacity', () => {
    const ring = new ExtensionErrorRing(3)
    for (let i = 1; i <= 5; i++) ring.push(error(`line ${i}`), i)
    expect(ring.list().map((e) => e.message)).toEqual(['line 3', 'line 4', 'line 5'])
    expect(ring.list().map((e) => e.id)).toEqual([3, 4, 5])
  })

  it('defaults to the hundred lines Chrome keeps', () => {
    const ring = new ExtensionErrorRing()
    for (let i = 0; i < ERROR_CONSOLE_CAPACITY + 10; i++) ring.push(error(`line ${i}`), i)
    expect(ring.size).toBe(ERROR_CONSOLE_CAPACITY)
    expect(ring.list()[0].message).toBe('line 10')
  })

  it('cuts an overlong message and URL with an ellipsis, and treats a bad line number as unknown', () => {
    const ring = new ExtensionErrorRing()
    const entry = ring.push(
      error('x'.repeat(ERROR_MESSAGE_MAX_LENGTH + 50), {
        url: `chrome-extension://${ID}/${'y'.repeat(600)}`,
        line: 0
      }),
      1
    )
    expect(entry.message).toHaveLength(ERROR_MESSAGE_MAX_LENGTH)
    expect(entry.message.endsWith('\u2026')).toBe(true)
    expect(entry.url).toHaveLength(512)
    expect(entry.line).toBeNull()
  })

  it('normalises absent optional fields to null', () => {
    const ring = new ExtensionErrorRing()
    const entry = ring.push({ level: 'warning', source: 'load', message: 'm' }, 1)
    expect(entry).toMatchObject({ url: null, line: null, context: null })
    // An empty string is no URL either.
    expect(ring.push(error('n', { url: '', context: '' }), 1)).toMatchObject({
      url: null,
      context: null
    })
  })

  it('lists copies, so a caller cannot edit the ring through them', () => {
    const ring = new ExtensionErrorRing()
    ring.push(error('a'), 1)
    const listed = ring.list()
    listed[0].message = 'changed'
    expect(ring.list()[0].message).toBe('a')
  })

  it('removes the lines a predicate picks and reports how many', () => {
    const ring = new ExtensionErrorRing()
    ring.push({ level: 'warning', source: 'load', message: 'unknown key' }, 1)
    ring.push(error('runtime'), 2)
    ring.push({ level: 'error', source: 'load', message: 'bad pattern' }, 3)
    expect(ring.remove((e) => e.source === 'load')).toBe(2)
    expect(ring.list().map((e) => e.message)).toEqual(['runtime'])
    expect(ring.remove(() => false)).toBe(0)
  })

  it('clear empties the ring and starts the ids over', () => {
    const ring = new ExtensionErrorRing()
    ring.push(error('a'), 1)
    ring.push(error('b'), 2)
    ring.clear()
    expect(ring.size).toBe(0)
    expect(ring.push(error('c'), 3).id).toBe(1)
  })
})

describe('extensionIdOfUrl', () => {
  it('reads the id of a chrome-extension URL, scope or page', () => {
    expect(extensionIdOfUrl(`chrome-extension://${ID}/`)).toBe(ID)
    expect(extensionIdOfUrl(`chrome-extension://${ID}/popup.html?x=1`)).toBe(ID)
    expect(extensionIdOfUrl(`chrome-extension://${ID}`)).toBe(ID)
  })

  it('is null for anything else', () => {
    expect(extensionIdOfUrl('https://example.com/')).toBeNull()
    expect(extensionIdOfUrl(`https://${ID}.example.com/`)).toBeNull()
    expect(extensionIdOfUrl('chrome-extension://short/')).toBeNull()
    expect(extensionIdOfUrl(`chrome-extension://${ID}x/`)).toBeNull()
    expect(extensionIdOfUrl('')).toBeNull()
    expect(extensionIdOfUrl(null)).toBeNull()
    expect(extensionIdOfUrl(undefined)).toBeNull()
  })
})

describe('consoleLevel', () => {
  it("maps a worker's numeric scale and a page's names to warning and error", () => {
    expect(consoleLevel(3)).toBe('error')
    expect(consoleLevel(2)).toBe('warning')
    expect(consoleLevel('error')).toBe('error')
    expect(consoleLevel('warning')).toBe('warning')
  })

  it('leaves the rest out of the console', () => {
    expect(consoleLevel(0)).toBeNull()
    expect(consoleLevel(1)).toBeNull()
    expect(consoleLevel('info')).toBeNull()
    expect(consoleLevel('debug')).toBeNull()
    expect(consoleLevel('log')).toBeNull()
  })
})

describe('attributePageMessage', () => {
  it("credits a line inside an extension's document to it as a page line, whatever printed it", () => {
    expect(
      attributePageMessage(
        `chrome-extension://${ID}/popup.html`,
        `chrome-extension://${ID}/popup.js`
      )
    ).toEqual({ extensionId: ID, source: 'page' })
    // The API layer's "Unchecked runtime.lastError" has the preload for a script.
    expect(attributePageMessage(`chrome-extension://${ID}/popup.html`, '')).toEqual({
      extensionId: ID,
      source: 'page'
    })
    expect(
      attributePageMessage(
        `chrome-extension://${ID}/popup.html`,
        '/opt/zenium/preload/extension.js'
      )
    ).toEqual({ extensionId: ID, source: 'page' })
  })

  it("credits a tab page's line from an extension script to that extension as a content line", () => {
    expect(
      attributePageMessage('https://example.com/a', `chrome-extension://${OTHER}/content.js`)
    ).toEqual({ extensionId: OTHER, source: 'content' })
  })

  it("an extension page's line from another extension's script stays the page's", () => {
    expect(
      attributePageMessage(`chrome-extension://${ID}/p.html`, `chrome-extension://${OTHER}/c.js`)
    ).toEqual({ extensionId: ID, source: 'page' })
  })

  it("is null for the page's own lines and the chrome's", () => {
    expect(attributePageMessage('https://example.com/', 'https://example.com/app.js')).toBeNull()
    expect(attributePageMessage('https://example.com/', '')).toBeNull()
    expect(attributePageMessage(null, null)).toBeNull()
    expect(attributePageMessage('zen://home', '/opt/zenium/renderer/index.js')).toBeNull()
  })
})

describe('manifestIssueReport', () => {
  it('formats a manifest issue as a load line against manifest.json', () => {
    expect(
      manifestIssueReport(
        ID,
        { path: 'content_scripts[0].matches', message: 'Bad pattern' },
        'warning'
      )
    ).toEqual({
      level: 'warning',
      source: 'load',
      message: 'content_scripts[0].matches: Bad pattern',
      url: `chrome-extension://${ID}/manifest.json`,
      line: null,
      context: null
    })
    expect(manifestIssueReport(ID, { path: '', message: 'Not an object' }, 'error').message).toBe(
      'Not an object'
    )
  })
})
