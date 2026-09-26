import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AUTO_PIP_BLUR_GRACE_MS,
  AUTO_PIP_SETTING,
  MEDIA_HUB_INACTIVE_MS,
  MIN_SESSION_DURATION_S,
  MediaSessionService,
  siteOf
} from '../mediaSession'
import type { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type { MediaState } from '../../shared/types'
import type {
  MediaSessionInfo,
  MediaReport,
  MediaSessionSource,
  MediaSessionSourceAction
} from '../../shared/mediaSession'
import type { PageHostMessage } from '../platform'

interface FakeView {
  tabId: string
  destroyed: boolean
  audible: boolean
  posted: PageHostMessage[]
  /** The scripts the desktop ran in the page (`executeJavaScript`), in order. */
  scripts: string[]
  /** What the page answers the automatic entry script with (`true`: a video went in). */
  enterResult: unknown
  /**
   * The document's `visibilityState` as Chromium computes it for the page: `hidden` for a tab off
   * the screen or a window minimized or covered (the default: the window trigger's tests blur
   * to a covering application), `visible` for a page the user can still see.
   */
  visibility: 'visible' | 'hidden'
  isDestroyed(): boolean
  isCurrentlyAudible(): boolean
  postToPage(message: PageHostMessage): void
  executeJavaScript(code: string): Promise<unknown>
}

/** Chrome's rule in the entry script: a document the user can still see stays where it is. */
const VISIBILITY_GUARD = "if (document.visibilityState !== 'hidden') return 'visible'"

/** A desktop window as the service sees it: what it shows, whether it has the focus. */
interface FakeWindow {
  id: string
  alive: boolean
  visible: string[]
  host: { isFocused(): boolean }
  focused: boolean
}

interface Harness {
  service: MediaSessionService
  views: Map<string, FakeView>
  updates: Array<MediaSessionInfo | null>
  pipRequests: MediaSessionInfo[]
  now: { value: number }
  privateTabs: Set<string>
  /** Origins whose `background-video` setting is allow (block is the default). */
  backgroundVideoSites: Set<string>
  /** Tabs whose page saw a gesture (`popups.activation(tabId).hasBeenActive()`). */
  activated: Set<string>
  /** Page URLs whose site the `auto-picture-in-picture` setting refuses. */
  denied: Set<string>
  /** Every `permissions.check` asked: the setting and the URL. */
  checks: Array<[string, string]>
  /** Every `permissions.set` made: the setting, the URL and the decision. */
  sets: Array<[string, string, string | null]>
  /** The sites told once (`permissions.noticed` / `markNoticed`): `permission|origin`. */
  noticed: Set<string>
  /** Every `browser.toast`: its words, kind, the window it went to and the action it carried. */
  toasts: Array<{ message: string; kind: string; win: FakeWindow | undefined; action: unknown }>
  windows: Map<string, FakeWindow>
  addTab(tabId: string, url: string, title: string): FakeView
  closeTab(tabId: string): void
  /** A window showing `visible`, which it owns from then on (`tabs.windowFor`). */
  addWindow(id: string, visible: string[]): FakeWindow
  /** `win` shows `visible` now, and the tab manager says so. */
  show(win: FakeWindow, visible: string[]): void
  setAlert(tabId: string, alert: string | undefined): void
  updateMedia: ReturnType<typeof vi.fn>
}

function harness(
  options: {
    host?: boolean
    pip?: boolean
    pictureInPicture?: boolean
    /** The host has the chrome's media hub, with this linger (ms) for a paused session (the desktop); absent for the phone. */
    mediaHub?: number
  } = {}
): Harness {
  const views = new Map<string, FakeView>()
  const tabs = new Map<string, { id: string; url: string; title: string; alert?: string }>()
  const updates: Array<MediaSessionInfo | null> = []
  const pipRequests: MediaSessionInfo[] = []
  const now = { value: 1_700_000_000_000 }
  const privateTabs = new Set<string>()
  const backgroundVideoSites = new Set<string>()
  const activated = new Set<string>()
  const denied = new Set<string>()
  const checks: Array<[string, string]> = []
  const sets: Harness['sets'] = []
  const noticed = new Set<string>()
  const toasts: Harness['toasts'] = []
  const windows = new Map<string, FakeWindow>()
  const owners = new Map<string, FakeWindow>()
  const updateMedia = vi.fn()
  const siteKey = (permission: string, url: string): string =>
    `${permission}|${new URL(url).origin}`
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
    platform: {
      mediaSession: host,
      mediaHub: options.mediaHub === undefined ? undefined : { inactiveAfterMs: options.mediaHub }
    },
    state: { capabilities: { pictureInPicture: options.pictureInPicture ?? true } },
    tabs: {
      allViews: () => views.entries(),
      view: (id: string) => views.get(id),
      tab: (id: string) => tabs.get(id),
      isPrivate: (tab: { id: string }) => privateTabs.has(tab.id),
      visibleTabIds: (win: FakeWindow) => [...win.visible],
      windowsShowing: (tabId: string) =>
        [...windows.values()].filter((w) => w.alive && w.visible.includes(tabId)),
      windowFor: (tabId: string) => {
        const owner = owners.get(tabId)
        if (!owner) throw new Error(`no window owns ${tabId}`)
        return owner
      }
    },
    popups: { activation: (tabId: string) => ({ hasBeenActive: () => activated.has(tabId) }) },
    permissions: {
      resolve: (permission: string, url: string) =>
        permission === 'background-video' && backgroundVideoSites.has(new URL(url).origin)
          ? 'allow'
          : 'deny',
      // The auto-PiP row's read, the desktop's `eligibleForAuto`'s and the session's carry alike:
      // the row's default is allow, a site denied by the site card's write alone.
      check: (permission: string, url: string) => {
        checks.push([permission, url])
        return !denied.has(url)
      },
      // The site card's write: a deny is what `check` reads from then on.
      set: (permission: string, url: string, decision: string | null) => {
        sets.push([permission, url, decision])
        if (decision === 'deny') denied.add(url)
        else denied.delete(url)
      },
      noticed: (permission: string, url: string) => noticed.has(siteKey(permission, url)),
      markNoticed: (permission: string, url: string) => {
        noticed.add(siteKey(permission, url))
      }
    },
    toast: (message: string, kind: string, win: FakeWindow | undefined, action: unknown) => {
      toasts.push({ message, kind, win, action })
    },
    allWindows: () => [...windows.values()].filter((w) => w.alive),
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
    backgroundVideoSites,
    activated,
    denied,
    checks,
    sets,
    noticed,
    toasts,
    windows,
    updateMedia,
    addTab: (tabId, url, title) => {
      const view: FakeView = {
        tabId,
        destroyed: false,
        audible: false,
        posted: [],
        scripts: [],
        enterResult: true,
        visibility: 'hidden',
        isDestroyed: () => view.destroyed,
        isCurrentlyAudible: () => view.audible,
        postToPage: (m) => view.posted.push(m),
        executeJavaScript: async (code) => {
          view.scripts.push(code)
          // The entry script's first line, when the trigger asks for a hidden document.
          if (code.includes(VISIBILITY_GUARD) && view.visibility === 'visible') return 'visible'
          return code.includes('requestPictureInPicture') ? view.enterResult : true
        }
      }
      views.set(tabId, view)
      tabs.set(tabId, { id: tabId, url, title })
      return view
    },
    closeTab: (tabId) => {
      views.delete(tabId)
      tabs.delete(tabId)
      owners.delete(tabId)
    },
    addWindow: (id, visible) => {
      const win: FakeWindow = {
        id,
        alive: true,
        visible,
        focused: true,
        host: { isFocused: () => win.focused }
      }
      windows.set(id, win)
      for (const tabId of visible) owners.set(tabId, win)
      service.onVisibleTabsChanged(win as unknown as ZenWindow)
      return win
    },
    show: (win, visible) => {
      win.visible = visible
      for (const tabId of visible) owners.set(tabId, win)
      service.onVisibleTabsChanged(win as unknown as ZenWindow)
    },
    setAlert: (tabId, alert) => {
      const tab = tabs.get(tabId)
      if (tab) tab.alert = alert
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

/** The read-aloud player as a chrome source on `tabId`, its actions recorded. */
function readAloud(
  tabId: string,
  overrides: Partial<Omit<MediaSessionSource, 'onAction'>> = {}
): MediaSessionSource & { onAction: Mock<MediaSessionSource['onAction']> } {
  const actions: MediaSessionSourceAction[] = [
    'play',
    'pause',
    'stop',
    'nexttrack',
    'previoustrack'
  ]
  return {
    id: 'read-aloud',
    tabId,
    title: 'An article',
    artist: 'news.example',
    artwork: null,
    playing: true,
    actions,
    position: null,
    ...overrides,
    onAction: vi.fn<MediaSessionSource['onAction']>()
  }
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

    it('withholds picture-in-picture from a private tab, and says so on its state', async () => {
      h.privateTabs.add('t2')
      play(h, 't2', report({ video: true, width: 1920, height: 1080 }))
      expect(h.service.hasVideo('t2')).toBe(true)
      // Chrome withholds PiP from Incognito; the host is never asked (ruled 2026-09-21).
      await expect(h.service.enterPictureInPicture('t2')).resolves.toBe(false)
      expect(h.pipRequests).toHaveLength(0)
      expect(h.service.pictureInPictureTab).toBeNull()
      const state = h.service.refresh().find((m) => m.tabId === 't2')!
      expect(state.private).toBe(true)
      expect(state.video).toBe(true)
      expect(state.pictureInPicture).toBe(false)
      // A regular tab's state carries no flag at all.
      play(h, 't1', report({ video: true }))
      expect(h.service.refresh().find((m) => m.tabId === 't1')!.private).toBeUndefined()
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

  it("marks a page's session as the page's for the host", () => {
    play(h, 't1')
    expect(h.updates.at(-1)).toMatchObject({ tabId: 't1', source: 'page' })
    expect(h.updates.at(-1)).not.toHaveProperty('sourceId')
  })

  describe("the site's background-video setting (Android keeps an allowed site's video playing)", () => {
    it('is carried on the session: block by default, allow once the site is allowed', () => {
      play(h, 't2', report({ video: true, width: 1280, height: 720 }))
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't2', video: true, backgroundVideo: false })
      h.backgroundVideoSites.add('https://video.example')
      h.service.followBackgroundVideoSetting()
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't2', video: true, backgroundVideo: true })
      expect(h.updates).toHaveLength(2)
    })

    it('reaches the host at once when the setting changes, and not when it resolves the same', () => {
      h.backgroundVideoSites.add('https://video.example')
      play(h, 't2', report({ video: true }))
      expect(h.updates.at(-1)).toMatchObject({ backgroundVideo: true })
      h.service.followBackgroundVideoSetting()
      expect(h.updates).toHaveLength(1)
      h.backgroundVideoSites.delete('https://video.example')
      h.service.followBackgroundVideoSetting()
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't2', backgroundVideo: false })
      expect(h.updates).toHaveLength(2)
    })

    it("is the session tab's site, not another allowed site's", () => {
      h.backgroundVideoSites.add('https://music.example')
      play(h, 't2', report({ video: true }))
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't2', backgroundVideo: false })
      h.now.value += 1000
      play(h, 't1')
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't1', backgroundVideo: true })
    })

    it('is never set for a page without a site, whatever the setting says', () => {
      h.addTab('t3', 'about:blank', 'Blank')
      h.backgroundVideoSites.add('null')
      play(h, 't3', report({ video: true }))
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't3', backgroundVideo: false })
    })

    it('goes with the picture-in-picture request as it does with the session', async () => {
      h.backgroundVideoSites.add('https://video.example')
      play(h, 't2', report({ video: true, width: 1280, height: 720 }))
      await h.service.enterPictureInPicture('t2')
      expect(h.pipRequests.at(-1)).toMatchObject({ tabId: 't2', backgroundVideo: true })
    })
  })

  describe("the site's auto-picture-in-picture setting (Android's auto-enter from a fullscreen video on Home obeys it)", () => {
    it('is carried on the session: allow by default, deny once the site is blocked', () => {
      play(h, 't2', report({ video: true, width: 1280, height: 720, fullscreen: true }))
      expect(h.updates.at(-1)).toMatchObject({
        tabId: 't2',
        video: true,
        autoPictureInPicture: true
      })
      h.denied.add('https://video.example/watch')
      h.service.followAutoPictureInPictureSetting()
      expect(h.updates.at(-1)).toMatchObject({
        tabId: 't2',
        video: true,
        autoPictureInPicture: false
      })
      expect(h.updates).toHaveLength(2)
    })

    it('reaches the host at once when the setting changes, and not when it resolves the same', () => {
      h.denied.add('https://video.example/watch')
      play(h, 't2', report({ video: true, fullscreen: true }))
      expect(h.updates.at(-1)).toMatchObject({ autoPictureInPicture: false })
      h.service.followAutoPictureInPictureSetting()
      expect(h.updates).toHaveLength(1)
      h.denied.delete('https://video.example/watch')
      h.service.followAutoPictureInPictureSetting()
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't2', autoPictureInPicture: true })
      expect(h.updates).toHaveLength(2)
    })

    it("is the session tab's site's answer, not another site's", () => {
      h.denied.add('https://video.example/watch')
      play(h, 't2', report({ video: true, fullscreen: true }))
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't2', autoPictureInPicture: false })
      h.now.value += 1000
      play(h, 't1')
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't1', autoPictureInPicture: true })
    })

    it("goes with the user's own picture-in-picture request, which a deny does not refuse", async () => {
      h.denied.add('https://video.example/watch')
      play(h, 't2', report({ video: true, width: 1280, height: 720 }))
      // Chrome's rule: the setting governs the automatic entry alone; the host is still asked.
      await expect(h.service.enterPictureInPicture('t2')).resolves.toBe(true)
      expect(h.pipRequests.at(-1)).toMatchObject({ tabId: 't2', autoPictureInPicture: false })
    })
  })

  describe('a chrome source (registerSource: the read-aloud player)', () => {
    it('registers as the session with its own metadata, no video and no PiP, and the host hears source: chrome', () => {
      const source = readAloud('t1')
      h.service.registerSource(source)
      expect(h.service.sessionTab).toBe('t1')
      expect(h.service.sessionSource).toBe('read-aloud')
      const info = h.updates.at(-1)!
      expect(info).toEqual({
        tabId: 't1',
        title: 'An article',
        artist: 'news.example',
        album: '',
        artwork: null,
        playing: true,
        video: false,
        width: 0,
        height: 0,
        position: null,
        positionAt: h.now.value,
        actions: ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'],
        fullscreen: false,
        private: false,
        backgroundVideo: false,
        autoPictureInPicture: false,
        source: 'chrome',
        sourceId: 'read-aloud'
      })
      expect(h.service.hasVideo('t1')).toBe(false)
    })

    it('updates through its handle (title, playing, position, actions) and re-pushes', () => {
      const handle = h.service.registerSource(readAloud('t1'))
      const sent = h.updates.length
      h.now.value += 500
      handle.update({
        title: 'Paragraph two',
        playing: false,
        position: { duration: 90, position: 30, playbackRate: 1 },
        actions: ['play', 'pause']
      })
      expect(h.updates.length).toBe(sent + 1)
      const info = h.updates.at(-1)!
      expect(info).toMatchObject({
        title: 'Paragraph two',
        artist: 'news.example',
        playing: false,
        position: { duration: 90, position: 30, playbackRate: 1 },
        positionAt: h.now.value,
        actions: ['play', 'pause'],
        source: 'chrome'
      })
      // An undefined field in the patch leaves the value as it was.
      handle.update({ title: undefined, artwork: 'https://news.example/a.png' })
      expect(h.updates.at(-1)).toMatchObject({
        title: 'Paragraph two',
        artwork: 'https://news.example/a.png'
      })
    })

    it('leaves the resolution on release, the session falling back to the pages', () => {
      play(h, 't2')
      play(h, 't2', report({ playing: false }))
      expect(h.service.sessionTab).toBe('t2')
      const handle = h.service.registerSource(readAloud('t1'))
      expect(h.service.sessionTab).toBe('t1')
      handle.release()
      expect(h.service.sessionTab).toBe('t2')
      expect(h.service.sessionSource).toBeNull()
      expect(h.updates.at(-1)).toMatchObject({ tabId: 't2', source: 'page' })
      expect(h.service.refresh().some((m) => m.source === 'chrome')).toBe(false)
      // A released handle is inert.
      handle.update({ playing: true })
      handle.release()
      expect(h.service.sessionTab).toBe('t2')
    })

    it('takes the session down with it when nothing else played', () => {
      const handle = h.service.registerSource(readAloud('t1'))
      expect(h.updates.at(-1)).not.toBeNull()
      handle.release()
      expect(h.service.sessionTab).toBeNull()
      expect(h.updates.at(-1)).toBeNull()
    })

    it('is resolved against the pages by the same rule: the latest to start playing wins, either order', () => {
      // A page plays, the source starts later: the source.
      play(h, 't2')
      h.now.value += 1000
      const handle = h.service.registerSource(readAloud('t1'))
      expect(h.service.sessionTab).toBe('t1')
      expect(h.service.sessionSource).toBe('read-aloud')
      // The page starts again later: the page.
      play(h, 't2', report({ playing: false }))
      expect(h.service.sessionTab).toBe('t1')
      h.now.value += 1000
      play(h, 't2')
      expect(h.service.sessionTab).toBe('t2')
      expect(h.service.sessionSource).toBeNull()
      // The source pauses and resumes later than the page: the source again.
      handle.update({ playing: false })
      expect(h.service.sessionTab).toBe('t2')
      h.now.value += 1000
      handle.update({ playing: true })
      expect(h.service.sessionTab).toBe('t1')
      // The source pauses while the page still plays: the page.
      handle.update({ playing: false })
      expect(h.service.sessionTab).toBe('t2')
    })

    it('beats a paused page while playing, and a playing page beats it while paused', () => {
      play(h, 't2', report({ playing: false }))
      h.service.registerSource(readAloud('t1', { playing: true }))
      expect(h.service.sessionTab).toBe('t1')
      const paused = harness()
      paused.addTab('p', 'https://a.example/', 'A')
      paused.addTab('q', 'https://b.example/', 'B')
      paused.service.registerSource(readAloud('q', { playing: false }))
      expect(paused.service.sessionTab).toBeNull()
      play(paused, 'p')
      expect(paused.service.sessionTab).toBe('p')
    })

    it('keeps the session while paused, as a paused page does, until dismissed or released', () => {
      const handle = h.service.registerSource(readAloud('t1'))
      handle.update({ playing: false })
      expect(h.service.sessionTab).toBe('t1')
      expect(h.updates.at(-1)).toMatchObject({ playing: false, source: 'chrome' })
      // A page that pauses later does not take a paused source's session.
      h.now.value += 1000
      play(h, 't2')
      expect(h.service.sessionTab).toBe('t2')
      play(h, 't2', report({ playing: false }))
      expect(h.service.sessionTab).toBe('t2')
      // A source that never played gets no session, as a page with metadata alone does not.
      const fresh = harness()
      fresh.addTab('a', 'https://a.example/', 'A')
      fresh.service.registerSource(readAloud('a', { playing: false }))
      expect(fresh.service.sessionTab).toBeNull()
      expect(fresh.updates).toEqual([])
      // Its entry is in the list all the same.
      expect(fresh.service.refresh().find((m) => m.tabId === 'a')).toMatchObject({
        playing: false,
        source: 'chrome',
        title: 'An article'
      })
    })

    it('routes the controls to the source: toggle resolved from its state, seeks with their details', () => {
      const source = readAloud('t1')
      const handle = h.service.registerSource(source)
      h.service.act(null, 'toggle')
      expect(source.onAction).toHaveBeenLastCalledWith('pause', {})
      handle.update({ playing: false })
      h.service.act(null, 'toggle')
      expect(source.onAction).toHaveBeenLastCalledWith('play', {})
      h.service.act('t1', 'nexttrack')
      expect(source.onAction).toHaveBeenLastCalledWith('nexttrack', {})
      h.service.act(null, 'seekforward', { seekOffset: 10 })
      expect(source.onAction).toHaveBeenLastCalledWith('seekforward', { seekOffset: 10 })
      h.service.act(null, 'seekto', { seekTime: -2 })
      expect(source.onAction).toHaveBeenLastCalledWith('seekto', { seekTime: 0 })
      h.service.act(null, 'seekto', { seekTime: Number.NaN })
      expect(source.onAction).toHaveBeenLastCalledWith('seekto', {})
      // Nothing went to the tab's page.
      expect(h.views.get('t1')!.posted).toEqual([])
    })

    it('stop reaches the source and dismisses its session until it next reports playing; it stays registered', () => {
      const source = readAloud('t1')
      const handle = h.service.registerSource(source)
      handle.update({ playing: false })
      h.service.act(null, 'stop')
      expect(source.onAction).toHaveBeenLastCalledWith('stop', {})
      expect(h.service.sessionTab).toBeNull()
      expect(h.updates.at(-1)).toBeNull()
      // Still registered: the list keeps its entry, paused, without the session.
      expect(h.service.refresh().find((m) => m.tabId === 't1')).toMatchObject({
        source: 'chrome',
        playing: false
      })
      expect(h.service.refresh().find((m) => m.tabId === 't1')?.session).toBeUndefined()
      // A change that is not playing leaves it dismissed.
      handle.update({ title: 'Still paused' })
      expect(h.service.sessionTab).toBeNull()
      handle.update({ playing: true })
      expect(h.service.sessionTab).toBe('t1')
      expect(h.updates.at(-1)).toMatchObject({ playing: true, source: 'chrome' })
      // Stop while playing: the player is told; as for a page, the session goes once it reports
      // paused, and stays away until it plays again.
      h.service.act('t1', 'stop')
      expect(source.onAction).toHaveBeenLastCalledWith('stop', {})
      expect(h.service.sessionTab).toBe('t1')
      handle.update({ playing: false })
      expect(h.service.sessionTab).toBeNull()
      expect(h.updates.at(-1)).toBeNull()
      handle.update({ playing: true })
      expect(h.service.sessionTab).toBe('t1')
    })

    it('reaches the one that holds the session when a page and a source share a tab, the page otherwise', () => {
      const source = readAloud('t1')
      play(h, 't1', report({ playing: false }))
      h.now.value += 1000
      h.service.registerSource(source)
      // The source (the later starter) holds the session on t1: the tab's controls reach it.
      expect(h.service.sessionSource).toBe('read-aloud')
      h.service.act('t1', 'pause')
      expect(source.onAction).toHaveBeenLastCalledWith('pause', {})
      expect(h.views.get('t1')!.posted).toEqual([])
      // The page plays later and holds it: the tab's controls reach the page.
      h.now.value += 1000
      play(h, 't1')
      expect(h.service.sessionSource).toBeNull()
      h.service.act('t1', 'pause')
      expect(h.views.get('t1')!.posted.at(-1)).toEqual({ type: 'mediaSession', action: 'pause' })
      expect(source.onAction).toHaveBeenCalledTimes(1)
      // Another tab's page holds the session: a control named for t1 reaches its page (its entry).
      h.now.value += 1000
      play(h, 't2')
      h.service.act('t1', 'toggle')
      expect(h.views.get('t1')!.posted.at(-1)).toEqual({ type: 'mediaSession', action: 'toggle' })
      expect(source.onAction).toHaveBeenCalledTimes(1)
    })

    it("reaches a tab's source by name while another tab's page holds the session", () => {
      const source = readAloud('t1', { playing: false })
      h.service.registerSource(source)
      play(h, 't2')
      expect(h.service.sessionTab).toBe('t2')
      h.service.act('t1', 'toggle')
      expect(source.onAction).toHaveBeenLastCalledWith('play', {})
      expect(h.views.get('t1')!.posted).toEqual([])
      // The session's page still gets the unnamed controls.
      h.service.act(null, 'pause')
      expect(h.views.get('t2')!.posted.at(-1)).toEqual({ type: 'mediaSession', action: 'pause' })
    })

    it("is its tab's entry in the media list while the page has no media of its own", () => {
      h.service.registerSource(
        readAloud('t1', { position: { duration: 120, position: 5, playbackRate: 1 } })
      )
      const states = h.service.refresh()
      expect(states).toHaveLength(1)
      expect(states[0]).toEqual({
        tabId: 't1',
        playing: true,
        title: 'An article',
        artist: 'news.example',
        album: '',
        artwork: null,
        video: false,
        position: { duration: 120, position: 5, playbackRate: 1 },
        positionAt: h.now.value,
        actions: ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'],
        source: 'chrome',
        session: true
      })
      // With both on one tab, the page's entry stays; the page's entries carry no source field.
      play(
        h,
        't1',
        report({ playing: false, metadata: { title: 'Clip', artist: '', album: '', artwork: [] } })
      )
      const both = h.service.refresh()
      expect(both).toHaveLength(1)
      expect(both[0]).toMatchObject({ tabId: 't1', title: 'Clip' })
      expect(both[0]).not.toHaveProperty('source')
      // The source still holds the session (the page paused without ever playing).
      expect(h.service.sessionSource).toBe('read-aloud')
      expect(h.updates.at(-1)).toMatchObject({ source: 'chrome', title: 'An article' })
    })

    it("shows nothing of a private tab's source but its state", () => {
      h.privateTabs.add('t1')
      h.service.registerSource(readAloud('t1', { artwork: 'https://news.example/a.png' }))
      const info = h.updates.at(-1)!
      expect(info).toMatchObject({
        tabId: 't1',
        title: '',
        artist: '',
        artwork: null,
        playing: true,
        private: true,
        source: 'chrome'
      })
      expect(h.service.refresh().find((m) => m.tabId === 't1')).toMatchObject({
        title: '',
        artist: '',
        artwork: null,
        source: 'chrome'
      })
    })

    it('drops with its tab, as a page report does', () => {
      const handle = h.service.registerSource(readAloud('t1'))
      h.closeTab('t1')
      h.service.refresh()
      expect(h.service.sessionTab).toBeNull()
      expect(h.updates.at(-1)).toBeNull()
      expect(h.service.refresh()).toEqual([])
      // Its handle is inert afterwards.
      handle.update({ playing: true })
      expect(h.service.sessionTab).toBeNull()
    })

    it('replaces an earlier registration under the same id, whose handle goes inert', () => {
      const first = readAloud('t1')
      const firstHandle = h.service.registerSource(first)
      const second = readAloud('t2', { title: 'Another article' })
      const secondHandle = h.service.registerSource(second)
      expect(h.service.sessionTab).toBe('t2')
      expect(h.updates.at(-1)).toMatchObject({ title: 'Another article', sourceId: 'read-aloud' })
      firstHandle.update({ title: 'stale' })
      firstHandle.release()
      expect(h.service.sessionTab).toBe('t2')
      expect(h.updates.at(-1)).toMatchObject({ title: 'Another article' })
      h.service.act(null, 'pause')
      expect(second.onAction).toHaveBeenLastCalledWith('pause', {})
      expect(first.onAction).not.toHaveBeenCalled()
      secondHandle.release()
      expect(h.service.sessionTab).toBeNull()
    })

    it('does not repeat an unchanged source session to the host', () => {
      h.service.registerSource(readAloud('t1'))
      const sent = h.updates.length
      h.service.refresh()
      h.service.refresh()
      expect(h.updates.length).toBe(sent)
    })

    it('reaches the in-app list on a host without OS controls (the preview host, desktop without MPRIS)', () => {
      const plain = harness({ host: false })
      plain.addTab('a', 'https://a.example/', 'A')
      plain.service.registerSource(readAloud('a'))
      expect(plain.service.sessionTab).toBe('a')
      expect(plain.service.refresh().find((m) => m.tabId === 'a')).toMatchObject({
        source: 'chrome',
        session: true
      })
      expect(plain.updates).toEqual([])
    })
  })
})

/** The desktop: no OS media host with a PiP window of its own; the page's video goes into its own. */
describe('automatic picture-in-picture (MW-28)', () => {
  let h: Harness
  let win: FakeWindow

  /** The pending page answers (`executeJavaScript`) land. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  const video = (): MediaReport => report({ video: true, width: 1280, height: 720 })
  const entered = (tabId: string): number =>
    h.views.get(tabId)!.scripts.filter((s) => s.includes('requestPictureInPicture')).length
  const left = (tabId: string): number =>
    h.views.get(tabId)!.scripts.filter((s) => s.includes('exitPictureInPicture')).length

  beforeEach(() => {
    h = harness({ host: false })
    h.addTab('film', 'https://video.example/watch', 'A film')
    h.addTab('docs', 'https://docs.example/', 'Docs')
    h.activated.add('film')
    win = h.addWindow('w1', ['film'])
    play(h, 'film', video())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('puts the playing video into the small window when its tab leaves the screen, and brings it back on return', async () => {
    h.show(win, ['docs'])
    await settle()
    expect(entered('film')).toBe(1)
    expect(h.service.autoPictureInPictureTab).toBe('film')
    // The largest video playing that allows it; a document already holding one is left alone.
    expect(h.views.get('film')!.scripts[0]).toContain('!v.paused && !v.ended')
    expect(h.views.get('film')!.scripts[0]).toContain(
      "if (document.pictureInPictureElement) return 'held'"
    )
    // The tab left the screen: no question about the document's visibility on this path.
    expect(h.views.get('film')!.scripts[0]).not.toContain('visibilityState')
    // The row asked for the film's site alone, never the docs' (the session's own carry of the
    // answer to the host asks the same question on every push, so the count is not pinned).
    expect(h.checks).toContainEqual([AUTO_PIP_SETTING, 'https://video.example/watch'])
    expect(
      h.checks.every(
        ([permission, url]) =>
          permission === AUTO_PIP_SETTING && url === 'https://video.example/watch'
      )
    ).toBe(true)
    // The page confirms; the user's own close later would end the claim (below).
    h.service.onPagePictureInPicture('film', true)
    h.show(win, ['film'])
    await settle()
    expect(left('film')).toBe(1)
    expect(h.service.autoPictureInPictureTab).toBeNull()
    // Nothing more happens for the tab that was never eligible.
    expect(h.views.get('docs')!.scripts).toEqual([])
  })

  it.each([
    ['a paused video', { report: report({ video: true, playing: false }) }],
    [
      'a muted video, which holds no media session',
      { report: report({ video: true, muted: true, playing: false }) }
    ],
    ['audio without video', { report: report() }],
    [
      'a clip too short for the OS controls',
      { report: report({ video: true, position: { duration: 3, position: 1, playbackRate: 1 } }) }
    ],
    ['a page the user never interacted with', { activated: false }],
    ['a private tab', { privateTab: true }],
    ['a site whose setting says no', { denied: true }],
    ['a host without picture-in-picture', { capability: false }],
    ['a tab whose view is gone', { destroyed: true }],
    ['a video already in the small window somewhere', { alert: 'pip' }]
  ] as Array<
    [
      string,
      {
        report?: MediaReport
        activated?: boolean
        privateTab?: boolean
        denied?: boolean
        capability?: boolean
        destroyed?: boolean
        alert?: string
      }
    ]
  >)('leaves %s on the page', async (_name, c) => {
    if (c.capability === false) {
      h = harness({ host: false, pictureInPicture: false })
      h.addTab('film', 'https://video.example/watch', 'A film')
      h.addTab('docs', 'https://docs.example/', 'Docs')
      h.activated.add('film')
      win = h.addWindow('w1', ['film'])
    }
    play(h, 'film', c.report ?? video())
    if (c.activated === false) h.activated.delete('film')
    if (c.privateTab) h.privateTabs.add('film')
    if (c.denied) h.denied.add('https://video.example/watch')
    if (c.destroyed) h.views.get('film')!.destroyed = true
    if (c.alert) h.setAlert('docs', c.alert)
    h.show(win, ['docs'])
    await settle()
    expect(entered('film')).toBe(0)
    expect(h.service.autoPictureInPictureTab).toBeNull()
  })

  it('does not take a video whose tab is still on screen in another window', async () => {
    const other = h.addWindow('w2', ['film'])
    h.show(win, ['docs'])
    await settle()
    expect(entered('film')).toBe(0)
    h.show(other, ['docs'])
    await settle()
    expect(entered('film')).toBe(1)
  })

  it('gives up the claim when the page refuses (no user gesture, no video), and when the user closes the small window', async () => {
    h.views.get('film')!.enterResult = false
    h.show(win, ['docs'])
    await settle()
    expect(entered('film')).toBe(1)
    expect(h.service.autoPictureInPictureTab).toBeNull()
    // Nothing to leave on return.
    h.show(win, ['film'])
    await settle()
    expect(left('film')).toBe(0)
    // Entered for real this time; the user closes the small window: the video stays on the page
    // until the tab leaves the screen again, and the return does not exit anything.
    h.views.get('film')!.enterResult = true
    h.show(win, ['docs'])
    await settle()
    expect(h.service.autoPictureInPictureTab).toBe('film')
    h.service.onPagePictureInPicture('film', true)
    h.service.onPagePictureInPicture('film', false)
    expect(h.service.autoPictureInPictureTab).toBeNull()
    h.show(win, ['film'])
    await settle()
    expect(left('film')).toBe(0)
  })

  it('ignores a stale "no picture-in-picture" report that lands before the page confirmed the entry', async () => {
    h.show(win, ['docs'])
    await settle()
    h.service.onPagePictureInPicture('film', false)
    expect(h.service.autoPictureInPictureTab).toBe('film')
    h.service.onPagePictureInPicture('docs', false)
    expect(h.service.autoPictureInPictureTab).toBe('film')
  })

  it('forgets the claim when the tab closes', async () => {
    h.show(win, ['docs'])
    await settle()
    expect(h.service.autoPictureInPictureTab).toBe('film')
    h.closeTab('film')
    h.service.refresh()
    expect(h.service.autoPictureInPictureTab).toBeNull()
  })

  it('enters when the app loses the focus for good and the page went out of sight with the window, and leaves when the window with the video comes back', async () => {
    vi.useFakeTimers()
    win.focused = false
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, false)
    expect(entered('film')).toBe(0)
    await vi.advanceTimersByTimeAsync(AUTO_PIP_BLUR_GRACE_MS)
    expect(entered('film')).toBe(1)
    // Chrome's rule on the window trigger: the entry script asks the document's own visibility
    // (Chromium's: minimized, or covered where occlusion is tracked natively) before it enters.
    expect(h.views.get('film')!.scripts[0]).toContain(VISIBILITY_GUARD)
    expect(h.service.autoPictureInPictureTab).toBe('film')
    h.service.onPagePictureInPicture('film', true)
    win.focused = true
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(left('film')).toBe(1)
    expect(h.service.autoPictureInPictureTab).toBeNull()
  })

  it('leaves a video the user can still see where it is when only the focus went (two windows side by side, a second monitor, X11 without a minimize), and holds no claim over it', async () => {
    vi.useFakeTimers()
    h.views.get('film')!.visibility = 'visible'
    win.focused = false
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, false)
    await vi.advanceTimersByTimeAsync(AUTO_PIP_BLUR_GRACE_MS)
    // Asked, and told the document is visible: nothing entered, no claim, no toast, no memory.
    expect(h.views.get('film')!.scripts).toHaveLength(1)
    expect(h.views.get('film')!.scripts[0]).toContain(VISIBILITY_GUARD)
    expect(h.service.autoPictureInPictureTab).toBeNull()
    expect(h.toasts).toEqual([])
    expect(h.noticed.size).toBe(0)
    // No stale claim: the focus back changes nothing, and the tab trigger still works – the
    // tab off the screen is hidden by the switch itself, so that path asks no such question.
    win.focused = true
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(left('film')).toBe(0)
    h.show(win, ['docs'])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.views.get('film')!.scripts).toHaveLength(2)
    expect(h.views.get('film')!.scripts[1]).not.toContain('visibilityState')
    expect(h.service.autoPictureInPictureTab).toBe('film')
  })

  it('lets the focus move to another Zenium window without entering', async () => {
    vi.useFakeTimers()
    const other = h.addWindow('w2', ['docs'])
    win.focused = false
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, false)
    other.focused = true
    h.service.onWindowFocusChanged(other as unknown as ZenWindow, true)
    await vi.advanceTimersByTimeAsync(AUTO_PIP_BLUR_GRACE_MS * 2)
    expect(entered('film')).toBe(0)
    // Focus back to the first window within the grace: nothing pending fires.
    win.focused = false
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, false)
    win.focused = true
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, true)
    await vi.advanceTimersByTimeAsync(AUTO_PIP_BLUR_GRACE_MS * 2)
    expect(entered('film')).toBe(0)
  })

  it('does not fire a blur for a window that closed in the meantime', async () => {
    vi.useFakeTimers()
    win.focused = false
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, false)
    win.alive = false
    await vi.advanceTimersByTimeAsync(AUTO_PIP_BLUR_GRACE_MS)
    expect(entered('film')).toBe(0)
  })

  it('leaves a host with its own picture-in-picture window (Android, #223) to its own hook', async () => {
    const android = harness()
    android.addTab('film', 'https://video.example/watch', 'A film')
    android.addTab('docs', 'https://docs.example/', 'Docs')
    android.activated.add('film')
    const w = android.addWindow('w1', ['film'])
    play(android, 'film', video())
    android.show(w, ['docs'])
    await settle()
    expect(android.views.get('film')!.scripts).toEqual([])
    expect(android.pipRequests).toEqual([])
    expect(android.service.autoPictureInPictureTab).toBeNull()
    // Nothing changes on the phone: no toast, no memory written.
    expect(android.toasts).toEqual([])
    expect(android.noticed.size).toBe(0)
  })

  describe('the first-time toast (the design lead’s ruling)', () => {
    const TOAST = {
      message: 'Video from video.example opened in a small window',
      kind: 'info',
      action: {
        label: 'Turn off for this site',
        command: 'media.autoPipOptOut',
        args: { tabId: 'film' }
      }
    }

    it('says so once per site, in the tab’s own window, with "Turn off for this site"', async () => {
      h.show(win, ['docs'])
      await settle()
      expect(h.toasts).toEqual([{ ...TOAST, win }])
      expect([...h.noticed]).toEqual([`${AUTO_PIP_SETTING}|https://video.example`])
      // Back and away again: the second entry is silent, the memory already holding the site.
      h.service.onPagePictureInPicture('film', true)
      h.show(win, ['film'])
      await settle()
      h.show(win, ['docs'])
      await settle()
      expect(entered('film')).toBe(2)
      expect(h.toasts).toHaveLength(1)
    })

    it('is silent for a site told before this session (the memory is the permission store’s)', async () => {
      h.noticed.add(`${AUTO_PIP_SETTING}|https://video.example`)
      h.show(win, ['docs'])
      await settle()
      expect(entered('film')).toBe(1)
      expect(h.toasts).toEqual([])
    })

    it('tells a second site in its own words, another page of a told site not at all', async () => {
      h.addTab('clip', 'https://www.clips.example:8443/c/1', 'A clip')
      h.addTab('again', 'https://video.example/other', 'The same site again')
      h.activated.add('clip').add('again')
      // The film's site is told first.
      h.show(win, ['docs'])
      await settle()
      h.service.onPagePictureInPicture('film', true)
      h.show(win, ['film'])
      await settle()
      // Another page of the film's site: silent.
      play(h, 'film', report({ video: false, playing: false }))
      play(h, 'again', video())
      h.show(win, ['again'])
      h.show(win, ['docs'])
      await settle()
      expect(entered('again')).toBe(1)
      expect(h.toasts).toHaveLength(1)
      h.service.onPagePictureInPicture('again', true)
      h.show(win, ['again'])
      await settle()
      // A new site: its own toast, the host without `www.` and with its port, as the site card names it.
      play(h, 'again', report({ video: false, playing: false }))
      play(h, 'clip', video())
      h.show(win, ['clip'])
      h.show(win, ['docs'])
      await settle()
      expect(h.toasts).toHaveLength(2)
      expect(h.toasts[1]).toEqual({
        message: 'Video from clips.example:8443 opened in a small window',
        kind: 'info',
        win,
        action: {
          label: 'Turn off for this site',
          command: 'media.autoPipOptOut',
          args: { tabId: 'clip' }
        }
      })
    })

    it('says nothing when the page refused the entry', async () => {
      h.views.get('film')!.enterResult = false
      h.show(win, ['docs'])
      await settle()
      expect(h.toasts).toEqual([])
      expect(h.noticed.size).toBe(0)
    })

    it('never speaks for the user’s own toggle (the hub’s button, page.pip)', async () => {
      await h.service.pictureInPicture('film', win as unknown as ZenWindow)
      expect(entered('film')).toBe(1)
      expect(h.toasts).toEqual([])
      expect(h.noticed.size).toBe(0)
    })

    it('goes to the tab’s window after a blur to another application too', async () => {
      vi.useFakeTimers()
      const other = h.addWindow('w2', ['docs'])
      win.focused = false
      other.focused = false
      h.service.onWindowFocusChanged(win as unknown as ZenWindow, false)
      await vi.advanceTimersByTimeAsync(AUTO_PIP_BLUR_GRACE_MS)
      expect(entered('film')).toBe(1)
      expect(h.toasts).toEqual([{ ...TOAST, win }])
    })

    it('"Turn off for this site" denies the site through the permissions service and brings the video back, and the site never enters again', async () => {
      h.show(win, ['docs'])
      await settle()
      h.service.onPagePictureInPicture('film', true)
      expect(h.service.autoPictureInPictureTab).toBe('film')
      await h.service.optOutAuto('film')
      // The site card's write, the same code path.
      expect(h.sets).toEqual([[AUTO_PIP_SETTING, 'https://video.example/watch', 'deny']])
      // The video is back on its page, the desktop's claim given up.
      expect(left('film')).toBe(1)
      expect(h.service.autoPictureInPictureTab).toBeNull()
      // The tab leaves the screen again: the denied site stays on its page, silently.
      h.service.onPagePictureInPicture('film', false)
      h.show(win, ['film'])
      await settle()
      h.show(win, ['docs'])
      await settle()
      expect(entered('film')).toBe(1)
      expect(h.toasts).toHaveLength(1)
    })

    it('"Turn off for this site" on a tab whose video the user already took back only writes the deny', async () => {
      h.show(win, ['docs'])
      await settle()
      h.service.onPagePictureInPicture('film', true)
      h.service.onPagePictureInPicture('film', false)
      expect(h.service.autoPictureInPictureTab).toBeNull()
      await h.service.optOutAuto('film')
      expect(h.sets).toEqual([[AUTO_PIP_SETTING, 'https://video.example/watch', 'deny']])
      expect(left('film')).toBe(0)
      // A tab that is gone: nothing to write, nothing to leave.
      h.closeTab('film')
      await h.service.optOutAuto('film')
      expect(h.sets).toHaveLength(1)
    })
  })
})

describe("the hub's linger for a paused session (W7-5: Chrome's inactivity dismissal)", () => {
  /** The desktop's linger in the tests: short, as `ZEN_MEDIA_LINGER_MS` makes it for a drive. */
  const LINGER_MS = 5_000
  const METADATA = { title: 'Nocturne', artist: 'Ensemble', album: '', artwork: [] }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** The tab's entry in the hub's list, or undefined once the linger took it out. */
  function entry(h: Harness, tabId: string): MediaState | undefined {
    return h.service.refresh().find((s) => s.tabId === tabId)
  }

  it("is Chrome's kAutoDismissTimerInMinutesDefault: 60 minutes", () => {
    expect(MEDIA_HUB_INACTIVE_MS).toBe(60 * 60 * 1000)
  })

  it('keeps a paused session in the hub with its title and artwork, and a play offered, until the linger runs out', () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1', report({ metadata: METADATA }))
    // The pause starts the clock; the entry stays, paused.
    play(h, 't1', report({ playing: false, metadata: METADATA }))
    vi.advanceTimersByTime(LINGER_MS - 1)
    const paused = entry(h, 't1')
    expect(paused).toMatchObject({ tabId: 't1', playing: false, title: 'Nocturne' })
    // The clock runs out: the chrome is told and the entry is gone from the hub's list…
    h.updateMedia.mockClear()
    vi.advanceTimersByTime(1)
    expect(h.updateMedia).toHaveBeenCalledTimes(1)
    expect(entry(h, 't1')).toBeUndefined()
    expect(h.service.isInactive('t1')).toBe(true)
    // …while the OS controls keep the paused session, as Chrome's SMTC and MPRIS do.
    expect(h.service.session()).toMatchObject({ tabId: 't1', playing: false })
  })

  it('cancels the clock when the media plays again, and shows an entry the linger had taken out', () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1')
    play(h, 't1', report({ playing: false }))
    vi.advanceTimersByTime(LINGER_MS - 1)
    // A play cancels the clock: no expiry follows, however long the playback runs.
    play(h, 't1')
    vi.advanceTimersByTime(LINGER_MS * 3)
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: true })
    // Paused again: a fresh clock, the full linger long.
    play(h, 't1', report({ playing: false }))
    vi.advanceTimersByTime(LINGER_MS - 1)
    expect(entry(h, 't1')).toBeDefined()
    vi.advanceTimersByTime(1)
    expect(entry(h, 't1')).toBeUndefined()
    // The next playback brings the entry back at once (Chrome's ShowItem on MarkActiveIfNecessary).
    play(h, 't1')
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: true })
    expect(h.service.isInactive('t1')).toBe(false)
  })

  it("starts the clock when the view falls quiet, not on the pause's report: the engine's audible word trails the element", () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1')
    const view = h.views.get('t1')!
    // The pause's report arrives while `isCurrentlyAudible()` still says audible (Chromium holds
    // the stream's word for a moment after its last audible frame; the W7-5 drive's probe read
    // two seconds): the entry keeps the engine's word, and no clock starts yet – one started
    // here would be stopped by this very refresh and never started again.
    h.service.onReport('t1', report({ playing: false }))
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: true })
    expect(vi.getTimerCount()).toBe(0)
    // The view falls quiet (`audio-state-changed` → `updateMedia` → refresh): the clock starts.
    view.audible = false
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: false })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(LINGER_MS - 1)
    expect(entry(h, 't1')).toMatchObject({ playing: false })
    vi.advanceTimersByTime(1)
    expect(entry(h, 't1')).toBeUndefined()
    // The play's report wakes the entry before the view is heard again (the mirror lag).
    h.service.onReport('t1', report({ playing: true }))
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: false })
    expect(h.service.isInactive('t1')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    // Heard: the entry plays by the engine's word; a later pause runs the whole path again.
    view.audible = true
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: true })
    h.service.onReport('t1', report({ playing: false }))
    view.audible = false
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: false })
    vi.advanceTimersByTime(LINGER_MS)
    expect(entry(h, 't1')).toBeUndefined()
  })

  it('treats an ended track as a pause: it lingers the same way, and its entry can replay it', () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1', report({ position: { duration: 240, position: 200, playbackRate: 1 } }))
    // The element ended: the shim keeps reporting it, paused at the end.
    play(
      h,
      't1',
      report({ playing: false, position: { duration: 240, position: 240, playbackRate: 1 } })
    )
    vi.advanceTimersByTime(LINGER_MS - 1)
    expect(entry(h, 't1')).toMatchObject({ playing: false })
    // The hub's Play reaches the page as `toggle`: the shim resolves it to a play of the element
    // (an ended element's `play()` starts it over) – and the press restarts the clock meanwhile.
    h.service.act('t1', 'toggle')
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({ type: 'mediaSession', action: 'toggle' })
    vi.advanceTimersByTime(LINGER_MS - 1)
    expect(entry(h, 't1')).toMatchObject({ playing: false })
    // A page that refused the replay (no `play` handler, the element gone read-only) leaves the
    // entry paused, and the clock takes it out on time.
    vi.advanceTimersByTime(1)
    expect(entry(h, 't1')).toBeUndefined()
  })

  it('restarts the clock on an interaction: a control pressed in the hub, or a seek while paused', () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1')
    play(
      h,
      't1',
      report({ playing: false, position: { duration: 240, position: 12, playbackRate: 1 } })
    )
    vi.advanceTimersByTime(LINGER_MS - 1)
    // A seek while paused (Chrome's MediaSessionPositionChanged → OnSessionInteractedWith).
    play(
      h,
      't1',
      report({ playing: false, position: { duration: 240, position: 90, playbackRate: 1 } })
    )
    vi.advanceTimersByTime(LINGER_MS - 1)
    expect(entry(h, 't1')).toBeDefined()
    // A control pressed in the hub (a seek forward on a paused track) restarts it again.
    h.service.act('t1', 'seekforward', { seekOffset: 10 })
    vi.advanceTimersByTime(LINGER_MS - 1)
    expect(entry(h, 't1')).toBeDefined()
    vi.advanceTimersByTime(1)
    expect(entry(h, 't1')).toBeUndefined()
  })

  it('does not restart the clock for a paused report that changed nothing (metadata refreshed, the same position)', () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1')
    play(h, 't1', report({ playing: false }))
    vi.advanceTimersByTime(LINGER_MS - 1)
    play(h, 't1', report({ playing: false, metadata: METADATA }))
    vi.advanceTimersByTime(1)
    expect(entry(h, 't1')).toBeUndefined()
  })

  it('removes the session at once when its tab closes, clock or no clock', () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1')
    play(h, 't1', report({ playing: false }))
    h.closeTab('t1')
    expect(entry(h, 't1')).toBeUndefined()
    expect(h.service.session()).toBeNull()
    // The clock was cleared with the tab: its expiry tells the chrome nothing.
    h.updateMedia.mockClear()
    vi.advanceTimersByTime(LINGER_MS * 2)
    expect(h.updateMedia).not.toHaveBeenCalled()
  })

  it('removes the session at once when its media element is gone, and a later element starts afresh', () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1')
    play(h, 't1', report({ playing: false }))
    // The element removed from the document: the shim's report has no media in it.
    play(h, 't1', report({ playing: false, position: null }))
    expect(entry(h, 't1')).toBeUndefined()
    h.updateMedia.mockClear()
    vi.advanceTimersByTime(LINGER_MS * 2)
    expect(h.updateMedia).not.toHaveBeenCalled()
    expect(h.service.isInactive('t1')).toBe(false)
  })

  it('never ends a session for a mute: a muted element starts no clock and stops one that runs', () => {
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1')
    // Muted on the page while playing: the report says playing false, muted true.
    play(h, 't1', report({ playing: false, muted: true }))
    vi.advanceTimersByTime(LINGER_MS * 3)
    expect(entry(h, 't1')).toBeDefined()
    // Paused, then muted while paused: the clock stops; unmuted while paused, it starts over.
    play(h, 't1', report({ playing: false }))
    vi.advanceTimersByTime(LINGER_MS - 1)
    play(h, 't1', report({ playing: false, muted: true }))
    vi.advanceTimersByTime(LINGER_MS * 3)
    expect(entry(h, 't1')).toBeDefined()
    play(h, 't1', report({ playing: false }))
    vi.advanceTimersByTime(LINGER_MS - 1)
    expect(entry(h, 't1')).toBeDefined()
    vi.advanceTimersByTime(1)
    expect(entry(h, 't1')).toBeUndefined()
  })

  it('leaves a host without the hub (the phone) exactly as it was: no clock, the paused session stays', () => {
    const h = harness()
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1', report({ metadata: METADATA }))
    play(h, 't1', report({ playing: false, metadata: METADATA }))
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(MEDIA_HUB_INACTIVE_MS * 2)
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: false, title: 'Nocturne' })
    expect(h.service.isInactive('t1')).toBe(false)
    expect(h.service.session()).toMatchObject({ tabId: 't1', playing: false })
  })

  it('ignores a linger that is not a positive number of milliseconds', () => {
    const h = harness({ mediaHub: 0 })
    h.addTab('t1', 'https://music.example/a', 'Music')
    play(h, 't1')
    play(h, 't1', report({ playing: false }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose clears the timers; a late report after dispose arms nothing', () => {
    // `Browser.shutdown()` – the quit path – calls `dispose()`; the services read asked that no
    // linger outlive it and none be armed after it.
    const h = harness({ mediaHub: LINGER_MS })
    h.addTab('t1', 'https://music.example/a', 'Music')
    h.addTab('t2', 'https://video.example/b', 'Video')
    play(h, 't1')
    play(h, 't1', report({ playing: false }))
    play(h, 't2')
    play(h, 't2', report({ playing: false }))
    expect(vi.getTimerCount()).toBe(2)
    h.service.dispose()
    // Every clock is cleared: none stands, none fires into the torn-down chrome.
    expect(vi.getTimerCount()).toBe(0)
    h.updateMedia.mockClear()
    vi.advanceTimersByTime(LINGER_MS * 2)
    expect(h.updateMedia).not.toHaveBeenCalled()
    expect(h.service.isInactive('t1')).toBe(false)
    expect(h.service.isInactive('t2')).toBe(false)
    // Late in the teardown a page reports a pause (a seek, a fresh pause), the view falls quiet
    // and a refresh runs: nothing arms – no timer, and the entry never goes inactive.
    h.service.onReport(
      't1',
      report({ playing: false, position: { duration: 240, position: 90, playbackRate: 1 } })
    )
    h.service.refresh()
    play(h, 't2')
    play(h, 't2', report({ playing: false }))
    h.service.act('t2', 'seekforward', { seekOffset: 10 })
    expect(vi.getTimerCount()).toBe(0)
    h.updateMedia.mockClear()
    vi.advanceTimersByTime(MEDIA_HUB_INACTIVE_MS * 2)
    expect(h.updateMedia).not.toHaveBeenCalled()
    expect(h.service.isInactive('t1')).toBe(false)
    expect(h.service.isInactive('t2')).toBe(false)
    expect(entry(h, 't1')).toMatchObject({ tabId: 't1', playing: false })
    expect(entry(h, 't2')).toMatchObject({ tabId: 't2', playing: false })
  })

  it("dispose clears the automatic picture-in-picture's blur clock too, and a blur after it arms none", () => {
    // The desktop's auto-PiP host: no `enterPictureInPicture` of the OS's, the page's own window.
    const h = harness({ host: false, mediaHub: LINGER_MS })
    h.addTab('film', 'https://video.example/watch', 'A film')
    h.activated.add('film')
    const win = h.addWindow('w1', ['film'])
    play(h, 'film', report({ video: true, width: 1280, height: 720 }))
    win.focused = false
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, false)
    expect(vi.getTimerCount()).toBe(1)
    h.service.dispose()
    expect(vi.getTimerCount()).toBe(0)
    h.service.onWindowFocusChanged(win as unknown as ZenWindow, false)
    expect(vi.getTimerCount()).toBe(0)
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
