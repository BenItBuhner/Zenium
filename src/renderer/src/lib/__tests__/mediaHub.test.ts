import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaState, Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { TOOLBAR_BUTTON, TOOLBAR_GAP } from '@renderer/lib/extensions/toolbar'
import { mediaDetail } from '@renderer/lib/media'
import {
  MEDIA_HUB_PILL,
  closeMediaHub,
  mediaHubButtonFits,
  mediaHubEntries,
  mediaHubLabel,
  mediaHubReturnRow,
  mediaHubUi,
  mediaHubVisible,
  mediaTitle,
  openMediaHub,
  toggleMediaHub
} from '@renderer/lib/mediaHub'
import { PILL_PADDING, PILL_TOOLS_TIER } from '@renderer/components/urlbar/pillChipTiers'

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

/*
 * The hub button's width tier (design language v2 §9.29): tiered exactly as the pill's chips
 * are, never by the active tab – folded into the app menu at the 240 sidebar, back where the
 * pill, with the button's own slot in the row, still holds the box the star returned at (the
 * 302 sidebar with today's buttons), never where the pill first reaches that box without it
 * (270, where a returning button took the pill straight back under the tier). The row asks with
 * its own width and the count of the other buttons in it; the hub's own slot is in the sum.
 */
describe('mediaHubButtonFits (the §9.29 tier)', () => {
  const slot = TOOLBAR_BUTTON + TOOLBAR_GAP
  /** The nav row is the sidebar less its 8 px gutters each side. */
  const row = (sidebar: number): number => sidebar - 16
  /** Back, forward, reload and ⋯: the buttons the row always has. */
  const always = 4

  it('folds at the 240 sidebar, stays folded at 270 where the star returns, and returns at 302 with the star', () => {
    expect(mediaHubButtonFits(row(240), always)).toBe(false)
    expect(mediaHubButtonFits(row(269), always)).toBe(false)
    // 270: the pill reaches the star's 126 / 110 without the button; the button leaves it so.
    expect(mediaHubButtonFits(row(270), always)).toBe(false)
    expect(mediaHubButtonFits(row(301), always)).toBe(false)
    expect(mediaHubButtonFits(row(302), always)).toBe(true)
    expect(mediaHubButtonFits(row(520), always)).toBe(true)
    // The threshold is the tokens' sum, not a literal: the tier's pill (16 + 110) and five
    // 32 px slots – the four other buttons' and the hub's own – is the 286 row, the 302 sidebar.
    expect(mediaHubReturnRow(always)).toBe(MEDIA_HUB_PILL + (always + 1) * slot)
    expect(mediaHubReturnRow(always) + 16).toBe(302)
    expect(MEDIA_HUB_PILL).toBe(PILL_PADDING + PILL_TOOLS_TIER)
    expect(MEDIA_HUB_PILL - PILL_PADDING).toBe(110)
    // The pill with the button at 302 is the 270 pill without it: 286 − 5 × 32 = 254 − 4 × 32.
    expect(row(302) - (always + 1) * slot).toBe(row(270) - always * slot)
    expect(row(302) - (always + 1) * slot).toBe(MEDIA_HUB_PILL)
  })

  it('makes room against the puzzle piece and the downloads button too, one slot each', () => {
    expect(mediaHubButtonFits(row(302), always + 1)).toBe(false)
    expect(mediaHubButtonFits(row(302 + slot), always + 1)).toBe(true)
    expect(mediaHubButtonFits(row(302 + slot), always + 2)).toBe(false)
    expect(mediaHubButtonFits(row(302 + 2 * slot), always + 2)).toBe(true)
    expect(mediaHubReturnRow(always + 1) - mediaHubReturnRow(always)).toBe(slot)
  })

  it('shows the button before the row has a width, and is monotonic in the width', () => {
    expect(mediaHubButtonFits(0, always)).toBe(true)
    let up = false
    for (let width = 1; width <= 600; width += 1) {
      const fits = mediaHubButtonFits(width, always)
      expect(fits || !up, `folded again at ${width}`).toBe(true)
      up = fits
    }
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
    expect(mediaHubUi.get()).toEqual({ open: true, fromKeyboard: false, buttonUp: false })
    expect(run).not.toHaveBeenCalled()
    closeMediaHub()
    expect(mediaHubUi.get().open).toBe(false)

    openMediaHub({ fromKeyboard: true })
    expect(mediaHubUi.get()).toEqual({ open: true, fromKeyboard: true, buttonUp: false })
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
