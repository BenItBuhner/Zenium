import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import type { ImagePost } from '../../shared/imageUpload'
import type { ShareChooser } from '../../shared/shareTarget'
import type { PinnedWebApp, WebAppShareTarget } from '../../shared/webApp'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

/*
 * Web Share Target on Android (MW-63): a share another app sends goes straight to a tab or a
 * search unless an installed web app declares a `share_target` that takes it – then the core
 * puts the chooser up, the house route first and the apps under "Apps", and routes on the pick:
 * the house row as before, an app's row as its target's launch.
 *
 * The chooser is part of the window's snapshot (`UIState.shareChooser`), not an event: a share
 * that cold-starts the app reaches the core before the chrome has mounted or subscribed to
 * anything, so it must be in the state the chrome draws from whenever that is. The suite reads
 * it there – nothing here listens for anything.
 */

const LINK = 'https://news.example/story?id=7'

function memoryIo(seed: Record<string, string> = {}): StoreIO {
  const files: Record<string, string> = { ...seed }
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

interface Recorded {
  readonly tabId: string
  readonly events: TabViewEvents
  /** Documents the core asked the view to load (`loadURL`). */
  readonly loads: string[]
  /** Bodies the core asked the view to post (`postURL`): a POST target's launch. */
  readonly posts: Array<{ url: string; post: ImagePost }>
}

function target(
  params: Partial<WebAppShareTarget['params']>,
  rest: Partial<Omit<WebAppShareTarget, 'params'>> = {}
): WebAppShareTarget {
  return {
    action: 'https://app.example/share',
    method: 'GET',
    enctype: 'application/x-www-form-urlencoded',
    ...rest,
    params: { title: null, text: null, url: null, files: [], ...params }
  }
}

/** An installed app's record as the store holds it, with the target its manifest declared. */
function pinned(
  id: string,
  name: string,
  shareTarget: WebAppShareTarget | null,
  icon: string | null = `${id}icon.png`
): PinnedWebApp {
  return {
    id,
    name,
    startUrl: id,
    scope: id,
    pinnedAt: 1,
    icon,
    shareTarget
  } as PinnedWebApp
}

function fixture(apps: PinnedWebApp[]): {
  browser: Browser
  views: Recorded[]
  sent: Array<{ name: string; payload: unknown }>
  /** The chooser the window's snapshot carries now, null while none does. */
  standing: () => ShareChooser | null
  /** The chooser standing now, which the test expects there. */
  chooser: () => ShareChooser
} {
  const views: Recorded[] = []
  const sent: Array<{ name: string; payload: unknown }> = []
  // A one-window host, as the phone is: an app's launch is a tab, not an app window.
  const capabilities = stub<HostCapabilities>({ windows: false, updates: false, agents: false })
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo({
      'webapps.json': JSON.stringify({ version: 1, pinned: apps, engagement: {} })
    }),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab, events: TabViewEvents) => {
        let url = ''
        const record: Recorded = { tabId: tab.id, events, loads: [], posts: [] }
        views.push(record)
        return stub<TabView>({
          showErrorPage: undefined,
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
            record.loads.push(u)
          },
          postURL: (u: string, post: ImagePost) => {
            url = u
            record.posts.push({ url: u, post })
          }
        })
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
    privacy: { apply: () => undefined },
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const standing = (): ShareChooser | null =>
    browser.state.snapshot(browser.focusedWindow()).shareChooser
  return {
    browser,
    views,
    sent,
    standing,
    chooser: () => {
      const chooser = standing()
      if (!chooser) throw new Error('no chooser stands')
      return chooser
    }
  }
}

/** The answer a window's chrome gives from its sheet. */
function pick(f: ReturnType<typeof fixture>, requestId: string, appId: string | null): void {
  f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserPick', { requestId, appId })
}
function cancel(f: ReturnType<typeof fixture>, requestId: string): void {
  f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserCancel', { requestId })
}

/** The coalesced state broadcast the core sends the window (`state.commitVolatile`) goes out on a later tick. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Every document loaded into any view, in order. */
const loads = (f: ReturnType<typeof fixture>): string[] => f.views.flatMap((v) => v.loads)

describe('a share with no installed app taking it (the routes as they were)', () => {
  it('opens a shared link in a tab and searches shared text, no chooser', () => {
    const f = fixture([pinned('https://app.example/', 'Sketch', null)])
    f.browser.openSharedIntent({ kind: 'send', text: `Read this ${LINK}` })
    expect(loads(f)).toContain(LINK)
    f.browser.openSharedIntent({ kind: 'send', text: 'how do springs work' })
    const search = loads(f).find((u) => u.includes('how'))
    expect(search).toBeDefined()
    expect(decodeURIComponent(search!)).toContain('how do springs work')
    expect(f.standing()).toBeNull()
  })

  it('does not offer a link to an app whose target takes text alone', () => {
    const f = fixture([pinned('https://notes.example/', 'Notes', target({ text: 'body' }))])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    expect(f.standing()).toBeNull()
    expect(loads(f)).toContain(LINK)
  })
})

describe('the chooser (MW-63)', () => {
  const sketch = pinned(
    'https://app.example/',
    'Sketch',
    target({ title: 'subject', text: 'body', url: 'link' })
  )
  const notes = pinned('https://notes.example/', 'Notes', target({ text: 'note' }), null)

  it('offers a shared link with its header, the house route first and the apps that take a URL under Apps', () => {
    const f = fixture([sketch, notes])
    f.browser.openSharedIntent({ kind: 'send', text: LINK, subject: 'A story' })
    // Nothing opened yet: the share waits on the pick.
    expect(loads(f)).not.toContain(LINK)
    const chooser = f.chooser()
    expect(chooser).toMatchObject({
      kind: 'url',
      link: { url: LINK, title: 'A story', thumbnail: null, scheme: null },
      text: null,
      apps: [{ id: 'https://app.example/', name: 'Sketch', icon: 'https://app.example/icon.png' }]
    })
    expect(chooser.link?.favicon ?? null).toBeNull()
    expect(typeof chooser.link?.copied).toBe('string')
  })

  it("titles a link without a subject by its host, as the link menu's header does", () => {
    const f = fixture([sketch])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    expect(f.chooser().link?.title).toBe('news.example')
  })

  it('offers shared text to the apps that take text, the search as the house route', () => {
    const f = fixture([sketch, notes])
    f.browser.openSharedIntent({ kind: 'send', text: 'first line\nsecond line' })
    const chooser = f.chooser()
    expect(chooser.kind).toBe('text')
    expect(chooser.link).toBeNull()
    expect(chooser.text).toBe('first line')
    expect(chooser.apps.map((a) => a.name)).toEqual(['Sketch', 'Notes'])
    // An app with no icon kept is offered without one (the row draws its letter tile).
    expect(chooser.apps[1].icon).toBeNull()
  })

  it("the house row takes the direct route: a tab for the link, the user's engine for text", () => {
    const f = fixture([sketch])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    pick(f, f.chooser().requestId, null)
    expect(loads(f)).toContain(LINK)

    f.browser.openSharedIntent({ kind: 'send', text: 'cats' })
    pick(f, f.chooser().requestId, null)
    expect(loads(f).some((u) => u.includes('cats'))).toBe(true)
  })

  it("an app's row launches its GET target with the share under the app's own field names", () => {
    const f = fixture([sketch])
    f.browser.openSharedIntent({ kind: 'send', text: `Read this ${LINK}`, subject: 'A story' })
    pick(f, f.chooser().requestId, 'https://app.example/')
    const launched = loads(f).find((u) => u.startsWith('https://app.example/share?'))
    expect(launched).toBeDefined()
    const u = new URL(launched!)
    expect(u.searchParams.get('link')).toBe(LINK)
    expect(u.searchParams.get('subject')).toBe('A story')
    expect(u.searchParams.get('body')).toBe(`Read this ${LINK}`)
    // The link itself did not open as a page of its own.
    expect(loads(f)).not.toContain(LINK)
  })

  it("an app's POST target is launched as a post of the action with the fields as its body", () => {
    const poster = pinned(
      'https://post.example/',
      'Poster',
      target({ url: 'u', text: 't' }, { method: 'POST', action: 'https://post.example/receive' })
    )
    const f = fixture([poster])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    pick(f, f.chooser().requestId, 'https://post.example/')
    const posts = f.views.flatMap((v) => v.posts)
    expect(posts).toEqual([
      {
        url: 'https://post.example/receive',
        post: {
          encoding: 'urlencoded',
          fields: [
            { name: 't', value: LINK },
            { name: 'u', value: LINK }
          ]
        }
      }
    ])
  })

  it('launchShare of an app whose target takes none of the share does nothing and says so', () => {
    const f = fixture([sketch, notes])
    const before = loads(f).length
    const share = { title: null, text: LINK, url: LINK }
    // Notes takes text alone: a link handed to it is refused – the chooser never offers it one,
    // so this is the guard's word, not a route.
    expect(f.browser.webApps.launchShare(notes.id, share)).toBe(false)
    // An id that is no installed app's, likewise.
    expect(f.browser.webApps.launchShare('https://nowhere.example/', share)).toBe(false)
    expect(loads(f).length).toBe(before)
    expect(f.views.flatMap((v) => v.posts)).toEqual([])
    // Sketch takes a URL: the same share is launched, the link under its field name.
    expect(f.browser.webApps.launchShare(sketch.id, share)).toBe(true)
    const launched = new URL(loads(f).at(-1)!)
    expect(launched.origin + launched.pathname).toBe('https://app.example/share')
    expect(launched.searchParams.get('link')).toBe(LINK)
  })

  it('a dismissal drops the share; a pick of a chooser no longer standing is nothing', () => {
    const f = fixture([sketch])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    const { requestId } = f.chooser()
    const before = loads(f).length
    cancel(f, requestId)
    pick(f, requestId, null)
    expect(loads(f).length).toBe(before)
    expect(loads(f)).not.toContain(LINK)
  })
})

describe('the chooser in the snapshot state (a cold start has no listener yet)', () => {
  const sketch = pinned(
    'https://app.example/',
    'Sketch',
    target({ title: 'subject', text: 'body', url: 'link' })
  )
  const notes = pinned('https://notes.example/', 'Notes', target({ text: 'note' }), null)

  it('a chooser opened with nothing listening is in the next snapshot, and stays there until it is answered', async () => {
    const f = fixture([sketch])
    // The share lands the way a cold start's does: before any chrome exists to hear an event.
    // Nothing was sent to the window that names the chooser – there is no such event.
    f.browser.openSharedIntent({ kind: 'send', text: LINK, subject: 'A story' })
    expect(f.sent.map((e) => e.name)).not.toContain('share.chooser')
    const chooser = f.standing()
    expect(chooser).toMatchObject({ kind: 'url', link: { url: LINK, title: 'A story' } })
    // The state the window is handed – `app.getState`'s answer at mount, the broadcast the
    // commit sends – carries it, and keeps carrying it across later snapshots.
    await tick()
    const broadcast = f.sent.filter((e) => e.name === 'state').at(-1)
    expect(broadcast).toBeDefined()
    expect((broadcast!.payload as { shareChooser: ShareChooser | null }).shareChooser).toEqual(
      chooser
    )
    expect(f.standing()).toEqual(chooser)
  })

  it('the pick clears the field (the house route runs); the cancel clears it (nothing runs)', () => {
    const f = fixture([sketch])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    pick(f, f.chooser().requestId, null)
    expect(f.standing()).toBeNull()
    expect(loads(f)).toContain(LINK)

    f.browser.openSharedIntent({ kind: 'send', text: 'https://other.example/' })
    const before = loads(f).length
    cancel(f, f.chooser().requestId)
    expect(f.standing()).toBeNull()
    expect(loads(f).length).toBe(before)

    // An app's pick clears it too, the launch in its place.
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    pick(f, f.chooser().requestId, 'https://app.example/')
    expect(f.standing()).toBeNull()
    expect(loads(f).at(-1)).toMatch(/^https:\/\/app\.example\/share\?/)
  })

  it('a newer share replaces the standing chooser in the state; one going directly clears it', () => {
    const f = fixture([sketch, notes])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    const first = f.chooser()
    // A second link: the newer share's chooser stands in the field; the first's pick is void.
    f.browser.openSharedIntent({ kind: 'send', text: 'https://other.example/' })
    const second = f.chooser()
    expect(second.requestId).not.toBe(first.requestId)
    expect(second.link?.url).toBe('https://other.example/')
    pick(f, first.requestId, null)
    expect(f.standing()).toEqual(second)
    expect(loads(f)).not.toContain(LINK)
    // An image share has no app for it: it goes its own way and the field is cleared – no
    // event says so, the snapshot does.
    f.browser.openSharedIntent({
      kind: 'send',
      mimeType: 'image/png',
      imageDataUrl: 'data:image/png;base64,AA=='
    })
    expect(f.standing()).toBeNull()
    expect(f.sent.map((e) => e.name)).not.toContain('share.chooserHide')
    // The overtaken share's pick, arriving late, is nothing.
    pick(f, second.requestId, null)
    expect(loads(f)).not.toContain('https://other.example/')
  })
})
