import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_LIVE_PER_ORIGIN, WebNotificationService } from '../webNotifications'
import type { Browser } from '../browser'
import type { PageHostMessage, WebNotificationRequest } from '../platform'
import type { NotificationPageRequest } from '../../shared/notifications'

type Decision = 'allow' | 'deny' | 'ask'

interface FakeView {
  url: string
  destroyed: boolean
  posted: PageHostMessage[]
  getURL(): string
  isDestroyed(): boolean
  postToPage(message: PageHostMessage): void
}

interface Harness {
  service: WebNotificationService
  views: Map<string, FakeView>
  decisions: Map<string, Decision>
  shown: WebNotificationRequest[]
  closed: string[]
  forgotten: string[]
  ensured: number
  revealed: string[]
  created: string[]
  hostShows: boolean
  listeners: Array<(change: { permission: string; origin: string | null }) => void>
  privateTabs: Set<string>
  addTab(tabId: string, url: string): FakeView
  closeTab(tabId: string): void
  decideCalls: Array<{ permission: string; url: string }>
}

function harness(options: { host?: boolean } = {}): Harness {
  const views = new Map<string, FakeView>()
  const decisions = new Map<string, Decision>()
  const listeners: Harness['listeners'] = []
  const privateTabs = new Set<string>()
  const h = {
    views,
    decisions,
    shown: [] as WebNotificationRequest[],
    closed: [] as string[],
    forgotten: [] as string[],
    ensured: 0,
    revealed: [] as string[],
    created: [] as string[],
    hostShows: true,
    listeners,
    privateTabs,
    decideCalls: [] as Array<{ permission: string; url: string }>
  }
  const originOf = (url: string): string => new URL(url).origin
  const host =
    options.host === false
      ? undefined
      : {
          show: async (request: WebNotificationRequest) => {
            h.shown.push(request)
            return h.hostShows
          },
          close: (id: string) => {
            h.closed.push(id)
          },
          forgetOrigin: (origin: string) => {
            h.forgotten.push(origin)
          },
          ensureAllowed: async () => {
            h.ensured++
            return true
          }
        }
  const browser = {
    platform: { webNotifications: host },
    permissions: {
      subscribe: (listener: (change: { permission: string; origin: string | null }) => void) => {
        listeners.push(listener)
        return () => undefined
      },
      resolve: (permission: string, url: string) =>
        decisions.get(`${permission}|${originOf(url)}`) ?? 'ask',
      decide: async (permission: string, url: string) => {
        h.decideCalls.push({ permission, url })
        const decision = decisions.get(`${permission}|${originOf(url)}`) ?? 'ask'
        if (decision === 'ask') {
          // The prompt: this harness answers allow and remembers it, like the user tapping Allow.
          decisions.set(`${permission}|${originOf(url)}`, 'allow')
          return true
        }
        return decision === 'allow'
      }
    },
    tabs: {
      tab: (id: string) => (views.has(id) ? { id } : undefined),
      view: (id: string) => views.get(id),
      allViews: () => views.entries(),
      isPrivate: (tab: { id: string }) => privateTabs.has(tab.id),
      createTab: (opts: { url: string }) => {
        h.created.push(opts.url)
        return { id: 'new' }
      }
    },
    revealTab: (tabId: string) => {
      h.revealed.push(tabId)
    },
    focusedWindow: () => ({ id: 'w1' })
  }
  const service = new WebNotificationService(browser as unknown as Browser)
  return Object.assign(h, {
    service,
    addTab: (tabId: string, url: string) => {
      const view: FakeView = {
        url,
        destroyed: false,
        posted: [],
        getURL: () => view.url,
        isDestroyed: () => view.destroyed,
        postToPage: (m) => view.posted.push(m)
      }
      views.set(tabId, view)
      return view
    },
    closeTab: (tabId: string) => {
      views.delete(tabId)
    }
  })
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function show(
  h: Harness,
  tabId: string,
  id: string,
  extra: Partial<NotificationPageRequest> = {}
): void {
  h.service.handle(tabId, { notification: 'show', id, title: 'Hello', body: 'World', ...extra })
}

describe('WebNotificationService', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
    h.addTab('t1', 'https://site.example/page')
    h.addTab('t2', 'https://other.example/')
  })

  it('answers Notification.permission from the shared permission model', () => {
    expect(h.service.status('t1', 'https://site.example/page')).toBe('default')
    h.decisions.set('notifications|https://site.example', 'allow')
    expect(h.service.status('t1', 'https://site.example/page')).toBe('granted')
    h.decisions.set('notifications|https://site.example', 'deny')
    expect(h.service.status('t1', 'https://site.example/page')).toBe('denied')
    h.service.handle('t1', { notification: 'query' })
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'status',
      status: 'denied'
    })
  })

  it('reads denied in a private tab, for a page that is not a site, and for an unknown tab', () => {
    h.privateTabs.add('t1')
    h.decisions.set('notifications|https://site.example', 'allow')
    expect(h.service.status('t1', 'https://site.example/page')).toBe('denied')
    expect(h.service.status('t2', 'zen://newtab')).toBe('denied')
    expect(h.service.status('nope', 'https://site.example/')).toBe('denied')
  })

  it('requestPermission prompts through the permission service, then secures the app-side right', async () => {
    h.service.handle('t1', { notification: 'request', id: 'req1' })
    await flush()
    expect(h.decideCalls).toEqual([
      { permission: 'notifications', url: 'https://site.example/page' }
    ])
    expect(h.ensured).toBe(1)
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'result',
      status: 'granted',
      id: 'req1'
    })
  })

  it('settles a private tab’s request as denied without a prompt', async () => {
    h.privateTabs.add('t1')
    h.service.handle('t1', { notification: 'request', id: 'r' })
    await flush()
    expect(h.decideCalls).toEqual([])
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'result',
      status: 'denied',
      id: 'r'
    })
  })

  it('shows an allowed site’s notification through the host under its origin and reports shown', async () => {
    h.decisions.set('notifications|https://site.example', 'allow')
    show(h, 't1', 'n1', {
      icon: 'https://site.example/icon.png',
      tag: 'chat',
      silent: true,
      renotify: true,
      timestamp: 1_700_000_000_000
    })
    await flush()
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]).toEqual({
      id: 't1/n1',
      origin: 'https://site.example',
      tabId: 't1',
      url: 'https://site.example/page',
      title: 'Hello',
      body: 'World',
      icon: 'https://site.example/icon.png',
      tag: 'chat',
      silent: true,
      requireInteraction: false,
      renotify: true,
      timestamp: 1_700_000_000_000
    })
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'shown',
      id: 'n1'
    })
    expect(h.service.liveCount).toBe(1)
  })

  it('refuses a notification the site was not granted, and one the host would not post', async () => {
    show(h, 't1', 'n1')
    await flush()
    expect(h.shown).toEqual([])
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'error',
      id: 'n1'
    })
    h.decisions.set('notifications|https://site.example', 'allow')
    h.hostShows = false
    show(h, 't1', 'n2')
    await flush()
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'error',
      id: 'n2'
    })
    expect(h.service.liveCount).toBe(0)
  })

  it('drops a data: or relative icon (the host fetches only web URLs) and caps the text', async () => {
    h.decisions.set('notifications|https://site.example', 'allow')
    show(h, 't1', 'n1', { icon: 'data:image/png;base64,AAAA', body: 'x'.repeat(5000) })
    await flush()
    expect(h.shown[0]!.icon).toBe('')
    expect(h.shown[0]!.body).toHaveLength(1024)
  })

  it('brings the tab forward on a tap and tells the page click; a swipe tells it close', async () => {
    h.decisions.set('notifications|https://site.example', 'allow')
    show(h, 't1', 'n1')
    await flush()
    h.service.onHostEvent('t1/n1', 'click')
    expect(h.revealed).toEqual(['t1'])
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'click',
      id: 'n1'
    })
    expect(h.service.liveCount).toBe(0)
    show(h, 't1', 'n2')
    await flush()
    h.service.onHostEvent('t1/n2', 'close')
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'close',
      id: 'n2'
    })
    expect(h.revealed).toEqual(['t1'])
  })

  it('opens the page again when the tab is gone at the tap, or the notification outlived the core', async () => {
    h.decisions.set('notifications|https://site.example', 'allow')
    show(h, 't1', 'n1')
    await flush()
    h.closeTab('t1')
    h.service.onHostEvent('t1/n1', 'click')
    expect(h.created).toEqual(['https://site.example/page'])
    h.service.onHostEvent('gone/x', 'click', 'https://elsewhere.example/a')
    expect(h.created).toEqual(['https://site.example/page', 'https://elsewhere.example/a'])
    // Not a web page: nothing opens.
    h.service.onHostEvent('gone/y', 'click', 'javascript:alert(1)')
    expect(h.created).toHaveLength(2)
  })

  it('forgets a notification a later one replaced without a word to the page', async () => {
    h.decisions.set('notifications|https://site.example', 'allow')
    show(h, 't1', 'n1', { tag: 't' })
    show(h, 't1', 'n2', { tag: 't' })
    await flush()
    expect(h.service.liveCount).toBe(2)
    const posted = h.views.get('t1')!.posted.length
    h.service.onHostEvent('t1/n1', 'replaced')
    expect(h.service.liveCount).toBe(1)
    expect(h.views.get('t1')!.posted.length).toBe(posted)
  })

  it('closes through the host on the page’s close()', async () => {
    h.decisions.set('notifications|https://site.example', 'allow')
    show(h, 't1', 'n1')
    await flush()
    h.service.handle('t1', { notification: 'close', id: 'n1' })
    expect(h.closed).toEqual(['t1/n1'])
    expect(h.service.liveCount).toBe(0)
    // Closing again, or one never shown, is nothing.
    h.service.handle('t1', { notification: 'close', id: 'n1' })
    expect(h.closed).toEqual(['t1/n1'])
  })

  it('keeps a site to its cap, closing the oldest through the host', async () => {
    h.decisions.set('notifications|https://site.example', 'allow')
    for (let i = 0; i <= MAX_LIVE_PER_ORIGIN; i++) show(h, 't1', `n${i}`)
    await flush()
    expect(h.closed).toEqual(['t1/n0'])
    expect(h.service.liveCount).toBe(MAX_LIVE_PER_ORIGIN)
  })

  it('withdraws a site’s notifications and channel when its permission goes, and tells its pages', async () => {
    h.decisions.set('notifications|https://site.example', 'allow')
    h.decisions.set('notifications|https://other.example', 'allow')
    show(h, 't1', 'n1')
    show(h, 't2', 'm1')
    await flush()
    h.decisions.set('notifications|https://site.example', 'deny')
    for (const listener of h.listeners)
      listener({ permission: 'notifications', origin: 'https://site.example' })
    expect(h.forgotten).toEqual(['https://site.example'])
    expect(h.service.liveCount).toBe(1)
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'status',
      status: 'denied'
    })
    // The other site's page heard nothing new.
    expect(h.views.get('t2')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'shown',
      id: 'm1'
    })
    // Another permission's change is not this service's business.
    const before = h.forgotten.length
    for (const listener of h.listeners)
      listener({ permission: 'camera', origin: 'https://other.example' })
    expect(h.forgotten.length).toBe(before)
  })

  it('a default changing (origin null) refreshes every page’s status', () => {
    for (const listener of h.listeners) listener({ permission: 'notifications', origin: null })
    expect(h.views.get('t1')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'status',
      status: 'default'
    })
    expect(h.views.get('t2')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'status',
      status: 'default'
    })
    expect(h.forgotten).toEqual([])
  })

  it('ignores malformed page requests and requests from unknown tabs', async () => {
    h.service.handle('t1', null as unknown as NotificationPageRequest)
    h.service.handle('t1', { notification: 42 } as unknown as NotificationPageRequest)
    h.service.handle('nope', { notification: 'query' })
    h.decisions.set('notifications|https://site.example', 'allow')
    h.service.handle('t1', { notification: 'show' })
    await flush()
    expect(h.shown).toEqual([])
    expect(h.views.get('t1')!.posted).toEqual([])
  })

  it('is inert on a host without web notifications (desktop): a show answers error', async () => {
    const plain = harness({ host: false })
    plain.addTab('a', 'https://a.example/')
    plain.decisions.set('notifications|https://a.example', 'allow')
    show(plain, 'a', 'n')
    await flush()
    expect(plain.views.get('a')!.posted.at(-1)).toEqual({
      type: 'notification',
      action: 'error',
      id: 'n'
    })
  })
})
