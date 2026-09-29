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
 * raises the chooser (`share.chooser`), the house route first and the apps under "Apps", and
 * routes on the pick: the house row as before, an app's row as its target's launch.
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
  choosers: () => ShareChooser[]
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
  return {
    browser,
    views,
    sent,
    choosers: () =>
      sent.filter((e) => e.name === 'share.chooser').map((e) => e.payload as ShareChooser)
  }
}

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
    expect(f.choosers()).toEqual([])
  })

  it('does not offer a link to an app whose target takes text alone', () => {
    const f = fixture([pinned('https://notes.example/', 'Notes', target({ text: 'body' }))])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    expect(f.choosers()).toEqual([])
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
    const [chooser] = f.choosers()
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
    expect(f.choosers()[0].link?.title).toBe('news.example')
  })

  it('offers shared text to the apps that take text, the search as the house route', () => {
    const f = fixture([sketch, notes])
    f.browser.openSharedIntent({ kind: 'send', text: 'first line\nsecond line' })
    const [chooser] = f.choosers()
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
    const [chooser] = f.choosers()
    f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserPick', {
      requestId: chooser.requestId,
      appId: null
    })
    expect(loads(f)).toContain(LINK)

    f.browser.openSharedIntent({ kind: 'send', text: 'cats' })
    const [, second] = f.choosers()
    f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserPick', {
      requestId: second.requestId,
      appId: null
    })
    expect(loads(f).some((u) => u.includes('cats'))).toBe(true)
  })

  it("an app's row launches its GET target with the share under the app's own field names", () => {
    const f = fixture([sketch])
    f.browser.openSharedIntent({ kind: 'send', text: `Read this ${LINK}`, subject: 'A story' })
    const [chooser] = f.choosers()
    f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserPick', {
      requestId: chooser.requestId,
      appId: 'https://app.example/'
    })
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
    const [chooser] = f.choosers()
    f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserPick', {
      requestId: chooser.requestId,
      appId: 'https://post.example/'
    })
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

  it('a dismissal drops the share; a pick of a chooser no longer standing is nothing', () => {
    const f = fixture([sketch])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    const [chooser] = f.choosers()
    const before = loads(f).length
    f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserCancel', {
      requestId: chooser.requestId
    })
    f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserPick', {
      requestId: chooser.requestId,
      appId: null
    })
    expect(loads(f).length).toBe(before)
    expect(loads(f)).not.toContain(LINK)
  })

  it('a newer share takes a standing chooser over; one that goes directly takes it down', () => {
    const f = fixture([sketch, notes])
    f.browser.openSharedIntent({ kind: 'send', text: LINK })
    const [first] = f.choosers()
    // A second link: a new chooser stands; the first's pick is void.
    f.browser.openSharedIntent({ kind: 'send', text: 'https://other.example/' })
    const [, second] = f.choosers()
    expect(second.requestId).not.toBe(first.requestId)
    f.browser.handleCommand(f.browser.focusedWindow(), 'share.chooserPick', {
      requestId: first.requestId,
      appId: null
    })
    expect(loads(f)).not.toContain(LINK)
    // An image share has no app for it: it goes its own way and the chooser is taken down.
    f.browser.openSharedIntent({
      kind: 'send',
      mimeType: 'image/png',
      imageDataUrl: 'data:image/png;base64,AA=='
    })
    expect(f.sent.filter((e) => e.name === 'share.chooserHide').map((e) => e.payload)).toEqual([
      { requestId: second.requestId }
    ])
  })
})
