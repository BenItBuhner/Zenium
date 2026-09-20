import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaState, Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import {
  closeMediaHub,
  formatMediaTime,
  handlesAction,
  livePosition,
  mediaDetail,
  mediaHubEntries,
  mediaHubLabel,
  mediaHubUi,
  mediaHubVisible,
  mediaTitle,
  openMediaHub,
  toggleMediaHub
} from '@renderer/lib/mediaHub'

/*
 * What the desktop's media hub (MW-16, Chrome's global media controls) reads from the state's
 * media entries: which tabs get a player and in what order, what the toolbar button says, the
 * lines a player leads with, where playback stands between reports, and how times are written.
 */

function tab(id: string, url: string, title = ''): Tab {
  return { id, url, title } as Tab
}

function media(over: Partial<MediaState> & { tabId: string }): MediaState {
  return { playing: false, ...over }
}

function stateWith(entries: MediaState[], tabs: Tab[]): UIState {
  return {
    media: entries,
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t]))
  } as unknown as UIState
}

afterEach(() => {
  mediaHubUi.set({ open: false, fromKeyboard: false })
  vi.mocked(run).mockClear()
})

describe('mediaHubEntries', () => {
  it('lists the media of tabs still open – the session first, then playing, then the rest in order', () => {
    const entries = [
      media({ tabId: 'paused', playing: false }),
      media({ tabId: 'gone', playing: true }),
      media({ tabId: 'playing', playing: true }),
      media({ tabId: 'session', playing: false, session: true }),
      media({ tabId: 'paused2', playing: false })
    ]
    const state = stateWith(entries, [
      tab('paused', 'https://a.example'),
      tab('playing', 'https://b.example'),
      tab('session', 'https://c.example'),
      tab('paused2', 'https://d.example')
    ])
    expect(mediaHubEntries(state).map((m) => m.tabId)).toEqual([
      'session',
      'playing',
      'paused',
      'paused2'
    ])
    expect(mediaHubVisible(state)).toBe(true)
    expect(mediaHubVisible(stateWith([], []))).toBe(false)
    expect(mediaHubVisible(stateWith([media({ tabId: 'gone' })], []))).toBe(false)
    expect(mediaHubVisible({ tabs: {} } as unknown as UIState)).toBe(false)
  })
})

describe('mediaHubLabel', () => {
  it('counts what plays', () => {
    expect(mediaHubLabel([media({ tabId: 'a' })])).toBe('Media controls')
    expect(mediaHubLabel([media({ tabId: 'a', playing: true })])).toBe('Media controls, 1 playing')
    expect(
      mediaHubLabel([
        media({ tabId: 'a', playing: true }),
        media({ tabId: 'b', playing: true }),
        media({ tabId: 'c' })
      ])
    ).toBe('Media controls, 2 playing')
  })
})

describe('mediaTitle and mediaDetail', () => {
  const site = tab('t', 'https://www.music.example/album/1', 'Album – Music')

  it('lead with the page metadata, then the tab, then the site; the detail says each once', () => {
    expect(mediaTitle(media({ tabId: 't', title: ' Nocturne ' }), site)).toBe('Nocturne')
    expect(mediaDetail(media({ tabId: 't', title: 'Nocturne', artist: 'The Band' }), site)).toBe(
      'The Band · music.example'
    )
    // No artist: the site alone.
    expect(mediaDetail(media({ tabId: 't', title: 'Nocturne' }), site)).toBe('music.example')
    // No metadata: the tab's title leads, the site under it.
    expect(mediaTitle(media({ tabId: 't' }), site)).toBe('Album – Music')
    expect(mediaDetail(media({ tabId: 't' }), site)).toBe('music.example')
    // No tab title either: the site is the title and is not said again.
    const bare = tab('t', 'https://www.music.example/')
    expect(mediaTitle(media({ tabId: 't' }), bare)).toBe('music.example')
    expect(mediaDetail(media({ tabId: 't' }), bare)).toBe('')
    // The artist is the site: once.
    expect(
      mediaDetail(media({ tabId: 't', title: 'Nocturne', artist: 'music.example' }), site)
    ).toBe('music.example')
    // No tab at all.
    expect(mediaTitle(media({ tabId: 't' }), undefined)).toBe('Media')
    expect(mediaDetail(media({ tabId: 't', artist: 'The Band' }), undefined)).toBe('The Band')
  })
})

describe('livePosition', () => {
  it('carries the reported position forward at the rate while playing, holds it while paused', () => {
    const position = { duration: 120, position: 30, playbackRate: 2 }
    expect(
      livePosition(media({ tabId: 't', playing: true, position, positionAt: 1000 }), 6000)
    ).toBe(40)
    expect(
      livePosition(media({ tabId: 't', playing: false, position, positionAt: 1000 }), 6000)
    ).toBe(30)
    // Never past the duration; never before the report.
    expect(
      livePosition(media({ tabId: 't', playing: true, position, positionAt: 1000 }), 1_000_000)
    ).toBe(120)
    expect(
      livePosition(media({ tabId: 't', playing: true, position, positionAt: 1000 }), 500)
    ).toBe(30)
    // A report without a time stands as it is; no report at all is the start.
    expect(livePosition(media({ tabId: 't', playing: true, position }), 6000)).toBe(30)
    expect(livePosition(media({ tabId: 't', playing: true, position: null }), 6000)).toBe(0)
    expect(livePosition(media({ tabId: 't', playing: true }), 6000)).toBe(0)
  })
})

describe('formatMediaTime', () => {
  it('writes m:ss, and h:mm:ss from an hour on', () => {
    expect(formatMediaTime(0)).toBe('0:00')
    expect(formatMediaTime(9.9)).toBe('0:09')
    expect(formatMediaTime(65)).toBe('1:05')
    expect(formatMediaTime(600)).toBe('10:00')
    expect(formatMediaTime(3600)).toBe('1:00:00')
    expect(formatMediaTime(3725)).toBe('1:02:05')
    expect(formatMediaTime(-5)).toBe('0:00')
    expect(formatMediaTime(Number.NaN)).toBe('0:00')
    expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('handlesAction', () => {
  it('is whether the page registered the track handler', () => {
    const m = media({ tabId: 't', actions: ['play', 'pause', 'nexttrack'] })
    expect(handlesAction(m, 'nexttrack')).toBe(true)
    expect(handlesAction(m, 'previoustrack')).toBe(false)
    expect(handlesAction(media({ tabId: 't' }), 'nexttrack')).toBe(false)
  })
})

describe('the hub open state', () => {
  it('opens from the button, taking the keyboard for the chrome when the button had it', () => {
    openMediaHub()
    expect(mediaHubUi.get()).toEqual({ open: true, fromKeyboard: false })
    expect(run).not.toHaveBeenCalled()
    closeMediaHub()
    expect(mediaHubUi.get().open).toBe(false)

    openMediaHub({ fromKeyboard: true })
    expect(mediaHubUi.get()).toEqual({ open: true, fromKeyboard: true })
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })

  it('the button toggles', () => {
    toggleMediaHub()
    expect(mediaHubUi.get().open).toBe(true)
    toggleMediaHub({ fromKeyboard: true })
    expect(mediaHubUi.get().open).toBe(false)
    // Closing what is closed changes nothing.
    const before = mediaHubUi.get()
    closeMediaHub()
    expect(mediaHubUi.get()).toBe(before)
  })
})
