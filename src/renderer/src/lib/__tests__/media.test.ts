import { describe, expect, it } from 'vitest'
import type { MediaState, Tab, UIState } from '@shared/types'
import {
  extrapolatePosition,
  formatMediaTime,
  handlesAction,
  mediaDetail,
  mediaOf,
  mediaSession
} from '../media'

/*
 * What the in-app player (the pill's Now playing chip and the media sheet, MW-16) reads from
 * `UIState.media`: the session tab, the extrapolated position, the times and the detail line.
 */

const tab = (id: string, url: string, title = 'Page'): Tab =>
  ({ id, url, title, containerId: 'default' }) as Tab

const media = (over: Partial<MediaState>): MediaState => ({ tabId: 't1', playing: true, ...over })

const state = (tabs: Tab[], list: MediaState[]): UIState =>
  ({
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    media: list
  }) as unknown as UIState

describe('mediaSession', () => {
  it('is the entry the core marked as the session, while its tab is there', () => {
    const s = state(
      [tab('t1', 'https://a.example/'), tab('t2', 'https://b.example/')],
      [media({ tabId: 't1' }), media({ tabId: 't2', session: true })]
    )
    expect(mediaSession(s)?.tabId).toBe('t2')
    // A session whose tab has gone from the list (a closing tab) counts for nothing.
    expect(
      mediaSession(
        state([tab('t1', 'https://a.example/')], [media({ tabId: 't2', session: true })])
      )
    ).toBeNull()
    // Audible tabs without a session (a page the OS controls do not show) give no chip.
    expect(
      mediaSession(state([tab('t1', 'https://a.example/')], [media({ tabId: 't1' })]))
    ).toBeNull()
  })

  it('mediaOf finds one tab’s media, or null', () => {
    const s = state([tab('t1', 'https://a.example/')], [media({ tabId: 't1', title: 'Song' })])
    expect(mediaOf(s, 't1')?.title).toBe('Song')
    expect(mediaOf(s, 't9')).toBeNull()
  })
})

describe('extrapolatePosition', () => {
  const at = 1_000_000
  it('carries the reported position forward at the playback rate while playing', () => {
    const m = media({ position: { duration: 200, position: 10, playbackRate: 1 }, positionAt: at })
    expect(extrapolatePosition(m, at)).toBe(10)
    expect(extrapolatePosition(m, at + 5_000)).toBe(15)
    const fast = media({
      position: { duration: 200, position: 10, playbackRate: 2 },
      positionAt: at
    })
    expect(extrapolatePosition(fast, at + 5_000)).toBe(20)
  })

  it('holds the reported position while paused and never runs past the duration', () => {
    const paused = media({
      playing: false,
      position: { duration: 200, position: 10, playbackRate: 1 },
      positionAt: at
    })
    expect(extrapolatePosition(paused, at + 60_000)).toBe(10)
    const nearEnd = media({
      position: { duration: 20, position: 18, playbackRate: 1 },
      positionAt: at
    })
    expect(extrapolatePosition(nearEnd, at + 10_000)).toBe(20)
  })

  it('reports 0 without a position, and does not clamp a stream without a duration', () => {
    expect(extrapolatePosition(media({}), at)).toBe(0)
    const live = media({ position: { duration: 0, position: 30, playbackRate: 1 }, positionAt: at })
    expect(extrapolatePosition(live, at + 4_000)).toBe(34)
    // A report without its time stands as reported.
    const bare = media({ position: { duration: 100, position: 7, playbackRate: 1 } })
    expect(extrapolatePosition(bare, at)).toBe(7)
  })
})

describe('formatMediaTime', () => {
  it('writes m:ss under an hour and h:mm:ss from one on, as the media notification does', () => {
    expect(formatMediaTime(0)).toBe('0:00')
    expect(formatMediaTime(9.7)).toBe('0:09')
    expect(formatMediaTime(74)).toBe('1:14')
    expect(formatMediaTime(3599)).toBe('59:59')
    expect(formatMediaTime(3600)).toBe('1:00:00')
    expect(formatMediaTime(3661)).toBe('1:01:01')
    expect(formatMediaTime(-5)).toBe('0:00')
    expect(formatMediaTime(Number.NaN)).toBe('0:00')
    expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('mediaDetail', () => {
  it('joins the artist and the site once each', () => {
    const t = tab('t1', 'https://music.example.com/album/1')
    expect(mediaDetail(media({ artist: 'The Band' }), t)).toBe('The Band · music.example.com')
    // The core fills the site in for an artist when the page set none: not twice.
    expect(mediaDetail(media({ artist: 'music.example.com' }), t)).toBe('music.example.com')
    expect(mediaDetail(media({ artist: '  ' }), t)).toBe('music.example.com')
    expect(mediaDetail(media({ artist: 'The Band' }), undefined)).toBe('The Band')
    expect(mediaDetail(media({}), undefined)).toBe('')
  })

  it('never repeats the site the title already is, and keeps an artist the page set', () => {
    const t = tab('t1', 'https://example.com/clip', 'example.com')
    // A page without a title of its own reads as its host, and the core filled the host in
    // for its artist: the title says it once, the line under it nothing.
    expect(mediaDetail(media({ artist: 'example.com' }), t, 'example.com')).toBe('')
    expect(mediaDetail(media({}), t, 'example.com')).toBe('')
    // A page with a title and no metadata: its title over its site.
    expect(mediaDetail(media({ artist: 'example.com' }), t, 'A clip')).toBe('example.com')
    // The page's own artist stays even when it is the title (a self-titled track).
    expect(mediaDetail(media({ artist: 'Weezer' }), t, 'Weezer')).toBe('Weezer · example.com')
    // The title alone never adds a site.
    expect(mediaDetail(media({}), undefined, 'example.com')).toBe('')
  })
})

describe('handlesAction', () => {
  it('is true only for actions the page registered', () => {
    expect(handlesAction(media({ actions: ['nexttrack'] }), 'nexttrack')).toBe(true)
    expect(handlesAction(media({ actions: ['nexttrack'] }), 'previoustrack')).toBe(false)
    expect(handlesAction(media({}), 'nexttrack')).toBe(false)
  })
})
