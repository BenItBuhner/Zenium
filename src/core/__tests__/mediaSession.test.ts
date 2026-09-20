import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SESSION_DURATION_S, MediaSessionService, siteOf } from '../mediaSession'
import type { Browser } from '../browser'
import type { MediaSessionInfo, MediaReport } from '../../shared/mediaSession'
import type { PageHostMessage } from '../platform'

interface FakeView {
  tabId: string
  destroyed: boolean
  audible: boolean
  posted: PageHostMessage[]
  isDestroyed(): boolean
  isCurrentlyAudible(): boolean
  postToPage(message: PageHostMessage): void
}

interface Harness {
  service: MediaSessionService
  views: Map<string, FakeView>
  updates: Array<MediaSessionInfo | null>
  pipRequests: MediaSessionInfo[]
  now: { value: number }
  privateTabs: Set<string>
  addTab(tabId: string, url: string, title: string): FakeView
  closeTab(tabId: string): void
  updateMedia: ReturnType<typeof vi.fn>
}

function harness(options: { host?: boolean; pip?: boolean } = {}): Harness {
  const views = new Map<string, FakeView>()
  const tabs = new Map<string, { id: string; url: string; title: string }>()
  const updates: Array<MediaSessionInfo | null> = []
  const pipRequests: MediaSessionInfo[] = []
  const now = { value: 1_700_000_000_000 }
  const privateTabs = new Set<string>()
  const updateMedia = vi.fn()
  const host =
    options.host === false
      ? undefined
      : {
          update: (session: MediaSessionInfo | null) => {
            updates.push(session)
          },
          ...(options.pip === false
            ? {}
            : {
                enterPictureInPicture: async (session: MediaSessionInfo) => {
                  pipRequests.push(session)
                  return true
                }
              })
        }
  const browser = {
    platform: { mediaSession: host },
    tabs: {
      allViews: () => views.entries(),
      view: (id: string) => views.get(id),
      tab: (id: string) => tabs.get(id),
      isPrivate: (tab: { id: string }) => privateTabs.has(tab.id)
    },
    updateMedia
  }
  const service = new MediaSessionService(browser as unknown as Browser, () => now.value)
  updateMedia.mockImplementation(() => service.refresh())
  return {
    service,
    views,
    updates,
    pipRequests,
    now,
    privateTabs,
    updateMedia,
    addTab: (tabId, url, title) => {
      const view: FakeView = {
        tabId,
        destroyed: false,
        audible: false,
        posted: [],
        isDestroyed: () => view.destroyed,
        isCurrentlyAudible: () => view.audible,
        postToPage: (m) => view.posted.push(m)
      }
      views.set(tabId, view)
      tabs.set(tabId, { id: tabId, url, title })
      return view
    },
    closeTab: (tabId) => {
      views.delete(tabId)
      tabs.delete(tabId)
    }
  }
}

function report(overrides: Partial<MediaReport> = {}): MediaReport {
  return {
    playing: true,
    video: false,
    width: 0,
    height: 0,
    muted: false,
    position: { duration: 240, position: 12, playbackRate: 1 },
    metadata: null,
    playbackState: 'none',
    actions: [],
    fullscreen: false,
    ...overrides
  }
}

/** A tab plays `r`: the page script's report, the view audible, the browser's media refresh. */
function play(h: Harness, tabId: string, r: MediaReport = report()): void {
  const view = h.views.get(tabId)!
  view.audible = r.playing
  h.service.onReport(tabId, r)
  h.service.refresh()
}

describe('MediaSessionService', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
    h.addTab('t1', 'https://music.example/album', 'Album – Music')
    h.addTab('t2', 'https://video.example/watch', 'A film')
  })

  it('shows a playing page as the session with the tab title and site standing in for metadata', () => {
    play(h, 't1')
    expect(h.service.sessionTab).toBe('t1')
    const info = h.updates.at(-1)!
    expect(info.title).toBe('Album – Music')
    expect(info.artist).toBe('music.example')
    expect(info.artwork).toBeNull()
    expect(info.playing).toBe(true)
    expect(info.position).toEqual({ duration: 240, position: 12, playbackRate: 1 })
    expect(info.positionAt).toBe(h.now.value)
  })

  it("carries the page's navigator.mediaSession metadata, artwork and handlers", () => {
    play(
      h,
      't1',
      report({
        metadata: {
          title: 'Track',
          artist: 'Band',
          album: 'LP',
          artwork: [
            { src: 'https://music.example/s.png', sizes: '96x96', type: 'image/png' },
            { src: 'https://music.example/l.png', sizes: '512x512', type: 'image/png' }
          ]
        },
        actions: ['play', 'pause', 'nexttrack']
      })
    )
    const info = h.updates.at(-1)!
    expect(info.title).toBe('Track')
    expect(info.artist).toBe('Band')
    expect(info.album).toBe('LP')
    expect(info.artwork).toBe('https://music.example/l.png')
    expect(info.actions).toEqual(['play', 'pause', 'nexttrack'])
    const state = h.service.refresh().find((m) => m.tabId === 't1')!
    expect(state.session).toBe(true)
    expect(state.actions).toEqual(['play', 'pause', 'nexttrack'])
  })

  it('does not repeat an unchanged session to the host', () => {
    play(h, 't1')
    const sent = h.updates.length
    h.service.refresh()
    h.service.refresh()
    expect(h.updates.length).toBe(sent)
  })

  it('keeps a paused session up until it is dismissed, and brings it back when the page plays', () => {
    play(h, 't1')
    play(h, 't1', report({ playing: false }))
    expect(h.service.sessionTab).toBe('t1')
    expect(h.updates.at(-1)!.playing).toBe(false)
    h.service.act(null, 'stop')
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({ type: 'mediaSession', action: 'stop' })
    expect(h.service.sessionTab).toBeNull()
    expect(h.updates.at(-1)).toBeNull()
    play(h, 't1')
    expect(h.service.sessionTab).toBe('t1')
  })

  it('shows no controls for metadata alone until the page has played, as Chrome does', () => {
    const paused = report({
      playing: false,
      position: { duration: 240, position: 0, playbackRate: 1 },
      metadata: { title: 'Track', artist: 'Band', album: '', artwork: [] }
    })
    play(h, 't1', paused)
    expect(h.service.sessionTab).toBeNull()
    expect(h.updates).toEqual([])
    // The chrome's list still knows the page has media (its metadata), just no session.
    expect(h.service.refresh().find((m) => m.tabId === 't1')?.title).toBe('Track')
    play(h, 't1', { ...paused, playing: true })
    expect(h.service.sessionTab).toBe('t1')
    // Paused after playing, the session stays up in paused form.
    play(h, 't1', paused)
    expect(h.service.sessionTab).toBe('t1')
    expect(h.updates.at(-1)!.playing).toBe(false)
  })

  it('prefers the page that started playing most recently when several play', () => {
    play(h, 't1')
    h.now.value += 1000
    play(h, 't2', report({ video: true, width: 1280, height: 720 }))
    expect(h.service.sessionTab).toBe('t2')
    // t2 pauses: t1 still plays, so it is the session again.
    play(h, 't2', report({ video: true, width: 1280, height: 720, playing: false }))
    expect(h.service.sessionTab).toBe('t1')
  })

  it('ends the session when its tab closes', () => {
    play(h, 't1')
    h.closeTab('t1')
    h.service.refresh()
    expect(h.service.sessionTab).toBeNull()
    expect(h.updates.at(-1)).toBeNull()
  })

  it('takes no session for a clip shorter than Chrome shows controls for', () => {
    play(
      h,
      't1',
      report({ position: { duration: MIN_SESSION_DURATION_S - 1, position: 0, playbackRate: 1 } })
    )
    expect(h.service.sessionTab).toBeNull()
    expect(h.updates).toEqual([])
    // The tab still counts as audible media for the chrome's list.
    expect(h.service.refresh().find((m) => m.tabId === 't1')?.playing).toBe(true)
  })

  it("hides a private tab's title, artist and artwork from the controls", () => {
    h.privateTabs.add('t1')
    play(
      h,
      't1',
      report({
        metadata: {
          title: 'Secret',
          artist: 'Nobody',
          album: '',
          artwork: [{ src: 'https://music.example/a.png', sizes: '', type: '' }]
        }
      })
    )
    const info = h.updates.at(-1)!
    expect(info.private).toBe(true)
    expect(info.title).toBe('')
    expect(info.artist).toBe('')
    expect(info.artwork).toBeNull()
    const state = h.service.refresh().find((m) => m.tabId === 't1')!
    expect(state.title).toBe('')
    expect(state.artwork).toBeNull()
  })

  it('routes a control to the session tab with the seek details, and to a named tab', () => {
    play(h, 't1')
    play(h, 't2', report({ playing: false }))
    h.service.act(null, 'seekto', { seekTime: 42.5 })
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'mediaSession',
      action: 'seekto',
      seekTime: 42.5
    })
    h.service.act(null, 'seekbackward', { seekOffset: 10 })
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'mediaSession',
      action: 'seekbackward',
      seekOffset: 10
    })
    h.service.act('t2', 'toggle')
    expect(h.views.get('t2')!.posted.at(-1)).toEqual({ type: 'mediaSession', action: 'toggle' })
    // A negative seek is clamped; a non-finite one dropped.
    h.service.act('t1', 'seekto', { seekTime: -3 })
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'mediaSession',
      action: 'seekto',
      seekTime: 0
    })
    h.service.act('t1', 'seekto', { seekTime: Number.NaN })
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({ type: 'mediaSession', action: 'seekto' })
  })

  it('does nothing for a control with no session and no tab', () => {
    h.service.act(null, 'play')
    expect(h.views.get('t1')!.posted).toEqual([])
    expect(h.views.get('t2')!.posted).toEqual([])
  })

  it('drops a tab whose report says its media is gone', () => {
    play(h, 't1')
    const view = h.views.get('t1')!
    view.audible = false
    h.service.onReport('t1', report({ playing: false, position: null }))
    h.service.refresh()
    expect(h.service.sessionTab).toBeNull()
    expect(h.service.refresh().some((m) => m.tabId === 't1')).toBe(false)
  })

  it('ignores a malformed report', () => {
    h.service.onReport('t1', { playing: 'yes' } as unknown as MediaReport)
    h.service.onReport('t1', null as unknown as MediaReport)
    expect(h.service.refresh()).toEqual([])
  })

  describe('picture-in-picture', () => {
    it("asks the host for the tab's video and lays the video over the page once the window is in", async () => {
      play(h, 't2', report({ video: true, width: 1920, height: 1080 }))
      expect(h.service.hasVideo('t2')).toBe(true)
      expect(h.service.hasVideo('t1')).toBe(false)
      await expect(h.service.enterPictureInPicture('t2')).resolves.toBe(true)
      expect(h.pipRequests).toHaveLength(1)
      expect(h.pipRequests[0]).toMatchObject({
        tabId: 't2',
        video: true,
        width: 1920,
        height: 1080
      })
      h.service.onPictureInPicture('t2', true)
      expect(h.views.get('t2')!.posted.at(-1)).toEqual({
        type: 'mediaSession',
        action: 'fill',
        on: true
      })
      expect(h.service.pictureInPictureTab).toBe('t2')
      expect(h.service.refresh().find((m) => m.tabId === 't2')!.pictureInPicture).toBe(true)
      h.service.onPictureInPicture('t2', false)
      expect(h.views.get('t2')!.posted.at(-1)).toEqual({
        type: 'mediaSession',
        action: 'fill',
        on: false
      })
      expect(h.service.pictureInPictureTab).toBeNull()
    })

    it('refuses a tab without video, and hosts without the entry point', async () => {
      play(h, 't1')
      await expect(h.service.enterPictureInPicture('t1')).resolves.toBe(false)
      await expect(h.service.enterPictureInPicture('nope')).resolves.toBe(false)
      const plain = harness({ pip: false })
      plain.addTab('v', 'https://video.example/', 'v')
      play(plain, 'v', report({ video: true, width: 640, height: 360 }))
      await expect(plain.service.enterPictureInPicture('v')).resolves.toBe(false)
      expect(plain.pipRequests).toEqual([])
    })

    it('forgets the picture-in-picture tab when it closes', () => {
      play(h, 't2', report({ video: true, width: 640, height: 360 }))
      h.service.onPictureInPicture('t2', true)
      h.closeTab('t2')
      h.service.refresh()
      expect(h.service.pictureInPictureTab).toBeNull()
    })
  })

  it('works without an OS media host (desktop): the chrome list still forms', () => {
    const plain = harness({ host: false })
    plain.addTab('a', 'https://a.example/', 'A')
    play(plain, 'a')
    expect(plain.service.sessionTab).toBe('a')
    expect(plain.service.refresh().find((m) => m.tabId === 'a')?.session).toBe(true)
    expect(plain.updates).toEqual([])
  })
})

describe('siteOf', () => {
  it('names the host of a web page and nothing else', () => {
    expect(siteOf('https://music.example:8443/a')).toBe('music.example:8443')
    expect(siteOf('http://x.test/')).toBe('x.test')
    expect(siteOf('zen://newtab')).toBe('')
    expect(siteOf('not a url')).toBe('')
  })
})
