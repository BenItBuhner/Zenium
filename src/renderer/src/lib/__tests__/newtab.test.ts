import { describe, expect, it } from 'vitest'
import type { Rect } from '@shared/types'
import {
  composeTiles,
  GROW_FADE_FROM,
  GROW_ORIGIN_RADIUS,
  growClipPath,
  growFrame,
  growHolePath,
  growSurfaceOpacity,
  growTravel,
  tileLabel
} from '../newtab'
import type { TopSite } from '../historyAdapter'

const origin: Rect = { x: 300, y: 800, width: 44, height: 44 }
const frame: Rect = { x: 6, y: 40, width: 380, height: 700 }

describe('the grow surface (MOT-03)', () => {
  it('starts as the control, ends as the frame, and moves every edge on a straight line', () => {
    expect(growFrame(0, origin, frame, 14)).toEqual({ ...origin, radius: GROW_ORIGIN_RADIUS })
    expect(growFrame(1, origin, frame, 14)).toEqual({ ...frame, radius: 14 })
    const mid = growFrame(0.5, origin, frame, 14)
    expect(mid.x).toBe((origin.x + frame.x) / 2)
    expect(mid.y).toBe((origin.y + frame.y) / 2)
    expect(mid.width).toBe((origin.width + frame.width) / 2)
    expect(mid.height).toBe((origin.height + frame.height) / 2)
    expect(mid.radius).toBe((GROW_ORIGIN_RADIUS + 14) / 2)
    // A spring's overshoot is clamped: the surface never grows past the frame.
    expect(growFrame(1.2, origin, frame, 14)).toEqual({ ...frame, radius: 14 })
    expect(growFrame(-0.1, origin, frame, 14).width).toBe(origin.width)
  })

  it('clips a window-sized layer to the surface, in the inset() vocabulary', () => {
    const layer: Rect = { x: 0, y: 0, width: 400, height: 900 }
    expect(growClipPath({ ...origin, radius: 22 }, layer)).toBe(
      'inset(800px 56px 56px 300px round 22px)'
    )
    expect(growClipPath({ ...frame, radius: 14 }, layer)).toBe(
      'inset(40px 14px 160px 6px round 14px)'
    )
  })

  it('runs the spring over the distance the surface travels, never a trivial one', () => {
    expect(growTravel(origin, frame)).toBeGreaterThan(400)
    expect(growTravel(frame, frame)).toBe(120)
  })

  it('fades the surface on its own progress, from seven tenths to arrival (v2 §11 rule 4)', () => {
    expect(GROW_FADE_FROM).toBe(0.7)
    expect(growSurfaceOpacity(0)).toBe(1)
    expect(growSurfaceOpacity(0.7)).toBe(1)
    expect(growSurfaceOpacity(0.85)).toBe(0.5)
    expect(growSurfaceOpacity(1)).toBe(0)
    // A spring's overshoot never brings it back.
    expect(growSurfaceOpacity(1.1)).toBe(0)
    // Run backwards, it comes back along the same line.
    expect(growSurfaceOpacity(0.775)).toBe(0.75)
  })

  it('cuts the surface out of the capture beneath it, in the capture’s own coordinates', () => {
    const card: Rect = { x: 6, y: 40, width: 380, height: 700 }
    const hole = growHolePath({ x: 106, y: 140, width: 200, height: 100, radius: 20 }, card)
    expect(hole).toBe(
      'path(evenodd, "M0 0H380V700H0Z' +
        'M120 100H280A20 20 0 0 1 300 120V180A20 20 0 0 1 280 200H120A20 20 0 0 1 100 180V120A20 20 0 0 1 120 100Z")'
    )
    // Arrived, the cut-out is the whole card: nothing of the old page is left.
    expect(growHolePath({ ...frame, radius: 14 }, card)).toContain('M14 0H366A14 14 0 0 1 380 14')
    // The origin pill: its radius never exceeds half a side.
    expect(growHolePath({ x: 6, y: 40, width: 44, height: 44, radius: 22 }, card)).toContain(
      'A22 22 0 0 1'
    )
    expect(growHolePath({ x: 6, y: 40, width: 20, height: 44, radius: 22 }, card)).toContain(
      'A10 10 0 0 1'
    )
  })
})

const site = (url: string, title = '', favicon: string | null = null): TopSite => ({
  url,
  title,
  favicon,
  score: 1
})

describe('composeTiles', () => {
  const ranked = [
    site('https://a.example/', 'A', 'a.png'),
    site('https://b.example/', 'B'),
    site('https://c.example/', 'C')
  ]

  it('puts the pins first, then the most visited sites of other hosts, up to n', () => {
    const tiles = composeTiles({
      pinned: [
        { url: 'https://c.example/start', title: 'C start' },
        { url: 'https://p.example/', title: 'P' }
      ],
      ranked,
      style: 'most-visited',
      n: 8
    })
    expect(tiles.map((t) => t.url)).toEqual([
      'https://c.example/start',
      'https://p.example/',
      'https://a.example/',
      'https://b.example/'
    ])
    expect(tiles.map((t) => t.pinned)).toEqual([true, true, false, false])
    expect(composeTiles({ pinned: [], ranked, style: 'most-visited', n: 2 })).toHaveLength(2)
  })

  it('"my shortcuts" shows the pins alone', () => {
    const tiles = composeTiles({
      pinned: [{ url: 'https://p.example/', title: 'P' }],
      ranked,
      style: 'my-shortcuts',
      n: 8
    })
    expect(tiles.map((t) => t.url)).toEqual(['https://p.example/'])
  })

  it('a pin borrows its icon and a missing title from what is known about its host', () => {
    const tiles = composeTiles({
      pinned: [
        { url: 'https://www.a.example/', title: '' },
        { url: 'https://t.example/', title: 'T' },
        { url: 'https://T.example/again', title: 'dupe host' }
      ],
      ranked,
      style: 'most-visited',
      n: 8,
      favicons: new Map([['t.example', 'tab.png']])
    })
    expect(tiles[0]).toMatchObject({ title: 'A', favicon: 'a.png', pinned: true })
    expect(tiles[1]).toMatchObject({ title: 'T', favicon: 'tab.png' })
    // One tile per host: the second pin of t.example is dropped, and a.example is not repeated.
    expect(tiles.map((t) => t.url)).toEqual([
      'https://www.a.example/',
      'https://t.example/',
      'https://b.example/',
      'https://c.example/'
    ])
  })
})

describe('tileLabel', () => {
  it('is the site name from a front page title, or the host when there is none that fits', () => {
    expect(tileLabel('YouTube', 'https://www.youtube.com/')).toBe('YouTube')
    expect(tileLabel('Hacker News - Top', 'https://news.ycombinator.com/')).toBe('Hacker News')
    expect(tileLabel('GitHub · Where software is built', 'https://github.com/')).toBe('GitHub')
    expect(tileLabel("GitHub: Let's build from here", 'https://github.com/')).toBe('GitHub')
    expect(tileLabel('', 'https://www.example.com/x')).toBe('example.com')
    expect(tileLabel('A very long page title that goes on and on', 'https://long.example/')).toBe(
      'long.example'
    )
    expect(tileLabel('', 'nonsense')).toBe('nonsense')
  })

  it('takes the site suffix of a page inside a site, or its host when the title has none', () => {
    expect(tileLabel('Coffee - Wikipedia', 'https://en.wikipedia.org/wiki/Coffee')).toBe(
      'Wikipedia'
    )
    expect(
      tileLabel('corner-shape - CSS | MDN', 'https://developer.mozilla.org/en-US/docs/Web/CSS/x')
    ).toBe('MDN')
    expect(tileLabel('Cat video - YouTube', 'https://www.youtube.com/watch?v=1')).toBe('YouTube')
    expect(tileLabel('RFC 2324: HTCPCP/1.0', 'https://www.rfc-editor.org/rfc/rfc2324.html')).toBe(
      'rfc-editor.org'
    )
    expect(
      tileLabel('BenItBuhner/Zenium: a Zen-style browser', 'https://github.com/BenItBuhner/Zenium')
    ).toBe('github.com')
    expect(tileLabel('Long title - A site whose name is far too long', 'https://x.example/a')).toBe(
      'x.example'
    )
  })
})
