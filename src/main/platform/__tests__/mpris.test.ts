import { describe, expect, it, vi } from 'vitest'
import { ElectronMpris, MPRIS_NO_TRACK, mprisStateFor, trackPath, type MprisPlayer } from '../mpris'
import type { Browser } from '../../../core/browser'
import type { MediaSessionAction, MediaSessionInfo } from '../../../shared/mediaSession'

const T0 = 1_700_000_000_000

/** The session the core resolves for a page with Media Session metadata. */
const SESSION: MediaSessionInfo = {
  tabId: 'tab-1',
  title: 'Song',
  artist: 'Band',
  album: 'Record',
  artwork: 'https://cdn.example/art.jpg',
  playing: true,
  video: false,
  width: 0,
  height: 0,
  position: { duration: 200, position: 50, playbackRate: 1 },
  positionAt: T0,
  actions: ['play', 'pause', 'seekto', 'nexttrack'],
  fullscreen: false,
  private: false,
  source: 'page'
}
const TAB = {
  title: 'Song – Player',
  url: 'https://music.example/play',
  favicon: 'data:image/png;base64,AA'
}

describe('mprisStateFor', () => {
  it('maps a session to MPRIS metadata and capabilities', () => {
    const state = mprisStateFor(SESSION, TAB)
    expect(state.playbackStatus).toBe('Playing')
    expect(state.metadata).toEqual({
      'mpris:trackid': '/org/zenium/track/tab_1',
      'xesam:title': 'Song',
      'xesam:artist': ['Band'],
      'xesam:album': 'Record',
      'mpris:artUrl': 'https://cdn.example/art.jpg',
      'mpris:length': 200_000_000,
      'xesam:url': 'https://music.example/play'
    })
    expect(state).toMatchObject({
      canPlay: true,
      canPause: true,
      canSeek: true,
      canGoNext: true,
      canGoPrevious: false
    })
  })

  it('takes the core’s fallbacks (tab title, site) and the favicon when the page named no artwork', () => {
    // The core already put the tab's title and site in; the host adds the favicon and the URL.
    const state = mprisStateFor(
      {
        ...SESSION,
        title: 'Song – Player',
        artist: 'music.example',
        album: '',
        artwork: null,
        playing: false,
        position: null,
        actions: []
      },
      TAB
    )
    expect(state.playbackStatus).toBe('Paused')
    expect(state.metadata).toEqual({
      'mpris:trackid': '/org/zenium/track/tab_1',
      'xesam:title': 'Song – Player',
      'xesam:artist': ['music.example'],
      'mpris:artUrl': 'data:image/png;base64,AA',
      'xesam:url': 'https://music.example/play'
    })
    expect(state.canSeek).toBe(false)
    expect(state.canGoNext).toBe(false)
  })

  it('can seek with a duration even when the page handles no seekto itself', () => {
    const state = mprisStateFor({ ...SESSION, actions: ['play', 'pause'] }, TAB)
    expect(state.canSeek).toBe(true)
  })

  it('shows nothing identifying for a private tab (the core blanks the words; the host adds none)', () => {
    const state = mprisStateFor(
      { ...SESSION, title: '', artist: '', album: '', artwork: null, private: true },
      TAB
    )
    expect(state.metadata).toEqual({
      'mpris:trackid': '/org/zenium/track/tab_1',
      'mpris:length': 200_000_000
    })
  })

  it('is the idle player without a session and never names a length for live media', () => {
    const idle = mprisStateFor(null, undefined)
    expect(idle.playbackStatus).toBe('Stopped')
    expect(idle.metadata).toEqual({ 'mpris:trackid': MPRIS_NO_TRACK })
    expect(idle.canPlay).toBe(false)
    const live = mprisStateFor(
      {
        ...SESSION,
        position: { duration: 0, position: 3, playbackRate: 1 },
        artwork: 'blob:x'
      },
      undefined
    )
    expect(live.metadata['mpris:length']).toBeUndefined()
    expect(live.metadata['mpris:artUrl']).toBeUndefined()
    expect(live.metadata['xesam:url']).toBeUndefined()
  })

  it('makes a valid object path of any tab id', () => {
    expect(trackPath('a-b.c d')).toBe('/org/zenium/track/a_b_c_d')
    expect(trackPath('')).toBe('/org/zenium/track/_')
  })
})

interface FakePlayer extends MprisPlayer {
  listeners: Map<string, Array<(...args: unknown[]) => void>>
  emit: (event: string, ...args: unknown[]) => void
  seeks: number[]
}

function fakePlayer(): FakePlayer {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const player: FakePlayer = {
    listeners,
    seeks: [],
    playbackStatus: 'Stopped',
    metadata: {},
    canControl: false,
    canPlay: false,
    canPause: false,
    canSeek: false,
    canGoNext: false,
    canGoPrevious: false,
    canQuit: true,
    canRaise: false,
    getPosition: () => 0,
    seeked: (position) => {
      player.seeks.push(position)
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return player
    },
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }
  }
  return player
}

interface Acted {
  tabId: string | null
  action: MediaSessionAction | 'toggle'
  details: { seekTime?: number; seekOffset?: number }
}

interface Harness {
  host: ElectronMpris
  players: FakePlayer[]
  acted: Acted[]
  revealed: string[]
  now: { value: number }
}

function harness(options: { fail?: boolean } = {}): Harness {
  const players: FakePlayer[] = []
  const acted: Acted[] = []
  const revealed: string[] = []
  const now = { value: T0 }
  const browser = {
    tabs: { tab: (id: string) => (id === 'tab-1' ? { id, ...TAB } : undefined) },
    mediaSession: {
      act: (tabId: string | null, action: Acted['action'], details: Acted['details'] = {}) => {
        acted.push({ tabId, action, details })
      }
    },
    revealTab: (tabId: string) => revealed.push(tabId)
  }
  const host = new ElectronMpris(
    () => browser as unknown as Browser,
    () => {
      if (options.fail) throw new Error('no session bus')
      const player = fakePlayer()
      players.push(player)
      return player
    },
    { now: () => now.value }
  )
  return { host, players, acted, revealed, now }
}

describe('ElectronMpris', () => {
  it('exports the player on the first session and keeps it, Stopped, once media is gone', () => {
    const h = harness()
    h.host.update(null)
    expect(h.players).toHaveLength(0)
    h.host.update(SESSION)
    expect(h.players).toHaveLength(1)
    const player = h.players[0]
    expect(player.canQuit).toBe(false)
    expect(player.canRaise).toBe(true)
    expect(player.canControl).toBe(true)
    expect(player.playbackStatus).toBe('Playing')
    expect(player.metadata['xesam:title']).toBe('Song')
    expect(player.canGoNext).toBe(true)
    expect(h.host.currentTabId()).toBe('tab-1')
    h.host.update(null)
    expect(h.players).toHaveLength(1)
    expect(player.playbackStatus).toBe('Stopped')
    expect(player.metadata).toEqual({ 'mpris:trackid': MPRIS_NO_TRACK })
    expect(h.host.currentTabId()).toBeNull()
  })

  it('reports the position moving while playing and signals a seek on a jump', () => {
    const h = harness()
    h.host.update(SESSION)
    const player = h.players[0]
    h.now.value = T0 + 10_000
    expect(player.getPosition()).toBe(60_000_000)
    // A report in step with playback is no seek; a jump is.
    h.host.update({
      ...SESSION,
      position: { ...SESSION.position!, position: 60 },
      positionAt: T0 + 10_000
    })
    expect(player.seeks).toEqual([])
    h.host.update({
      ...SESSION,
      position: { ...SESSION.position!, position: 120 },
      positionAt: T0 + 10_000
    })
    expect(player.seeks).toEqual([120_000_000])
    // A re-publish of the same report (same timestamp) is no seek either.
    h.host.update({
      ...SESSION,
      position: { ...SESSION.position!, position: 120 },
      positionAt: T0 + 10_000
    })
    expect(player.seeks).toEqual([120_000_000])
    // Paused: the position stands still.
    h.host.update({
      ...SESSION,
      playing: false,
      position: { ...SESSION.position!, position: 120 },
      positionAt: T0 + 10_000
    })
    h.now.value = T0 + 30_000
    expect(player.getPosition()).toBe(120_000_000)
  })

  it('turns the bus controls into Media Session actions for the session’s tab', () => {
    const h = harness()
    h.host.update(SESSION)
    const player = h.players[0]
    player.emit('play')
    player.emit('pause')
    player.emit('stop')
    player.emit('next')
    player.emit('previous')
    player.emit('seek', 15_000_000)
    player.emit('seek', -5_000_000)
    player.emit('seek', 0)
    player.emit('position', { trackId: trackPath('tab-1'), position: 42_000_000 })
    player.emit('position', { trackId: trackPath('stale'), position: 1_000_000 })
    player.emit('position', { trackId: trackPath('tab-1'), position: 7n })
    player.emit('playpause')
    expect(h.acted.map((a) => ({ action: a.action, ...a.details }))).toEqual([
      { action: 'play' },
      { action: 'pause' },
      { action: 'stop' },
      { action: 'nexttrack' },
      { action: 'previoustrack' },
      { action: 'seekforward', seekOffset: 15 },
      { action: 'seekbackward', seekOffset: 5 },
      { action: 'seekto', seekTime: 42 },
      { action: 'seekto', seekTime: 0.000007 },
      { action: 'toggle' }
    ])
    expect(h.acted.every((a) => a.tabId === 'tab-1')).toBe(true)
    player.emit('raise')
    expect(h.revealed).toEqual(['tab-1'])
    // Nothing plays: the controls have no target.
    h.host.update(null)
    player.emit('play')
    player.emit('raise')
    expect(h.acted).toHaveLength(10)
    expect(h.revealed).toHaveLength(1)
  })

  it('stays quiet for the run when the bus is not there or the player errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = harness({ fail: true })
    failing.host.update(SESSION)
    failing.host.update(SESSION)
    expect(warn).toHaveBeenCalledTimes(1)
    const h = harness()
    h.host.update(SESSION)
    h.players[0].emit('error', new Error('name lost'))
    h.host.update({ ...SESSION, playing: false })
    expect(h.players).toHaveLength(1)
    warn.mockRestore()
  })
})
