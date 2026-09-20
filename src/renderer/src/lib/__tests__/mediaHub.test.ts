import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaState, Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { mediaDetail } from '@renderer/lib/media'
import {
  closeMediaHub,
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
 * media entries beyond the players' shared helpers (lib/media.ts, tested there): which tabs get
 * a player and in what order, what the toolbar button says, the line a player leads with and
 * how the shared detail line composes under it, and the hub's open state.
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

describe('mediaTitle, with the shared detail line under it', () => {
  const site = tab('t', 'https://www.music.example/album/1', 'Album – Music')
  const detail = (m: MediaState, t: Tab | undefined): string => mediaDetail(m, t, mediaTitle(m, t))

  it('leads with the page metadata, then the tab, then the site; the detail says each once', () => {
    expect(mediaTitle(media({ tabId: 't', title: ' Nocturne ' }), site)).toBe('Nocturne')
    expect(detail(media({ tabId: 't', title: 'Nocturne', artist: 'The Band' }), site)).toBe(
      'The Band · music.example'
    )
    // No artist: the site alone.
    expect(detail(media({ tabId: 't', title: 'Nocturne' }), site)).toBe('music.example')
    // No metadata: the tab's title leads, the site under it.
    expect(mediaTitle(media({ tabId: 't' }), site)).toBe('Album – Music')
    expect(detail(media({ tabId: 't' }), site)).toBe('music.example')
    // No tab title either: the site is the title and is not said again – not even as the
    // artist the core fills in for a page without metadata.
    const bare = tab('t', 'https://www.music.example/')
    expect(mediaTitle(media({ tabId: 't' }), bare)).toBe('music.example')
    expect(detail(media({ tabId: 't' }), bare)).toBe('')
    expect(detail(media({ tabId: 't', artist: 'music.example' }), bare)).toBe('')
    // The artist is the site under a title of its own: once.
    expect(detail(media({ tabId: 't', title: 'Nocturne', artist: 'music.example' }), site)).toBe(
      'music.example'
    )
    // No tab at all.
    expect(mediaTitle(media({ tabId: 't' }), undefined)).toBe('Media')
    expect(detail(media({ tabId: 't', artist: 'The Band' }), undefined)).toBe('The Band')
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
