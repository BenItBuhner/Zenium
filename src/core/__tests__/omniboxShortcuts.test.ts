import { describe, expect, it } from 'vitest'
import type { StoreIO } from '../platform'
import {
  MAX_SHORTCUTS,
  OmniboxShortcutsService,
  SHORTCUT_RETENTION_MS,
  migrateShortcuts,
  pruneShortcuts,
  scoreShortcut,
  shortcutKey,
  type Shortcut
} from '../omniboxShortcuts'

/*
 * The omnibox's shortcuts provider (omnibox-03, Chromium's ShortcutsProvider): learn, boost,
 * decay, clear. Every time is the fixture's clock, never the real date.
 */

const DAY = 86_400_000
const WEEK = 7 * DAY
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

function fakeIo(initial: Record<string, string> = {}): StoreIO & { docs: Record<string, string> } {
  const io = {
    docs: { ...initial },
    readSync: (name: string) => io.docs[name] ?? null,
    write: async (name: string, text: string) => {
      io.docs[name] = text
    },
    writeSync: (name: string, text: string) => {
      io.docs[name] = text
    }
  }
  return io
}

const GMAIL = { url: 'https://mail.google.com/mail/', title: 'Gmail', kind: 'url' as const }
const GITHUB = { url: 'https://github.com/', title: 'GitHub', kind: 'url' as const }
const CATS = {
  url: 'https://www.google.com/search?q=cats',
  title: 'cats',
  kind: 'search' as const,
  engineId: 'google'
}

function shortcut(partial: Partial<Shortcut> & { text: string; url: string }): Shortcut {
  return {
    fill: partial.fill ?? partial.url,
    title: partial.title ?? partial.url,
    kind: partial.kind ?? 'url',
    hits: partial.hits ?? 1,
    lastUsed: partial.lastUsed ?? NOW,
    ...partial
  }
}

describe('shortcutKey', () => {
  it('trims, lower-cases and collapses inner whitespace', () => {
    expect(shortcutKey('  Gmail  ')).toBe('gmail')
    expect(shortcutKey('how   to  brew')).toBe('how to brew')
    expect(shortcutKey('   ')).toBe('')
  })
})

describe('scoreShortcut', () => {
  it('is zero unless the shortcut text starts with what was typed', () => {
    const s = shortcut({ text: 'gmail', url: GMAIL.url })
    expect(scoreShortcut(s, 'g', NOW)).toBeGreaterThan(0)
    expect(scoreShortcut(s, 'gmail', NOW)).toBeGreaterThan(0)
    expect(scoreShortcut(s, 'mail', NOW)).toBe(0)
    expect(scoreShortcut(s, '', NOW)).toBe(0)
  })

  it('grows with the share of the text typed and with the hits', () => {
    const once = shortcut({ text: 'gmail', url: GMAIL.url, hits: 1 })
    const often = shortcut({ text: 'gmail', url: GMAIL.url, hits: 5 })
    expect(scoreShortcut(once, 'gmail', NOW)).toBeGreaterThan(scoreShortcut(once, 'g', NOW))
    expect(scoreShortcut(often, 'g', NOW)).toBeGreaterThan(scoreShortcut(once, 'g', NOW))
  })

  it('halves a once-used shortcut every week it goes unused', () => {
    const s = shortcut({ text: 'gmail', url: GMAIL.url, hits: 1, lastUsed: NOW })
    const fresh = scoreShortcut(s, 'gmail', NOW)
    expect(scoreShortcut(s, 'gmail', NOW + WEEK)).toBeCloseTo(fresh / 2, 10)
    expect(scoreShortcut(s, 'gmail', NOW + 2 * WEEK)).toBeCloseTo(fresh / 4, 10)
  })

  it('a shortcut used often decays more slowly, at most five times as slowly', () => {
    const rare = shortcut({ text: 'gmail', url: GMAIL.url, hits: 1, lastUsed: NOW })
    const frequent = shortcut({ text: 'gmail', url: GMAIL.url, hits: 21, lastUsed: NOW })
    const rareLoss = scoreShortcut(rare, 'gmail', NOW + WEEK) / scoreShortcut(rare, 'gmail', NOW)
    const frequentLoss =
      scoreShortcut(frequent, 'gmail', NOW + WEEK) / scoreShortcut(frequent, 'gmail', NOW)
    expect(rareLoss).toBeCloseTo(0.5, 10)
    // Five weeks to halve: one week leaves 2^(-1/5).
    expect(frequentLoss).toBeCloseTo(Math.pow(0.5, 1 / 5), 10)
    const veryFrequent = shortcut({ text: 'gmail', url: GMAIL.url, hits: 100, lastUsed: NOW })
    expect(
      scoreShortcut(veryFrequent, 'gmail', NOW + WEEK) / scoreShortcut(veryFrequent, 'gmail', NOW)
    ).toBeCloseTo(frequentLoss, 10)
  })
})

describe('pruneShortcuts', () => {
  it('drops what was last used 90 days ago or more and keeps the newest MAX_SHORTCUTS', () => {
    const kept = shortcut({
      text: 'a',
      url: 'https://a/',
      lastUsed: NOW - SHORTCUT_RETENTION_MS + 1
    })
    const gone = shortcut({ text: 'b', url: 'https://b/', lastUsed: NOW - SHORTCUT_RETENTION_MS })
    expect(pruneShortcuts([gone, kept], NOW)).toEqual([kept])
    const many = Array.from({ length: MAX_SHORTCUTS + 5 }, (_, i) =>
      shortcut({ text: `t${i}`, url: `https://s/${i}`, lastUsed: NOW - i * 1000 })
    )
    const pruned = pruneShortcuts(many, NOW)
    expect(pruned).toHaveLength(MAX_SHORTCUTS)
    expect(pruned[0].text).toBe('t0')
    expect(pruned.some((s) => s.text === `t${MAX_SHORTCUTS + 4}`)).toBe(false)
  })
})

describe('migrateShortcuts', () => {
  it('reads a v1 document, dropping malformed records, and starts empty otherwise', () => {
    const good = shortcut({ text: 'a', url: 'https://a/' })
    expect(
      migrateShortcuts({ version: 1, shortcuts: [good, { text: 'no url' }, null, 'x'] })
    ).toEqual([good])
    expect(migrateShortcuts(null)).toEqual([])
    expect(migrateShortcuts({ version: 2, shortcuts: [good] })).toEqual([])
    expect(migrateShortcuts('garbage')).toEqual([])
  })
})

describe('OmniboxShortcutsService', () => {
  function service(io = fakeIo()): {
    io: ReturnType<typeof fakeIo>
    s: OmniboxShortcutsService
    tick: (ms: number) => void
  } {
    let clock = NOW
    const s = new OmniboxShortcutsService(io, () => clock)
    return {
      io,
      s,
      tick: (ms) => {
        clock += ms
      }
    }
  }

  it('learns a typing → destination and counts repeat uses on the same shortcut', () => {
    const { s } = service()
    s.learn('gm', GMAIL)
    s.learn('gm', GMAIL)
    expect(s.all()).toHaveLength(1)
    expect(s.all()[0]).toMatchObject({
      text: 'gm',
      url: GMAIL.url,
      title: 'Gmail',
      fill: 'mail.google.com/mail/',
      kind: 'url',
      hits: 2
    })
    // Another destination for the same text is a shortcut of its own.
    s.learn('gm', GITHUB)
    expect(s.all()).toHaveLength(2)
  })

  it('remembers a search with its query as the fill and its engine', () => {
    const { s } = service()
    s.learn('cat', CATS)
    expect(s.all()[0]).toMatchObject({
      text: 'cat',
      fill: 'cats',
      kind: 'search',
      engineId: 'google'
    })
  })

  it('ignores empty typings and destinations without an address', () => {
    const { s } = service()
    s.learn('   ', GMAIL)
    s.learn('gm', { ...GMAIL, url: '' })
    expect(s.all()).toEqual([])
  })

  it('boosts the destination on a prefix of the remembered text, the most used first', () => {
    const { s } = service()
    s.learn('gm', GMAIL)
    s.learn('gm', GMAIL)
    s.learn('gi', GITHUB)
    s.learn('git', GITHUB)
    const forG = s.match('g')
    expect(forG.map((m) => m.url)).toEqual([GMAIL.url, GITHUB.url])
    expect(s.match('gi').map((m) => m.url)).toEqual([GITHUB.url])
    // One row per destination, whichever of its shortcuts scores best.
    expect(s.match('g', 10).filter((m) => m.url === GITHUB.url)).toHaveLength(1)
    expect(s.match('x')).toEqual([])
    expect(s.match('')).toEqual([])
  })

  it('a destination used often outranks one typed more fully', () => {
    const { s } = service()
    for (let i = 0; i < 6; i += 1) s.learn('gm', GMAIL)
    s.learn('gmx', GITHUB)
    expect(s.match('gm')[0].url).toBe(GMAIL.url)
  })

  it('decays: an unused shortcut loses to a fresh one and is forgotten after 90 days', () => {
    const { s, tick } = service()
    s.learn('g', GMAIL)
    s.learn('g', GMAIL)
    tick(3 * WEEK)
    s.learn('g', GITHUB)
    // Two hits three weeks old (÷8) against one fresh hit: the fresh one leads.
    expect(s.match('g').map((m) => m.url)).toEqual([GITHUB.url, GMAIL.url])
    tick(SHORTCUT_RETENTION_MS - 3 * WEEK)
    // Gmail's last use is now 90 days back: gone on the next learn.
    s.learn('h', { url: 'https://h.example/', title: 'H', kind: 'url' })
    expect(s.all().map((x) => x.url)).toEqual(['https://h.example/', GITHUB.url])
  })

  it('lists remembered searches most recent first, one per query, for zero-suggest', () => {
    const { s, tick } = service()
    s.learn('cat', CATS)
    tick(1000)
    s.learn('gm', GMAIL)
    tick(1000)
    s.learn('dog', { ...CATS, url: 'https://www.google.com/search?q=dogs', title: 'dogs' })
    tick(1000)
    s.learn('ca', CATS)
    expect(s.recentSearches(8).map((x) => x.fill)).toEqual(['cats', 'dogs'])
    expect(s.recentSearches(1).map((x) => x.fill)).toEqual(['cats'])
  })

  it('forgets by destination, by range and altogether', () => {
    const { s, tick } = service()
    s.learn('gm', GMAIL)
    tick(DAY)
    s.learn('gi', GITHUB)
    tick(DAY)
    s.learn('cat', CATS)
    s.forgetUrl(GMAIL.url)
    expect(s.all().map((x) => x.url)).toEqual([CATS.url, GITHUB.url])
    // The range holds GitHub's use only.
    s.forgetRange(NOW + DAY - 1, NOW + DAY + 1)
    expect(s.all().map((x) => x.url)).toEqual([CATS.url])
    s.clear()
    expect(s.all()).toEqual([])
  })

  it('persists to shortcuts.json and reads it back, pruning what expired meanwhile', () => {
    const { s, io } = service()
    s.learn('gm', GMAIL)
    s.learn('old', GITHUB)
    s.flushSync()
    const doc = JSON.parse(io.docs['shortcuts.json']) as { version: number; shortcuts: Shortcut[] }
    expect(doc.version).toBe(1)
    expect(doc.shortcuts.map((x) => x.text)).toEqual(['gm', 'old'])

    // A profile opened 91 days later: the shortcuts expired, and the file says so.
    doc.shortcuts[1].lastUsed = NOW - SHORTCUT_RETENTION_MS - DAY
    io.docs['shortcuts.json'] = JSON.stringify(doc)
    const later = new OmniboxShortcutsService(io, () => NOW)
    expect(later.all().map((x) => x.text)).toEqual(['gm'])
    later.flushSync()
    expect(JSON.parse(io.docs['shortcuts.json']).shortcuts).toHaveLength(1)
  })

  it('starts empty from a corrupt file and never writes until something is learned', () => {
    const io = fakeIo({ 'shortcuts.json': '{not json' })
    const { s } = service(io)
    expect(s.all()).toEqual([])
    s.flushSync()
    expect(io.docs['shortcuts.json']).toBe('{not json')
  })
})
