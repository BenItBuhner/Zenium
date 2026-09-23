import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_LIVE_PER_ORIGIN,
  WebNotificationService,
  asksQuietly,
  quietNotificationPrompt
} from '../webNotifications'
import type { Browser } from '../browser'
import type { PageHostMessage, WebNotificationRequest } from '../platform'
import type { NotificationPageRequest } from '../../shared/notifications'
import type { PermissionPrompt, PermissionPromptAnswer } from '../../shared/types'

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
  /** The chrome's prompt queue: the quiet prompts `show` put there, answered by `answer`. */
  prompts: PermissionPrompt[]
  answer(id: string, answer: PermissionPromptAnswer | null): void
  /** What the harness's `decide` answers a loud prompt with (Allow by default). */
  loudAnswer: PermissionPromptAnswer | null
  remembered: Array<{ permission: string; url: string; decision: string }>
}

function harness(options: { host?: boolean } = {}): Harness {
  const views = new Map<string, FakeView>()
  const decisions = new Map<string, Decision>()
  const listeners: Harness['listeners'] = []
  const privateTabs = new Set<string>()
  const answered: Array<(prompt: PermissionPrompt, answer: PermissionPromptAnswer | null) => void> =
    []
  const pending = new Map<string, (answer: PermissionPromptAnswer | null) => void>()
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
    decideCalls: [] as Array<{ permission: string; url: string }>,
    prompts: [] as PermissionPrompt[],
    loudAnswer: 'allow' as PermissionPromptAnswer | null,
    remembered: [] as Array<{ permission: string; url: string; decision: string }>,
    answer: (id: string, answer: PermissionPromptAnswer | null): void => {
      const i = h.prompts.findIndex((p) => p.id === id)
      if (i < 0) return
      const [prompt] = h.prompts.splice(i, 1)
      pending.get(id)?.(answer)
      pending.delete(id)
      for (const listener of answered) listener(prompt!, answer)
    }
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
      decide: async (permission: string, url: string, details?: { tabId?: string }) => {
        h.decideCalls.push({ permission, url })
        const decision = decisions.get(`${permission}|${originOf(url)}`) ?? 'ask'
        if (decision === 'ask') {
          // The prompt: this harness answers as `loudAnswer` says (Allow by default, remembered,
          // like the user tapping Allow) and tells the prompts' listeners, as the core does.
          const prompt: PermissionPrompt = {
            id: `loud-${h.decideCalls.length}`,
            tabId: details?.tabId ?? null,
            origin: originOf(url),
            permission,
            message: '',
            detail: '',
            allowLabel: 'Allow',
            blockLabel: 'Block',
            allowOnce: false,
            requestedAt: 0
          }
          const answer = h.loudAnswer
          if (answer === 'allow') decisions.set(`${permission}|${originOf(url)}`, 'allow')
          if (answer === 'block') decisions.set(`${permission}|${originOf(url)}`, 'deny')
          for (const listener of answered) listener(prompt, answer)
          return answer === 'allow'
        }
        return decision === 'allow'
      },
      remember: (permission: string, url: string, decision: 'allow' | 'deny') => {
        h.remembered.push({ permission, url, decision })
        decisions.set(`${permission}|${originOf(url)}`, decision)
      }
    },
    permissionPrompts: {
      show: (prompt: PermissionPrompt) =>
        new Promise<PermissionPromptAnswer | null>((resolve) => {
          h.prompts.push(prompt)
          pending.set(prompt.id, resolve)
        }),
      onAnswered: (
        listener: (prompt: PermissionPrompt, answer: PermissionPromptAnswer | null) => void
      ) => {
        answered.push(listener)
        return () => undefined
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

  describe('the quiet ask (NOT-03)', () => {
    const lastPosted = (tabId: string): PageHostMessage | undefined =>
      h.views.get(tabId)!.posted.at(-1)

    it('asks quietly for a request without a gesture: a quiet prompt in the queue, no sheet through decide', async () => {
      h.service.handle('t1', { notification: 'request', id: 'q1', gesture: false })
      await flush()
      expect(h.decideCalls).toEqual([])
      expect(h.prompts).toHaveLength(1)
      const prompt = h.prompts[0]!
      expect(prompt).toMatchObject({
        tabId: 't1',
        origin: 'https://site.example',
        permission: 'notifications',
        quiet: true,
        allowOnce: false,
        message: 'Notifications blocked',
        detail: 'You usually block notifications. To let site.example notify you, tap Allow.',
        allowLabel: 'Allow',
        blockLabel: 'Keep blocking'
      })
      // The page waits: its promise settles with the answer.
      expect(h.views.get('t1')!.posted.filter((m) => m.type === 'notification')).toEqual([])

      h.answer(prompt.id, 'allow')
      await flush()
      expect(h.remembered).toEqual([
        { permission: 'notifications', url: 'https://site.example/page', decision: 'allow' }
      ])
      expect(h.ensured).toBe(1)
      expect(lastPosted('t1')).toEqual({
        type: 'notification',
        action: 'result',
        status: 'granted',
        id: 'q1'
      })
    })

    it('Keep blocking remembers a block; a withdrawn quiet prompt remembers nothing and reads default', async () => {
      h.service.handle('t1', { notification: 'request', id: 'q1', gesture: false })
      await flush()
      h.answer(h.prompts[0]!.id, 'block')
      await flush()
      expect(h.remembered).toEqual([
        { permission: 'notifications', url: 'https://site.example/page', decision: 'deny' }
      ])
      expect(h.ensured).toBe(0)
      expect(lastPosted('t1')).toMatchObject({ action: 'result', status: 'denied', id: 'q1' })

      h.service.handle('t2', { notification: 'request', id: 'q2', gesture: false })
      await flush()
      h.answer(h.prompts[0]!.id, null)
      await flush()
      expect(h.remembered).toHaveLength(1)
      expect(lastPosted('t2')).toMatchObject({ action: 'result', status: 'default', id: 'q2' })
    })

    it('a gestured request asks loudly the first time and quietly once its prompt was dismissed', async () => {
      h.loudAnswer = 'dismiss'
      h.service.handle('t1', { notification: 'request', id: 'r1', gesture: true })
      await flush()
      expect(h.decideCalls).toHaveLength(1)
      expect(h.prompts).toEqual([])
      expect(lastPosted('t1')).toMatchObject({ action: 'result', status: 'default', id: 'r1' })
      expect(h.service.dismissedBefore('https://site.example/other')).toBe(true)
      expect(h.service.dismissedBefore('https://other.example/')).toBe(false)

      // The same site, asked again with a gesture: the bell, not the sheet.
      h.service.handle('t1', { notification: 'request', id: 'r2', gesture: true })
      await flush()
      expect(h.decideCalls).toHaveLength(1)
      expect(h.prompts).toHaveLength(1)
      expect(h.prompts[0]!.quiet).toBe(true)
      // Another site is not marked by it.
      h.service.handle('t2', { notification: 'request', id: 'r3', gesture: true })
      await flush()
      expect(h.decideCalls).toHaveLength(2)
    })

    it('a loud prompt answered Allow or Block closes the site’s question: no quiet mark', async () => {
      h.loudAnswer = 'dismiss'
      h.service.handle('t1', { notification: 'request', id: 'r1', gesture: true })
      await flush()
      expect(h.service.dismissedBefore('https://site.example/')).toBe(true)
      h.loudAnswer = 'block'
      // The answer arrives through the prompts' listener, as the core's does.
      h.decisions.delete('notifications|https://site.example')
      h.service.handle('t1', { notification: 'request', id: 'r2', gesture: true })
      await flush()
      // Dismissed before: this one went quietly; answering the loud path is simulated directly.
      expect(h.prompts).toHaveLength(1)
      h.answer(h.prompts[0]!.id, 'block')
      await flush()
      expect(h.service.dismissedBefore('https://site.example/')).toBe(false)
    })

    it('a request without the gesture word (an older page script) asks loudly', async () => {
      h.service.handle('t1', { notification: 'request', id: 'r1' })
      await flush()
      expect(h.decideCalls).toHaveLength(1)
      expect(h.prompts).toEqual([])
    })

    it('a site with an answer never asks quietly: allowed reads granted, blocked reads denied', async () => {
      h.decisions.set('notifications|https://site.example', 'deny')
      h.service.handle('t1', { notification: 'request', id: 'r1', gesture: false })
      await flush()
      expect(h.prompts).toEqual([])
      expect(h.decideCalls).toHaveLength(1)
      expect(lastPosted('t1')).toMatchObject({ action: 'result', status: 'denied' })
    })

    it('two quiet requests from one tab share one bell and its answer', async () => {
      h.service.handle('t1', { notification: 'request', id: 'a', gesture: false })
      h.service.handle('t1', { notification: 'request', id: 'b', gesture: false })
      await flush()
      expect(h.prompts).toHaveLength(1)
      h.answer(h.prompts[0]!.id, 'allow')
      await flush()
      const results = h.views
        .get('t1')!
        .posted.filter((m) => m.type === 'notification' && m.action === 'result')
      expect(results.map((m) => (m as { id?: string }).id).sort()).toEqual(['a', 'b'])
      expect(h.remembered).toHaveLength(1)
    })

    it('the quiet rule and the quiet prompt are pure', () => {
      expect(asksQuietly(false, false)).toBe(true)
      expect(asksQuietly(true, true)).toBe(true)
      expect(asksQuietly(undefined, false)).toBe(false)
      expect(asksQuietly(true, false)).toBe(false)
      const prompt = quietNotificationPrompt('t9', 'https://news.example:8443', 42)
      expect(prompt.quiet).toBe(true)
      expect(prompt.requestedAt).toBe(42)
      expect(prompt.detail).toContain('news.example:8443')
      expect(prompt.id).not.toBe(quietNotificationPrompt('t9', 'https://news.example', 42).id)
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
