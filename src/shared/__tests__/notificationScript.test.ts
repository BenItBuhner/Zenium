// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNotificationPolyfill } from '../notificationScript'
import {
  MAX_NOTIFICATION_TEXT,
  type NotificationHostMessage,
  type NotificationPageRequest,
  type NotificationPermissionStatus
} from '../notifications'
import type { PageScriptMessage } from '../pageScript'

interface PageNotification extends EventTarget {
  readonly title: string
  readonly body: string
  readonly icon: string
  readonly image: string
  readonly badge: string
  readonly tag: string
  readonly dir: string
  readonly lang: string
  readonly data: unknown
  readonly silent: boolean | null
  readonly requireInteraction: boolean
  readonly renotify: boolean
  readonly timestamp: number
  readonly vibrate: ReadonlyArray<number>
  readonly actions: ReadonlyArray<never>
  onclick: ((ev: Event) => unknown) | null
  onshow: ((ev: Event) => unknown) | null
  onerror: ((ev: Event) => unknown) | null
  onclose: ((ev: Event) => unknown) | null
  close(): void
}

interface PageNotificationCtor {
  new (title?: unknown, options?: unknown): PageNotification
  readonly permission: NotificationPermissionStatus
  readonly maxActions: number
  requestPermission(
    callback?: (status: NotificationPermissionStatus) => void
  ): Promise<NotificationPermissionStatus>
}

interface Harness {
  sent: PageScriptMessage[]
  requests(): NotificationPageRequest[]
  lastRequest(): NotificationPageRequest
  host(message: Omit<NotificationHostMessage, 'type'>): void
  Notification: PageNotificationCtor
}

const w = window as unknown as { Notification?: unknown }

function install(): Harness {
  const sent: PageScriptMessage[] = []
  let listener: ((message: NotificationHostMessage) => void) | null = null
  installNotificationPolyfill({
    send: (message) => sent.push(message),
    onNotification: (l) => {
      listener = l
    }
  })
  const requests = (): NotificationPageRequest[] =>
    sent
      .filter((m) => m.type === 'notification')
      .map((m) => m.notification as NotificationPageRequest)
  return {
    sent,
    requests,
    lastRequest: () => {
      const all = requests()
      expect(all.length).toBeGreaterThan(0)
      return all[all.length - 1]
    },
    host: (message) => listener?.({ type: 'notification', ...message }),
    Notification: w.Notification as PageNotificationCtor
  }
}

/** Install and let the browser answer the status query with `status`. */
function installWith(status: NotificationPermissionStatus): Harness {
  const h = install()
  h.host({ action: 'status', status })
  return h
}

const events = (n: PageNotification): string[] => {
  const seen: string[] = []
  for (const type of ['show', 'click', 'close', 'error'])
    n.addEventListener(type, () => seen.push(type))
  return seen
}

beforeEach(() => {
  vi.useFakeTimers()
  delete w.Notification
})

afterEach(() => {
  vi.useRealTimers()
  delete w.Notification
})

describe('installNotificationPolyfill: the static side', () => {
  it('defines window.Notification and asks the browser for the status', () => {
    const h = install()
    expect(typeof w.Notification).toBe('function')
    expect((w.Notification as { name: string }).name).toBe('Notification')
    expect(h.requests()).toEqual([{ notification: 'query' }])
    expect(h.Notification.permission).toBe('default')
    expect(h.Notification.maxActions).toBe(0)
  })

  it('stays out of the way when the engine has a Notification of its own', () => {
    const native = class {}
    w.Notification = native
    const sent: PageScriptMessage[] = []
    installNotificationPolyfill({ send: (m) => sent.push(m), onNotification: () => undefined })
    expect(w.Notification).toBe(native)
    expect(sent).toEqual([])
  })

  it('permission follows what the browser says, ignoring anything else', () => {
    const h = install()
    h.host({ action: 'status', status: 'granted' })
    expect(h.Notification.permission).toBe('granted')
    h.host({ action: 'status', status: 'denied' })
    expect(h.Notification.permission).toBe('denied')
    h.host({ action: 'status', status: 'weird' as NotificationPermissionStatus })
    expect(h.Notification.permission).toBe('denied')
  })

  it('requestPermission posts a request and settles on the answer, callback included', async () => {
    const h = installWith('default')
    const callback = vi.fn()
    const promise = h.Notification.requestPermission(callback)
    const request = h.lastRequest()
    expect(request.notification).toBe('request')
    expect(typeof request.id).toBe('string')
    h.host({ action: 'result', status: 'granted', id: request.id })
    await expect(promise).resolves.toBe('granted')
    expect(callback).toHaveBeenCalledWith('granted')
    expect(h.Notification.permission).toBe('granted')
  })

  it('two requests in flight settle separately by id', async () => {
    const h = installWith('default')
    const first = h.Notification.requestPermission()
    const firstId = h.lastRequest().id
    const second = h.Notification.requestPermission()
    const secondId = h.lastRequest().id
    expect(firstId).not.toBe(secondId)
    h.host({ action: 'result', status: 'denied', id: secondId })
    await expect(second).resolves.toBe('denied')
    h.host({ action: 'result', status: 'denied', id: firstId })
    await expect(first).resolves.toBe('denied')
  })

  it('a throwing callback still settles the promise', async () => {
    const h = installWith('default')
    const promise = h.Notification.requestPermission(() => {
      throw new Error('page bug')
    })
    h.host({ action: 'result', status: 'granted', id: h.lastRequest().id })
    await expect(promise).resolves.toBe('granted')
  })

  it('requestPermission rejects a non-function callback like Chrome', async () => {
    const h = installWith('default')
    await expect(h.Notification.requestPermission('nope' as unknown as () => void)).rejects.toThrow(
      TypeError
    )
  })
})

describe('constructing a notification', () => {
  it('posts title, body, resolved icon and options to the browser when granted', () => {
    const h = installWith('granted')
    const n = new h.Notification('Hello', {
      body: 'World',
      icon: '/icon.png',
      tag: 'greeting',
      silent: true,
      requireInteraction: true,
      renotify: true,
      timestamp: 1700000000000,
      data: { a: 1 },
      dir: 'rtl',
      lang: 'fr',
      badge: 'badge.png',
      vibrate: [100, 50]
    } as NotificationOptions)
    expect(h.lastRequest()).toEqual({
      notification: 'show',
      id: expect.any(String),
      title: 'Hello',
      body: 'World',
      icon: 'http://localhost:3000/icon.png',
      tag: 'greeting',
      silent: true,
      requireInteraction: true,
      renotify: true,
      timestamp: 1700000000000
    })
    expect(n.title).toBe('Hello')
    expect(n.body).toBe('World')
    expect(n.icon).toBe('http://localhost:3000/icon.png')
    expect(n.badge).toBe('http://localhost:3000/badge.png')
    expect(n.image).toBe('')
    expect(n.tag).toBe('greeting')
    expect(n.dir).toBe('rtl')
    expect(n.lang).toBe('fr')
    expect(n.data).toEqual({ a: 1 })
    expect(n.silent).toBe(true)
    expect(n.vibrate).toEqual([100, 50])
    expect(n.actions).toEqual([])
    expect(Object.isFrozen(n.actions)).toBe(true)
  })

  it('defaults: empty texts, auto dir, null silent and data, a now timestamp', () => {
    vi.setSystemTime(1_700_000_123_456)
    const h = installWith('granted')
    const n = new h.Notification('Title')
    expect(n.body).toBe('')
    expect(n.icon).toBe('')
    expect(n.tag).toBe('')
    expect(n.dir).toBe('auto')
    expect(n.silent).toBeNull()
    expect(n.data).toBeNull()
    expect(n.requireInteraction).toBe(false)
    expect(n.renotify).toBe(false)
    expect(n.timestamp).toBe(1_700_000_123_456)
    expect(h.lastRequest()).toMatchObject({
      notification: 'show',
      silent: false,
      timestamp: n.timestamp
    })
  })

  it('coerces and truncates the texts, drops an unparseable icon', () => {
    const h = installWith('granted')
    const long = 'x'.repeat(MAX_NOTIFICATION_TEXT + 50)
    const n = new h.Notification(long, { body: 12345, icon: 'http://[bad' } as NotificationOptions)
    expect(n.title).toHaveLength(MAX_NOTIFICATION_TEXT)
    expect(n.body).toBe('12345')
    expect(n.icon).toBe('')
    expect(new h.Notification(undefined).title).toBe('')
  })

  it('throws like Chrome on a missing title, a non-object options bag and renotify without tag', () => {
    const h = installWith('granted')
    expect(() => new (h.Notification as unknown as new () => unknown)()).toThrow(
      /1 argument required/
    )
    expect(() => new h.Notification('T', 5)).toThrow(/not an object/)
    expect(() => new h.Notification('T', { renotify: true })).toThrow(/non-empty tag/)
    // Nothing reached the browser for the ones that threw.
    expect(h.requests().filter((r) => r.notification === 'show')).toEqual([])
  })

  it('without the permission a notification never shows: it errors on the next tick', () => {
    const h = installWith('default')
    const n = new h.Notification('Quiet')
    const seen = events(n)
    n.onerror = vi.fn()
    expect(h.requests().filter((r) => r.notification === 'show')).toEqual([])
    expect(seen).toEqual([])
    vi.runAllTimers()
    expect(seen).toEqual(['error'])
    // (happy-dom's EventTarget also calls `on*` itself, so only the fact of the call is checked.)
    expect(n.onerror).toHaveBeenCalled()
    // Its close() has nothing to tell the browser.
    n.close()
    expect(h.requests().filter((r) => r.notification === 'close')).toEqual([])
  })

  it('a denied site gets the same error', () => {
    const h = installWith('denied')
    const n = new h.Notification('Blocked')
    const seen = events(n)
    vi.runAllTimers()
    expect(seen).toEqual(['error'])
  })
})

describe('the life of a shown notification', () => {
  it('show, click (which closes it on Android), and the on* handlers', () => {
    const h = installWith('granted')
    const n = new h.Notification('Tap me')
    const id = h.lastRequest().id
    const seen = events(n)
    const onclick = vi.fn()
    const onshow = vi.fn()
    const onclose = vi.fn()
    n.onclick = onclick
    n.onshow = onshow
    n.onclose = onclose
    h.host({ action: 'shown', id })
    expect(seen).toEqual(['show'])
    // The `on*` handlers run with the notification as `this` (exact counts are checked through
    // the listeners above: happy-dom's EventTarget calls `on*` itself as well, a browser does not).
    expect(onshow).toHaveBeenCalled()
    expect(onshow.mock.contexts[0]).toBe(n)
    h.host({ action: 'click', id })
    expect(seen).toEqual(['show', 'click', 'close'])
    expect(onclick).toHaveBeenCalled()
    expect(onclose).toHaveBeenCalled()
    // Closed by the tap: a later close() posts nothing and fires nothing more.
    n.close()
    expect(seen).toEqual(['show', 'click', 'close'])
    expect(h.requests().filter((r) => r.notification === 'close')).toEqual([])
  })

  it('a swipe on the shade closes it once', () => {
    const h = installWith('granted')
    const n = new h.Notification('Swipe me')
    const id = h.lastRequest().id
    const seen = events(n)
    h.host({ action: 'close', id })
    h.host({ action: 'close', id })
    h.host({ action: 'click', id })
    expect(seen).toEqual(['close'])
  })

  it('close() from the page tells the browser and fires close once', () => {
    const h = installWith('granted')
    const n = new h.Notification('Bye')
    const id = h.lastRequest().id
    const seen = events(n)
    n.close()
    n.close()
    expect(h.lastRequest()).toEqual({ notification: 'close', id })
    expect(h.requests().filter((r) => r.notification === 'close')).toHaveLength(1)
    expect(seen).toEqual(['close'])
    // Gone from the live set: a late shade event finds nothing.
    h.host({ action: 'click', id })
    expect(seen).toEqual(['close'])
  })

  it('an error from the browser (the shade refused it) fires error and forgets it', () => {
    const h = installWith('granted')
    const n = new h.Notification('Refused')
    const id = h.lastRequest().id
    const seen = events(n)
    h.host({ action: 'error', id })
    expect(seen).toEqual(['error'])
    h.host({ action: 'close', id })
    expect(seen).toEqual(['error'])
  })

  it('events for an unknown id are ignored', () => {
    const h = installWith('granted')
    const n = new h.Notification('Mine')
    const seen = events(n)
    h.host({ action: 'click', id: 'someone-else' })
    h.host({ action: 'shown' })
    expect(seen).toEqual([])
  })

  it('every notification gets its own id', () => {
    const h = installWith('granted')
    new h.Notification('A')
    const a = h.lastRequest().id
    new h.Notification('B')
    const b = h.lastRequest().id
    expect(a).not.toBe(b)
  })
})
