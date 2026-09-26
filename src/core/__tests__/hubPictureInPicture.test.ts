import { describe, expect, it } from 'vitest'
import { Browser } from '../browser'
import { AUTO_PIP_SETTING } from '../mediaSession'
import { PermissionService } from '../permissions'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import { EMPTY_MEDIA_REPORT, type MediaReport } from '../../shared/mediaSession'
import { PRIVATE_CONTAINER_ID, type HostCapabilities, type Tab } from '../../shared/types'

/*
 * The media hub's Picture-in-picture button runs `media.pictureInPicture` (pip-02). On a host
 * whose window itself goes into picture-in-picture (Android) the command asks the host; the
 * desktop's Electron host has no such window – its `mediaSession` host is MPRIS on Linux and
 * nothing at all on Windows and macOS – so there the command toggles the page's own video, as
 * `page.pip` does: out of the small window when a video is in it, else the largest video with a
 * frame that allows it goes in. It reports whether that happened and says why when it cannot.
 */

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** How the page answers the toggle script: a boolean, or a throw (the document went away). */
type PageAnswer = boolean | 'throws'

interface Fixture {
  browser: Browser
  sent: Array<{ name: string; payload: unknown }>
  scripts: string[]
  pipRequests: string[]
  page: { answer: PageAnswer }
}

/**
 * `host`: `none` is Windows' and macOS' Electron (no `mediaSession` host), `mpris` is Linux's
 * (a host that mirrors the session to the desktop and has no window to put into PiP), `window`
 * is Android's (a host with `enterPictureInPicture`).
 */
function fixture(host: 'none' | 'mpris' | 'window', io: StoreIO = memoryIo()): Fixture {
  const sent: Fixture['sent'] = []
  const scripts: string[] = []
  const pipRequests: string[] = []
  const page: Fixture['page'] = { answer: true }
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: false,
    pageTabs: false,
    pictureInPicture: true
  })
  const platform: Platform = {
    info: { os: host === 'window' ? 'android' : 'linux', version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          },
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        let url = tab.url
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
          loadURL: (u: string) => {
            url = u
          },
          executeJavaScript: async (code: string) => {
            scripts.push(code)
            if (page.answer === 'throws') throw new Error('Script failed to execute')
            return page.answer
          },
          destroy: () => undefined
        })
      }
    }),
    ...(host === 'none'
      ? {}
      : {
          mediaSession: {
            update: () => undefined,
            ...(host === 'window'
              ? {
                  enterPictureInPicture: async (session: { tabId: string }) => {
                    pipRequests.push(session.tabId)
                    return true
                  }
                }
              : {})
          }
        }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  } as Platform
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, sent, scripts, pipRequests, page }
}

function toasts(f: Fixture): string[] {
  return f.sent
    .filter((e) => e.name === 'toast')
    .map((e) => (e.payload as { message: string }).message)
}

const pipScripts = (f: Fixture): string[] =>
  f.scripts.filter((s) => s.includes('requestPictureInPicture'))

/** A video playing in the tab, as the page reports it (what puts the tab's card in the hub). */
function playingVideo(f: Fixture, tabId: string): void {
  const report: MediaReport = {
    ...EMPTY_MEDIA_REPORT,
    playing: true,
    video: true,
    width: 1280,
    height: 720,
    position: { duration: 600, position: 12, playbackRate: 1 },
    playbackState: 'playing'
  }
  f.browser.mediaSession.onReport(tabId, report)
}

/** A regular tab with a playing video, in the focused window. */
function videoTab(
  f: Fixture,
  url = 'https://video.example/watch'
): { tab: Tab; win: ReturnType<Browser['focusedWindow']> } {
  const win = f.browser.focusedWindow()
  const tab = f.browser.tabs.createTab({ url, active: true }, win)
  playingVideo(f, tab.id)
  return { tab, win }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe.each(['none', 'mpris'] as const)(
  "the hub's Picture-in-picture on the desktop (Electron host: %s)",
  (host) => {
    it("puts the page's video into its floating window and says so", async () => {
      const f = fixture(host)
      const { tab, win } = videoTab(f)
      const result = await f.browser.handleCommand(win, 'media.pictureInPicture', {
        tabId: tab.id
      })
      expect(result).toBe(true)
      expect(pipScripts(f)).toHaveLength(1)
      expect(f.pipRequests).toEqual([])
      expect(toasts(f)).toEqual([])
    })

    it('runs the same element-targeted toggle as page.pip', async () => {
      const f = fixture(host)
      const { tab, win } = videoTab(f)
      await f.browser.handleCommand(win, 'media.pictureInPicture', { tabId: tab.id })
      f.browser.actions.run('page.pip', { sourceTabId: null, win })
      await flush()
      const [fromHub, fromAction] = pipScripts(f)
      expect(fromAction).toBe(fromHub)
      // Out when a video is in the small window; else the largest ready video that allows it.
      expect(fromHub).toContain('document.pictureInPictureElement')
      expect(fromHub).toContain('exitPictureInPicture')
      expect(fromHub).toContain('readyState > 0')
      expect(fromHub).toContain('disablePictureInPicture')
      expect(fromHub).toContain('clientWidth * b.clientHeight')
    })

    it('tells the user when the page has no video for it, and reports false', async () => {
      const f = fixture(host)
      const { tab, win } = videoTab(f)
      f.page.answer = false
      const result = await f.browser.handleCommand(win, 'media.pictureInPicture', {
        tabId: tab.id
      })
      expect(result).toBe(false)
      expect(toasts(f)).toEqual(['No video available for Picture-in-Picture'])
    })

    it('tells the user when the page refuses (the script throws), and reports false', async () => {
      const f = fixture(host)
      const { tab, win } = videoTab(f)
      f.page.answer = 'throws'
      const result = await f.browser.handleCommand(win, 'media.pictureInPicture', {
        tabId: tab.id
      })
      expect(result).toBe(false)
      expect(toasts(f)).toEqual(['No video available for Picture-in-Picture'])
    })

    it('is withheld from a private tab, as page.pip is, without touching the page', async () => {
      const f = fixture(host)
      const win = f.browser.focusedWindow()
      const priv = f.browser.tabs.createTab(
        { url: 'https://video.example/clip', active: true, containerId: PRIVATE_CONTAINER_ID },
        win
      )
      playingVideo(f, priv.id)
      const result = await f.browser.handleCommand(win, 'media.pictureInPicture', {
        tabId: priv.id
      })
      expect(result).toBe(false)
      expect(pipScripts(f)).toHaveLength(0)
      expect(toasts(f)).toEqual(["Picture-in-Picture isn't available in private tabs."])
    })

    it('is quiet for a tab without a page (unloaded), and reports false', async () => {
      const f = fixture(host)
      const win = f.browser.focusedWindow()
      const result = await f.browser.handleCommand(win, 'media.pictureInPicture', {
        tabId: 'tab_gone'
      })
      expect(result).toBe(false)
      expect(pipScripts(f)).toHaveLength(0)
      expect(toasts(f)).toEqual([])
    })
  }
)

describe("the hub's Picture-in-picture on a host whose window goes into it (Android)", () => {
  it('asks the host and never the page, quietly, as before', async () => {
    const f = fixture('window')
    const { tab, win } = videoTab(f)
    const result = await f.browser.handleCommand(win, 'media.pictureInPicture', {
      tabId: tab.id
    })
    expect(result).toBe(true)
    expect(f.pipRequests).toEqual([tab.id])
    expect(pipScripts(f)).toHaveLength(0)
    expect(toasts(f)).toEqual([])
  })

  it('refuses quietly what the host cannot show: a tab without a video, a private tab', async () => {
    const f = fixture('window')
    const win = f.browser.focusedWindow()
    const audio = f.browser.tabs.createTab(
      { url: 'https://music.example/album', active: true },
      win
    )
    f.browser.mediaSession.onReport(audio.id, { ...EMPTY_MEDIA_REPORT, playing: true })
    expect(await f.browser.handleCommand(win, 'media.pictureInPicture', { tabId: audio.id })).toBe(
      false
    )
    const priv = f.browser.tabs.createTab(
      { url: 'https://video.example/clip', active: true, containerId: PRIVATE_CONTAINER_ID },
      win
    )
    playingVideo(f, priv.id)
    expect(await f.browser.handleCommand(win, 'media.pictureInPicture', { tabId: priv.id })).toBe(
      false
    )
    expect(f.pipRequests).toEqual([])
    expect(pipScripts(f)).toHaveLength(0)
    expect(toasts(f)).toEqual([])
  })
})

describe('page.pip on the desktop', () => {
  it('says when the page has no video for it, where before only a refusal was reported', async () => {
    const f = fixture('none')
    const { win } = videoTab(f)
    f.page.answer = false
    f.browser.actions.run('page.pip', { sourceTabId: null, win })
    await flush()
    expect(pipScripts(f)).toHaveLength(1)
    expect(toasts(f)).toEqual(['No video available for Picture-in-Picture'])
  })
})

describe('the toast event and the first automatic entry’s toast (MW-28)', () => {
  const toastEvents = (f: Fixture): unknown[] =>
    f.sent.filter((e) => e.name === 'toast').map((e) => e.payload)

  it('carries an action as the command the chrome runs on the pick; a plain toast is sent as it always was', () => {
    const f = fixture('none')
    const win = f.browser.focusedWindow()
    f.browser.toast('Link copied', 'info', win)
    f.browser.toast('Something failed', 'error')
    f.browser.toast('Video from video.example opened in a small window', 'info', win, {
      label: 'Turn off for this site',
      command: 'media.autoPipOptOut',
      args: { tabId: 'tab_1' }
    })
    const events = toastEvents(f)
    expect(events).toEqual([
      { message: 'Link copied', kind: 'info' },
      { message: 'Something failed', kind: 'error' },
      {
        message: 'Video from video.example opened in a small window',
        kind: 'info',
        action: {
          label: 'Turn off for this site',
          command: 'media.autoPipOptOut',
          args: { tabId: 'tab_1' }
        }
      }
    ])
    // Not even an `action: undefined`: a consumer of the plain toast sees the shape it always saw.
    expect(Object.keys(events[0] as object)).toEqual(['message', 'kind'])
  })

  it('tells the site’s first automatic entry once, "Turn off for this site" denies the site through the permissions service and brings the video back, and the memory holds across a restart', async () => {
    const io = memoryIo()
    const f = fixture('none', io)
    const { tab, win } = videoTab(f)
    f.browser.popups.activate(tab.id)
    // Away to another tab: the video goes into the small window, and the toast says so.
    f.browser.tabs.createTab({ url: 'https://docs.example/', active: true }, win)
    await flush()
    expect(f.browser.mediaSession.autoPictureInPictureTab).toBe(tab.id)
    expect(toastEvents(f)).toEqual([
      {
        message: 'Video from video.example opened in a small window',
        kind: 'info',
        action: {
          label: 'Turn off for this site',
          command: 'media.autoPipOptOut',
          args: { tabId: tab.id }
        }
      }
    ])
    expect(f.browser.permissions.noticed(AUTO_PIP_SETTING, 'https://video.example/watch')).toBe(
      true
    )
    // The pick: the site card's own write, and the video back on its page.
    await f.browser.handleCommand(win, 'media.autoPipOptOut', { tabId: tab.id })
    expect(f.browser.permissions.get(AUTO_PIP_SETTING, 'https://video.example/watch')).toBe('deny')
    expect(f.browser.permissions.check(AUTO_PIP_SETTING, 'https://video.example/watch')).toBe(false)
    expect(f.scripts.filter((s) => s.includes('exitPictureInPicture'))).toHaveLength(1)
    expect(f.browser.mediaSession.autoPictureInPictureTab).toBeNull()
    // Back to the video's tab and away again: the denied site stays on its page, silently.
    f.browser.tabs.activateTab(tab.id, win)
    await flush()
    f.browser.tabs.createTab({ url: 'https://more.example/', active: true }, win)
    await flush()
    expect(f.browser.mediaSession.autoPictureInPictureTab).toBeNull()
    expect(pipScripts(f)).toHaveLength(1)
    expect(toastEvents(f)).toHaveLength(1)
    // The restart: the notice and the deny are the permission store's, device-local.
    f.browser.permissions.flushSync()
    const again = new PermissionService(io, { show: async () => null, cancel: () => undefined })
    expect(again.noticed(AUTO_PIP_SETTING, 'https://video.example/watch')).toBe(true)
    expect(again.check(AUTO_PIP_SETTING, 'https://video.example/watch')).toBe(false)
  })
})
