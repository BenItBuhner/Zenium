import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RELAYS,
  NotificationRequestRelay,
  RELAY_WAIT_MS,
  RELAY_WINDOW_MS,
  decideNotificationRequest,
  relayedFrom
} from '../notificationRequests'
import type { Browser } from '../../../core/browser'
import { PermissionPromptService } from '../../../core/permissionPrompts'
import {
  PermissionService,
  permissionSite,
  type PermissionRequestDetails
} from '../../../core/permissions'
import type { StoreIO } from '../../../core/platform'
import { WebNotificationService } from '../../../core/webNotifications'
import type { PermissionPrompt } from '../../../shared/types'

function fakeIo(): StoreIO {
  return { readSync: () => null, write: async () => undefined, writeSync: () => undefined }
}

const PAGE = 'https://news.example/today'
const SITE = 'https://news.example'
const TAB = 'tab-1'
const PAGE_ID = 7

/**
 * The desktop's permission request handler, in miniature: the real permission service, the
 * real prompt queue and the real notification service (the core's one rule), and the relay in
 * front of them as `attachPermissions` puts it. `request` raises the engine's request the way
 * the handler does; `relay.note` is the page bridge's word ahead of it.
 */
interface Desk {
  permissions: PermissionService
  prompts: PermissionPromptService
  relay: NotificationRequestRelay
  clock: { now: number }
  request(options?: {
    /** The page bridge's word; 'none' when no relay lands at all. */
    gesture?: boolean | 'none'
    url?: string
    isMainFrame?: boolean
    details?: Omit<PermissionRequestDetails, 'tabId'>
  }): Promise<boolean>
  /** The prompt the chrome shows for the tab right now, if any. */
  prompt(): PermissionPrompt | undefined
}

function desk(): Desk {
  const clock = { now: 0 }
  const prompts = new PermissionPromptService(() => undefined)
  const permissions = new PermissionService(fakeIo(), prompts, () => 1_000)
  const browser = {
    permissions,
    permissionPrompts: prompts,
    platform: { webNotifications: undefined },
    tabs: { allViews: () => [] }
  } as unknown as Browser
  const webNotifications = new WebNotificationService(browser)
  const relay = new NotificationRequestRelay(() => clock.now)
  return {
    permissions,
    prompts,
    relay,
    clock,
    request: ({ gesture = true, url = PAGE, isMainFrame = true, details = {} } = {}) => {
      if (gesture !== 'none')
        relay.note(PAGE_ID, { gesture, site: permissionSite(url), isMainFrame })
      return decideNotificationRequest(webNotifications, relay, PAGE_ID, TAB, url, isMainFrame, {
        tabId: TAB,
        ...details
      })
    },
    prompt: () => prompts.forTab(TAB)[0]
  }
}

/** Let the request reach the prompt queue (a few promise hops; no timer). */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

const isQuiet = (prompt: PermissionPrompt | undefined): boolean => prompt?.quiet === true

describe('the desktop’s notification request: the relayed gesture and the core’s one rule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a gestured first ask is the loud prompt; its Allow resolves the engine’s request and is remembered', async () => {
    const d = desk()
    const answer = d.request({ gesture: true })
    await settle()
    const prompt = d.prompt()
    expect(prompt?.permission).toBe('notifications')
    expect(prompt?.origin).toBe(SITE)
    expect(isQuiet(prompt)).toBe(false)
    d.prompts.respond(prompt!.id, 'allow')
    await expect(answer).resolves.toBe(true)
    expect(d.permissions.resolve('notifications', PAGE)).toBe('allow')
    // The next request has its answer: no prompt, whatever the bridge says.
    await expect(d.request({ gesture: false })).resolves.toBe(true)
    expect(d.prompt()).toBeUndefined()
  })

  it('an ask without a gesture is the quiet prompt – the bell – whose Allow resolves the request as the loud one’s does', async () => {
    const d = desk()
    const answer = d.request({ gesture: false })
    await settle()
    const prompt = d.prompt()
    expect(isQuiet(prompt)).toBe(true)
    expect(prompt?.message).toBe('Notifications blocked')
    expect(prompt?.blockLabel).toBe('Keep blocking')
    d.prompts.respond(prompt!.id, 'allow')
    await expect(answer).resolves.toBe(true)
    expect(d.permissions.resolve('notifications', PAGE)).toBe('allow')
  })

  it('a site dismissed before asks quietly, with a gesture or without', async () => {
    for (const gesture of [true, false]) {
      const d = desk()
      const first = d.request({ gesture: true })
      await settle()
      expect(isQuiet(d.prompt())).toBe(false)
      d.prompts.respond(d.prompt()!.id, 'dismiss')
      await expect(first).resolves.toBe(false)
      expect(d.permissions.resolve('notifications', PAGE)).toBe('ask')

      const second = d.request({ gesture })
      await settle()
      expect(isQuiet(d.prompt())).toBe(true)
      d.prompts.respond(d.prompt()!.id, 'allow')
      await expect(second).resolves.toBe(true)
    }
  })

  it('Keep blocking on the quiet prompt refuses the request and blocks the site', async () => {
    const d = desk()
    const answer = d.request({ gesture: false })
    await settle()
    d.prompts.respond(d.prompt()!.id, 'block')
    await expect(answer).resolves.toBe(false)
    expect(d.permissions.resolve('notifications', PAGE)).toBe('deny')
    await expect(d.request({ gesture: true })).resolves.toBe(false)
    expect(d.prompt()).toBeUndefined()
  })

  it('a quiet prompt withdrawn with its page refuses this once, remembers nothing and marks nothing', async () => {
    const d = desk()
    const answer = d.request({ gesture: false })
    await settle()
    expect(isQuiet(d.prompt())).toBe(true)
    d.prompts.cancelForTab(TAB)
    await expect(answer).resolves.toBe(false)
    expect(d.permissions.resolve('notifications', PAGE)).toBe('ask')
    // The withdrawal was not a dismissal: a gestured ask is still the loud prompt.
    void d.request({ gesture: true })
    await settle()
    expect(isQuiet(d.prompt())).toBe(false)
  })

  it('no relay at all – a page whose frames carry no bridge – leaves the gesture unknown after the wait, and the prompt is the loud one', async () => {
    const d = desk()
    const answer = d.request({ gesture: 'none' })
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS - 1)
    expect(d.prompt()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(isQuiet(d.prompt())).toBe(false)
    d.prompts.respond(d.prompt()!.id, 'allow')
    await expect(answer).resolves.toBe(true)
  })

  it('a relay landing after the request (the two ride different pipes) is taken within the wait', async () => {
    const d = desk()
    const answer = d.request({ gesture: 'none' })
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS / 2)
    expect(d.prompt()).toBeUndefined()
    d.relay.note(PAGE_ID, { gesture: false, site: SITE, isMainFrame: true })
    await settle()
    expect(isQuiet(d.prompt())).toBe(true)
    d.prompts.respond(d.prompt()!.id, 'allow')
    await expect(answer).resolves.toBe(true)
  })

  it('a standing decision answers without a prompt whatever the gesture', async () => {
    const d = desk()
    d.permissions.set('notifications', SITE, 'allow')
    await expect(d.request({ gesture: false })).resolves.toBe(true)
    d.permissions.set('notifications', SITE, 'deny')
    await expect(d.request({ gesture: false })).resolves.toBe(false)
    // A page with no bridge (a push subscription's request, say) waits for the relay that never
    // comes and then gets the standing answer too.
    const unrelayed = d.request({ gesture: 'none' })
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS)
    await expect(unrelayed).resolves.toBe(false)
    expect(d.prompt()).toBeUndefined()
  })

  it('a page without a site is refused without a question', async () => {
    const d = desk()
    await expect(d.request({ gesture: false, url: 'about:blank' })).resolves.toBe(false)
    expect(d.prompt()).toBeUndefined()
  })

  it('a private window’s quiet answer lives in its container, never in the store', async () => {
    const d = desk()
    const answer = d.request({ gesture: false, details: { privateContainerId: 'private' } })
    await settle()
    expect(isQuiet(d.prompt())).toBe(true)
    d.prompts.respond(d.prompt()!.id, 'allow')
    await expect(answer).resolves.toBe(true)
    expect(d.permissions.resolve('notifications', PAGE, { privateContainerId: 'private' })).toBe(
      'allow'
    )
    expect(d.permissions.resolve('notifications', PAGE)).toBe('ask')
  })

  it('a rule changed by hand – the site sheet’s row, Settings’ list, a reset – lifts the quiet mark, and the site asks aloud again', async () => {
    const byHand: Array<(permissions: PermissionService) => void> = [
      // The site-information sheet's row set to Block, then back to Ask.
      (p) => {
        p.set('notifications', SITE, 'deny')
        p.set('notifications', SITE, null)
      },
      // Settings › Site settings › Notifications: the rule removed from the list.
      (p) => {
        p.set('notifications', SITE, 'deny')
        p.forgetRule(SITE, 'notifications')
      },
      // The site sheet's "Reset permissions".
      (p) => {
        p.set('notifications', SITE, 'deny')
        p.resetOrigin(SITE)
      }
    ]
    for (const change of byHand) {
      const d = desk()
      const first = d.request({ gesture: true })
      await settle()
      d.prompts.respond(d.prompt()!.id, 'dismiss')
      await expect(first).resolves.toBe(false)
      change(d.permissions)
      expect(d.permissions.resolve('notifications', PAGE)).toBe('ask')
      void d.request({ gesture: true })
      await settle()
      expect(isQuiet(d.prompt())).toBe(false)
    }
  })
})

describe('the relay: matching the page bridge’s word to the engine’s request', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('matches by page, site and frame kind, oldest first, and each relay answers one request', async () => {
    const clock = { now: 1_000 }
    const relay = new NotificationRequestRelay(() => clock.now)
    relay.note(PAGE_ID, { gesture: true, site: SITE, isMainFrame: true })
    relay.note(PAGE_ID, { gesture: false, site: SITE, isMainFrame: true })
    relay.note(PAGE_ID, { gesture: true, site: 'https://ads.example', isMainFrame: false })
    relay.note(PAGE_ID + 1, { gesture: false, site: SITE, isMainFrame: true })
    expect(relay.pending(PAGE_ID)).toBe(3)
    await expect(relay.take(PAGE_ID, SITE, true)).resolves.toBe(true)
    await expect(relay.take(PAGE_ID, SITE, true)).resolves.toBe(false)
    // The embedded frame's relay is not the top frame's, and another page's is not this one's.
    const third = relay.take(PAGE_ID, SITE, true)
    expect(relay.pending(PAGE_ID)).toBe(1)
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS)
    await expect(third).resolves.toBeUndefined()
    await expect(relay.take(PAGE_ID, 'https://ads.example', false)).resolves.toBe(true)
    await expect(relay.take(PAGE_ID + 1, SITE, true)).resolves.toBe(false)
  })

  it('drops a relay older than the window: a call whose request never came claims nothing later', async () => {
    const clock = { now: 1_000 }
    const relay = new NotificationRequestRelay(() => clock.now)
    relay.note(PAGE_ID, { gesture: false, site: SITE, isMainFrame: true })
    clock.now += RELAY_WINDOW_MS
    const inTime = relay.take(PAGE_ID, SITE, true)
    await expect(inTime).resolves.toBe(false)
    relay.note(PAGE_ID, { gesture: false, site: SITE, isMainFrame: true })
    clock.now += RELAY_WINDOW_MS + 1
    const late = relay.take(PAGE_ID, SITE, true)
    expect(relay.pending(PAGE_ID)).toBe(0)
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS)
    await expect(late).resolves.toBeUndefined()
  })

  it('keeps a bounded number of relays per page', () => {
    const relay = new NotificationRequestRelay(() => 0)
    for (let i = 0; i < MAX_RELAYS + 5; i++)
      relay.note(PAGE_ID, { gesture: i % 2 === 0, site: SITE, isMainFrame: true })
    expect(relay.pending(PAGE_ID)).toBe(MAX_RELAYS)
  })

  it('a waiting request takes the relay that lands, once; the wait ends with nothing otherwise', async () => {
    const relay = new NotificationRequestRelay(() => 0)
    const first = relay.take(PAGE_ID, SITE, true)
    const second = relay.take(PAGE_ID, SITE, true)
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS / 2)
    relay.note(PAGE_ID, { gesture: true, site: SITE, isMainFrame: true })
    await expect(first).resolves.toBe(true)
    // A relay of another document does not answer the second waiter.
    relay.note(PAGE_ID, { gesture: false, site: 'https://other.example', isMainFrame: true })
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS)
    await expect(second).resolves.toBeUndefined()
    expect(relay.pending(PAGE_ID)).toBe(1)
    // The relay a waiter took is gone: the next request waits afresh.
    const third = relay.take(PAGE_ID, SITE, true)
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS)
    await expect(third).resolves.toBeUndefined()
  })

  it('a page gone: nothing of it stands, and a request still waiting learns nothing', async () => {
    const relay = new NotificationRequestRelay(() => 0)
    relay.note(PAGE_ID, { gesture: false, site: SITE, isMainFrame: true })
    const waiting = relay.take(PAGE_ID, 'https://other.example', true)
    relay.forget(PAGE_ID)
    await expect(waiting).resolves.toBeUndefined()
    expect(relay.pending(PAGE_ID)).toBe(0)
    // The forgotten waiter's timer is gone with it: nothing fires later.
    await vi.advanceTimersByTimeAsync(RELAY_WAIT_MS * 2)
    expect(relay.pending(PAGE_ID)).toBe(0)
  })

  it('reads the relaying frame’s own site and kind; a frame gone is taken for the top frame at the page’s URL', () => {
    expect(relayedFrom({ url: 'https://ads.example/unit', parent: {} }, PAGE)).toEqual({
      site: 'https://ads.example',
      isMainFrame: false
    })
    expect(relayedFrom({ url: PAGE, parent: null }, PAGE)).toEqual({
      site: SITE,
      isMainFrame: true
    })
    expect(relayedFrom(null, PAGE)).toEqual({ site: SITE, isMainFrame: true })
    const disposed = {
      url: 'https://ads.example/unit',
      get parent(): unknown {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    }
    expect(relayedFrom(disposed, PAGE)).toEqual({ site: SITE, isMainFrame: true })
  })
})
